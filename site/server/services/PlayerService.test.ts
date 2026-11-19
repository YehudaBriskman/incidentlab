import { test } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../domain/types.ts";
import type { CaseConfig, Secrets } from "../domain/types.ts";
import { InMemoryPlayerRepository } from "../repositories/InMemoryPlayerRepository.ts";
import { AdminAuthService } from "./AdminAuthService.ts";
import { MAX_CREATES_PER_WINDOW, PlayerService } from "./PlayerService.ts";
import { PlayerNameSchema } from "../../shared/contract.ts";
import type { QuestionId } from "../../shared/contract.ts";

const secrets: Secrets = {
  caseId: "3am-outage",
  answers: { q1: "a1", q2: "a2", q3: "a3", q4: "a4", q5: "a5", q6: "a6" },
  debrief: "# fake debrief",
};
const q = { points: 100, hintCosts: [10, 20, 40] };
const caseConfig: CaseConfig = { caseId: "3am-outage", questions: { q1: q, q2: q, q3: q, q4: q, q5: q, q6: { points: 150, hintCosts: [15, 30, 50] } } };

const setup = (now: () => Date = () => new Date()) => {
  const repository = new InMemoryPlayerRepository();
  const service = new PlayerService({ repository, secrets, caseConfig, now });
  return { repository, service };
};

const expectStatus = async (promise: Promise<unknown>, status: number): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    return error;
  }
  assert.fail(`expected status ${status}`);
};

const newPlayer = async (service: PlayerService) => {
  const { token } = await service.createPlayer({ name: "Ada", caseId: "3am-outage", ip: "1.1.1.1" });
  return token;
};

test("player name validation", () => {
  assert.equal(PlayerNameSchema.safeParse("<script>").success, false);
  assert.equal(PlayerNameSchema.safeParse("a<img src=x onerror=alert(1)>").success, false);
  assert.equal(PlayerNameSchema.safeParse("x").success, false);
  assert.equal(PlayerNameSchema.safeParse("יהודה בריסקמן").success, true);
  assert.equal(PlayerNameSchema.safeParse("O'Neil-Smith").success, true);
});

test("create player returns a token and a locked view", async () => {
  const { service } = setup();
  const { token, player } = await service.createPlayer({ name: "יהודה", caseId: "3am-outage", ip: "1.1.1.1" });
  assert.match(token, /^[0-9A-Za-z]{12}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(player.name, "יהודה");
  assert.equal(player.maxScore, 650);
  assert.equal(player.stages.q1.status, "locked");
});

test("auth required / bad token", async () => {
  const { service } = setup();
  const token = await newPlayer(service);
  await expectStatus(service.me(null), 401);
  await expectStatus(service.me("garbage"), 401);
  await expectStatus(service.me(`${token.slice(0, 13)}${"A".repeat(43)}`), 401);
  await expectStatus(service.me("../../etc.passwd"), 401);
  assert.equal((await service.me(token)).name, "Ada");
});

test("setup-done activates q1 and is idempotent", async () => {
  const { service } = setup();
  const token = await newPlayer(service);
  const view = await service.setupDone(token);
  assert.ok(view.setupDoneAt);
  assert.equal(view.stages.q1.status, "active");
  assert.equal((await service.setupDone(token)).setupDoneAt, view.setupDoneAt);
});

test("stage sequencing: q2 before q1 is 403", async () => {
  const { service } = setup();
  const token = await newPlayer(service);
  await expectStatus(service.answer(token, "q1", "a1"), 403); // setup not done
  await service.setupDone(token);
  await expectStatus(service.answer(token, "q2", "a2"), 403);
  await expectStatus(service.hint(token, "q2"), 403);
  await expectStatus(service.reveal(token, "q2"), 403);
});

test("wrong answer increments attempts", async () => {
  const { service } = setup();
  const token = await newPlayer(service);
  await service.setupDone(token);
  const res = await service.answer(token, "q1", "nope");
  assert.equal(res.correct, false);
  assert.equal(res.player.stages.q1.wrongAttempts, 1);
  assert.equal(res.player.stages.q1.status, "active");
});

test("correct answer scores with hints deducted, normalized, advances", async () => {
  const { service } = setup();
  const token = await newPlayer(service);
  await service.setupDone(token);
  await service.hint(token, "q1");
  await service.hint(token, "q1");
  const res = await service.answer(token, "q1", "  A1 ");
  assert.equal(res.correct, true);
  assert.equal(res.player.stages.q1.points, 70);
  assert.equal(res.player.stages.q1.status, "solved");
  assert.equal(res.player.stages.q2.status, "active");
  assert.equal(res.player.score, 70);
  // idempotent re-submit does not re-score
  const again = await service.answer(token, "q1", "whatever");
  assert.equal(again.correct, true);
  assert.equal(again.player.score, 70);
});

test("hints are capped", async () => {
  const { service } = setup();
  const token = await newPlayer(service);
  await service.setupDone(token);
  for (let i = 0; i < 3; i++) await service.hint(token, "q1");
  await expectStatus(service.hint(token, "q1"), 409);
});

test("reveal gives 0 points and advances", async () => {
  const { service } = setup();
  const token = await newPlayer(service);
  await service.setupDone(token);
  const view = await service.reveal(token, "q1");
  assert.equal(view.stages.q1.status, "revealed");
  assert.equal(view.stages.q1.points, 0);
  assert.equal(view.stages.q1.revealedAnswer, "a1");
  assert.equal(view.stages.q2.status, "active");
});

test("rate limit: 6th wrong answer within 60s is 429", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00Z");
  const { service } = setup(() => new Date(nowMs));
  const token = await newPlayer(service);
  await service.setupDone(token);
  for (let i = 0; i < 5; i++) {
    await service.answer(token, "q1", `wrong${i}`);
    nowMs += 1000;
  }
  const err = await expectStatus(service.answer(token, "q1", "wrong6"), 429);
  assert.ok(err.retryAfterSeconds !== undefined && err.retryAfterSeconds > 0 && err.retryAfterSeconds <= 60);
  nowMs += 61_000;
  assert.equal((await service.answer(token, "q1", "a1")).correct, true);
});

test("player creation is rate limited per IP", async () => {
  const { service } = setup();
  for (let i = 0; i < MAX_CREATES_PER_WINDOW; i++) await service.createPlayer({ name: "Bob", caseId: "3am-outage", ip: "9.9.9.9" });
  await expectStatus(service.createPlayer({ name: "Bob", caseId: "3am-outage", ip: "9.9.9.9" }), 429);
  await service.createPlayer({ name: "Bob", caseId: "3am-outage", ip: "8.8.8.8" });
});

test("debrief 403 until all stages done, then 200", async () => {
  const { service } = setup();
  const token = await newPlayer(service);
  await expectStatus(service.debrief(token), 403);
  await service.setupDone(token);
  const ids: QuestionId[] = ["q1", "q2", "q3", "q4", "q5"];
  for (const id of ids) await service.answer(token, id, secrets.answers[id]);
  await expectStatus(service.debrief(token), 403);
  const last = await service.reveal(token, "q6");
  assert.ok(last.completedAt);
  assert.equal(last.score, 500);
  assert.equal((await service.debrief(token)).markdown, "# fake debrief");
});

test("admin key missing / wrong / right / disabled", () => {
  const key = "k".repeat(32);
  assert.equal(expectThrow(() => new AdminAuthService(undefined).assertAdmin(key)), 503);
  assert.equal(expectThrow(() => new AdminAuthService("short").assertAdmin("short")), 503);
  assert.equal(expectThrow(() => new AdminAuthService(key).assertAdmin(null)), 401);
  assert.equal(expectThrow(() => new AdminAuthService(key).assertAdmin("wrong")), 401);
  new AdminAuthService(key).assertAdmin(key);
});

const expectThrow = (fn: () => void): number => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.status;
  }
  return 0;
};

test("admin list computes currentStage / stuckMinutes; delete and reset", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00Z");
  const { service } = setup(() => new Date(nowMs));
  const a = await newPlayer(service);
  await newPlayer(service);
  await service.setupDone(a);
  nowMs += 5 * 60_000;
  const list = await service.listForAdmin();
  assert.equal(list.players.length, 2);
  const stages = list.players.map((p) => p.currentStage).sort();
  assert.deepEqual(stages, ["q1", "setup"]);
  assert.ok(list.players.every((p) => p.stuckMinutes === 5));
  const id = list.players[0]?.id ?? "";
  await expectStatus(service.deletePlayer("bad id!"), 400);
  await service.deletePlayer(id);
  await expectStatus(service.deletePlayer(id), 404);
  assert.equal((await service.listForAdmin()).players.length, 1);
  await service.resetAll();
  assert.equal((await service.listForAdmin()).players.length, 0);
  await expectStatus(service.me(a), 401);
});

test("concurrency: 10 parallel hints and wrong answers stay consistent", async () => {
  const { service } = setup();
  const token = await newPlayer(service);
  await service.setupDone(token);

  const hintResults = await Promise.allSettled(Array.from({ length: 10 }, () => service.hint(token, "q1")));
  const hintOk = hintResults.filter((r) => r.status === "fulfilled").length;
  assert.ok(hintResults.every((r) => r.status === "fulfilled" || (r.reason instanceof AppError && r.reason.status === 409)));
  assert.equal(hintOk, 3);
  assert.equal((await service.me(token)).stages.q1.hintsRevealed, 3);

  const answerResults = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => service.answer(token, "q1", `bad${i}`)));
  const answered = answerResults.filter((r) => r.status === "fulfilled").length;
  assert.ok(answerResults.every((r) => r.status === "fulfilled" || (r.reason instanceof AppError && [409, 429].includes(r.reason.status))));
  const stage = (await service.me(token)).stages.q1;
  assert.equal(stage.wrongAttempts, answered);
  assert.ok(stage.wrongAttempts <= 5);

  const solves = await Promise.all(Array.from({ length: 5 }, () => service.reveal(token, "q2").catch(() => null)));
  assert.ok(solves.length === 5);
});
