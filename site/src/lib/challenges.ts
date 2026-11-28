// Personal and class challenges (#183) for home and My stats: where a class event stands, which classes home shows,
// the player's place on a class board and the closest locked achievement (a class's case of the day is classToday
// in lib/class-api.ts).
// DOM-free, with unit tests (challenges.test.ts).
import type { ClassEvent, ClassSummary, LeaderboardResponse, UserStats } from "../../shared/contract";

type LeaderboardEntry = LeaderboardResponse["entries"][number];

/** Home shows at most this many classes (one detail call each), then links to the full list. */
export const HOME_CLASS_LIMIT = 5;

export type ClassEventPhase =
  | { readonly kind: "none" }
  | { readonly kind: "before"; readonly msLeft: number }
  | { readonly kind: "live"; readonly msLeft: number | null }
  | { readonly kind: "over" };

/** Where a class event window stands at `now` (server clock). "none" when it has no window. */
export function classEventPhase(event: Pick<ClassEvent, "startsAt" | "endsAt"> | undefined, now: number): ClassEventPhase {
  if (event === undefined || (event.startsAt === null && event.endsAt === null)) return { kind: "none" };
  const start = event.startsAt === null ? null : Date.parse(event.startsAt);
  const end = event.endsAt === null ? null : Date.parse(event.endsAt);
  if (start !== null && now < start) return { kind: "before", msLeft: start - now };
  if (end !== null && now >= end) return { kind: "over" };
  return { kind: "live", msLeft: end === null ? null : end - now };
}

/** The class board is frozen: its freeze time has passed. */
export function isClassBoardFrozen(event: Pick<ClassEvent, "freezeAt"> | undefined, now: number): boolean {
  return event?.freezeAt != null && now >= Date.parse(event.freezeAt);
}

/** "YYYY-MM-DD" at `now` in the IANA zone `timezone`, or null for a zone the browser doesn't know. */
export function dateInZone(timezone: string, now: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
    const get = (type: string): string | undefined => parts.find((p) => p.type === type)?.value;
    const y = get("year");
    const m = get("month");
    const d = get("day");
    return y && m && d ? `${y}-${m}-${d}` : null;
  } catch {
    return null;
  }
}

/** The classes worth a line on home: not archived, and the caller is a member (the site admin has no membership). */
export function homeClasses(classes: readonly ClassSummary[], limit = HOME_CLASS_LIMIT): { shown: ClassSummary[]; more: number } {
  const mine = classes.filter((c) => c.status === "active" && c.membership !== null);
  // active memberships first, pending requests after; the server already sorts by name
  const ordered = [...mine.filter((c) => c.membership?.status === "active"), ...mine.filter((c) => c.membership?.status !== "active")];
  return { shown: ordered.slice(0, limit), more: Math.max(0, ordered.length - limit) };
}

/** A class detail call is worth making only for an active member: pending requests get the summary only. */
export const needsDetail = (c: ClassSummary): boolean => c.membership?.status === "active";

export type ClassRoleKind = "owner" | "admin" | "member" | "pending";
export function classRoleKind(c: ClassSummary): ClassRoleKind {
  const m = c.membership;
  if (m === null || m.status === "pending") return "pending";
  return m.isOwner ? "owner" : m.role;
}

/** The player's row on a class board, matched the way the server keys usernames. */
export function boardEntryFor(entries: readonly LeaderboardEntry[], username: string): LeaderboardEntry | null {
  const key = (u: string): string => u.trim().normalize("NFKC").toLowerCase();
  const mine = key(username);
  return entries.find((e) => key(e.username) === mine) ?? null;
}

export type NextAchievement =
  /** a locked achievement with measurable progress: `have` of `need` */
  | { readonly id: string; readonly have: number; readonly need: number }
  /** locked, but its progress can't be counted from the stats (first blood, clean case…) */
  | { readonly id: string; readonly have: null; readonly need: null };

/**
 * The closest locked achievement. Only progress the stats can count exactly is measured: the streaks (from the
 * current streak) and "all cases" (completed of released). Otherwise the first locked achievement, unmeasured.
 * Null when every achievement is earned.
 */
export function nextAchievement(stats: Pick<UserStats, "achievements" | "streak" | "cases" | "casesCompleted">, ids: readonly string[]): NextAchievement | null {
  const earned = new Set(stats.achievements.map((a) => a.id));
  const locked = ids.filter((id) => !earned.has(id));
  if (locked.length === 0) return null;
  const measured: { id: string; have: number; need: number }[] = [];
  const measure = (id: string, have: number, need: number): void => {
    if (locked.includes(id) && need > 0) measured.push({ id, have: Math.min(have, need), need });
  };
  measure("streak-3", stats.streak.current, 3);
  measure("streak-7", stats.streak.current, 7);
  measure("all-cases", stats.casesCompleted, stats.cases.length);
  measured.sort((a, b) => b.have / b.need - a.have / a.need || a.need - a.have - (b.need - b.have));
  const best = measured[0];
  if (best !== undefined) return best;
  const first = locked[0];
  return first === undefined ? null : { id: first, have: null, need: null };
}

/** A class event shown on a case page: the class's name and its event window. */
export type CaseClassEvent<E> = { readonly classId: string; readonly className: string; readonly event: E };

/** How far ahead an upcoming class event is worth a place in the case status line. */
export const CASE_EVENT_LOOKAHEAD_MS = 12 * 3_600_000;

/**
 * The class event that matters on this case page (#216): a live event first (the one that ends soonest), else
 * one starting within CASE_EVENT_LOOKAHEAD_MS. Only classes whose assigned cases include this case count (no
 * assigned cases = any public case). Null when there is none.
 */
export function pickClassEvent<E extends Pick<ClassEvent, "startsAt" | "endsAt">>(
  classes: readonly { readonly id: string; readonly name: string; readonly event?: E; readonly caseIds?: readonly string[] }[],
  caseId: string,
  now: number,
): CaseClassEvent<E> | null {
  let live: { item: CaseClassEvent<E>; left: number } | null = null;
  let soon: { item: CaseClassEvent<E>; left: number } | null = null;
  for (const c of classes) {
    if (c.event === undefined) continue;
    if (c.caseIds !== undefined && c.caseIds.length > 0 && !c.caseIds.includes(caseId)) continue;
    const phase = classEventPhase(c.event, now);
    const item = { classId: c.id, className: c.name, event: c.event };
    if (phase.kind === "live") {
      const left = phase.msLeft ?? Number.POSITIVE_INFINITY;
      if (live === null || left < live.left) live = { item, left };
    } else if (phase.kind === "before" && phase.msLeft <= CASE_EVENT_LOOKAHEAD_MS) {
      if (soon === null || phase.msLeft < soon.left) soon = { item, left: phase.msLeft };
    }
  }
  return live?.item ?? soon?.item ?? null;
}
