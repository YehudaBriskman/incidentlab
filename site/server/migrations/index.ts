// The ordered list of data migrations. Add new ones at the end with the next number; never edit or
// remove one that has run in production (it is in the config:migrations ledger there).
import { z } from "zod";
import { AccountRecordSchema, ProgressRecordSchema } from "../domain/types.ts";
import type { ProgressRecord } from "../domain/types.ts";
import { ScoreRecordSchema, sameScore, summarizeProgress } from "../domain/score.ts";
import { CLASS_DEFAULTS, EventSchema, normalizeClassCode, ScheduleSchema, SettingsSchema } from "../../shared/contract.ts";
import { CLASS_SCHEMA_VERSION, ClassMemberRecordSchema, ClassRecordSchema, DEFAULT_CLASS_EVENT, DEFAULT_CLASS_SCHEDULE, reverseOf, sameReverse, SITE_OWNER_ID } from "../domain/classes.ts";
import type { ClassMemberRecord, ClassRecord } from "../domain/classes.ts";
import { MemberOfRecordSchema } from "../domain/classes.ts";
import { sha256Hex } from "../services/crypto.ts";
import { generateBoardToken, generateJoinCode } from "../services/ClassService.ts";
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

/** Class 1 has a fixed id, so every run finds the class an earlier (or interrupted) run made. */
export const DEFAULT_CLASS_ID = "DefaultClass";

/**
 * 004 (classes, #179): today's single class becomes "Class 1", owned by the site owner (`admin`):
 * - its schedule (timezone, days, default case) and event (window, freeze, announcement) are copies of
 *   `config:schedule` and `config:event`, which keep working unchanged (gameplay gating moves in #180);
 * - its join code is `config:settings.inviteCode` when one is set (and usable as a code), otherwise a generated
 *   one; join mode `code`;
 * - every approved full account (no guests, no rejected accounts) becomes an active member, in both indexes.
 *   memberLimit is 60, or the number of those accounts when that is more, so nobody is left out.
 * Idempotent: the class has a fixed id and is created only when missing; the code index and member rows are
 * written only when missing or different. An interrupted run is finished by the next one. The ledger stops any
 * later run, so members who leave Class 1 afterwards are never added back.
 */
const defaultClass: Migration = {
  id: "004-default-class",
  description: "create Class 1 (owned by admin) from the schedule, event and class code, with every approved account as a member",
  async run(ctx) {
    const nowIso = ctx.now().toISOString();
    const accounts: string[] = [];
    let scanned = 0;
    for (const key of await ctx.kv.listKeys("account:")) {
      const parsed = AccountRecordSchema.safeParse((await ctx.kv.get(key))?.data);
      if (!parsed.success) {
        ctx.log(`  skip ${key}: doesn't parse`);
        continue;
      }
      scanned += 1;
      if (parsed.data.status === "approved" && parsed.data.kind === "user") accounts.push(parsed.data.id);
    }

    let changed = 0;
    const classKey = `class:${DEFAULT_CLASS_ID}`;
    const existing = await ctx.kv.get(classKey);
    let record: ClassRecord;
    if (existing) {
      const parsed = ClassRecordSchema.safeParse(existing.data);
      if (!parsed.success) return { scanned, changed: 0, note: `${classKey} doesn't parse: left alone` };
      record = parsed.data;
    } else {
      const schedule = ScheduleSchema.safeParse((await ctx.kv.get("config:schedule"))?.data);
      const event = EventSchema.safeParse((await ctx.kv.get("config:event"))?.data);
      const settings = SettingsSchema.safeParse((await ctx.kv.get("config:settings"))?.data);
      const inviteCode = settings.success ? settings.data.inviteCode : null;
      const usable = inviteCode !== null && /^[0-9A-Z]{4,40}$/.test(normalizeClassCode(inviteCode));
      if (inviteCode !== null && !usable) ctx.log("  the class code has characters a join code can't hold: generating a new one");
      record = {
        schemaVersion: CLASS_SCHEMA_VERSION,
        id: DEFAULT_CLASS_ID,
        name: "Class 1",
        ownerId: SITE_OWNER_ID,
        createdAt: nowIso,
        updatedAt: nowIso,
        status: "active",
        joinMode: "code",
        memberLimit: Math.max(CLASS_DEFAULTS.MEMBER_LIMIT, accounts.length),
        boardToken: generateBoardToken(DEFAULT_CLASS_ID),
        joinCode: usable && inviteCode !== null ? inviteCode : generateJoinCode(),
        schedule: schedule.success
          ? { timezone: schedule.data.timezone, defaultCaseId: schedule.data.defaultCaseId, days: schedule.data.days }
          : { ...DEFAULT_CLASS_SCHEDULE, days: {} },
        event: event.success
          ? { name: event.data.name, startsAt: event.data.startsAt, endsAt: event.data.endsAt, freezeAt: event.data.freezeAt, announcement: event.data.announcement }
          : { ...DEFAULT_CLASS_EVENT },
        caseIds: [],
      };
      changed += 1;
      if (!ctx.dryRun && !(await ctx.kv.setIfMatch(classKey, record, null))) return { scanned, changed: 0, note: "Class 1 was created meanwhile: run again" };
    }

    // The join-code index, when missing.
    const codeKey = `classcode:${sha256Hex(normalizeClassCode(record.joinCode))}`;
    const index = await ctx.kv.get(codeKey);
    if (!index) {
      changed += 1;
      if (!ctx.dryRun) await ctx.kv.setIfMatch(codeKey, { classId: DEFAULT_CLASS_ID }, null);
    } else if (JSON.stringify(index.data) !== JSON.stringify({ classId: DEFAULT_CLASS_ID })) {
      ctx.log("  the code index entry for Class 1's code points at another class: left alone (rotate the code)");
    }

    // Members: forward first, then reverse, each only when missing or different.
    let members = 0;
    const fresh: ClassMemberRecord = { role: "member", status: "active", isOwner: false, joinedAt: nowIso, decidedAt: nowIso };
    await mapWithConcurrency(accounts, async (accountId) => {
      const forwardKey = `classmember:${DEFAULT_CLASS_ID}:${accountId}`;
      const found = await ctx.kv.get(forwardKey);
      const current = found ? ClassMemberRecordSchema.safeParse(found.data) : null;
      if (current && !current.success) {
        ctx.log(`  skip ${forwardKey}: doesn't parse`);
        return;
      }
      const member = current?.data ?? fresh;
      const reverseKey = `memberof:${accountId}:${DEFAULT_CLASS_ID}`;
      const reverse = MemberOfRecordSchema.safeParse((await ctx.kv.get(reverseKey))?.data);
      const needsForward = !found;
      const needsReverse = !reverse.success || !sameReverse(reverse.data, reverseOf(member));
      if (!needsForward && !needsReverse) return;
      if (needsForward) members += 1;
      changed += 1;
      if (ctx.dryRun) return;
      if (needsForward) await ctx.kv.setIfMatch(forwardKey, member, null);
      await ctx.kv.set(reverseKey, reverseOf(member));
    });
    return { scanned, changed, note: `${existing ? "Class 1 exists" : "Class 1 created"}, ${members} members added` };
  },
};

export const MIGRATIONS: readonly Migration[] = [stampSchemaVersion, importLegacyPlayers, openAccess, defaultClass];
