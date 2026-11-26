#!/usr/bin/env -S node --experimental-strip-types
// Production data operations for IncidentLab (Netlify Blobs). Everything is read-only or a dry run
// unless --apply is given, and every write path takes a local backup first.
//
//   node --experimental-strip-types scripts/data.ts backup [--out DIR]
//   node --experimental-strip-types scripts/data.ts list-backups
//   node --experimental-strip-types scripts/data.ts restore <file.json | daily/YYYY-MM-DD.json> [--apply] [--prune]
//   node --experimental-strip-types scripts/data.ts migrate [--apply]
//   node --experimental-strip-types scripts/data.ts migrate --check        (exit 3 when migrations are pending)
//   node --experimental-strip-types scripts/data.ts upload <package.case.zip> [--publish] [--accept-answer-changes] [--url <base>]
//   node --experimental-strip-types scripts/data.ts publish <case-id> <version> [--accept-answer-changes] [--url <base>]
//   node --experimental-strip-types scripts/data.ts usage      (read-only: monthly bandwidth and counters vs the free plan)
//   node --experimental-strip-types scripts/data.ts gc-evidence [--apply]   (evidence chunks nothing uses; dry run first)
//     upload/publish go through the HTTP API (scripts/upload-case.ts), not Blobs: the URL defaults to the
//     local server, production needs an explicit --url.
//
// Credentials: NETLIFY_AUTH_TOKEN (or ~/.netlify-token) and the site id from .netlify/state.json.
// Local backups go to ~/.incidentlab-backups/ (mode 600), never into the repo.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../site/server/migrations/index.ts";
import { pendingMigrations, runMigrations } from "../site/server/migrations/runner.ts";
import { BACKUP_STORE, BlobsKvStore, LEGACY_STORE, PRIMARY_STORE } from "../site/server/repositories/KvStore.ts";
import type { BlobsCredentials } from "../site/server/repositories/KvStore.ts";
import { BlobsByteStore } from "../site/server/repositories/ByteStore.ts";
import { EvidenceGcService, GcAbort } from "../site/server/services/EvidenceGcService.ts";
import { SnapshotSchema, diffSnapshot, restoreSnapshot, takeSnapshot } from "../site/server/services/BackupService.ts";
import type { Snapshot, SnapshotDiff } from "../site/server/services/BackupService.ts";
import { runPublishCli, runUploadCli } from "./upload-case.ts";
import { fetchUsage, formatUsage } from "../site/server/ops/netlify-usage.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): boolean => args.includes(name);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const die = (message: string, code = 1): never => {
  console.error(`[data] ${message}`);
  process.exit(code);
};

const credentials = (): BlobsCredentials => {
  const tokenFile = join(homedir(), ".netlify-token");
  const token = process.env.NETLIFY_AUTH_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
  if (!token) die("set NETLIFY_AUTH_TOKEN or put a token in ~/.netlify-token");
  const statePath = join(ROOT, ".netlify/state.json");
  const siteId = process.env.NETLIFY_SITE_ID ?? (existsSync(statePath) ? String((JSON.parse(readFileSync(statePath, "utf8")) as { siteId?: unknown }).siteId ?? "") : "");
  if (!siteId) die("no site id: link the site (.netlify/state.json) or set NETLIFY_SITE_ID");
  return { siteID: siteId, token };
};

const store = (name: string): BlobsKvStore => new BlobsKvStore({ name, credentials: credentials() });

const summarize = (diff: SnapshotDiff): string =>
  `${diff.added.length} to add, ${diff.changed.length} to overwrite, ${diff.unchanged} unchanged, ${diff.extra.length} newer keys not in the backup`;

/** Snapshot of production written to ~/.incidentlab-backups (mode 600). Returns the path. */
const backupToDisk = async (reason: string): Promise<string> => {
  const dir = option("--out") ?? join(homedir(), ".incidentlab-backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const snapshot = await takeSnapshot(store(PRIMARY_STORE), { source: reason, now: new Date() });
  const path = join(dir, `incidentlab-${snapshot.createdAt.replace(/[:.]/g, "-")}-${reason}.json`);
  writeFileSync(path, JSON.stringify(snapshot), { mode: 0o600 });
  chmodSync(path, 0o600);
  const counts = new Map<string, number>();
  for (const key of Object.keys(snapshot.entries)) counts.set(key.split(":")[0] ?? key, (counts.get(key.split(":")[0] ?? key) ?? 0) + 1);
  console.log(`[data] backup: ${Object.keys(snapshot.entries).length} keys (${[...counts].map(([k, n]) => `${k} ${n}`).join(", ")})`);
  console.log(`[data] wrote ${path}`);
  return path;
};

const loadSnapshot = async (source: string): Promise<Snapshot> => {
  const raw: unknown = source.startsWith("daily/") ? (await store(BACKUP_STORE).get(source))?.data : JSON.parse(readFileSync(source, "utf8"));
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) die(`${source} is not an IncidentLab backup`);
  return (parsed as { data: Snapshot }).data;
};

const main = async (): Promise<void> => {
  switch (command) {
    case "backup": {
      await backupToDisk(option("--reason") ?? "manual");
      return;
    }
    case "list-backups": {
      const keys = await store(BACKUP_STORE).listKeys("daily/");
      console.log(keys.length ? keys.sort().join("\n") : "[data] no daily backups yet (the scheduled function runs once a day)");
      return;
    }
    case "restore": {
      const source = args[1];
      if (!source) die("usage: restore <file.json | daily/YYYY-MM-DD.json> [--apply] [--prune]");
      const snapshot = await loadSnapshot(source as string);
      const primary = store(PRIMARY_STORE);
      const diff = await diffSnapshot(primary, snapshot);
      console.log(`[data] restore from ${source} (taken ${snapshot.createdAt}): ${summarize(diff)}`);
      for (const key of diff.changed.slice(0, 20)) console.log(`  overwrite ${key}`);
      for (const key of diff.added.slice(0, 20)) console.log(`  add       ${key}`);
      if (flag("--prune")) for (const key of diff.extra.slice(0, 20)) console.log(`  DELETE    ${key}`);
      if (!flag("--apply")) {
        console.log("[data] dry run: nothing written. Re-run with --apply to restore (newer keys are kept unless --prune).");
        return;
      }
      await backupToDisk("pre-restore");
      await restoreSnapshot(primary, snapshot, { prune: flag("--prune") });
      console.log("[data] restored.");
      return;
    }
    case "gc-evidence": {
      // Mark-and-sweep of evidence chunks no case version or live upload uses (#122). Dry run unless --apply.
      const credentialsNow = credentials();
      const gc = new EvidenceGcService({
        kv: store(PRIMARY_STORE),
        bytes: new BlobsByteStore({ name: PRIMARY_STORE, credentials: credentialsNow }),
        now: () => new Date(),
      });
      try {
        const plan = await gc.plan();
        const unreferenced = plan.candidates.filter((c) => c.reason === "unreferenced").length;
        console.log(`[data] evidence: ${plan.storedChunks} chunks stored, ${plan.referencedFiles} files referenced, ${plan.liveUploads} upload(s) in progress`);
        console.log(`[data] collectable: ${plan.candidates.length} chunks (${unreferenced} of files nobody uses, ${plan.candidates.length - unreferenced} past a file's end), up to ${Math.ceil((plan.candidates.length * 4) / 1024)} GB`);
        for (const c of plan.candidates.slice(0, 20)) console.log(`[data]   ${c.key} (${c.reason})`);
        if (plan.candidates.length > 20) console.log(`[data]   … and ${plan.candidates.length - 20} more`);
        if (!flag("--apply")) {
          console.log("[data] dry run: nothing deleted. Re-run with --apply (takes a backup of the records first; chunk bytes come back only by re-uploading their case package).");
          return;
        }
        if (plan.candidates.length === 0) return console.log("[data] nothing to collect.");
        await backupToDisk("pre-gc");
        const deleted = await gc.sweep();
        console.log(`[data] deleted ${deleted.length} chunks.`);
      } catch (error) {
        if (error instanceof GcAbort) die(`gc-evidence stopped: ${error.message}`);
        throw error;
      }
      return;
    }
    case "migrate": {
      const primary = store(PRIMARY_STORE);
      const pending = await pendingMigrations(primary, MIGRATIONS);
      if (flag("--check")) {
        if (pending.length === 0) return console.log("[data] migrations: none pending");
        console.log(`[data] migrations pending: ${pending.map((m) => m.id).join(", ")}`);
        process.exit(3);
      }
      if (pending.length === 0) return console.log("[data] migrations: none pending");
      const apply = flag("--apply");
      if (apply) await backupToDisk("pre-migrate");
      const report = await runMigrations({ kv: primary, legacy: store(LEGACY_STORE), migrations: MIGRATIONS, dryRun: !apply, log: (m) => console.log(`[data] ${m}`) });
      for (const r of report.results) console.log(`[data] ${r.id}: scanned ${r.scanned}, ${apply ? "changed" : "would change"} ${r.changed}${r.note ? ` (${r.note})` : ""}`);
      if (!apply) console.log("[data] dry run: nothing written. Re-run with --apply.");
      return;
    }
    case "upload": {
      await runUploadCli(args.slice(1));
      return;
    }
    case "publish": {
      await runPublishCli(args.slice(1));
      return;
    }
    case "usage": {
      // Read-only: this month's bandwidth and counters against the legacy Free plan limits (#142).
      const { siteID, token } = credentials();
      const report = await fetchUsage(token, siteID);
      for (const line of formatUsage(report, new Date())) console.log(line);
      return;
    }
    default:
      die("commands: backup | list-backups | restore <src> [--apply] [--prune] | migrate [--apply|--check] | upload <package> [--publish] [--accept-answer-changes] [--url <base>] | publish <case-id> <version> [--accept-answer-changes] [--url <base>] | usage | gc-evidence [--apply]", 2);
  }
};

await main();
