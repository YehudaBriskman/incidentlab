// The ordered list of data migrations. Add new ones at the end with the next number; never edit or
// remove one that has run in production (it is in the config:migrations ledger there).
import { z } from "zod";
import { AccountRecordSchema, ProgressRecordSchema } from "../domain/types.ts";
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

export const MIGRATIONS: readonly Migration[] = [stampSchemaVersion, importLegacyPlayers];
