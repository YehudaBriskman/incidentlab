// Small singleton records and append-only logs: settings, live event, first-blood claims, audit log.
//   config:settings                   Settings
//   config:event                      LiveEvent
//   firstblood:<caseId>:<questionId>  { accountId, at }   (claimed with onlyIfNew)
//   audit:<isoTimestamp>:<random>     AuditEntry
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AuditEntrySchema, EventSchema, SettingsSchema } from "../../shared/contract.ts";
import type { AuditEntry, LiveEvent, QuestionId, Settings } from "../../shared/contract.ts";
import { mapWithConcurrency } from "./KvStore.ts";
import type { KvStore } from "./KvStore.ts";

export const DEFAULT_SETTINGS: Settings = { inviteCode: null };
export const DEFAULT_EVENT: LiveEvent = { name: "", startsAt: null, endsAt: null, freezeAt: null, enforceWindow: false, announcement: null };

const parse = <T>(schema: z.ZodType<T>, raw: unknown): T | null => {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export class SettingsRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  async get(): Promise<Settings> {
    return parse(SettingsSchema, (await this.kv.get("config:settings"))?.data) ?? DEFAULT_SETTINGS;
  }
  async save(settings: Settings): Promise<void> {
    await this.kv.set("config:settings", settings);
  }
}

export class EventRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  async get(): Promise<LiveEvent> {
    return parse(EventSchema, (await this.kv.get("config:event"))?.data) ?? DEFAULT_EVENT;
  }
  async save(event: LiveEvent): Promise<void> {
    await this.kv.set("config:event", event);
  }
}

const FirstBloodSchema = z.object({ accountId: z.string(), at: z.string() });

export class FirstBloodRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  /**
   * True when this account is the first to claim the stage (race-free: conditional create).
   * Idempotent per account, so a retried request by the winner still gets true.
   */
  async claim(input: { caseId: string; questionId: QuestionId; accountId: string; at: string }): Promise<boolean> {
    const key = `firstblood:${input.caseId}:${input.questionId}`;
    if (await this.kv.setIfMatch(key, { accountId: input.accountId, at: input.at }, null)) return true;
    return parse(FirstBloodSchema, (await this.kv.get(key))?.data)?.accountId === input.accountId;
  }
  async clear(caseId?: string): Promise<void> {
    const keys = await this.kv.listKeys(caseId === undefined ? "firstblood:" : `firstblood:${caseId}:`);
    await mapWithConcurrency(keys, (key) => this.kv.delete(key));
  }
}

const MAX_AUDIT_READ = 500;

export class AuditRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  async append(entry: AuditEntry): Promise<void> {
    await this.kv.set(`audit:${entry.at}:${randomBytes(4).toString("hex")}`, entry);
  }
  /** Every audit key, oldest first (`audit:<isoTimestamp>:<random>`). */
  async listKeys(): Promise<string[]> {
    return (await this.kv.listKeys("audit:")).sort();
  }
  async delete(key: string): Promise<void> {
    if (key.startsWith("audit:")) await this.kv.delete(key);
  }
  /** Newest first. Keys sort by ISO timestamp, so the tail of the listing is the newest. */
  async latest(limit: number): Promise<AuditEntry[]> {
    const keys = (await this.kv.listKeys("audit:")).sort().slice(-Math.min(limit, MAX_AUDIT_READ)).reverse();
    const rows = await mapWithConcurrency(keys, async (key) => parse(AuditEntrySchema, (await this.kv.get(key))?.data));
    return rows.filter((r): r is AuditEntry => r !== null);
  }
}
