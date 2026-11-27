// Restore and expiry for soft-deleted data. Restores are additive: they never overwrite data that was
// created after the delete (a player who re-registered, or progress made after a reset).
// A deleted case keeps its records; its meta has status "trashed" and the trash entry remembers the status
// to put back. When the entry expires the case simply stays trashed (its records and chunks remain until
// a garbage collection exists).
import { TRASH_RETENTION_DAYS } from "../../shared/contract.ts";
import type { TrashEntry } from "../../shared/contract.ts";
import { composeCaseMeta } from "../../shared/case-records.ts";
import { AppError } from "../domain/types.ts";
import type { CaseRepository } from "../repositories/case-repository.ts";
import type { Repositories } from "../repositories/repositories.ts";
import type { TrashBundle, TrashRepository } from "../repositories/trash-repository.ts";
import { caseChangeTags, noopCachePurger } from "./CachePurger.ts";
import type { CachePurger } from "./CachePurger.ts";
import { sha256Hex } from "./crypto.ts";
import type { GlobalBoardService } from "./GlobalBoardService.ts";
import type { ScoreService } from "./ScoreService.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH_ID = /^[0-9TZ:.-]+:[0-9a-f]{8}$/;

export type TrashInput = Omit<TrashBundle, "deletedAt" | "caseId" | "caseStatus" | "memberships"> & Partial<Pick<TrashBundle, "caseId" | "caseStatus" | "memberships">>;

export class TrashService {
  private readonly trash: TrashRepository;
  private readonly repos: Repositories;
  private readonly cases: CaseRepository | null;
  private readonly scores: ScoreService | null;
  private readonly board: GlobalBoardService | null;
  private readonly now: () => Date;
  private readonly purger: CachePurger;

  constructor(deps: {
    trash: TrashRepository; repos: Repositories; cases?: CaseRepository; scores?: ScoreService; board?: GlobalBoardService; now: () => Date;
    /** a restored case is back in the CDN-cached catalog at once (#243) */
    purger?: CachePurger | undefined;
  }) {
    this.trash = deps.trash;
    this.repos = deps.repos;
    this.cases = deps.cases ?? null;
    this.scores = deps.scores ?? null;
    this.board = deps.board ?? null;
    this.now = deps.now;
    this.purger = deps.purger ?? noopCachePurger;
  }

  put(bundle: TrashInput): Promise<string> {
    return this.trash.put({ caseId: null, caseStatus: null, memberships: [], ...bundle, deletedAt: this.now().toISOString() });
  }

  /** Drops an entry without restoring it (a delete that did not go through). */
  discard(id: string): Promise<void> {
    return this.trash.delete(id);
  }

  expiresAt(deletedAt: string): string {
    return new Date(Date.parse(deletedAt) + TRASH_RETENTION_DAYS * DAY_MS).toISOString();
  }

  /** Live entries, newest first. Expired entries are purged as a side effect. */
  async list(): Promise<TrashEntry[]> {
    const nowMs = this.now().getTime();
    const out: TrashEntry[] = [];
    for (const { id, bundle } of await this.trash.list()) {
      const expiresMs = Date.parse(bundle.deletedAt) + TRASH_RETENTION_DAYS * DAY_MS;
      if (expiresMs <= nowMs) {
        await this.trash.delete(id);
        continue;
      }
      out.push({ id, kind: bundle.kind, label: bundle.label, deletedAt: bundle.deletedAt, expiresAt: new Date(expiresMs).toISOString(), records: bundle.progress.length });
    }
    return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  /** Ids of entries past the restore window (the hygiene job discards them). Read-only. */
  async expiredIds(): Promise<string[]> {
    const nowMs = this.now().getTime();
    return (await this.trash.list()).filter(({ bundle }) => Date.parse(bundle.deletedAt) + TRASH_RETENTION_DAYS * DAY_MS <= nowMs).map(({ id }) => id);
  }

  /** The newest live trash entry for a deleted case, or null. */
  async findCaseEntry(caseId: string): Promise<string | null> {
    const entries = await this.list();
    for (const entry of entries) {
      if (entry.kind !== "case") continue;
      const bundle = await this.trash.get(entry.id);
      if (bundle?.caseId === caseId) return entry.id;
    }
    return null;
  }

  async restore(id: string): Promise<{ restored: number; skipped: number; label: string }> {
    if (!TRASH_ID.test(id)) throw new AppError(400, "invalid trash id");
    const bundle = await this.trash.get(id);
    if (!bundle) throw new AppError(404, "nothing to restore (expired or already restored)");

    let restored = 0;
    let skipped = 0;
    if (bundle.kind === "case") {
      await this.restoreCase(bundle);
      restored += 1;
    }
    if (bundle.account) {
      const account = bundle.account;
      if (await this.repos.accounts.get(account.id)) throw new AppError(409, "that account exists again", { code: "conflict" });
      // Guests never hold a username (#176): restoring one must not claim its generated name.
      if (account.kind !== "guest" && !(await this.repos.usernames.claim(sha256Hex(account.usernameKey), account.id))) {
        throw new AppError(409, `the username ${account.username} was taken by someone else since`, { code: "conflict" });
      }
      await this.repos.accounts.saveIfMatch(account, null);
      restored += 1;
    }
    for (const record of bundle.progress) {
      if (await this.repos.progress.saveIfMatch(record, null)) restored += 1;
      else skipped += 1; // newer progress exists: keep it
      // The board's summary follows whatever progress is stored now (restored or newer).
      await this.scores?.syncCase(record.accountId, record.caseId);
    }
    if (bundle.account) {
      await this.board?.restoreMarker(bundle.account);
      // Class memberships come back in both indexes, for classes that still exist (#179).
      await this.repos.classes.restoreAccount(bundle.account.id, bundle.memberships);
    }
    for (const [key, value] of Object.entries(bundle.firstBlood)) {
      await this.trash.restoreKeyIfAbsent(key, value);
    }
    await this.trash.delete(id);
    return { restored, skipped, label: bundle.label };
  }

  /** Puts a trashed case back to the status it had (published or draft). 409 if it is not trashed any more. */
  private async restoreCase(bundle: TrashBundle): Promise<void> {
    if (!this.cases || bundle.caseId === null) throw new AppError(500, "case restore is not available");
    const current = await this.cases.getMeta(bundle.caseId);
    if (!current || current.data.status !== "trashed") throw new AppError(409, "that case is not deleted any more", { code: "conflict" });
    const meta = current.data;
    const status = bundle.caseStatus === "draft" || meta.publishedVersion === null ? "draft" : "published";
    const next = composeCaseMeta({ ...meta, status, updatedAt: this.now().toISOString() });
    if (!(await this.cases.saveMeta(next, current.etag))) throw new AppError(409, "the case changed meanwhile, please retry", { code: "conflict" });
    await this.purger.purge(caseChangeTags(bundle.caseId));
  }
}
