// Weekly hygiene (#177): keeps the store from growing forever. Run by the scheduled function `hygiene-weekly`
// and by `scripts/data.ts gc-accounts` (dry run unless --apply). One pass:
// - idle guests: guests not seen for GUEST_IDLE_DAYS go to the trash with their progress (a soft delete, so
//   they can be restored for TRASH_RETENTION_DAYS like any deleted account), then their records are removed,
//   with their `score:` summary (ScoreService.remove, the same path as an admin delete);
// - expired sessions: `session:` records past `expiresAt` (authenticate() already refuses them);
// - stale rate limits: `ratelimit:` windows whose newest hit is older than every rule's window;
// - old audit: `audit:` entries older than AUDIT_RETENTION_DAYS (the key starts with the timestamp);
// - expired trash: entries past the 7-day restore window (TrashService.list also drops them, but only when
//   someone opens Recently deleted);
// - expired password reset requests (#254): `resetrequest:` records past `expiresAt`, whatever their status.
// Dry run (apply false) only reads: it reports what a real run would remove.
import type { AccountRecord } from "../domain/types.ts";
import { AuditRepository } from "../repositories/config-repositories.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import type { KvStore } from "../repositories/KvStore.ts";
import { createRepositories } from "../repositories/repositories.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { TrashRepository } from "../repositories/trash-repository.ts";
import { ScoreService } from "./ScoreService.ts";
import { TrashService } from "./TrashService.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const GUEST_IDLE_DAYS = 30;
export const AUDIT_RETENTION_DAYS = 90;
/** At least as long as every RateLimitRule window (the longest is class-create, one day), so a swept window can't still count. */
export const RATE_LIMIT_STALE_MS = DAY_MS;

export type HygieneReport = {
  readonly applied: boolean;
  /** usernames of the idle guests trashed (or that would be) */
  readonly idleGuests: readonly string[];
  readonly guestProgress: number;
  readonly expiredSessions: number;
  readonly staleRateLimits: number;
  readonly oldAudit: number;
  readonly expiredTrash: number;
  readonly expiredResetRequests: number;
  /** event-run records (#253) of event occurrences that started more than 180 days ago (#268) */
  readonly oldEventRuns: number;
};

/** Event-run records older than this are deleted by the weekly sweep (#268). */
const OLD_EVENT_RUN_DAYS = 180;

const AUDIT_KEY_TIME = /^audit:(\d{4}-\d{2}-\d{2}T[0-9:.]+Z):/;

export class AccountHygieneService {
  private readonly repos: Repositories;
  private readonly audit: AuditRepository;
  private readonly trash: TrashService;
  private readonly scores: ScoreService;
  private readonly now: () => Date;

  constructor(deps: { repos: Repositories; audit: AuditRepository; trash: TrashService; scores: ScoreService; now: () => Date }) {
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.trash = deps.trash;
    this.scores = deps.scores;
    this.now = deps.now;
  }

  async run(options: { apply: boolean }): Promise<HygieneReport> {
    const apply = options.apply;
    const nowMs = this.now().getTime();
    const guests = await this.idleGuests(nowMs);
    const guestProgress = await this.sweepGuests(guests, apply);
    const expiredSessions = await this.sweepSessions(nowMs, apply);
    const staleRateLimits = await this.sweepRateLimits(nowMs, apply);
    const oldAudit = await this.sweepAudit(nowMs, apply);
    const expiredTrash = await this.sweepTrash(apply);
    const expiredResetRequests = await this.sweepResetRequests(nowMs, apply);
    const oldEventRuns = await this.sweepOldEventRuns(nowMs, apply);
    return { applied: apply, idleGuests: guests.map((g) => g.username), guestProgress, expiredSessions, staleRateLimits, oldAudit, expiredTrash, expiredResetRequests, oldEventRuns };
  }

  /**
   * Event-run records whose run started more than 180 days ago (#268). They only ever counted on the class board of
   * that one event occurrence, long over by then, so they are deleted (not trashed).
   */
  private async sweepOldEventRuns(nowMs: number, apply: boolean): Promise<number> {
    const cutoff = nowMs - OLD_EVENT_RUN_DAYS * DAY_MS;
    const old = (await this.repos.eventProgress.listMatching({})).filter((e) => {
      const started = Date.parse(e.record.startedAt ?? "");
      return Number.isFinite(started) && started <= cutoff;
    });
    if (apply) await this.repos.eventProgress.deleteEntries(old);
    return old.length;
  }

  private async idleGuests(nowMs: number): Promise<AccountRecord[]> {
    const cutoff = nowMs - GUEST_IDLE_DAYS * DAY_MS;
    return (await this.repos.accounts.list()).filter((a) => {
      if (a.kind !== "guest") return false;
      const seen = Date.parse(a.lastSeenAt ?? a.createdAt);
      return Number.isFinite(seen) && seen <= cutoff;
    });
  }

  /** Same order as an admin delete: trash first, then progress, then the account (its sessions die with it). */
  private async sweepGuests(guests: readonly AccountRecord[], apply: boolean): Promise<number> {
    if (guests.length === 0) return 0;
    const progress = await this.repos.progress.listForAccounts(new Set(guests.map((g) => g.id)));
    if (!apply) return progress.length;
    for (const guest of guests) {
      const own = progress.filter((p) => p.accountId === guest.id);
      // Guests can't join classes, but the delete stays the same as an admin delete: memberships go to the trash too.
      const memberships = await this.repos.classes.membershipsOf(guest.id);
      await this.trash.put({ kind: "account", label: `idle guest ${guest.username}`, account: guest, progress: own, firstBlood: {}, memberships });
      await this.repos.progress.deleteMany({ accountId: guest.id });
      await this.repos.classes.removeAccount(guest.id);
      await this.scores.remove(guest.id); // its score summary (and any stray board marker) go too; a restore re-derives them
      await this.repos.accounts.delete(guest.id);
    }
    return progress.length;
  }

  private async sweepSessions(nowMs: number, apply: boolean): Promise<number> {
    const hashes = await this.repos.sessions.listHashes();
    const expired = await mapWithConcurrency(hashes, async (hash) => {
      const session = await this.repos.sessions.get(hash);
      return session !== null && Date.parse(session.expiresAt) <= nowMs ? hash : null;
    });
    const doomed = expired.filter((h): h is string => h !== null);
    if (apply) await mapWithConcurrency(doomed, (hash) => this.repos.sessions.delete(hash));
    return doomed.length;
  }

  private async sweepRateLimits(nowMs: number, apply: boolean): Promise<number> {
    const keys = await this.repos.rateLimits.listKeys();
    const stale = await mapWithConcurrency(keys, async (key) => {
      const newest = Math.max(0, ...(await this.repos.rateLimits.getHits(key)));
      return nowMs - newest >= RATE_LIMIT_STALE_MS ? key : null;
    });
    const doomed = stale.filter((k): k is string => k !== null);
    if (apply) await mapWithConcurrency(doomed, (key) => this.repos.rateLimits.delete(key));
    return doomed.length;
  }

  private async sweepAudit(nowMs: number, apply: boolean): Promise<number> {
    const cutoff = nowMs - AUDIT_RETENTION_DAYS * DAY_MS;
    const doomed = (await this.audit.listKeys()).filter((key) => {
      const at = Date.parse(AUDIT_KEY_TIME.exec(key)?.[1] ?? "");
      return Number.isFinite(at) && at < cutoff;
    });
    if (apply) await mapWithConcurrency(doomed, (key) => this.audit.delete(key));
    return doomed.length;
  }

  /** Entries past the restore window can't be restored any more (TrashService.list drops them too). */
  private async sweepTrash(apply: boolean): Promise<number> {
    const expired = await this.trash.expiredIds();
    if (apply) for (const id of expired) await this.trash.discard(id);
    return expired.length;
  }

  /** Reset requests (#254) past their expiry can't be vouched for or approved any more. */
  private async sweepResetRequests(nowMs: number, apply: boolean): Promise<number> {
    const doomed = (await this.repos.resetRequests.list()).filter((r) => Date.parse(r.expiresAt) <= nowMs).map((r) => r.accountId);
    if (apply) await mapWithConcurrency(doomed, (id) => this.repos.resetRequests.delete(id));
    return doomed.length;
  }
}

/** The service over one store (the scheduled function and the CLI both build it this way). */
export const createAccountHygiene = (kv: KvStore, now: () => Date): AccountHygieneService => {
  const repos = createRepositories(kv);
  // Only `remove` is used here, which needs no case list (rebuilds happen on the request path).
  const scores = new ScoreService({ repos, caseIds: () => [] });
  return new AccountHygieneService({ repos, audit: new AuditRepository(kv), trash: new TrashService({ trash: new TrashRepository(kv), repos, scores, now }), scores, now });
};
