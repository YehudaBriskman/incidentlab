// Per-account and per-case statistics, achievements and streaks, computed from progress records, and the
// global leaderboard, computed from the opted-in players' score summaries only (#175): the board and a
// player's rank never read another account's progress.
import { ADMIN_USERS_PAGE, QUESTION_ORDER } from "../../shared/contract.ts";
import type {
  AdminUsersQuery,
  AdminUsersResponse,
  CaseStats,
  CaseSummary,
  LeaderboardResponse,
  QuestionId,
  Schedule,
  StageProgress,
  UserStats,
} from "../../shared/contract.ts";
import type { AccountRecord, ProgressRecord, Secrets } from "../domain/types.ts";
import { boardTotals } from "../domain/score.ts";
import type { BoardTotals, ScoreRecord } from "../domain/score.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import { localDate } from "./ScheduleService.ts";
import { parScore } from "./scoring.ts";
import { BoardCache } from "./BoardCache.ts";

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

/**
 * Who may be listed on the public board: an approved, full (non-guest) account that opted in and that the owner
 * has not hidden from the boards (#236).
 */
export const isBoardEligible = (account: AccountRecord): boolean =>
  account.status === "approved" && account.kind === "user" && account.showOnGlobalBoard && !account.hiddenFromBoards;

export type BoardPlayer = { readonly account: AccountRecord; readonly score: ScoreRecord };

/**
 * Every account with its score total (from the `score:` summaries), for the console's users list (#185). One
 * listing and one read per account and per summary; no progress record is read. Admin only, fetched on demand.
 */
export type AccountDirectory = {
  readonly accounts: readonly AccountRecord[];
  /** score totals by account id (0 when the account has no summary yet) */
  readonly totals: ReadonlyMap<string, number>;
};

/** Ranked on the console: approved full accounts. Guests and banned or pending accounts get no rank. */
const isRanked = (a: AccountRecord): boolean => a.status === "approved" && a.kind === "user";
type BoardRow = BoardTotals & { readonly accountId: string; readonly username: string };
type RankedRow = BoardRow & { readonly rank: number };

export class StatsService {
  private readonly repos: Repositories;
  private readonly secrets: Secrets;
  private readonly privateCaseIds: () => readonly string[];
  private readonly now: () => Date;
  private readonly boardCache: BoardCache<BoardPlayer[]>;

  constructor(deps: {
    repos: Repositories;
    secrets: Secrets;
    /** #184: private cases never count on the public global board */
    privateCaseIds?: () => readonly string[];
    now: () => Date;
    /** #185: the opted-in players, shared for a few seconds; the board's writers clear it */
    boardCache?: BoardCache<BoardPlayer[]>;
  }) {
    this.repos = deps.repos;
    this.secrets = deps.secrets;
    this.privateCaseIds = deps.privateCaseIds ?? (() => []);
    this.now = deps.now;
    this.boardCache = deps.boardCache ?? new BoardCache<BoardPlayer[]>(() => deps.now().getTime());
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
   * Streak = consecutive calendar days (schedule time zone) on which the player solved at least one stage of any
   * case (#212). Not having played yet today doesn't break it. The old rule (finish that day's scheduled case on
   * that day) could never pass 5 with 5 cases, since each case completes only once.
   * Returns the streak, whether today already counts, and when each length was first reached.
   */
  private streak(records: readonly ProgressRecord[], schedule: Schedule): { current: number; best: number; activeToday: boolean; reachedAt: Map<number, string> } {
    const today = localDate(this.now(), schedule.timezone);
    const active = new Map<string, string>(); // date -> first solve that day
    for (const r of records) {
      for (const st of stagesOf(r)) {
        if (st.status !== "solved" || st.finishedAt === null) continue;
        const date = localDate(new Date(st.finishedAt), schedule.timezone);
        const seen = active.get(date);
        if (seen === undefined || st.finishedAt < seen) active.set(date, st.finishedAt);
      }
    }
    if (active.size === 0) return { current: 0, best: 0, activeToday: false, reachedAt: new Map() };

    let run = 0;
    let best = 0;
    const reachedAt = new Map<number, string>();
    const firstDate = [...active.keys()].sort()[0] ?? today;
    for (let day = firstDate; day <= today; day = shiftDate(day, 1)) {
      const at = active.get(day);
      if (at !== undefined) {
        run += 1;
        best = Math.max(best, run);
        if (!reachedAt.has(run)) reachedAt.set(run, at);
      } else if (day !== today) {
        run = 0;
      }
    }
    return { current: run, best, activeToday: active.has(today), reachedAt };
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
      kind: account.kind,
      classLimit: account.classLimit,
      hiddenFromBoards: account.hiddenFromBoards,
      banReason: account.status === "rejected" ? account.banReason : null,
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
      streak: { current: streak.current, best: streak.best, activeToday: streak.activeToday },
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

  /** The console's account directory (#185): every account and its summary total, no progress. */
  async directory(): Promise<AccountDirectory> {
    const accounts = await this.repos.accounts.list();
    const scores = await mapWithConcurrency(accounts, async (a) => [a.id, (await this.repos.scores.get(a.id))?.data.total ?? 0] as const);
    return { accounts, totals: new Map(scores) };
  }

  /**
   * One page of the console's users list (#185): filtered and sorted over the directory, then full stats for
   * the page and the pending sign-ups only (their progress through one key listing, never every record).
   */
  async userPage(directory: AccountDirectory, query: AdminUsersQuery): Promise<AdminUsersResponse> {
    const { accounts, totals } = directory;
    const total = (a: AccountRecord): number => totals.get(a.id) ?? 0;
    const rankedScores = accounts.filter(isRanked).map(total).sort((a, b) => b - a);
    const rankOfAccount = (a: AccountRecord): number | null => (isRanked(a) ? rankOf(total(a), rankedScores) : null);
    const nowMs = this.now().getTime();
    const seenMs = (a: AccountRecord): number => (a.lastSeenAt === null ? 0 : Date.parse(a.lastSeenAt));

    const q = query.q.toLowerCase();
    const matching = accounts.filter(
      (a) =>
        (q === "" || a.username.toLowerCase().includes(q)) &&
        (query.kind === null || a.kind === query.kind) &&
        (query.role === null || a.role === query.role) &&
        (query.status === null || a.status === query.status),
    );
    const byName = (a: AccountRecord, b: AccountRecord): number => a.username.localeCompare(b.username);
    const sorted = [...matching].sort((a, b) => {
      switch (query.sort) {
        case "rank":
          return (rankOfAccount(a) ?? Number.MAX_SAFE_INTEGER) - (rankOfAccount(b) ?? Number.MAX_SAFE_INTEGER) || total(b) - total(a) || byName(a, b);
        case "newest":
          return b.createdAt.localeCompare(a.createdAt) || byName(a, b);
        case "seen":
          return seenMs(b) - seenMs(a) || byName(a, b);
        case "name":
          return byName(a, b);
      }
    });
    const page = sorted.slice(query.offset, query.offset + query.limit);
    const pending = accounts
      .filter((a) => a.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, ADMIN_USERS_PAGE.PENDING_LIMIT);

    const ids = new Set([...page, ...pending].map((a) => a.id));
    const [progress, schedule] = await Promise.all([ids.size === 0 ? Promise.resolve([]) : this.repos.progress.listForAccounts(ids), this.repos.schedule.get()]);
    const byAccount = new Map<string, ProgressRecord[]>();
    for (const record of progress) byAccount.set(record.accountId, [...(byAccount.get(record.accountId) ?? []), record]);
    const view = (a: AccountRecord): UserStats => ({
      ...this.userStats(a, byAccount.get(a.id) ?? [], schedule),
      rank: rankOfAccount(a),
      onGlobalBoard: isBoardEligible(a),
    });
    const count = (pick: (a: AccountRecord) => boolean): number => accounts.reduce((n, a) => n + (pick(a) ? 1 : 0), 0);
    return {
      generatedAt: this.now().toISOString(),
      total: accounts.length,
      matched: matching.length,
      offset: query.offset,
      limit: query.limit,
      counts: {
        users: count((a) => a.kind === "user"),
        guests: count((a) => a.kind === "guest"),
        authors: count((a) => a.role === "author"),
        pending: count((a) => a.status === "pending"),
        approved: count((a) => a.status === "approved"),
        rejected: count((a) => a.status === "rejected"),
        active24h: count((a) => a.lastSeenAt !== null && nowMs - seenMs(a) < DAY_MS),
      },
      accounts: page.map(view),
      pending: pending.map(view),
    };
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
    // The others from the shared board read (#185); the player's own row from their current summary, so their
    // latest solve counts in their rank even when the shared read is a few seconds old.
    const [players, ownScore] = await Promise.all([this.boardPlayers(), this.repos.scores.get(account.id)]);
    const others = players.filter((p) => p.account.id !== account.id);
    const withOwn = ownScore === null ? others : [...others, { account, score: ownScore.data }];
    const board = this.rank(this.rows(withOwn, { caseId: null, cutoff: null }));
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

  /** The opted-in accounts (shared for a few seconds, see BoardCache). */
  private boardPlayers(): Promise<BoardPlayer[]> {
    return this.boardCache.get(() => this.readBoardPlayers());
  }

  /** The opted-in accounts: one key listing, then each one's account and summary. */
  private async readBoardPlayers(): Promise<BoardPlayer[]> {
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
