// Staged gameplay for one account on one case: setup -> q1..q6 -> debrief. Answers are checked here only.
import { QUESTION_ORDER, normalizeAnswer } from "../../shared/contract.ts";
import type { AdminProgress, ProgressView, QuestionId, StageProgress } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { AccountRecord, CaseSecrets, ProgressRecord, Secrets } from "../domain/types.ts";
import type { ProgressRepository } from "../repositories/repositories.ts";
import type { Versioned } from "../repositories/KvStore.ts";
import type { ScheduleService } from "./ScheduleService.ts";

const WRONG_ANSWER_WINDOW_MS = 60_000;
const MAX_WRONG_PER_WINDOW = 5;
const MAX_WRITE_RETRIES = 3;
const LAST_SEEN_RESOLUTION_MS = 15_000;

type Mutation<T> = { result: T; changed: boolean };
export type Player = Pick<AccountRecord, "id" | "username">;

const backoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 10 * (attempt + 1))));

export const emptyStage = (): StageProgress => ({
  status: "locked",
  startedAt: null,
  finishedAt: null,
  hintsRevealed: 0,
  wrongAttempts: 0,
  points: 0,
  revealedAnswer: null,
});

export const maxScoreOf = (secrets: CaseSecrets): number => QUESTION_ORDER.reduce((sum, q) => sum + secrets.questions[q].points, 0);

export class GameService {
  private readonly repository: ProgressRepository;
  private readonly secrets: Secrets;
  private readonly schedule: ScheduleService;
  private readonly now: () => Date;

  constructor(deps: { repository: ProgressRepository; secrets: Secrets; schedule: ScheduleService; now: () => Date }) {
    this.repository = deps.repository;
    this.secrets = deps.secrets;
    this.schedule = deps.schedule;
    this.now = deps.now;
  }

  caseSecrets(caseId: string): CaseSecrets {
    const found = this.secrets.cases[caseId];
    if (!found) throw new AppError(404, "unknown case", { code: "unknown-case" });
    return found;
  }

  /** Opening a case creates its progress record (so the instructor sees the player at "setup"). */
  async progress(player: Player, caseId: string): Promise<ProgressView> {
    const secrets = this.caseSecrets(caseId);
    const found = await this.repository.get(caseId, player.id);
    if (found) {
      if (this.touch(found.data)) await this.repository.saveIfMatch(found.data, found.etag);
      return this.toView(found.data, player, secrets);
    }
    if (!(await this.schedule.canStart(caseId))) {
      return { ...this.toView(this.newRecord(player.id, caseId), player, secrets), startedAt: null }; // view only, nothing stored
    }
    const record = this.newRecord(player.id, caseId);
    if (!(await this.repository.saveIfMatch(record, null))) return this.progress(player, caseId); // lost a race: re-read
    return this.toView(record, player, secrets);
  }

  async setupDone(player: Player, caseId: string): Promise<ProgressView> {
    const secrets = this.caseSecrets(caseId);
    if (!(await this.repository.get(caseId, player.id))) {
      await this.schedule.assertCanStart(caseId);
      await this.repository.saveIfMatch(this.newRecord(player.id, caseId), null);
    }
    return this.mutate(player, caseId, (record) => {
      if (record.setupDoneAt !== null) return { result: this.toView(record, player, secrets), changed: false };
      const nowIso = this.now().toISOString();
      record.setupDoneAt = nowIso;
      record.stages.q1 = { ...this.stage(record, "q1"), status: "active", startedAt: nowIso };
      return { result: this.toView(record, player, secrets), changed: true };
    });
  }

  answer(player: Player, caseId: string, input: { questionId: QuestionId; answer: string }): Promise<{ correct: boolean; progress: ProgressView }> {
    const secrets = this.caseSecrets(caseId);
    const { questionId } = input;
    return this.mutate(player, caseId, (record) => {
      // Idempotent: a double-submitted correct answer must not re-score or error.
      if (this.stage(record, questionId).status === "solved") {
        return { result: { correct: true, progress: this.toView(record, player, secrets) }, changed: false };
      }
      const stage = this.requireActive(record, questionId);
      const nowMs = this.now().getTime();
      const recent = (record.wrongAnswerTimestamps[questionId] ?? []).filter((t) => nowMs - t < WRONG_ANSWER_WINDOW_MS);
      const oldest = recent[0];
      if (recent.length >= MAX_WRONG_PER_WINDOW && oldest !== undefined) {
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WRONG_ANSWER_WINDOW_MS - nowMs) / 1000));
        throw new AppError(429, "too many wrong answers, slow down", { code: "rate-limited", retryAfterSeconds });
      }
      const expected = secrets.answers[questionId];
      const correct = expected !== undefined && normalizeAnswer(input.answer) === expected;
      if (correct) {
        const question = secrets.questions[questionId];
        const hintCost = question.hintCosts.slice(0, stage.hintsRevealed).reduce((sum, c) => sum + c, 0);
        this.finishStage(record, questionId, { ...stage, status: "solved", points: Math.max(0, question.points - hintCost) });
        record.wrongAnswerTimestamps[questionId] = [];
      } else {
        record.stages[questionId] = { ...stage, wrongAttempts: stage.wrongAttempts + 1 };
        record.wrongAnswerTimestamps[questionId] = [...recent, nowMs];
      }
      return { result: { correct, progress: this.toView(record, player, secrets) }, changed: true };
    });
  }

  hint(player: Player, caseId: string, questionId: QuestionId): Promise<ProgressView> {
    const secrets = this.caseSecrets(caseId);
    return this.mutate(player, caseId, (record) => {
      const stage = this.requireActive(record, questionId);
      if (stage.hintsRevealed >= secrets.questions[questionId].hintCosts.length) throw new AppError(409, "no more hints");
      record.stages[questionId] = { ...stage, hintsRevealed: stage.hintsRevealed + 1 };
      return { result: this.toView(record, player, secrets), changed: true };
    });
  }

  reveal(player: Player, caseId: string, questionId: QuestionId): Promise<ProgressView> {
    const secrets = this.caseSecrets(caseId);
    return this.mutate(player, caseId, (record) => {
      if (this.stage(record, questionId).status === "revealed") return { result: this.toView(record, player, secrets), changed: false };
      const stage = this.requireActive(record, questionId);
      const revealedAnswer = secrets.answers[questionId] ?? "";
      this.finishStage(record, questionId, { ...stage, status: "revealed", points: 0, revealedAnswer });
      return { result: this.toView(record, player, secrets), changed: true };
    });
  }

  async debrief(player: Player, caseId: string, lang: "en" | "he"): Promise<{ markdown: string }> {
    const secrets = this.caseSecrets(caseId);
    const found = await this.repository.get(caseId, player.id);
    if (!found || found.data.completedAt === null) throw new AppError(403, "debrief is locked until every stage is finished", { code: "locked" });
    return { markdown: lang === "he" && secrets.debriefHe ? secrets.debriefHe : secrets.debrief };
  }

  // ---- admin --------------------------------------------------------------

  toAdminView(record: ProgressRecord, player: Player & { lastSeenAt: string | null }): AdminProgress {
    const now = this.now();
    const view = this.toView(record, player, this.caseSecrets(record.caseId));
    let currentStage: AdminProgress["currentStage"];
    let since: string | null;
    if (record.setupDoneAt === null) {
      currentStage = "setup";
      since = record.startedAt;
    } else if (record.completedAt !== null) {
      currentStage = "done";
      since = null;
    } else {
      const active = QUESTION_ORDER.find((q) => view.stages[q].status === "active");
      currentStage = active ?? "done";
      since = active ? view.stages[active].startedAt : null;
    }
    const stuckMinutes = since ? Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 60_000)) : 0;
    const lastSeenAt = [record.lastSeenAt, player.lastSeenAt].filter((v): v is string => v !== null).sort().at(-1) ?? record.lastSeenAt;
    return { ...view, lastSeenAt, currentStage, stuckMinutes };
  }

  toView(record: ProgressRecord, player: Player, secrets: CaseSecrets): ProgressView {
    const stages = Object.fromEntries(QUESTION_ORDER.map((q) => [q, this.stage(record, q)])) as Record<QuestionId, StageProgress>;
    return {
      accountId: player.id,
      username: player.username,
      caseId: record.caseId,
      startedAt: record.startedAt,
      setupDoneAt: record.setupDoneAt,
      completedAt: record.completedAt,
      score: QUESTION_ORDER.reduce((sum, q) => sum + stages[q].points, 0),
      maxScore: maxScoreOf(secrets),
      stages,
    };
  }

  // ---- helpers ------------------------------------------------------------

  private newRecord(accountId: string, caseId: string): ProgressRecord {
    const nowIso = this.now().toISOString();
    return {
      accountId,
      caseId,
      startedAt: nowIso,
      lastSeenAt: nowIso,
      setupDoneAt: null,
      completedAt: null,
      stages: Object.fromEntries(QUESTION_ORDER.map((q) => [q, emptyStage()])) as Record<QuestionId, StageProgress>,
      wrongAnswerTimestamps: {},
    };
  }

  private async load(accountId: string, caseId: string): Promise<Versioned<ProgressRecord>> {
    const found = await this.repository.get(caseId, accountId);
    if (!found) throw new AppError(403, "open the case first", { code: "locked" });
    return found;
  }

  /** Returns true when lastSeenAt is stale enough to be worth a write. */
  private touch(record: ProgressRecord): boolean {
    const now = this.now();
    if (now.getTime() - Date.parse(record.lastSeenAt) < LAST_SEEN_RESOLUTION_MS) return false;
    record.lastSeenAt = now.toISOString();
    return true;
  }

  /** Optimistic read-modify-write with etag check and bounded retries. */
  private async mutate<T>(player: Player, caseId: string, fn: (record: ProgressRecord) => Mutation<T>): Promise<T> {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const { data: record, etag } = await this.load(player.id, caseId);
      const { result, changed } = fn(record);
      const touched = this.touch(record);
      if (!changed && !touched) return result;
      if (await this.repository.saveIfMatch(record, etag)) return result;
      if (!changed) return result; // only lastSeenAt lost the race
      await backoff(attempt);
    }
    throw new AppError(409, "concurrent update, please retry");
  }

  private stage(record: ProgressRecord, questionId: QuestionId): StageProgress {
    return record.stages[questionId] ?? emptyStage();
  }

  private requireActive(record: ProgressRecord, questionId: QuestionId): StageProgress {
    const stage = this.stage(record, questionId);
    if (stage.status === "locked") throw new AppError(403, "stage is locked", { code: "locked" });
    if (stage.status !== "active") throw new AppError(409, "stage already finished");
    return stage;
  }

  private finishStage(record: ProgressRecord, questionId: QuestionId, finished: StageProgress): void {
    const nowIso = this.now().toISOString();
    record.stages[questionId] = { ...finished, finishedAt: nowIso };
    const next = QUESTION_ORDER[QUESTION_ORDER.indexOf(questionId) + 1];
    if (next) {
      record.stages[next] = { ...this.stage(record, next), status: "active", startedAt: nowIso };
    } else {
      record.completedAt = nowIso;
    }
  }
}
