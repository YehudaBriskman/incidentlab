// Class scoring windows (#180): what counts on a class's board. Gameplay never blocks on a class; a class's case
// list, event window and freeze only decide which of its members' solves count on that class's board. Pure
// functions over the members' `score:` summaries (domain/score.ts), so the board needs no progress record and no
// new keys: every solve already carries its time.
//
// The rules, for a solve (or a completion bonus) of case C at moment T:
// 1. Case: C is in `class.caseIds`, or `caseIds` is empty and C is a public (published) case.
// 2. Window: when the class event has both `startsAt` and `endsAt`, startsAt <= T < endsAt (the end is exclusive).
// 3. Freeze: once now >= `freezeAt`, only T <= freezeAt counts (the frozen board).
// A moment that is unknown (a solve from before solve times were kept) counts only when no time rule applies.
// The completion bonus counts by the case's `completedAt` with the same rules.
//
// First solver: per case and question, the member with the earliest counted solve is the class's first solver.
// The class board gives the first-blood bonus to that member instead of to whoever was first on the whole site:
// a counted solve's points lose the site-wide bonus it may carry and gain the class bonus if it was the class's
// first. No new key stores this; it is re-derived from the members' solve times on every board read.
import { SCORING } from "../../shared/contract.ts";
import type { BoardTotals, ScoreCase } from "./score.ts";

/** The parts of a class record the rules read. */
export type ClassWindowSource = {
  readonly caseIds: readonly string[];
  readonly event: { readonly startsAt: string | null; readonly endsAt: string | null; readonly freezeAt: string | null };
};

export type ClassWindow = {
  /** assigned cases; empty = any public case */
  readonly caseIds: readonly string[];
  /** the published cases, for an empty `caseIds` */
  readonly publicCaseIds: readonly string[];
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  /** `freezeAt` once it has been reached, else null (the board is live) */
  readonly cutoff: string | null;
};

/** The class's window at `now`. */
export const classWindow = (source: ClassWindowSource, input: { now: Date; publicCaseIds: readonly string[] }): ClassWindow => {
  const { startsAt, endsAt, freezeAt } = source.event;
  const isFrozen = freezeAt !== null && input.now.getTime() >= Date.parse(freezeAt);
  return { caseIds: source.caseIds, publicCaseIds: input.publicCaseIds, startsAt, endsAt, cutoff: isFrozen ? freezeAt : null };
};

/** Rule 1: the case counts for this class. */
export const caseCounts = (caseId: string, window: ClassWindow): boolean =>
  window.caseIds.length === 0 ? window.publicCaseIds.includes(caseId) : window.caseIds.includes(caseId);

/** Rules 2 and 3: the moment counts for this class. */
export const momentCounts = (at: string | null, window: ClassWindow): boolean => {
  const hasWindow = window.startsAt !== null && window.endsAt !== null;
  if (at === null) return !hasWindow && window.cutoff === null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return false;
  if (hasWindow && (t < Date.parse(window.startsAt ?? "") || t >= Date.parse(window.endsAt ?? ""))) return false;
  if (window.cutoff !== null && t > Date.parse(window.cutoff)) return false;
  return true;
};

/** One member as the board sees them: the username and the score summary's cases. */
export type ClassBoardMember = {
  readonly accountId: string;
  readonly username: string;
  readonly cases: Readonly<Record<string, ScoreCase>>;
};

export type ClassBoardRow = BoardTotals & { readonly accountId: string; readonly username: string; readonly rank: number };

/**
 * The class's first solver of every case and question, among the counted solves: `"<caseId>:<q>" -> accountId`.
 * Ties on the same moment go to the lower account id, so the answer never depends on the listing order.
 */
export const classFirstSolvers = (members: readonly ClassBoardMember[], window: ClassWindow): ReadonlyMap<string, string> => {
  const best = new Map<string, { accountId: string; t: number }>();
  for (const member of members) {
    for (const [caseId, entry] of Object.entries(member.cases)) {
      if (!caseCounts(caseId, window)) continue;
      for (const solve of entry.solves) {
        if (solve.at === null || !momentCounts(solve.at, window)) continue;
        const key = `${caseId}:${solve.q}`;
        const t = Date.parse(solve.at);
        const current = best.get(key);
        if (current === undefined || t < current.t || (t === current.t && member.accountId < current.accountId)) best.set(key, { accountId: member.accountId, t });
      }
    }
  }
  return new Map([...best].map(([key, { accountId }]) => [key, accountId]));
};

/** One member's board totals for this class, optionally for one case. */
export const classTotals = (
  member: ClassBoardMember,
  window: ClassWindow,
  input: { caseId: string | null; firstSolvers: ReadonlyMap<string, string> },
): BoardTotals => {
  let score = 0;
  let stagesSolved = 0;
  let casesCompleted = 0;
  let firstBloods = 0;
  let lastSolveAt: string | null = null;
  for (const [caseId, entry] of Object.entries(member.cases)) {
    if (input.caseId !== null && caseId !== input.caseId) continue;
    if (!caseCounts(caseId, window)) continue;
    for (const solve of entry.solves) {
      if (!momentCounts(solve.at, window)) continue;
      const isClassFirst = input.firstSolvers.get(`${caseId}:${solve.q}`) === member.accountId;
      const siteBonus = solve.firstBlood ? SCORING.FIRST_BLOOD_BONUS : 0;
      score += Math.max(0, solve.points - siteBonus) + (isClassFirst ? SCORING.FIRST_BLOOD_BONUS : 0);
      stagesSolved += 1;
      if (isClassFirst) firstBloods += 1;
      if (solve.at !== null && (lastSolveAt === null || solve.at > lastSolveAt)) lastSolveAt = solve.at;
    }
    if (entry.completedAt !== null && momentCounts(entry.completedAt, window)) {
      score += entry.completionBonus;
      casesCompleted += 1;
    }
  }
  return { score, stagesSolved, casesCompleted, firstBloods, lastSolveAt };
};

/**
 * The ranked class board: members with at least one counted solve, by score (ties: whoever got there first is
 * listed first, and tied scores share a rank, like the global board).
 */
export const classBoardRows = (members: readonly ClassBoardMember[], window: ClassWindow, input: { caseId: string | null }): ClassBoardRow[] => {
  const firstSolvers = classFirstSolvers(members, window);
  const rows = members
    .map((m) => ({ accountId: m.accountId, username: m.username, ...classTotals(m, window, { caseId: input.caseId, firstSolvers }) }))
    .filter((row) => row.stagesSolved > 0)
    .sort((a, b) => b.score - a.score || (a.lastSolveAt ?? "").localeCompare(b.lastSolveAt ?? "") || a.username.localeCompare(b.username));
  const scores = rows.map((r) => r.score);
  return rows.map((row) => ({ ...row, rank: scores.indexOf(row.score) + 1 }));
};
