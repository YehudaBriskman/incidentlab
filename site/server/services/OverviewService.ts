// The owner overview (#235, GET /api/admin/overview): sign-ups per day, active players, classes, what waits on the
// owner, and the function-call budget. Admin only, no-store, fetched when the owner opens the Overview section (never
// on a timer).
//
// Reads (docs/DATA.md "Capacity budget"): every `account:` record (the same directory the Users section reads), every
// `class:` record, the case metas (the review queue), the open reset and author-access requests, the schedule's time
// zone, and the usage cache. No `progress:` record, no `classmember:` listing and no `score:` read: every number
// here comes from fields on those records (createdAt, kind, role, status, lastSeenAt, the class event window).
import { OVERVIEW_DAYS } from "../../shared/contract.ts";
import type { AdminOverview } from "../../shared/contract.ts";
import { isEventLive } from "../domain/event-run.ts";
import type { AccountRecord } from "../domain/types.ts";
import type { Repositories } from "../repositories/repositories.ts";
import type { AuthorAccessService } from "./AuthorAccessService.ts";
import type { CaseAuthoringService } from "./CaseAuthoringService.ts";
import type { PasswordResetService } from "./PasswordResetService.ts";
import { localDate } from "./ScheduleService.ts";
import type { UsageService } from "./UsageService.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The last `days` calendar dates in `timezone`, oldest first, ending today. */
export const recentDates = (now: Date, timezone: string, days: number): string[] => {
  const today = localDate(now, timezone);
  const out: string[] = [];
  // Step back in whole UTC days from today's date (dates, not instants, so DST never skips or repeats a day).
  const base = Date.parse(`${today}T12:00:00Z`);
  for (let i = days - 1; i >= 0; i--) out.push(new Date(base - i * DAY_MS).toISOString().slice(0, 10));
  return out;
};

/** Sign-ups per day (users and guests) over the given dates. Pure, for tests. */
export const signupsByDay = (accounts: readonly AccountRecord[], dates: readonly string[], timezone: string): AdminOverview["signups"] => {
  const rows = new Map(dates.map((date) => [date, { date, users: 0, guests: 0 }]));
  for (const a of accounts) {
    const row = rows.get(localDate(new Date(a.createdAt), timezone));
    if (row === undefined) continue;
    if (a.kind === "guest") row.guests += 1;
    else row.users += 1;
  }
  return dates.map((d) => rows.get(d) ?? { date: d, users: 0, guests: 0 });
};

export class OverviewService {
  private readonly repos: Repositories;
  private readonly authoring: Pick<CaseAuthoringService, "reviewQueue">;
  private readonly resets: Pick<PasswordResetService, "forOwner">;
  private readonly authorRequests: Pick<AuthorAccessService, "count">;
  private readonly usage: Pick<UsageService, "current">;
  private readonly now: () => Date;

  constructor(deps: {
    repos: Repositories;
    authoring: Pick<CaseAuthoringService, "reviewQueue">;
    resets: Pick<PasswordResetService, "forOwner">;
    authorRequests: Pick<AuthorAccessService, "count">;
    usage: Pick<UsageService, "current">;
    now: () => Date;
  }) {
    this.repos = deps.repos;
    this.authoring = deps.authoring;
    this.resets = deps.resets;
    this.authorRequests = deps.authorRequests;
    this.usage = deps.usage;
    this.now = deps.now;
  }

  async overview(): Promise<AdminOverview> {
    const now = this.now();
    const nowMs = now.getTime();
    const [accounts, classes, schedule, reviews, resets, authorRequests, usage] = await Promise.all([
      this.repos.accounts.list(),
      this.repos.classes.list(),
      this.repos.schedule.get(),
      this.authoring.reviewQueue(),
      this.resets.forOwner(),
      this.authorRequests.count(),
      this.usage.current(),
    ]);
    const timezone = schedule.timezone;
    const seenWithin = (a: AccountRecord, fromDays: number, toDays: number): boolean => {
      if (a.lastSeenAt === null) return false;
      const age = nowMs - Date.parse(a.lastSeenAt);
      return age >= fromDays * DAY_MS && age < toDays * DAY_MS;
    };
    const count = (pick: (a: AccountRecord) => boolean): number => accounts.reduce((n, a) => n + (pick(a) ? 1 : 0), 0);
    const active = classes.filter((c) => c.status === "active");
    return {
      generatedAt: now.toISOString(),
      timezone,
      signups: signupsByDay(accounts, recentDates(now, timezone, OVERVIEW_DAYS), timezone),
      accounts: {
        users: count((a) => a.kind === "user"),
        guests: count((a) => a.kind === "guest"),
        authors: count((a) => a.role === "author"),
        banned: count((a) => a.status === "rejected"),
        hidden: count((a) => a.hiddenFromBoards),
      },
      active: {
        d1: count((a) => seenWithin(a, 0, 1)),
        d7: count((a) => seenWithin(a, 0, 7)),
        d30: count((a) => seenWithin(a, 0, 30)),
      },
      classes: {
        active: active.length,
        archived: classes.length - active.length,
        liveEvents: active.filter((c) => isEventLive(c.event, now)).length,
      },
      queues: {
        reviews: reviews.length,
        resetRequests: resets.length,
        authorRequests,
        pendingSignups: count((a) => a.status === "pending"),
      },
      usage,
    };
  }
}
