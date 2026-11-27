// Per-account and per-case statistics, achievements and streaks, computed from progress records, and the
// global leaderboard, computed from the opted-in players' score summaries only (#175): the board and a
// player's rank never read another account's progress.
import { QUESTION_ORDER } from "../../shared/contract.ts";
import type { CaseStats, CaseSummary, LeaderboardResponse, QuestionId, Schedule, StageProgress, UserStats } from "../../shared/contract.ts";
import type { AccountRecord, ProgressRecord, Secrets } from "../domain/types.ts";
import { boardTotals } from "../domain/score.ts";
import type { BoardTotals, ScoreRecord } from "../domain/score.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import { localDate } from "./ScheduleService.ts";
import { parScore } from "./scoring.ts";

const average = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length);
const round1 = (value: number | null): number | null => (value === null ? null : Math.round(value * 10) / 10);
const DAY_MS = 24 * 60 * 60 * 1000;
const NO_HINT_STAGES_FOR_BADGE = 5;

type Achievement = UserStats["achievements"][number];

const stagesOf = (record: ProgressRecord): StageProgress[] => QUESTION_ORDER.map((q) => record.stages[q]).filter((s) => s !== undefined);
const earliest = (values: readonly (string | null | undefined)[]): string | null =>
  values.filter((v): v is string => typeof v === "string").sort()[0] ?? null;

/** Adds `days` to a YYYY-MM-DD date. */
const shiftDate = (isoDate: string, days: number): string => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Ranks by score descending; ties share a rank (1, 1, 3). */
const rankOf = (score: number, sortedScores: readonly number[]): number => sortedScores.indexOf(score) + 1;

/** Who may be listed on the public board: an approved, full (non-guest) account that opted in. */
export const isBoardEligible = (account: AccountRecord): boolean => account.status === "approved" && account.kind === "user" && account.showOnGlobalBoard;

type BoardPlayer = { readonly account: AccountRecord; readonly score: ScoreRecord };
type BoardRow = BoardTotals & { readonly accountId: string; readonly username: string };
type RankedRow = BoardRow & { readonly rank: number };

export class StatsService {
  private readonly repos: Repositories;
  private readonly secrets: Secrets;
  private readonly privateCaseIds: () => readonly string[];
  private readonly now: () => Date;

  constructor(deps: {
    repos: Repositories;
    secrets: Secrets;
    /** #184: private cases never count on the public global board */
    privateCaseIds?: () => readonly string[];
    now: () => Date;
  }) {
    this.repos = deps.repos;
    this.secrets = deps.secrets;
    this.privateCaseIds = deps.privateCaseIds ?? (() => []);
    this.now = deps.now;
  }

  private get caseIds(): string[] {
    return Object.keys(this.secrets.cases);
  }

  caseStats(caseId: string, record: ProgressRecord | null): CaseStats {
    const secrets = this.secrets.cases[caseId];
    const maxScore = secrets ? parScore(secrets) : 0;
    if (!record) {
      return {
        caseId, status: "not-started", score: 0, maxScore, solved: 0, revealed: 0, hintsUsed: 0, commandsRevealed: 0,
        wrongAttempts: 0, firstBloods: 0, startedAt: null, completedAt: null, durationSeconds: null,
      };
    }
    const stages = stagesOf(record);
    const end = record.completedAt ? Date.parse(record.completedAt) : this.now().getTime();
    return {
      caseId,
      status: record.completedAt ? "completed" : "in-progress",
      score: stages.reduce((s, st) => s + st.points, 0) + record.completionBonus,
      maxScore,
      solved: stages.filter((st) => st.status === "solved").length,
      revealed: stages.filter((st) => st.status === "revealed").length,
      hintsUsed: stages.reduce((s, st) => s + st.hintsRevealed, 0),
      commandsRevealed: stages.reduce((s, st) => s + st.commandsRevealed, 0),
      wrongAttempts: stages.reduce((s, st) => s + st.wrongAttempts, 0),
      firstBloods: stages.filter((st) => (st.breakdown?.firstBlood ?? 0) > 0).length,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      durationSeconds: record.setupDoneAt ? Math.max(0, Math.round((end - Date.parse(record.setupDoneAt)) / 1000)) : null,
    };
  }

  /**
   * Streak = consecutive "incident days" (scheduled dates, or every date while a default case is set)
   * on which the player completed that day's case on that very date (schedule time zone).
   * Returns the streak and when each length was first reached.
   */
  private streak(records: readonly ProgressRecord[], schedule: Schedule): { current: number; best: number; reachedAt: Map<number, string> } {
    const today = localDate(this.now(), schedule.timezone);
    const scheduledCase = (date: string): string | null => schedule.days[date] ?? schedule.defaultCaseId;
    const qualifying = new Map<string, string>(); // date -> completedAt
    for (const r of records) {
      if (!r.completedAt) continue;
      const date = localDate(new Date(r.completedAt), schedule.timezone);
      if (scheduledCase(date) === r.caseId) qualifying.set(date, r.completedAt);
    }
    if (qualifying.size === 0) return { current: 0, best: 0, reachedAt: new Map() };

    const firstDate = [...qualifying.keys(), ...Object.keys(schedule.days)].sort()[0] ?? today;
    const incidentDays: string[] = [];
    if (schedule.defaultCaseId !== null) {
      for (let d = firstDate; d <= today; d = shiftDate(d, 1)) incidentDays.push(d);
    } else {
      incidentDays.push(...Object.keys(schedule.days).filter((d) => d <= today).sort());
    }

    let run = 0;
    let best = 0;
    const reachedAt = new Map<number, string>();
    for (const day of incidentDays) {
      const doneAt = qualifying.get(day);
      if (doneAt) {
        run += 1;
        best = Math.max(best, run);
        if (!reachedAt.has(run)) reachedAt.set(run, doneAt);
      } else if (day !== today) {
        run = 0; // not having done today's incident yet doesn't break the streak
      }
    }
    return { current: run, best, reachedAt };
  }

  private achievements(records: readonly ProgressRecord[], streakReached: ReadonlyMap<number, string>): Achievement[] {
    const out: Achievement[] = [];
    const add = (id: string, earnedAt: string | null): void => {
      if (earnedAt) out.push({ id, earnedAt });
    };
    const allStages = records.flatMap(stagesOf);
    const completed = records.filter((r) => r.completedAt !== null);
    const isSpeedrun = (r: ProgressRecord): boolean => {
      const est = this.secrets.cases[r.caseId]?.estMinutes;
      return est !== undefined && r.setupDoneAt !== null && r.completedAt !== null && Date.parse(r.completedAt) - Date.parse(r.setupDoneAt) <= est * 60_000;
    };
    const isCleanCase = (r: ProgressRecord): boolean => stagesOf(r).every((s) => s.status === "solved" && s.hintsRevealed === 0 && s.commandsRevealed === 0);

    add("first-blood", earliest(allStages.filter((s) => (s.breakdown?.firstBlood ?? 0) > 0).map((s) => s.finishedAt)));
    add("clean-case", earliest(completed.filter(isCleanCase).map((r) => r.completedAt)));
    add("speedrun", earliest(completed.filter(isSpeedrun).map((r) => r.completedAt)));
    const noHintSolves = allStages
      .filter((s) => s.status === "solved" && s.hintsRevealed === 0)
      .map((s) => s.finishedAt)
      .filter((v): v is string => v !== null)
      .sort();
    add("no-hints-5", noHintSolves[NO_HINT_STAGES_FOR_BADGE - 1] ?? null);
    const doneIds = new Set(completed.map((r) => r.caseId));
    if (this.caseIds.length > 0 && this.caseIds.every((id) => doneIds.has(id))) {
      add("all-cases", completed.map((r) => r.completedAt).filter((v): v is string => v !== null).sort().at(-1) ?? null);
    }
    add("streak-3", streakReached.get(3) ?? null);
    add("streak-7", streakReached.get(7) ?? null);
    return out.sort((a, b) => a.earnedAt.localeCompare(b.earnedAt));
  }

  private userStats(account: AccountRecord, records: readonly ProgressRecord[], schedule: Schedule): Omit<UserStats, "rank" | "onGlobalBoard"> {
    const cases = this.caseIds.map((caseId) => this.caseStats(caseId, records.find((r) => r.caseId === caseId) ?? null));
    const sum = (pick: (c: CaseStats) => number): number => cases.reduce((s, c) => s + pick(c), 0);
    const solved = sum((c) => c.solved);
    const wrong = sum((c) => c.wrongAttempts);
    const streak = this.streak(records, schedule);
    return {
      accountId: account.id,
      username: account.username,
      status: account.status,
      role: account.role,
      createdAt: account.createdAt,
      lastSeenAt: account.lastSeenAt,
      totalScore: sum((c) => c.score),
      casesStarted: cases.filter((c) => c.status !== "not-started").length,
      casesCompleted: cases.filter((c) => c.status === "completed").length,
      stagesSolved: solved,
      stagesRevealed: sum((c) => c.revealed),
      hintsUsed: sum((c) => c.hintsUsed),
      commandsRevealed: sum((c) => c.commandsRevealed),
      wrongAttempts: wrong,
      accuracy: solved + wrong === 0 ? null : Math.round((solved / (solved + wrong)) * 1000) / 1000,
      achievements: this.achievements(records, streak.reachedAt),
      streak: { current: streak.current, best: streak.best },
      cases,
    };
  }

  /** Every account with stats and a rank among approved accounts (ties share a rank). Admin only: a full scan. */
  async allUsers(): Promise<UserStats[]> {
    const [accounts, progress, schedule] = await Promise.all([this.repos.accounts.list(), this.repos.progress.list(), this.repos.schedule.get()]);
    const byAccount = new Map<string, ProgressRecord[]>();
    for (const record of progress) byAccount.set(record.accountId, [...(byAccount.get(record.accountId) ?? []), record]);
    // Guests (#176) are listed for the instructor but never ranked: only approved user accounts compete.
    const rows = accounts.map((a) => ({ ...this.userStats(a, byAccount.get(a.id) ?? [], schedule), onGlobalBoard: isBoardEligible(a), ranked: a.status === "approved" && a.kind === "user" }));
    const scores = rows.filter((r) => r.ranked).map((r) => r.totalScore).sort((a, b) => b - a);
    return rows
      .map(({ ranked, ...r }): UserStats => ({ ...r, rank: ranked ? rankOf(r.totalScore, scores) : null }))
      .sort((a, b) => b.totalScore - a.totalScore || a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * One account's stats. The rank is the account's place on the live overall public board, read from the
   * opted-in players' summaries only (never every account or progress record); null when the account isn't
   * on the board (not opted in, a guest, not approved, or nothing solved yet).
   */
  async forAccount(account: AccountRecord): Promise<UserStats> {
    const [own, schedule] = await Promise.all([
      mapWithConcurrency(this.caseIds, (caseId) => this.repos.progress.get(caseId, account.id)),
      this.repos.schedule.get(),
    ]);
    const stats = this.userStats(account, own.filter((r) => r !== null).map((r) => r.data), schedule);
    const onGlobalBoard = isBoardEligible(account);
    if (!onGlobalBoard) return { ...stats, rank: null, onGlobalBoard };
    const board = this.rank(this.rows(await this.boardPlayers(), { caseId: null, cutoff: null }));
    return { ...stats, rank: board.find((row) => row.accountId === account.id)?.rank ?? null, onGlobalBoard };
  }

  /**
   * Public standings of the opted-in players, overall or for one case. With `frozenAt`, only what happened
   * before it counts: every solve in a summary keeps its time, so the frozen board needs no progress record.
   */
  async leaderboard(input: { caseId: string | null; frozenAt: string | null }): Promise<LeaderboardResponse> {
    const cutoff = input.frozenAt;
    const ranked = this.rank(this.rows(await this.boardPlayers(), { caseId: input.caseId, cutoff }));
    return {
      caseId: input.caseId,
      frozen: cutoff !== null,
      frozenAt: cutoff,
      generatedAt: this.now().toISOString(),
      entries: ranked.map((row) => ({
        rank: row.rank,
        username: row.username,
        score: row.score,
        stagesSolved: row.stagesSolved,
        casesCompleted: row.casesCompleted,
        firstBloods: row.firstBloods,
        lastSolveAt: row.lastSolveAt,
      })),
    };
  }

  /** The opted-in accounts: one key listing, then each one's account and summary (a small set by design). */
  private async boardPlayers(): Promise<BoardPlayer[]> {
    const ids = await this.repos.globalBoard.listAccountIds();
    const players = await mapWithConcurrency(ids, async (id): Promise<BoardPlayer | null> => {
      const [account, score] = await Promise.all([this.repos.accounts.get(id), this.repos.scores.get(id)]);
      return account && score && isBoardEligible(account.data) ? { account: account.data, score: score.data } : null;
    });
    return players.filter((p): p is BoardPlayer => p !== null);
  }

  private rows(players: readonly BoardPlayer[], filter: { caseId: string | null; cutoff: string | null }): BoardRow[] {
    const hidden = new Set(this.privateCaseIds());
    const publicOnly = (cases: BoardPlayer["score"]["cases"]): BoardPlayer["score"]["cases"] =>
      hidden.size === 0 ? cases : Object.fromEntries(Object.entries(cases).filter(([caseId]) => !hidden.has(caseId)));
    return players
      .map((p): BoardRow => ({ accountId: p.account.id, username: p.account.username, ...boardTotals(publicOnly(p.score.cases), filter) }))
      .filter((row) => row.stagesSolved > 0)
      // Same score: whoever got there first is listed first (the rank number is still shared).
      .sort((a, b) => b.score - a.score || (a.lastSolveAt ?? "").localeCompare(b.lastSolveAt ?? ""));
  }

  private rank(rows: readonly BoardRow[]): RankedRow[] {
    const scores = rows.map((r) => r.score);
    return rows.map((row) => ({ ...row, rank: rankOf(row.score, scores) }));
  }

  async caseSummaries(): Promise<CaseSummary[]> {
    const progress = await this.repos.progress.list();
    return this.caseIds.map((caseId) => {
      const secrets = this.secrets.cases[caseId];
      const records = progress.filter((r) => r.caseId === caseId);
      const stats = records.map((r) => this.caseStats(caseId, r));
      const done = stats.filter((s) => s.status === "completed");
      const questions = Object.fromEntries(
        QUESTION_ORDER.map((q): [QuestionId, CaseSummary["questions"][QuestionId]] => {
          const stages = records.map((r) => r.stages[q]).filter((s) => s !== undefined && s.status !== "locked");
          return [
            q,
            {
              solved: stages.filter((s) => s.status === "solved").length,
              revealed: stages.filter((s) => s.status === "revealed").length,
              avgWrong: round1(average(stages.map((s) => s.wrongAttempts))) ?? 0,
              avgHints: round1(average(stages.map((s) => s.hintsRevealed))) ?? 0,
            },
          ];
        }),
      ) as CaseSummary["questions"];
      return {
        caseId,
        title: secrets?.title ?? caseId,
        maxScore: secrets ? parScore(secrets) : 0,
        players: records.length,
        completed: done.length,
        avgScore: round1(average(done.map((s) => s.score))),
        avgDurationSeconds: round1(average(done.map((s) => s.durationSeconds).filter((d): d is number => d !== null))),
        questions,
      };
    });
  }
}
