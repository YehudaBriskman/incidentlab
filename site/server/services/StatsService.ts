// Per-account and per-case statistics, computed from progress records (no extra writes on the hot path).
import { QUESTION_ORDER } from "../../shared/contract.ts";
import type { CaseStats, CaseSummary, QuestionId, UserStats } from "../../shared/contract.ts";
import type { AccountRecord, ProgressRecord, Secrets } from "../domain/types.ts";
import type { Repositories } from "../repositories/repositories.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import { maxScoreOf } from "./GameService.ts";

const average = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length);
const round1 = (value: number | null): number | null => (value === null ? null : Math.round(value * 10) / 10);

export class StatsService {
  private readonly repos: Repositories;
  private readonly secrets: Secrets;
  private readonly now: () => Date;

  constructor(deps: { repos: Repositories; secrets: Secrets; now: () => Date }) {
    this.repos = deps.repos;
    this.secrets = deps.secrets;
    this.now = deps.now;
  }

  private get caseIds(): string[] {
    return Object.keys(this.secrets.cases);
  }

  caseStats(caseId: string, record: ProgressRecord | null): CaseStats {
    const secrets = this.secrets.cases[caseId];
    const maxScore = secrets ? maxScoreOf(secrets) : 0;
    if (!record) {
      return { caseId, status: "not-started", score: 0, maxScore, solved: 0, revealed: 0, hintsUsed: 0, wrongAttempts: 0, startedAt: null, completedAt: null, durationSeconds: null };
    }
    const stages = QUESTION_ORDER.map((q) => record.stages[q]).filter((s) => s !== undefined);
    const end = record.completedAt ? Date.parse(record.completedAt) : this.now().getTime();
    return {
      caseId,
      status: record.completedAt ? "completed" : "in-progress",
      score: stages.reduce((s, st) => s + st.points, 0),
      maxScore,
      solved: stages.filter((st) => st.status === "solved").length,
      revealed: stages.filter((st) => st.status === "revealed").length,
      hintsUsed: stages.reduce((s, st) => s + st.hintsRevealed, 0),
      wrongAttempts: stages.reduce((s, st) => s + st.wrongAttempts, 0),
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      durationSeconds: record.setupDoneAt ? Math.max(0, Math.round((end - Date.parse(record.setupDoneAt)) / 1000)) : null,
    };
  }

  private userStats(account: AccountRecord, records: readonly ProgressRecord[]): Omit<UserStats, "rank"> {
    const cases = this.caseIds.map((caseId) => this.caseStats(caseId, records.find((r) => r.caseId === caseId) ?? null));
    const sum = (pick: (c: CaseStats) => number): number => cases.reduce((s, c) => s + pick(c), 0);
    const solved = sum((c) => c.solved);
    const wrong = sum((c) => c.wrongAttempts);
    return {
      accountId: account.id,
      username: account.username,
      status: account.status,
      createdAt: account.createdAt,
      lastSeenAt: account.lastSeenAt,
      totalScore: sum((c) => c.score),
      casesStarted: cases.filter((c) => c.status !== "not-started").length,
      casesCompleted: cases.filter((c) => c.status === "completed").length,
      stagesSolved: solved,
      stagesRevealed: sum((c) => c.revealed),
      hintsUsed: sum((c) => c.hintsUsed),
      wrongAttempts: wrong,
      accuracy: solved + wrong === 0 ? null : Math.round((solved / (solved + wrong)) * 1000) / 1000,
      cases,
    };
  }

  /** Every account with stats and a rank among approved accounts (ties share a rank). */
  async allUsers(): Promise<UserStats[]> {
    const [accounts, progress] = await Promise.all([this.repos.accounts.list(), this.repos.progress.list()]);
    const byAccount = new Map<string, ProgressRecord[]>();
    for (const record of progress) byAccount.set(record.accountId, [...(byAccount.get(record.accountId) ?? []), record]);
    const rows = accounts.map((a) => this.userStats(a, byAccount.get(a.id) ?? []));
    const scores = rows.filter((r) => r.status === "approved").map((r) => r.totalScore).sort((a, b) => b - a);
    return rows
      .map((r): UserStats => ({ ...r, rank: r.status === "approved" ? scores.indexOf(r.totalScore) + 1 : null }))
      .sort((a, b) => b.totalScore - a.totalScore || a.createdAt.localeCompare(b.createdAt));
  }

  /** One account's stats. Rank needs everyone's totals, so this reads all progress (fine at classroom scale). */
  async forAccount(account: AccountRecord): Promise<UserStats> {
    const own = (await mapWithConcurrency(this.caseIds, (caseId) => this.repos.progress.get(caseId, account.id)))
      .filter((r) => r !== null)
      .map((r) => r.data);
    const stats = this.userStats(account, own);
    if (account.status !== "approved") return { ...stats, rank: null };
    const all = await this.allUsers();
    return { ...stats, rank: all.find((u) => u.accountId === account.id)?.rank ?? null };
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
        maxScore: secrets ? maxScoreOf(secrets) : 0,
        players: records.length,
        completed: done.length,
        avgScore: round1(average(done.map((s) => s.score))),
        avgDurationSeconds: round1(average(done.map((s) => s.durationSeconds).filter((d): d is number => d !== null))),
        questions,
      };
    });
  }
}
