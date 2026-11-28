// `authorrequest:<accountId>` (#234): one open "request author access" item per account, for the owner's review
// queue. Additive: a new prefix that nothing else reads. The prefix stays small (a request is deleted when the owner
// decides it, and only full accounts that are not authors yet may file one), so the queue is one key listing plus
// one read per request.
import { z } from "zod";
import type { KvStore, Versioned } from "./KvStore.ts";
import { mapWithConcurrency } from "./KvStore.ts";

const PREFIX = "authorrequest:";

export const AuthorRequestRecordSchema = z.object({
  schemaVersion: z.number().int().min(1).default(1),
  accountId: z.string(),
  /** what the player wrote about the case they want to make (plain text, rendered with textContent) */
  note: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type AuthorRequestRecord = z.infer<typeof AuthorRequestRecordSchema>;

export class AuthorRequestRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  async get(accountId: string): Promise<Versioned<AuthorRequestRecord> | null> {
    const entry = await this.kv.get(`${PREFIX}${accountId}`);
    if (!entry) return null;
    const parsed = AuthorRequestRecordSchema.safeParse(entry.data);
    return parsed.success ? { data: parsed.data, etag: entry.etag } : null;
  }
  /** Conditional write; `etag === null` means "only if new". */
  saveIfMatch(record: AuthorRequestRecord, etag: string | null): Promise<boolean> {
    return this.kv.setIfMatch(`${PREFIX}${record.accountId}`, record, etag);
  }
  async delete(accountId: string): Promise<void> {
    await this.kv.delete(`${PREFIX}${accountId}`);
  }
  /** How many requests are open (one key listing, no reads): the overview's queue count. */
  async count(): Promise<number> {
    return (await this.kv.listKeys(PREFIX)).length;
  }
  async list(): Promise<AuthorRequestRecord[]> {
    const ids = (await this.kv.listKeys(PREFIX)).map((key) => key.slice(PREFIX.length));
    const rows = await mapWithConcurrency(ids, async (id) => (await this.get(id))?.data ?? null);
    return rows.filter((r): r is AuthorRequestRecord => r !== null);
  }
}
