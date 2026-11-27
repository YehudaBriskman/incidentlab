// The global leaderboard's records (#175):
//   score:<accountId>         ScoreRecord      (domain/score.ts; kept up to date by ScoreService)
//   globalboard:<accountId>   { accountId, since }   exists only while the account opts in to the public board
// The board lists the `globalboard:` prefix and reads only those accounts' records, never every account.
import { z } from "zod";
import { ScoreRecordSchema } from "../domain/score.ts";
import type { ScoreRecord } from "../domain/score.ts";
import type { KvStore, Versioned } from "./KvStore.ts";

const SCORE_PREFIX = "score:";
const BOARD_PREFIX = "globalboard:";

export class ScoreRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  async get(accountId: string): Promise<Versioned<ScoreRecord> | null> {
    const entry = await this.kv.get(`${SCORE_PREFIX}${accountId}`);
    if (!entry) return null;
    const parsed = ScoreRecordSchema.safeParse(entry.data);
    return parsed.success ? { data: parsed.data, etag: entry.etag } : null;
  }
  /** Conditional write; `etag === null` means "only if new". */
  saveIfMatch(record: ScoreRecord, etag: string | null): Promise<boolean> {
    return this.kv.setIfMatch(`${SCORE_PREFIX}${record.accountId}`, record, etag);
  }
  async delete(accountId: string): Promise<void> {
    await this.kv.delete(`${SCORE_PREFIX}${accountId}`);
  }
}

const BoardMarkerSchema = z.object({ accountId: z.string(), since: z.string() });
export type BoardMarker = z.infer<typeof BoardMarkerSchema>;

export class GlobalBoardRepository {
  private readonly kv: KvStore;
  constructor(kv: KvStore) {
    this.kv = kv;
  }
  /** The ids of every account that opted in (one list call, no reads). */
  async listAccountIds(): Promise<string[]> {
    return (await this.kv.listKeys(BOARD_PREFIX)).map((key) => key.slice(BOARD_PREFIX.length));
  }
  async has(accountId: string): Promise<boolean> {
    return BoardMarkerSchema.safeParse((await this.kv.get(`${BOARD_PREFIX}${accountId}`))?.data).success;
  }
  /** Adds the marker; an existing one (and its `since`) is kept. */
  async add(accountId: string, since: string): Promise<void> {
    await this.kv.setIfMatch(`${BOARD_PREFIX}${accountId}`, { accountId, since }, null);
  }
  async remove(accountId: string): Promise<void> {
    await this.kv.delete(`${BOARD_PREFIX}${accountId}`);
  }
}
