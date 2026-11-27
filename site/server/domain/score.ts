// Per-account score summaries (#175): `score:<accountId>` holds the leaderboard totals plus every solve with
// its time, so the public board (overall, per case and frozen) is computed from these small records alone,
// without reading any progress record. Everything here is pure: the summary is always derived from the
// account's progress records, so writing it again is idempotent.
import { z } from "zod";
import { QUESTION_ORDER, QuestionIdSchema } from "../../shared/contract.ts";
import type { ProgressRecord } from "./types.ts";

export const SCORE_SCHEMA_VERSION = 1;

/** One solved stage: its points and when it was solved (the freeze cuts off on `at`). */
export const ScoreSolveSchema = z.object({
  q: QuestionIdSchema,
  points: z.number().int().min(0),
  at: z.string().nullable(),
  firstBlood: z.boolean(),
});
export type ScoreSolve = z.infer<typeof ScoreSolveSchema>;

/** What one case adds to the board: its solves, and the completion bonus once the case is done. */
export const ScoreCaseSchema = z.object({
  solves: z.array(ScoreSolveSchema).default([]),
  completedAt: z.string().nullable().default(null),
  completionBonus: z.number().int().min(0).default(0),
});
export type ScoreCase = z.infer<typeof ScoreCaseSchema>;

export const ScoreRecordSchema = z.object({
  schemaVersion: z.number().int().min(1).default(SCORE_SCHEMA_VERSION),
  accountId: z.string(),
  /** stage points + completion bonuses, the same total the leaderboard has always shown */
  total: z.number().int().min(0),
  stagesSolved: z.number().int().min(0),
  casesCompleted: z.number().int().min(0),
  firstBloods: z.number().int().min(0),
  lastSolveAt: z.string().nullable(),
  /** caseId -> what that case contributes; cases with no solve and no completion are left out */
  cases: z.record(z.string(), ScoreCaseSchema).default({}),
});
export type ScoreRecord = z.infer<typeof ScoreRecordSchema>;

/** The board columns for one account. */
export type BoardTotals = Pick<ScoreRecord, "stagesSolved" | "casesCompleted" | "firstBloods" | "lastSolveAt"> & { readonly score: number };

/** A case's contribution, from its progress record; null when it adds nothing to the board. */
export const scoreCaseOf = (record: ProgressRecord): ScoreCase | null => {
  const solves: ScoreSolve[] = [];
  for (const q of QUESTION_ORDER) {
    const stage = record.stages[q];
    if (stage === undefined || stage.status !== "solved") continue;
    solves.push({ q, points: stage.points, at: stage.finishedAt, firstBlood: (stage.breakdown?.firstBlood ?? 0) > 0 });
  }
  if (solves.length === 0 && record.completedAt === null) return null;
  return { solves, completedAt: record.completedAt, completionBonus: record.completedAt === null ? 0 : record.completionBonus };
};

/**
 * Board totals over the summary's cases, optionally for one case and only for what happened by `cutoff`
 * (the event freeze). Same rules the progress-based board used: solved stages count by their finish time,
 * a completion bonus by the case's completion time.
 */
export const boardTotals = (cases: Readonly<Record<string, ScoreCase>>, filter: { caseId: string | null; cutoff: string | null }): BoardTotals => {
  const counts = (at: string | null): boolean => filter.cutoff === null || (at !== null && at <= filter.cutoff);
  let score = 0;
  let stagesSolved = 0;
  let casesCompleted = 0;
  let firstBloods = 0;
  let lastSolveAt: string | null = null;
  for (const [caseId, entry] of Object.entries(cases)) {
    if (filter.caseId !== null && caseId !== filter.caseId) continue;
    for (const solve of entry.solves) {
      if (!counts(solve.at)) continue;
      score += solve.points;
      stagesSolved += 1;
      if (solve.firstBlood) firstBloods += 1;
      if (solve.at !== null && (lastSolveAt === null || solve.at > lastSolveAt)) lastSolveAt = solve.at;
    }
    if (entry.completedAt !== null && counts(entry.completedAt)) {
      score += entry.completionBonus;
      casesCompleted += 1;
    }
  }
  return { score, stagesSolved, casesCompleted, firstBloods, lastSolveAt };
};

/** The full summary record for an account from its per-case contributions. */
export const summarize = (accountId: string, cases: Readonly<Record<string, ScoreCase>>): ScoreRecord => {
  const sorted = Object.fromEntries(Object.entries(cases).sort(([a], [b]) => a.localeCompare(b)));
  const totals = boardTotals(sorted, { caseId: null, cutoff: null });
  return {
    schemaVersion: SCORE_SCHEMA_VERSION,
    accountId,
    total: totals.score,
    stagesSolved: totals.stagesSolved,
    casesCompleted: totals.casesCompleted,
    firstBloods: totals.firstBloods,
    lastSolveAt: totals.lastSolveAt,
    cases: sorted,
  };
};

/** The summary of an account from all of its progress records (the migration backfill and a full rebuild). */
export const summarizeProgress = (accountId: string, records: readonly ProgressRecord[]): ScoreRecord => {
  const cases: Record<string, ScoreCase> = {};
  for (const record of records) {
    if (record.accountId !== accountId) continue;
    const entry = scoreCaseOf(record);
    if (entry !== null) cases[record.caseId] = entry;
  }
  return summarize(accountId, cases);
};

/** True when two summaries hold the same data (so an unchanged summary is never rewritten). */
export const sameScore = (a: ScoreRecord | null, b: ScoreRecord): boolean => a !== null && JSON.stringify(summarize(a.accountId, a.cases)) === JSON.stringify(b);
