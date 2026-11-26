// Staged gameplay for one account on one case: setup -> q1..q6 -> debrief. Answers are checked and scored
// here only, and paid content (hint texts, full commands) leaves the server only once it is paid for.
import { QUESTION_ORDER, SCORING, normalizeAnswer } from "../../shared/contract.ts";
import type { AdminProgress, ProgressView, QuestionId, StageProgress } from "../../shared/contract.ts";
import { AppError, PROGRESS_SCHEMA_VERSION } from "../domain/types.ts";
import type { AccountRecord, CaseSecrets, ProgressRecord, Secrets } from "../domain/types.ts";
import type { FirstBloodRepository } from "../repositories/config-repositories.ts";
import type { ProgressRepository } from "../repositories/repositories.ts";
import type { Versioned } from "../repositories/KvStore.ts";
import type { EventService } from "./EventService.ts";
import type { ScheduleService } from "./ScheduleService.ts";
import { parScore, scoreStage } from "./scoring.ts";

const WRONG_ANSWER_WINDOW_MS = 60_000;
const MAX_WRONG_PER_WINDOW = 5;
const MAX_WRITE_RETRIES = 3;
const LAST_SEEN_RESOLUTION_MS = 15_000;

type Mutation<T> = { result: T; changed: boolean };
export type Player = Pick<AccountRecord, "id" | "username">;
export type Lang = "en" | "he";
/** Who is playing which case, and the language for paid content in responses. */
export type PlayContext = { readonly player: Player; readonly caseId: string; readonly lang: Lang };

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
  commandsRevealed: 0,
  breakdown: null,
});

/** Par score (see scoring.ts). Kept under this name for callers that only need "the max". */
export const maxScoreOf = (secrets: CaseSecrets): number => parScore(secrets);

export class GameService {
  private readonly repository: ProgressRepository;
  private readonly firstBlood: FirstBloodRepository;
  private readonly secrets: Secrets;
  private readonly schedule: ScheduleService;
  private readonly events: EventService;
  private readonly now: () => Date;

  constructor(deps: {
    repository: ProgressRepository;
    firstBlood: FirstBloodRepository;
    secrets: Secrets;
    schedule: ScheduleService;
    events: EventService;
    now: () => Date;
  }) {
    this.repository = deps.repository;
    this.firstBlood = deps.firstBlood;
    this.secrets = deps.secrets;
    this.schedule = deps.schedule;
    this.events = deps.events;
    this.now = deps.now;
  }

  caseSecrets(caseId: string): CaseSecrets {
    const found = this.secrets.cases[caseId];
    if (!found) throw new AppError(404, "unknown case", { code: "unknown-case" });
    return found;
  }

  /** Opening a case creates its progress record (so the instructor sees the player at "setup"). */
  async progress(ctx: PlayContext): Promise<ProgressView> {
    this.caseSecrets(ctx.caseId); // 404 for unknown cases
    const found = await this.repository.get(ctx.caseId, ctx.player.id);
    if (found) {
      if (this.touch(found.data)) await this.repository.saveIfMatch(found.data, found.etag);
      return this.toView(found.data, ctx);
    }
    if (!(await this.schedule.canStart(ctx.caseId))) {
      return { ...this.toView(this.newRecord(ctx.player.id, ctx.caseId), ctx), startedAt: null }; // view only, nothing stored
    }
    const record = this.newRecord(ctx.player.id, ctx.caseId);
    if (!(await this.repository.saveIfMatch(record, null))) return this.progress(ctx); // lost a race: re-read
    return this.toView(record, ctx);
  }

  async setupDone(ctx: PlayContext): Promise<ProgressView> {
    this.caseSecrets(ctx.caseId);
    if (!(await this.repository.get(ctx.caseId, ctx.player.id))) {
      await this.schedule.assertCanStart(ctx.caseId);
      await this.repository.saveIfMatch(this.newRecord(ctx.player.id, ctx.caseId), null);
    }
    return this.mutate(ctx, (record) => {
      if (record.setupDoneAt !== null) return { result: this.toView(record, ctx), changed: false };
      const nowIso = this.now().toISOString();
      record.setupDoneAt = nowIso;
      record.stages.q1 = { ...this.stage(record, "q1"), status: "active", startedAt: nowIso };
      return { result: this.toView(record, ctx), changed: true };
    });
  }

  async answer(ctx: PlayContext, input: { questionId: QuestionId; answer: string }): Promise<{ correct: boolean; progress: ProgressView }> {
    const secrets = this.caseSecrets(ctx.caseId);
    const { questionId } = input;
    const expected = secrets.answers[questionId];
    const isCorrect = expected !== undefined && normalizeAnswer(input.answer) === expected;
    await this.events.assertOpen();

    // First blood is claimed before the write; the claim is idempotent per account, so retries keep it.
    let isFirstBlood = false;
    if (isCorrect) {
      const current = await this.repository.get(ctx.caseId, ctx.player.id);
      if (current && this.stage(current.data, questionId).status === "active") {
        isFirstBlood = await this.firstBlood.claim({ caseId: ctx.caseId, questionId, accountId: ctx.player.id, at: this.now().toISOString() });
      }
    }

    return this.mutate(ctx, (record) => {
      // Idempotent: a double-submitted correct answer must not re-score or error.
      if (this.stage(record, questionId).status === "solved") {
        return { result: { correct: true, progress: this.toView(record, ctx) }, changed: false };
      }
      const stage = this.requireActive(record, questionId);
      const nowMs = this.now().getTime();
      const recent = (record.wrongAnswerTimestamps[questionId] ?? []).filter((t) => nowMs - t < WRONG_ANSWER_WINDOW_MS);
      const oldest = recent[0];
      if (recent.length >= MAX_WRONG_PER_WINDOW && oldest !== undefined) {
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WRONG_ANSWER_WINDOW_MS - nowMs) / 1000));
        throw new AppError(429, "too many wrong answers, slow down", { code: "rate-limited", retryAfterSeconds });
      }
      if (isCorrect) {
        const question = secrets.questions[questionId];
        const solveSeconds = stage.startedAt ? (nowMs - Date.parse(stage.startedAt)) / 1000 : question.targetSeconds;
        const breakdown = scoreStage({
          basePoints: question.points,
          hintCosts: question.hintCosts,
          targetSeconds: question.targetSeconds,
          stage,
          solveSeconds,
          isFirstBlood,
        });
        this.finishStage(record, questionId, { ...stage, status: "solved", points: breakdown.total, breakdown });
        record.wrongAnswerTimestamps[questionId] = [];
      } else {
        record.stages[questionId] = { ...stage, wrongAttempts: stage.wrongAttempts + 1 };
        record.wrongAnswerTimestamps[questionId] = [...recent, nowMs];
      }
      return { result: { correct: isCorrect, progress: this.toView(record, ctx) }, changed: true };
    });
  }

  async hint(ctx: PlayContext, questionId: QuestionId): Promise<ProgressView> {
    const secrets = this.caseSecrets(ctx.caseId);
    await this.events.assertOpen();
    return this.mutate(ctx, (record) => {
      const stage = this.requireActive(record, questionId);
      if (stage.hintsRevealed >= secrets.questions[questionId].hintCosts.length) throw new AppError(409, "no more hints");
      record.stages[questionId] = { ...stage, hintsRevealed: stage.hintsRevealed + 1 };
      return { result: this.toView(record, ctx), changed: true };
    });
  }

  /** Pay 5 points (on the active stage) to see a full command. Free if already paid for or the case is done. */
  async revealCommand(ctx: PlayContext, toolId: string): Promise<ProgressView> {
    const secrets = this.caseSecrets(ctx.caseId);
    if (!secrets.tools[toolId]) throw new AppError(404, "unknown command", { code: "unknown-command" });
    return this.mutate(ctx, (record) => {
      if (record.completedAt !== null || record.commandsRevealed[toolId] !== undefined) {
        return { result: this.toView(record, ctx), changed: false };
      }
      const active = QUESTION_ORDER.find((q) => this.stage(record, q).status === "active");
      if (record.setupDoneAt === null || active === undefined) {
        throw new AppError(403, "start the case before revealing commands", { code: "locked" });
      }
      const stage = this.stage(record, active);
      record.stages[active] = { ...stage, commandsRevealed: stage.commandsRevealed + 1 };
      record.commandsRevealed[toolId] = active;
      return { result: this.toView(record, ctx), changed: true };
    }, { checkEvent: true });
  }

  async reveal(ctx: PlayContext, questionId: QuestionId): Promise<ProgressView> {
    const secrets = this.caseSecrets(ctx.caseId);
    await this.events.assertOpen();
    return this.mutate(ctx, (record) => {
      if (this.stage(record, questionId).status === "revealed") return { result: this.toView(record, ctx), changed: false };
      const stage = this.requireActive(record, questionId);
      const revealedAnswer = secrets.answers[questionId] ?? "";
      this.finishStage(record, questionId, { ...stage, status: "revealed", points: 0, revealedAnswer, breakdown: null });
      return { result: this.toView(record, ctx), changed: true };
    });
  }

  async debrief(ctx: PlayContext): Promise<{ markdown: string }> {
    const secrets = this.caseSecrets(ctx.caseId);
    const found = await this.repository.get(ctx.caseId, ctx.player.id);
    if (!found || found.data.completedAt === null) throw new AppError(403, "debrief is locked until every stage is finished", { code: "locked" });
    return { markdown: ctx.lang === "he" && secrets.debriefHe ? secrets.debriefHe : secrets.debrief };
  }

  // ---- admin --------------------------------------------------------------

  toAdminView(record: ProgressRecord, player: Player & { lastSeenAt: string | null }): AdminProgress {
    const now = this.now();
    const view = this.toView(record, { player, caseId: record.caseId, lang: "en" }, { includeUnlocked: false });
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

  toView(record: ProgressRecord, ctx: PlayContext, options: { includeUnlocked: boolean } = { includeUnlocked: true }): ProgressView {
    const secrets = this.caseSecrets(record.caseId);
    const stages = Object.fromEntries(QUESTION_ORDER.map((q) => [q, this.stage(record, q)])) as Record<QuestionId, StageProgress>;
    const isComplete = record.completedAt !== null;
    const hints: ProgressView["unlocked"]["hints"] = {};
    const commands: ProgressView["unlocked"]["commands"] = {};
    if (options.includeUnlocked) {
      for (const q of QUESTION_ORDER) {
        const texts = secrets.hints[q] ?? [];
        const shown = isComplete ? texts.length : stages[q].hintsRevealed;
        if (shown > 0) hints[q] = texts.slice(0, shown).map((t) => (ctx.lang === "he" && t.he ? t.he : t.en));
      }
      const toolIds = isComplete ? Object.keys(secrets.tools) : Object.keys(record.commandsRevealed);
      for (const id of toolIds) {
        const tool = secrets.tools[id];
        // One paid reveal unlocks every variant of the item (bash, PowerShell, lab).
        if (tool) commands[id] = { command: tool.command, powershell: tool.powershell, lab: tool.lab };
      }
    }
    return {
      accountId: ctx.player.id,
      username: ctx.player.username,
      caseId: record.caseId,
      startedAt: record.startedAt,
      setupDoneAt: record.setupDoneAt,
      completedAt: record.completedAt,
      score: QUESTION_ORDER.reduce((sum, q) => sum + stages[q].points, 0) + record.completionBonus,
      maxScore: parScore(secrets),
      completionBonus: record.completionBonus,
      stages,
      commandsRevealed: record.commandsRevealed,
      unlocked: { hints, commands },
    };
  }

  // ---- helpers ------------------------------------------------------------

  private newRecord(accountId: string, caseId: string): ProgressRecord {
    const nowIso = this.now().toISOString();
    return {
      schemaVersion: PROGRESS_SCHEMA_VERSION,
      accountId,
      caseId,
      startedAt: nowIso,
      lastSeenAt: nowIso,
      setupDoneAt: null,
      completedAt: null,
      stages: Object.fromEntries(QUESTION_ORDER.map((q) => [q, emptyStage()])) as Record<QuestionId, StageProgress>,
      wrongAnswerTimestamps: {},
      commandsRevealed: {},
      completionBonus: 0,
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

  /**
   * Optimistic read-modify-write with etag check and bounded retries. With `checkEvent`, the event window
   * is enforced only when the mutation actually changes something (free re-reveals stay allowed).
   */
  private async mutate<T>(ctx: PlayContext, fn: (record: ProgressRecord) => Mutation<T>, options: { checkEvent?: boolean } = {}): Promise<T> {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const { data: record, etag } = await this.load(ctx.player.id, ctx.caseId);
      const { result, changed } = fn(record);
      if (changed && options.checkEvent) await this.events.assertOpen();
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
      return;
    }
    record.completedAt = nowIso;
    const isFlawless = QUESTION_ORDER.every((q) => this.stage(record, q).status === "solved");
    record.completionBonus = isFlawless ? SCORING.COMPLETION_BONUS : 0;
  }
}

