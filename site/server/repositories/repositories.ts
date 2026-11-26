// Typed repositories over the KvStore. Key layout (one Blobs store, "incidentlab-v2"):
//   account:<accountId>                 AccountRecord
//   username:<sha256(usernameKey)>      { accountId }       (unique index, written onlyIfNew)
//   session:<sha256(token)>             SessionRecord
//   progress:<caseId>:<accountId>       ProgressRecord
//   config:schedule                     Schedule
//   ratelimit:<bucket>:<sha256(subject)> number[]
import { z } from "zod";
import { ScheduleSchema } from "../../shared/contract.ts";
import type { Schedule } from "../../shared/contract.ts";
import { AccountRecordSchema, ProgressRecordSchema, SessionRecordSchema } from "../domain/types.ts";
import type { AccountRecord, ProgressRecord, SessionRecord } from "../domain/types.ts";
import { mapWithConcurrency } from "./KvStore.ts";
import type { KvStore, Versioned } from "./KvStore.ts";

const parseVersioned = <T>(entry: Versioned<unknown> | null, schema: z.ZodType<T>): Versioned<T> | null => {
  if (!entry) return null;
  const parsed = schema.safeParse(entry.data);
  return parsed.success ? { data: parsed.data, etag: entry.etag } : null;
};

export class AccountRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  async get(accountId: string): Promise<Versioned<AccountRecord> | null> {
    return parseVersioned(await this.kv.get(`account:${accountId}`), AccountRecordSchema);
  }
  saveIfMatch(account: AccountRecord, etag: string | null): Promise<boolean> {
    return this.kv.setIfMatch(`account:${account.id}`, account, etag);
  }
  async delete(accountId: string): Promise<void> {
    await this.kv.delete(`account:${accountId}`);
  }
  async list(): Promise<AccountRecord[]> {
    const keys = await this.kv.listKeys("account:");
    const rows = await mapWithConcurrency(keys, async (key) => parseVersioned(await this.kv.get(key), AccountRecordSchema)?.data ?? null);
    return rows.filter((r): r is AccountRecord => r !== null);
  }
}

const UsernameIndexSchema = z.object({ accountId: z.string() });

export class UsernameIndexRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  async lookup(hashedKey: string): Promise<string | null> {
    return parseVersioned(await this.kv.get(`username:${hashedKey}`), UsernameIndexSchema)?.data.accountId ?? null;
  }
  /** Atomically claims a username. False when it is already taken. */
  claim(hashedKey: string, accountId: string): Promise<boolean> {
    return this.kv.setIfMatch(`username:${hashedKey}`, { accountId }, null);
  }
  async release(hashedKey: string): Promise<void> {
    await this.kv.delete(`username:${hashedKey}`);
  }
}

export class SessionRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  async get(tokenHash: string): Promise<SessionRecord | null> {
    return parseVersioned(await this.kv.get(`session:${tokenHash}`), SessionRecordSchema)?.data ?? null;
  }
  async save(tokenHash: string, session: SessionRecord): Promise<void> {
    await this.kv.set(`session:${tokenHash}`, session);
  }
  async delete(tokenHash: string): Promise<void> {
    await this.kv.delete(`session:${tokenHash}`);
  }
}

export class ProgressRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  private key(caseId: string, accountId: string): string {
    return `progress:${caseId}:${accountId}`;
  }
  async get(caseId: string, accountId: string): Promise<Versioned<ProgressRecord> | null> {
    return parseVersioned(await this.kv.get(this.key(caseId, accountId)), ProgressRecordSchema);
  }
  saveIfMatch(record: ProgressRecord, etag: string | null): Promise<boolean> {
    return this.kv.setIfMatch(this.key(record.caseId, record.accountId), record, etag);
  }
  async delete(caseId: string, accountId: string): Promise<void> {
    await this.kv.delete(this.key(caseId, accountId));
  }
  private async listKeys(caseId?: string): Promise<string[]> {
    return this.kv.listKeys(caseId === undefined ? "progress:" : `progress:${caseId}:`);
  }
  /** True when any player has a progress record on the case (the answer-drift guard). */
  async hasAny(caseId: string): Promise<boolean> {
    return (await this.listKeys(caseId)).length > 0;
  }
  async list(caseId?: string): Promise<ProgressRecord[]> {
    const keys = await this.listKeys(caseId);
    const rows = await mapWithConcurrency(keys, async (key) => parseVersioned(await this.kv.get(key), ProgressRecordSchema)?.data ?? null);
    return rows.filter((r): r is ProgressRecord => r !== null);
  }
  async deleteMany(filter: { caseId?: string; accountId?: string }): Promise<void> {
    const keys = (await this.listKeys(filter.caseId)).filter((k) => filter.accountId === undefined || k.endsWith(`:${filter.accountId}`));
    await mapWithConcurrency(keys, (key) => this.kv.delete(key));
  }
}

export const DEFAULT_SCHEDULE: Schedule = { timezone: "Asia/Jerusalem", defaultCaseId: null, days: {}, lockToToday: false };

export class ScheduleRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  async get(): Promise<Schedule> {
    return parseVersioned(await this.kv.get("config:schedule"), ScheduleSchema)?.data ?? DEFAULT_SCHEDULE;
  }
  async save(schedule: Schedule): Promise<void> {
    await this.kv.set("config:schedule", schedule);
  }
}

const HitsSchema = z.array(z.number());

export class RateLimitRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  async getHits(key: string): Promise<number[]> {
    return parseVersioned(await this.kv.get(`ratelimit:${key}`), HitsSchema)?.data ?? [];
  }
  async setHits(key: string, hits: number[]): Promise<void> {
    await this.kv.set(`ratelimit:${key}`, hits);
  }
}

export type Repositories = {
  readonly accounts: AccountRepository;
  readonly usernames: UsernameIndexRepository;
  readonly sessions: SessionRepository;
  readonly progress: ProgressRepository;
  readonly schedule: ScheduleRepository;
  readonly rateLimits: RateLimitRepository;
};

export const createRepositories = (kv: KvStore): Repositories => ({
  accounts: new AccountRepository(kv),
  usernames: new UsernameIndexRepository(kv),
  sessions: new SessionRepository(kv),
  progress: new ProgressRepository(kv),
  schedule: new ScheduleRepository(kv),
  rateLimits: new RateLimitRepository(kv),
});
