// The ordered list of data migrations. Add new ones at the end with the next number; never edit or
// remove one that has run in production (it is in the config:migrations ledger there).
import { z } from "zod";
import { AccountRecordSchema, ProgressRecordSchema } from "../domain/types.ts";
import type { ProgressRecord } from "../domain/types.ts";
import { ScoreRecordSchema, sameScore, summarizeProgress } from "../domain/score.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import type { Migration } from "./runner.ts";

/** 001: stamp schemaVersion on every account and progress record, writing back the fully-defaulted shape. */
const stampSchemaVersion: Migration = {
  id: "001-stamp-schema-version",
  description: "write schemaVersion and default fields on every account and progress record",
  async run(ctx) {
    let scanned = 0;
    let changed = 0;
    for (const [prefix, schema] of [["account:", AccountRecordSchema], ["progress:", ProgressRecordSchema]] as const) {
      const keys = await ctx.kv.listKeys(prefix);
      await mapWithConcurrency(keys, async (key) => {
        const entry = await ctx.kv.get(key);
        if (!entry) return;
        scanned += 1;
        const raw = entry.data;
        if (typeof raw === "object" && raw !== null && "schemaVersion" in raw) return; // already stamped
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          ctx.log(`  skip ${key}: doesn't parse (${parsed.error.issues[0]?.message ?? "invalid"})`);
          return;
        }
        changed += 1;
        // Conditional write: if a live request updated the record meanwhile, its version wins and is re-stamped next run.
        if (!ctx.dryRun) await ctx.kv.setIfMatch(key, parsed.data, entry.etag);
      });
    }
    return { scanned, changed };
  },
};

const LegacyPlayerSchema = z.object({ id: z.string(), name: z.string(), caseId: z.string(), createdAt: z.string() }).passthrough();

/**
 * 002: copy round-1 anonymous players (store "incidentlab-players", orphaned when accounts moved to
 * "incidentlab-v2") into `legacy:<id>` so their scores are kept. Read-only on the old store.
 */
const importLegacyPlayers: Migration = {
  id: "002-import-legacy-players",
  description: "copy pre-accounts players from incidentlab-players into legacy:<id> (old store untouched)",
  async run(ctx) {
    if (!ctx.legacy) return { scanned: 0, changed: 0, note: "no legacy store available" };
    const keys = (await ctx.legacy.listKeys("")).filter((k) => !k.startsWith("ratelimit:"));
    let changed = 0;
    for (const key of keys) {
      const entry = await ctx.legacy.get(key);
      const parsed = LegacyPlayerSchema.safeParse(entry?.data);
      if (!parsed.success) continue;
      const target = `legacy:${parsed.data.id}`;
      if (await ctx.kv.get(target)) continue; // already imported
      changed += 1;
      if (!ctx.dryRun) await ctx.kv.setIfMatch(target, { ...parsed.data, importedAt: ctx.now().toISOString(), source: "incidentlab-players" }, null);
    }
    return { scanned: keys.length, changed };
  },
};

/**
 * 003 (open access, #171/#175):
 * 1. approves every `pending` account (sign-up is open now; approval moves to classes) and stamps `decidedAt`;
 *    `rejected` accounts stay rejected;
 * 2. backfills `score:<accountId>` for every account from its progress records, so the opt-in board and the
 *    rank on /api/me/stats work without reading progress.
 * `showOnGlobalBoard` is not touched: it stays false (the default), so the public board starts empty until
 * players opt in. Idempotent: an approved account and a summary equal to its progress are left alone.
 */
const openAccess: Migration = {
  id: "003-open-access",
  description: "approve pending accounts and backfill score:<accountId> summaries from progress",
  async run(ctx) {
    const progressByAccount = new Map<string, ProgressRecord[]>();
    for (const key of await ctx.kv.listKeys("progress:")) {
      const parsed = ProgressRecordSchema.safeParse((await ctx.kv.get(key))?.data);
      if (!parsed.success) continue;
      const list = progressByAccount.get(parsed.data.accountId) ?? [];
      list.push(parsed.data);
      progressByAccount.set(parsed.data.accountId, list);
    }
    const nowIso = ctx.now().toISOString();
    let scanned = 0;
    let approved = 0;
    let scores = 0;
    const accountKeys = await ctx.kv.listKeys("account:");
    await mapWithConcurrency(accountKeys, async (key) => {
      const entry = await ctx.kv.get(key);
      const parsed = AccountRecordSchema.safeParse(entry?.data);
      if (!entry || !parsed.success) {
        ctx.log(`  skip ${key}: doesn't parse`);
        return;
      }
      scanned += 1;
      const account = parsed.data;
      if (account.status === "pending") {
        approved += 1;
        // Conditional write: a live request that changed the account meanwhile wins; the next run approves it.
        if (!ctx.dryRun) await ctx.kv.setIfMatch(key, { ...account, status: "approved", decidedAt: nowIso }, entry.etag);
      }
      const summary = summarizeProgress(account.id, progressByAccount.get(account.id) ?? []);
      const scoreKey = `score:${account.id}`;
      const existing = await ctx.kv.get(scoreKey);
      const current = existing ? ScoreRecordSchema.safeParse(existing.data) : null;
      if (current && !current.success) {
        ctx.log(`  skip ${scoreKey}: doesn't parse`);
        return;
      }
      if (sameScore(current?.data ?? null, summary)) return;
      scores += 1;
      if (!ctx.dryRun) await ctx.kv.setIfMatch(scoreKey, summary, existing?.etag ?? null);
    });
    return { scanned, changed: approved + scores, note: `${approved} approved, ${scores} score summaries written` };
  },
};

export const MIGRATIONS: readonly Migration[] = [stampSchemaVersion, importLegacyPlayers, openAccess];
