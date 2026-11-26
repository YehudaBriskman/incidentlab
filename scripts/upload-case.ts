// `scripts/data.ts upload`: uploads a case package through the same HTTP endpoints as the upload page
// (site/shared/upload-client.ts), authenticated as the admin with X-Admin-Key.
//
//   node --experimental-strip-types scripts/data.ts upload <package.case.zip> [--publish] [--accept-answer-changes] [--url <base>]
//   node --experimental-strip-types scripts/data.ts publish <case-id> <version> [--accept-answer-changes] [--url <base>]
//
// The URL defaults to the local server (tests/local-server.ts on port 8888). A production upload needs an
// explicit --url. The admin key comes from ADMIN_KEY or, for a remote URL, ~/.incidentlab-admin-key; a local
// URL falls back to the local server's default key. A failed upload resumes when run again: chunks the
// server already has are not sent twice.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { UploadError, publishCaseVersion, uploadCasePackage } from "../site/shared/upload-client.ts";
import type { UploadOutcome, UploadProgress, UploadTransport } from "../site/shared/upload-client.ts";

export const DEFAULT_UPLOAD_URL = "http://localhost:8888";
export const LOCAL_ADMIN_KEY = "local-admin-key-0123456789";
const KEY_FILE = join(homedir(), ".incidentlab-admin-key");

export const isLocalUrl = (url: URL): boolean => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

export type UploadCommand = {
  readonly file: string;
  readonly url: string;
  readonly publish: boolean;
  readonly acceptAnswerChanges: boolean;
  readonly adminKey: string;
  /** tests pass an in-process fetch */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly log?: (line: string) => void;
};

export const resolveAdminKey = (url: URL, env: NodeJS.ProcessEnv = process.env): string | null => {
  const fromEnv = env["ADMIN_KEY"]?.trim();
  if (fromEnv) return fromEnv;
  if (isLocalUrl(url)) return LOCAL_ADMIN_KEY;
  return existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() || null : null;
};

const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

const describe = (p: UploadProgress): string | null => {
  switch (p.phase) {
    case "validated": return `package ${p.caseId}: valid, ${p.files} evidence files, ${mib(p.bytes)}`;
    case "created": return `upload ${p.uploadId}: ${p.missingChunks} of ${p.totalChunks} chunk(s) to send`;
    case "chunk": return p.sent === p.total || p.sent % 5 === 0 ? `  chunks ${p.sent}/${p.total} (${mib(p.bytes)})` : null;
    case "parts": return p.sent === p.total ? `  parts ${p.sent}/${p.total}` : null;
    case "finalized": return `stored draft v${p.version}`;
    case "published": return `published v${p.version}`;
  }
};

/** Runs one upload. Throws UploadError (with the server's details) on failure. */
export async function uploadCommand(cmd: UploadCommand): Promise<UploadOutcome> {
  const log = cmd.log ?? ((line: string) => console.log(`[data] ${line}`));
  const base = new URL(cmd.url);
  const doFetch = cmd.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const bytes = new Uint8Array(readFileSync(cmd.file));
  const send: UploadTransport = (path, init) =>
    doFetch(new URL(path, base).toString(), {
      method: init.method,
      headers: { ...init.headers, "x-admin-key": cmd.adminKey },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  // The confirmation line, before anything is written.
  log(`uploading ${basename(cmd.file)} to ${base.origin}${isLocalUrl(base) ? " (local)" : " (REMOTE: this writes to that site's data)"}${cmd.publish ? ", then publishing" : " as a draft"}`);
  const outcome = await uploadCasePackage(bytes, {
    send,
    publish: cmd.publish,
    acceptAnswerChanges: cmd.acceptAnswerChanges,
    onProgress: (p) => {
      const line = describe(p);
      if (line) log(line);
    },
  });
  const { diff } = outcome.draft;
  log(`diff against ${diff.against === null ? "nothing published" : `v${diff.against}`}: ${diff.contentChanged.length}${diff.contentTruncated ? "+" : ""} content key(s) changed, evidence +${diff.evidenceAdded.length} -${diff.evidenceRemoved.length} ~${diff.evidenceChanged.length}, answer key ${diff.answerFingerprintChanged === null ? "new" : diff.answerFingerprintChanged ? "CHANGED" : "unchanged"}`);
  log(`sent ${outcome.chunksSent} chunk(s), skipped ${outcome.chunksSkipped} already stored`);
  return outcome;
}

const usageExit = (message: string): never => {
  console.error(`[data] ${message}`);
  process.exit(2);
};

/** --url (default: the local server) and the admin key for it, or exit 2. */
const target = (args: readonly string[]): { url: string; adminKey: string } => {
  const i = args.indexOf("--url");
  const url = i >= 0 ? (args[i + 1] ?? usageExit("--url needs a value")) : DEFAULT_UPLOAD_URL;
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    return usageExit(`--url is not a URL: ${url}`);
  }
  const adminKey = resolveAdminKey(base) ?? usageExit("no admin key: set ADMIN_KEY or put it in ~/.incidentlab-admin-key");
  return { url, adminKey };
};

/** Positional arguments (not flags, not the value after --url). */
const positional = (args: readonly string[]): string[] => args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--url");

/** `publish <case-id> <version> [--accept-answer-changes] [--url <base>]`: publish (or roll back to) a stored version. */
export async function runPublishCli(args: readonly string[]): Promise<void> {
  const [caseId, versionText] = positional(args);
  const version = Number(versionText);
  if (!caseId || !Number.isInteger(version) || version < 1) usageExit("usage: publish <case-id> <version> [--accept-answer-changes] [--url <base>]");
  const { url, adminKey } = target(args);
  const base = new URL(url);
  console.log(`[data] publishing ${caseId} v${version} on ${base.origin}${isLocalUrl(base) ? " (local)" : " (REMOTE: this changes what players see)"}`);
  const send: UploadTransport = (path, init) =>
    fetch(new URL(path, base).toString(), { method: init.method, headers: { ...init.headers, "x-admin-key": adminKey }, ...(init.body === undefined ? {} : { body: init.body }) });
  try {
    const result = await publishCaseVersion(send, caseId ?? "", version, args.includes("--accept-answer-changes"));
    console.log(`[data] ${result.changed ? (result.rollback ? "rolled back to" : "published") : "already published:"} v${result.publishedVersion}${result.previousVersion === null ? "" : ` (was v${result.previousVersion})`}`);
  } catch (error) {
    console.error(`[data] publish failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/** `upload <package.case.zip> [--publish] [--accept-answer-changes] [--url <base>]`; exits non-zero on failure. */
export async function runUploadCli(args: readonly string[]): Promise<void> {
  const [file] = positional(args);
  if (!file) return usageExit("usage: upload <package.case.zip> [--publish] [--accept-answer-changes] [--url <base>]");
  if (!existsSync(file)) return usageExit(`no such file: ${file}`);
  const { url, adminKey } = target(args);
  try {
    await uploadCommand({ file, url, publish: args.includes("--publish"), acceptAnswerChanges: args.includes("--accept-answer-changes"), adminKey });
  } catch (error) {
    if (error instanceof UploadError) {
      console.error(`[data] upload failed: ${error.message}`);
      for (const detail of error.details.slice(0, 30)) console.error(`  - ${detail}`);
      if (error.code === "answer-drift") console.error("[data] players have progress on this case; publish the stored draft anyway with: data.ts publish <case-id> <version> --accept-answer-changes");
      else if (error.status === 0 || error.status >= 500 || error.status === 429) console.error("[data] run the same command again to resume: chunks already sent are skipped");
    } else {
      console.error(`[data] upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}
