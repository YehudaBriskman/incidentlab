// Keeps `score:<accountId>` (domain/score.ts) in step with the account's progress (#175). Every write is
// derived from the stored progress record, re-read after the summary's etag, and saved with a conditional
// write: a retry or a second request can only write the same summary again, and two requests racing on the
// same account can't leave an older progress state behind (the loser's write fails, it re-reads and retries).
import { scoreCaseOf, sameScore, summarize, summarizeProgress } from "../domain/score.ts";
import type { ScoreCase, ScoreRecord } from "../domain/score.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";

const MAX_WRITE_RETRIES = 4;

const backoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 10 * (attempt + 1))));

export class ScoreService {
  private readonly repos: Repositories;
  private readonly caseIds: () => readonly string[];
  private readonly onChange: () => void;

  constructor(deps: { repos: Repositories; caseIds: () => readonly string[]; onChange?: () => void }) {
    this.repos = deps.repos;
    this.caseIds = deps.caseIds;
    this.onChange = deps.onChange ?? (() => undefined);
  }

  /** Re-derives one case's part of the summary from its stored progress record (gone = the case is removed). */
  async syncCase(accountId: string, caseId: string): Promise<ScoreRecord> {
    return this.write(accountId, async (current) => {
      const progress = await this.repos.progress.get(caseId, accountId);
      const cases: Record<string, ScoreCase> = { ...(current?.cases ?? {}) };
      const entry = progress ? scoreCaseOf(progress.data) : null;
      if (entry === null) delete cases[caseId];
      else cases[caseId] = entry;
      return summarize(accountId, cases);
    });
  }

  /** Rebuilds the whole summary from the account's progress on every released case (cases no longer released keep their part). */
  async rebuild(accountId: string): Promise<ScoreRecord> {
    return this.write(accountId, async (current) => {
      const ids = this.caseIds();
      const records = (await mapWithConcurrency(ids, (caseId) => this.repos.progress.get(caseId, accountId))).flatMap((r) => (r ? [r.data] : []));
      const released = summarizeProgress(accountId, records).cases;
      const kept = Object.fromEntries(Object.entries(current?.cases ?? {}).filter(([caseId]) => !ids.includes(caseId)));
      return summarize(accountId, { ...kept, ...released });
    });
  }

  /** The stored summary, built on first use for accounts that don't have one yet (before migration 003). */
  async ensure(accountId: string): Promise<ScoreRecord> {
    return (await this.repos.scores.get(accountId))?.data ?? this.rebuild(accountId);
  }

  /** Drops the summary and the board marker (the account is deleted). */
  async remove(accountId: string): Promise<void> {
    await Promise.all([this.repos.scores.delete(accountId), this.repos.globalBoard.remove(accountId)]);
    this.onChange();
  }

  /** Conditional read-modify-write. `next` must read whatever it derives from after the summary was read. */
  private async write(accountId: string, next: (current: ScoreRecord | null) => Promise<ScoreRecord>): Promise<ScoreRecord> {
    for (let attempt = 0; ; attempt++) {
      const current = await this.repos.scores.get(accountId);
      const record = await next(current?.data ?? null);
      if (sameScore(current?.data ?? null, record)) return record;
      if (await this.repos.scores.saveIfMatch(record, current?.etag ?? null)) {
        this.onChange(); // the board's shared read is stale now (#185)
        return record;
      }
      if (attempt >= MAX_WRITE_RETRIES) throw new Error(`score summary for ${accountId}: too many concurrent updates`);
      await backoff(attempt);
    }
  }
}
