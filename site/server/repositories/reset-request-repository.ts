// `resetrequest:<accountId>` (#254): one password reset request per account (domain/reset-requests.ts).
// The prefix stays small (requests expire after 7 days and the weekly hygiene job deletes them), so the owner's
// list and a class's list start from one key listing and read only the requests they need.
import { ResetRequestRecordSchema } from "../domain/reset-requests.ts";
import type { ResetRequestRecord } from "../domain/reset-requests.ts";
import type { KvStore, Versioned } from "./KvStore.ts";
import { mapWithConcurrency } from "./KvStore.ts";

const PREFIX = "resetrequest:";

export class ResetRequestRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  async get(accountId: string): Promise<Versioned<ResetRequestRecord> | null> {
    const entry = await this.kv.get(`${PREFIX}${accountId}`);
    if (!entry) return null;
    const parsed = ResetRequestRecordSchema.safeParse(entry.data);
    return parsed.success ? { data: parsed.data, etag: entry.etag } : null;
  }
  /** Conditional write; `etag === null` means "only if new". */
  saveIfMatch(record: ResetRequestRecord, etag: string | null): Promise<boolean> {
    return this.kv.setIfMatch(`${PREFIX}${record.accountId}`, record, etag);
  }
  async delete(accountId: string): Promise<void> {
    await this.kv.delete(`${PREFIX}${accountId}`);
  }
  /** The account ids that have a request (one key listing, no reads). */
  async listAccountIds(): Promise<string[]> {
    return (await this.kv.listKeys(PREFIX)).map((key) => key.slice(PREFIX.length));
  }
  async list(): Promise<ResetRequestRecord[]> {
    const rows = await mapWithConcurrency(await this.listAccountIds(), async (id) => (await this.get(id))?.data ?? null);
    return rows.filter((r): r is ResetRequestRecord => r !== null);
  }
}
