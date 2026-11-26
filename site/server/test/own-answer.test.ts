// #133: a solved stage keeps the player's own answer (`solvedAnswer`, an additive field with a default).
// Older records without it still parse and show nothing; only the player gets it back, never the admin live view
// or a public (CDN-cached) response.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountResponseSchema, AdminProgressResponseSchema, AnswerResponseSchema, ProgressResponseSchema, StageProgressSchema } from "../../shared/contract.ts";
import { ProgressRecordSchema } from "../domain/types.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { createHarness, expectStatus } from "./helpers.ts";

const approvedPlayer = async (harness: ReturnType<typeof createHarness>, username: string) => {
  const player = harness.client();
  await player.call("/auth/register", { body: { username, password: "password1" } });
  const id = (await player.json(await player.call("/me"), AccountResponseSchema)).account.id;
  await expectStatus(harness.admin(`/admin/accounts/${id}/approve`, { body: {} }), 200);
  return { player, id };
};

/** A stage as stored before #133: no `solvedAnswer` key at all. */
const oldStage = (status: "solved" | "active" | "locked") => ({
  status,
  startedAt: status === "locked" ? null : "2026-11-01T10:00:00.000Z",
  finishedAt: status === "solved" ? "2026-11-01T10:05:00.000Z" : null,
  hintsRevealed: 0,
  wrongAttempts: 0,
  points: status === "solved" ? 140 : 0,
  revealedAnswer: null,
  commandsRevealed: 0,
  breakdown: null,
});

const oldRecord = (accountId: string) => ({
  schemaVersion: 1,
  accountId,
  caseId: "alpha",
  startedAt: "2026-11-01T09:58:00.000Z",
  lastSeenAt: "2026-11-01T10:05:00.000Z",
  setupDoneAt: "2026-11-01T10:00:00.000Z",
  completedAt: null,
  stages: { q1: oldStage("solved"), q2: oldStage("active"), q3: oldStage("locked"), q4: oldStage("locked"), q5: oldStage("locked"), q6: oldStage("locked") },
  wrongAnswerTimestamps: {},
  commandsRevealed: {},
  completionBonus: 0,
});

test("an old progress record without solvedAnswer parses, with null on every stage", () => {
  const parsed = ProgressRecordSchema.parse(oldRecord("acc-1"));
  for (const stage of Object.values(parsed.stages)) assert.equal(stage.solvedAnswer, null);
  assert.equal(StageProgressSchema.parse(oldStage("solved")).solvedAnswer, null);
});

test("an old record still loads through the API: the solved stage shows no answer, the next solve stores one", async () => {
  const store = new InMemoryKvStore();
  const harness = createHarness({ store });
  const { player, id } = await approvedPlayer(harness, "Old");
  await store.set(`progress:alpha:${id}`, oldRecord(id));

  const before = await player.json(await player.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(before.progress.stages.q1.status, "solved");
  assert.equal(before.progress.stages.q1.solvedAnswer, null);

  const right = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q2", answer: " a2 " } }), AnswerResponseSchema);
  assert.equal(right.correct, true);
  assert.equal(right.progress.stages.q2.solvedAnswer, "a2");
  assert.equal(right.progress.stages.q1.solvedAnswer, null);
});

test("solvedAnswer: stored as typed on a correct answer, never on wrong or revealed stages, only for the player", async () => {
  const harness = createHarness();
  const { player } = await approvedPlayer(harness, "Ada");
  await expectStatus(player.call("/cases/alpha/setup-done", { body: {} }), 200);

  const wrong = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "nope" } }), AnswerResponseSchema);
  assert.equal(wrong.progress.stages.q1.solvedAnswer, null);
  const right = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "  ALPHA-A1 " } }), AnswerResponseSchema);
  assert.equal(right.progress.stages.q1.solvedAnswer, "ALPHA-A1");
  // a double submit is idempotent and keeps the first answer
  const again = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } }), AnswerResponseSchema);
  assert.equal(again.progress.stages.q1.solvedAnswer, "ALPHA-A1");

  const revealed = await player.json(await player.call("/cases/alpha/reveal", { body: { questionId: "q2" } }), ProgressResponseSchema);
  assert.equal(revealed.progress.stages.q2.solvedAnswer, null);
  assert.equal(revealed.progress.stages.q2.revealedAnswer, "a2");

  // The player's own progress carries it, with no-store.
  const own = await player.call("/cases/alpha/progress");
  assert.equal(own.headers.get("cache-control"), "no-store");
  assert.equal((await player.json(own, ProgressResponseSchema)).progress.stages.q1.solvedAnswer, "ALPHA-A1");

  // Another player's view of the same case doesn't (their own record).
  const { player: bob } = await approvedPlayer(harness, "Bob");
  const bobView = await bob.json(await bob.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(bobView.progress.stages.q1.solvedAnswer, null);

  // The admin live view blanks it.
  const liveRes = await harness.admin("/admin/progress?caseId=alpha");
  const liveText = await liveRes.clone().text();
  assert.ok(!liveText.includes("ALPHA-A1"), "admin live view must not carry the player's answer");
  const live = AdminProgressResponseSchema.parse(JSON.parse(liveText));
  for (const p of live.players) for (const s of Object.values(p.stages)) assert.equal(s.solvedAnswer, null);

  // Public, CDN-cacheable responses never carry it.
  for (const path of ["/leaderboard", "/leaderboard?caseId=alpha", "/today", "/event"]) {
    const res = await harness.client().call(path);
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assert.ok(!body.includes("ALPHA-A1") && !body.includes("solvedAnswer"), `${path} must not carry solvedAnswer`);
  }
});
