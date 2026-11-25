import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountResponseSchema,
  AdminAccountsResponseSchema,
  AdminProgressResponseSchema,
  AdminStatsResponseSchema,
  AnswerResponseSchema,
  DebriefResponseSchema,
  ProgressResponseSchema,
  ScheduleResponseSchema,
  TodayResponseSchema,
  UserStatsResponseSchema,
} from "../../shared/contract.ts";
import { ALL_ANSWERS, createHarness, expectStatus } from "./helpers.ts";

const approvedPlayer = async (harness: ReturnType<typeof createHarness>, username: string) => {
  const player = harness.client();
  await player.call("/auth/register", { body: { username, password: "password1" } });
  const id = (await player.json(await player.call("/me"), AccountResponseSchema)).account.id;
  await expectStatus(harness.admin(`/admin/accounts/${id}/approve`, { body: {} }), 200);
  return { player, id };
};

test("staged flow, scoring, reveal, debrief per case", async () => {
  const harness = createHarness();
  const { player } = await approvedPlayer(harness, "Ada");
  const progress = await player.json(await player.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(progress.progress.maxScore, 650);
  assert.equal(progress.progress.stages.q1.status, "locked");

  await expectStatus(player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "x" } }), 403, "locked");
  await expectStatus(player.call("/cases/alpha/setup-done", { body: {} }), 200);
  await expectStatus(player.call("/cases/alpha/hint", { body: { questionId: "q1" } }), 200);
  const wrong = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "nope" } }), AnswerResponseSchema);
  assert.equal(wrong.correct, false);
  // the other case's answer must not work here
  const crossCase = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "beta-a1" } }), AnswerResponseSchema);
  assert.equal(crossCase.correct, false);
  const right = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "  ALPHA-A1 " } }), AnswerResponseSchema);
  assert.equal(right.correct, true);
  assert.equal(right.progress.stages.q1.points, 90);

  await expectStatus(player.call("/cases/alpha/debrief"), 403, "locked");
  const revealed = await player.json(await player.call("/cases/alpha/reveal", { body: { questionId: "q2" } }), ProgressResponseSchema);
  assert.equal(revealed.progress.stages.q2.revealedAnswer, "a2");
  for (const [i, answer] of ALL_ANSWERS.slice(1).entries()) {
    await expectStatus(player.call("/cases/alpha/answer", { body: { questionId: `q${i + 3}`, answer } }), 200);
  }
  const en = await player.json(await player.call("/cases/alpha/debrief"), DebriefResponseSchema);
  assert.equal(en.markdown, "# debrief alpha");
  const he = await player.json(await player.call("/cases/alpha/debrief?lang=he"), DebriefResponseSchema);
  assert.equal(he.markdown, "# תחקיר alpha");

  // beta is independent
  const beta = await player.json(await player.call("/cases/beta/progress"), ProgressResponseSchema);
  assert.equal(beta.progress.setupDoneAt, null);
  await expectStatus(player.call("/cases/nope/progress"), 404, "unknown-case");
});

test("wrong-answer rate limit per question", async () => {
  const harness = createHarness();
  const { player } = await approvedPlayer(harness, "Spammer");
  await player.call("/cases/alpha/progress");
  await player.call("/cases/alpha/setup-done", { body: {} });
  for (let i = 0; i < 5; i++) await expectStatus(player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: `w${i}` } }), 200);
  await expectStatus(player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "w" } }), 429, "rate-limited");
});

test("parallel correct answers score once", async () => {
  const harness = createHarness();
  const { player } = await approvedPlayer(harness, "Racer");
  await player.call("/cases/alpha/setup-done", { body: {} });
  const results = await Promise.all(Array.from({ length: 5 }, () => player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } })));
  assert.ok(results.every((r) => r.status === 200));
  const after = await player.json(await player.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(after.progress.score, 100);
  assert.equal(after.progress.stages.q2.status, "active");
});

test("schedule: today's case, lock-to-today, validation", async () => {
  let now = new Date("2026-11-25T21:30:00Z"); // 23:30 in Jerusalem
  const harness = createHarness({ now: () => now });
  const { player } = await approvedPlayer(harness, "Early");
  await player.call("/cases/beta/setup-done", { body: {} }); // started before the lock

  await expectStatus(harness.admin("/admin/schedule", { method: "PUT", body: { timezone: "Mars/Olympus", defaultCaseId: null, days: {}, lockToToday: false } }), 400);
  await expectStatus(harness.admin("/admin/schedule", { method: "PUT", body: { timezone: "UTC", defaultCaseId: "nope", days: {}, lockToToday: false } }), 400);
  const saved = await player.json(
    await harness.admin("/admin/schedule", { method: "PUT", body: { timezone: "Asia/Jerusalem", defaultCaseId: "beta", days: { "2026-11-26": "alpha" }, lockToToday: true } }),
    ScheduleResponseSchema,
  );
  assert.equal(saved.schedule.days["2026-11-26"], "alpha");

  const today = await player.json(await player.call("/today"), TodayResponseSchema);
  assert.equal(today.date, "2026-11-25");
  assert.equal(today.caseId, "beta");
  assert.deepEqual(today.releasedCaseIds, ["alpha", "beta"]);

  // alpha is locked today: viewing works but stores nothing, starting is refused
  const view = await player.json(await player.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(view.progress.startedAt, null);
  await expectStatus(player.call("/cases/alpha/setup-done", { body: {} }), 403, "not-today");

  now = new Date("2026-11-25T22:30:00Z"); // 00:30 on the 26th in Jerusalem
  const tomorrow = await player.json(await player.call("/today"), TodayResponseSchema);
  assert.equal(tomorrow.caseId, "alpha");
  await expectStatus(player.call("/cases/alpha/setup-done", { body: {} }), 200);
  // beta was already started, so it stays playable
  await expectStatus(player.call("/cases/beta/answer", { body: { questionId: "q1", answer: "beta-a1" } }), 200);
});

test("stats: per user, rank, per case, admin live view and resets", async () => {
  const harness = createHarness();
  const ada = await approvedPlayer(harness, "Ada");
  const bob = await approvedPlayer(harness, "Bob");
  const pending = harness.client();
  await pending.call("/auth/register", { body: { username: "Pending", password: "password1" } });

  await ada.player.call("/cases/alpha/setup-done", { body: {} });
  await ada.player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "wrong" } });
  await ada.player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } });
  await bob.player.call("/cases/alpha/progress");

  const mine = await ada.player.json(await ada.player.call("/me/stats"), UserStatsResponseSchema);
  assert.equal(mine.stats.totalScore, 100);
  assert.equal(mine.stats.rank, 1);
  assert.equal(mine.stats.accuracy, 0.5);
  assert.equal(mine.stats.casesStarted, 1);
  assert.equal(mine.stats.cases.find((c) => c.caseId === "alpha")?.status, "in-progress");
  assert.equal(mine.stats.cases.find((c) => c.caseId === "beta")?.status, "not-started");
  const bobStats = await bob.player.json(await bob.player.call("/me/stats"), UserStatsResponseSchema);
  assert.equal(bobStats.stats.rank, 2);

  const all = await ada.player.json(await harness.admin("/admin/accounts"), AdminAccountsResponseSchema);
  assert.deepEqual(all.accounts.map((a) => [a.username, a.status, a.rank]), [["Ada", "approved", 1], ["Bob", "approved", 2], ["Pending", "pending", null]]);

  const live = await ada.player.json(await harness.admin("/admin/progress?caseId=alpha"), AdminProgressResponseSchema);
  assert.deepEqual(live.players.map((p) => [p.username, p.currentStage]), [["Ada", "q2"], ["Bob", "setup"]]);
  await expectStatus(harness.admin("/admin/progress"), 400);

  const summary = await ada.player.json(await harness.admin("/admin/stats"), AdminStatsResponseSchema);
  const alpha = summary.cases.find((c) => c.caseId === "alpha");
  assert.equal(alpha?.players, 2);
  assert.equal(alpha?.questions.q1.solved, 1);

  await expectStatus(harness.admin(`/admin/progress/${ada.id}/alpha`, { method: "DELETE" }), 204);
  const reset = await ada.player.json(await ada.player.call("/me/stats"), UserStatsResponseSchema);
  assert.equal(reset.stats.totalScore, 0);
  await expectStatus(harness.admin("/admin/reset", { body: { confirm: "nope" } }), 400);
  await expectStatus(harness.admin("/admin/reset", { body: { confirm: "RESET", caseId: "alpha" } }), 204);
  const empty = await ada.player.json(await harness.admin("/admin/progress?caseId=alpha"), AdminProgressResponseSchema);
  assert.equal(empty.players.length, 0);
});

test("body limits and content type", async () => {
  const harness = createHarness();
  const { player } = await approvedPlayer(harness, "Limits");
  await player.call("/cases/alpha/setup-done", { body: {} });
  await expectStatus(player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "x".repeat(5000) } }), 413);
  await expectStatus(player.call("/cases/alpha/answer", { method: "POST", headers: { "content-type": "text/plain" } }), 415);
});
