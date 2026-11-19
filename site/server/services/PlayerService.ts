import { QUESTION_ORDER, normalizeAnswer } from "../../shared/contract.ts";
import type { AdminPlayer, PlayerView, QuestionId, StageProgress } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { CaseConfig, PlayerRecord, Secrets } from "../domain/types.ts";
import type { PlayerRepository, VersionedPlayer } from "../repositories/PlayerRepository.ts";
import { PLAYER_ID_PATTERN, generatePlayerId, generateToken, parseToken, safeEqual, sha256Hex } from "./crypto.ts";

const WRONG_ANSWER_WINDOW_MS = 60_000;
const MAX_WRONG_PER_WINDOW = 5;
const CREATE_WINDOW_MS = 60 * 60_000;
// Classrooms share one NAT IP, so this only stops scripted floods, not a full class.
export const MAX_CREATES_PER_WINDOW = 300;
const MAX_WRITE_RETRIES = 3;
const LAST_SEEN_RESOLUTION_MS = 15_000;
const ADMIN_CACHE_MS = 2_000;

type Mutation<T> = { result: T; changed: boolean };

const backoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 10 * (attempt + 1))));

export type PlayerServiceDeps = {
  readonly repository: PlayerRepository;
  readonly secrets: Secrets;
  readonly caseConfig: CaseConfig;
  readonly now?: () => Date;
};

const emptyStage = (): StageProgress => ({
  status: "locked",
  startedAt: null,
  finishedAt: null,
  hintsRevealed: 0,
  wrongAttempts: 0,
  points: 0,
  revealedAnswer: null,
});

export class PlayerService {
  private readonly repository: PlayerRepository;
  private readonly secrets: Secrets;
  private readonly caseConfig: CaseConfig;
  private readonly now: () => Date;
  private adminCache: { at: number; records: Promise<PlayerRecord[]> } | null = null;

  constructor(deps: PlayerServiceDeps) {
    this.repository = deps.repository;
    this.secrets = deps.secrets;
    this.caseConfig = deps.caseConfig;
    this.now = deps.now ?? (() => new Date());
  }

  // ---- player lifecycle ---------------------------------------------------

  async createPlayer(input: { name: string; caseId: string; ip: string }): Promise<{ token: string; player: PlayerView }> {
    await this.enforceCreateRateLimit(input.ip);
    const id = generatePlayerId();
    const token = generateToken(id);
    const nowIso = this.now().toISOString();
    const stages = Object.fromEntries(QUESTION_ORDER.map((q) => [q, emptyStage()])) as Record<QuestionId, StageProgress>;
    const record: PlayerRecord = {
      id,
      name: input.name,
      caseId: input.caseId,
      tokenHash: sha256Hex(token),
      createdAt: nowIso,
      lastSeenAt: nowIso,
      setupDoneAt: null,
      completedAt: null,
      stages,
      wrongAnswerTimestamps: {},
    };
    if (!(await this.repository.saveIfMatch(record, null))) throw new AppError(409, "id collision, retry");
    this.adminCache = null;
    return { token, player: this.toView(record) };
  }

  me(token: string | null): Promise<PlayerView> {
    return this.read(token, (record) => this.toView(record));
  }

  setupDone(token: string | null): Promise<PlayerView> {
    return this.mutate(token, (record) => {
      if (record.setupDoneAt !== null) return { result: this.toView(record), changed: false };
      const nowIso = this.now().toISOString();
      record.setupDoneAt = nowIso;
      record.stages.q1 = { ...this.stage(record, "q1"), status: "active", startedAt: nowIso };
      return { result: this.toView(record), changed: true };
    });
  }

  answer(token: string | null, questionId: QuestionId, rawAnswer: string): Promise<{ correct: boolean; player: PlayerView }> {
    return this.mutate(token, (record) => {
      // Idempotent: a double-submitted correct answer must not re-score or error.
      if (this.stage(record, questionId).status === "solved") {
        return { result: { correct: true, player: this.toView(record) }, changed: false };
      }
      const stage = this.requireActive(record, questionId);
      const nowMs = this.now().getTime();
      const recent = (record.wrongAnswerTimestamps[questionId] ?? []).filter((t) => nowMs - t < WRONG_ANSWER_WINDOW_MS);
      const oldest = recent[0];
      if (recent.length >= MAX_WRONG_PER_WINDOW && oldest !== undefined) {
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WRONG_ANSWER_WINDOW_MS - nowMs) / 1000));
        throw new AppError(429, "too many wrong answers, slow down", retryAfterSeconds);
      }
      const expected = this.secrets.answers[questionId];
      const correct = expected !== undefined && normalizeAnswer(rawAnswer) === expected;
      if (correct) {
        const question = this.question(questionId);
        const hintCost = question.hintCosts.slice(0, stage.hintsRevealed).reduce((sum, c) => sum + c, 0);
        const points = Math.max(0, question.points - hintCost);
        this.finishStage(record, questionId, { ...stage, status: "solved", points });
        record.wrongAnswerTimestamps[questionId] = [];
      } else {
        record.stages[questionId] = { ...stage, wrongAttempts: stage.wrongAttempts + 1 };
        record.wrongAnswerTimestamps[questionId] = [...recent, nowMs];
      }
      return { result: { correct, player: this.toView(record) }, changed: true };
    });
  }

  hint(token: string | null, questionId: QuestionId): Promise<PlayerView> {
    return this.mutate(token, (record) => {
      const stage = this.requireActive(record, questionId);
      if (stage.hintsRevealed >= this.question(questionId).hintCosts.length) throw new AppError(409, "no more hints");
      record.stages[questionId] = { ...stage, hintsRevealed: stage.hintsRevealed + 1 };
      return { result: this.toView(record), changed: true };
    });
  }

  reveal(token: string | null, questionId: QuestionId): Promise<PlayerView> {
    return this.mutate(token, (record) => {
      // Idempotent: revealing an already-revealed stage just returns the current state.
      if (this.stage(record, questionId).status === "revealed") return { result: this.toView(record), changed: false };
      const stage = this.requireActive(record, questionId);
      const revealedAnswer = this.secrets.answers[questionId] ?? "";
      this.finishStage(record, questionId, { ...stage, status: "revealed", points: 0, revealedAnswer });
      return { result: this.toView(record), changed: true };
    });
  }

  debrief(token: string | null): Promise<{ markdown: string }> {
    return this.read(token, (record) => {
      const allDone = QUESTION_ORDER.every((q) => {
        const status = this.stage(record, q).status;
        return status === "solved" || status === "revealed";
      });
      if (!allDone) throw new AppError(403, "debrief is locked until every stage is finished");
      return { markdown: this.secrets.debrief };
    });
  }

  // ---- admin --------------------------------------------------------------

  async listForAdmin(): Promise<{ generatedAt: string; players: AdminPlayer[] }> {
    const now = this.now();
    const cached = this.adminCache;
    if (!cached || now.getTime() - cached.at >= ADMIN_CACHE_MS) {
      // Share one in-flight read between concurrent admin requests.
      this.adminCache = { at: now.getTime(), records: this.repository.list() };
    }
    const pending = this.adminCache;
    let records: PlayerRecord[];
    try {
      records = pending ? await pending.records : [];
    } catch (error) {
      this.adminCache = null;
      throw error;
    }
    const players = records
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => this.toAdminView(r, now));
    return { generatedAt: now.toISOString(), players };
  }

  async deletePlayer(playerId: string): Promise<void> {
    if (!PLAYER_ID_PATTERN.test(playerId)) throw new AppError(400, "invalid player id");
    const existing = await this.repository.get(playerId);
    if (!existing) throw new AppError(404, "player not found");
    await this.repository.delete(playerId);
    this.adminCache = null;
  }

  async resetAll(): Promise<void> {
    await this.repository.deleteAll();
    this.adminCache = null;
  }

  // ---- helpers ------------------------------------------------------------

  /** Verifies the bearer token and returns the versioned record. Throws 401 on any failure. */
  private async load(token: string | null): Promise<VersionedPlayer> {
    if (!token) throw new AppError(401, "authentication required");
    const parsed = parseToken(token);
    if (!parsed) throw new AppError(401, "invalid token");
    const found = await this.repository.get(parsed.playerId);
    if (!found || !safeEqual(found.record.tokenHash, sha256Hex(token))) throw new AppError(401, "invalid token");
    return found;
  }

  /** Returns true when lastSeenAt is stale enough to be worth a write. */
  private touch(record: PlayerRecord): boolean {
    const now = this.now();
    if (now.getTime() - Date.parse(record.lastSeenAt) < LAST_SEEN_RESOLUTION_MS) return false;
    record.lastSeenAt = now.toISOString();
    return true;
  }

  /** Read-only op; bumps lastSeenAt best-effort (a lost race is harmless). */
  private async read<T>(token: string | null, fn: (record: PlayerRecord) => T): Promise<T> {
    const { record, etag } = await this.load(token);
    const result = fn(record);
    if (this.touch(record)) await this.repository.saveIfMatch(record, etag);
    return result;
  }

  /** Optimistic read-modify-write with etag check and bounded retries. */
  private async mutate<T>(token: string | null, fn: (record: PlayerRecord) => Mutation<T>): Promise<T> {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const { record, etag } = await this.load(token);
      const { result, changed } = fn(record);
      const touched = this.touch(record);
      if (!changed && !touched) return result;
      if (await this.repository.saveIfMatch(record, etag)) return result;
      if (!changed) return result; // only lastSeenAt lost the race
      await backoff(attempt);
    }
    throw new AppError(409, "concurrent update, please retry");
  }

  private async enforceCreateRateLimit(ip: string): Promise<void> {
    const key = sha256Hex(ip || "unknown");
    const nowMs = this.now().getTime();
    const recent = (await this.repository.getIpHits(key)).filter((t) => nowMs - t < CREATE_WINDOW_MS);
    const oldest = recent[0];
    if (recent.length >= MAX_CREATES_PER_WINDOW && oldest !== undefined) {
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + CREATE_WINDOW_MS - nowMs) / 1000));
      throw new AppError(429, "too many players created from this address", retryAfterSeconds);
    }
    await this.repository.setIpHits(key, [...recent, nowMs]);
  }

  private question(questionId: QuestionId): { points: number; hintCosts: readonly number[] } {
    return this.caseConfig.questions[questionId];
  }

  private stage(record: PlayerRecord, questionId: QuestionId): StageProgress {
    return record.stages[questionId] ?? emptyStage();
  }

  private requireActive(record: PlayerRecord, questionId: QuestionId): StageProgress {
    const stage = this.stage(record, questionId);
    if (stage.status === "locked") throw new AppError(403, "stage is locked");
    if (stage.status !== "active") throw new AppError(409, "stage already finished");
    return stage;
  }

  private finishStage(record: PlayerRecord, questionId: QuestionId, finished: StageProgress): void {
    const nowIso = this.now().toISOString();
    record.stages[questionId] = { ...finished, finishedAt: nowIso };
    const next = QUESTION_ORDER[QUESTION_ORDER.indexOf(questionId) + 1];
    if (next) {
      record.stages[next] = { ...this.stage(record, next), status: "active", startedAt: nowIso };
    } else {
      record.completedAt = nowIso;
    }
  }

  private toView(record: PlayerRecord): PlayerView {
    const stages = Object.fromEntries(QUESTION_ORDER.map((q) => [q, this.stage(record, q)])) as Record<QuestionId, StageProgress>;
    const score = QUESTION_ORDER.reduce((sum, q) => sum + stages[q].points, 0);
    const maxScore = QUESTION_ORDER.reduce((sum, q) => sum + this.question(q).points, 0);
    return {
      id: record.id,
      name: record.name,
      caseId: record.caseId,
      createdAt: record.createdAt,
      setupDoneAt: record.setupDoneAt,
      completedAt: record.completedAt,
      score,
      maxScore,
      stages,
    };
  }

  private toAdminView(record: PlayerRecord, now: Date): AdminPlayer {
    const view = this.toView(record);
    let currentStage: AdminPlayer["currentStage"];
    let since: string | null;
    if (record.setupDoneAt === null) {
      currentStage = "setup";
      since = record.createdAt;
    } else if (record.completedAt !== null) {
      currentStage = "done";
      since = null;
    } else {
      const active = QUESTION_ORDER.find((q) => view.stages[q].status === "active");
      currentStage = active ?? "done";
      since = active ? view.stages[active].startedAt : null;
    }
    const stuckMinutes = since ? Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 60_000)) : 0;
    return { ...view, lastSeenAt: record.lastSeenAt, currentStage, stuckMinutes };
  }
}
