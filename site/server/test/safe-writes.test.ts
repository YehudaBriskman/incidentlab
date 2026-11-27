// Safe writes (#202, #203): a retried or stale hint, command or answer request never charges twice, a stale one
// answers 409 "stale" with the current progress, and clients that don't send the new fields keep working.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountResponseSchema, AnswerResponseSchema, ErrorBodySchema, ProgressResponseSchema } from "../../shared/contract.ts";
import { createHarness, expectStatus } from "./helpers.ts";

const startedPlayer = async (username: string) => {
  const harness = createHarness();
  const player = harness.client();
  await player.call("/auth/register", { body: { username, password: "password1" } });
  const id = (await player.json(await player.call("/me"), AccountResponseSchema)).account.id;
  await expectStatus(harness.admin(`/admin/accounts/${id}/approve`, { body: {} }), 200);
  await player.call("/cases/alpha/progress");
  await expectStatus(player.call("/cases/alpha/setup-done", { body: {} }), 200);
  return player;
};

const staleBody = async (res: Response) => {
  assert.equal(res.status, 409, await res.clone().text());
  const body = ErrorBodySchema.parse(await res.json());
  assert.equal(body.code, "stale");
  assert.ok(body.progress, "a stale answer carries the current progress");
  return body.progress;
};

test("a retried hint request charges once and answers stale with the progress", async () => {
  const player = await startedPlayer("Retry");
  const first = await player.json(await player.call("/cases/alpha/hint", { body: { questionId: "q1", expectedHint: 0 } }), ProgressResponseSchema);
  assert.equal(first.progress.stages.q1.hintsRevealed, 1);
  // The same request again (the client retried after a lost response): nothing more is bought.
  const progress = await staleBody(await player.call("/cases/alpha/hint", { body: { questionId: "q1", expectedHint: 0 } }));
  assert.equal(progress.stages.q1.hintsRevealed, 1);
  assert.deepEqual(progress.unlocked.hints.q1, ["q1 hint 1"]);
  const after = await player.json(await player.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(after.progress.stages.q1.hintsRevealed, 1);
});

test("a stale tab cannot buy the next hint by accident", async () => {
  const player = await startedPlayer("Tabs");
  await expectStatus(player.call("/cases/alpha/hint", { body: { questionId: "q1", expectedHint: 0 } }), 200); // tab A
  await expectStatus(player.call("/cases/alpha/hint", { body: { questionId: "q1", expectedHint: 1 } }), 200); // tab A again
  // Tab B still shows "hint 1" and asks for it: refused, not charged for hint 3.
  const progress = await staleBody(await player.call("/cases/alpha/hint", { body: { questionId: "q1", expectedHint: 0 } }));
  assert.equal(progress.stages.q1.hintsRevealed, 2);
  // A hint ahead of the server's count is stale too.
  await staleBody(await player.call("/cases/alpha/hint", { body: { questionId: "q1", expectedHint: 5 } }));
  // A hint on a stage that is finished now is stale (with the progress), not a bare conflict.
  await expectStatus(player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } }), 200);
  const finished = await staleBody(await player.call("/cases/alpha/hint", { body: { questionId: "q1", expectedHint: 2 } }));
  assert.equal(finished.stages.q1.status, "solved");
  assert.equal(finished.stages.q2.status, "active");
});

test("an old client without expectedHint still buys hints in order", async () => {
  const player = await startedPlayer("OldClient");
  for (let i = 1; i <= 3; i++) {
    const res = await player.json(await player.call("/cases/alpha/hint", { body: { questionId: "q1" } }), ProgressResponseSchema);
    assert.equal(res.progress.stages.q1.hintsRevealed, i);
  }
  await expectStatus(player.call("/cases/alpha/hint", { body: { questionId: "q1" } }), 409);
});

test("a command reveal is charged only on the stage the client expects", async () => {
  const player = await startedPlayer("Commands");
  // The client shows q2 active, the server has q1: refused, nothing charged.
  const progress = await staleBody(await player.call("/cases/alpha/reveal-command", { body: { toolId: "grep-5xx", expectedStage: "q2" } }));
  assert.equal(progress.stages.q1.commandsRevealed, 0);
  assert.deepEqual(progress.commandsRevealed, {});
  const paid = await player.json(await player.call("/cases/alpha/reveal-command", { body: { toolId: "grep-5xx", expectedStage: "q1" } }), ProgressResponseSchema);
  assert.equal(paid.progress.stages.q1.commandsRevealed, 1);
  // A retry of the same reveal is free: the command is already paid for.
  const retry = await player.json(await player.call("/cases/alpha/reveal-command", { body: { toolId: "grep-5xx", expectedStage: "q1" } }), ProgressResponseSchema);
  assert.equal(retry.progress.stages.q1.commandsRevealed, 1);
  // Old clients (no expectedStage) still pay on the active stage.
  const old = await player.json(await player.call("/cases/alpha/reveal-command", { body: { toolId: "jq-start" } }), ProgressResponseSchema);
  assert.equal(old.progress.stages.q1.commandsRevealed, 2);
});

test("the same wrong answer twice is counted once", async () => {
  const player = await startedPlayer("Double");
  const first = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "nope" } }), AnswerResponseSchema);
  assert.equal(first.correct, false);
  assert.equal(first.progress.stages.q1.wrongAttempts, 1);
  // A retried request, or the same text with other spacing and case: the same result, no second charge.
  for (const answer of ["nope", "  NOPE "]) {
    const again = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer } }), AnswerResponseSchema);
    assert.equal(again.correct, false);
    assert.equal(again.progress.stages.q1.wrongAttempts, 1);
  }
  // A different wrong answer counts, and so does the first one again after it.
  const other = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "other" } }), AnswerResponseSchema);
  assert.equal(other.progress.stages.q1.wrongAttempts, 2);
  const back = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "nope" } }), AnswerResponseSchema);
  assert.equal(back.progress.stages.q1.wrongAttempts, 3);
  const right = await player.json(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } }), AnswerResponseSchema);
  assert.equal(right.progress.stages.q1.breakdown?.wrong, -6);
});

test("repeating one wrong answer does not use up the rate limit", async () => {
  const player = await startedPlayer("Repeat");
  for (let i = 0; i < 8; i++) await expectStatus(player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "same" } }), 200);
  const progress = await player.json(await player.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(progress.progress.stages.q1.wrongAttempts, 1);
});

test("answering or revealing a finished stage is stale with the progress", async () => {
  const player = await startedPlayer("Finished");
  await expectStatus(player.call("/cases/alpha/reveal", { body: { questionId: "q1" } }), 200);
  const progress = await staleBody(await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "late" } }));
  assert.equal(progress.stages.q1.status, "revealed");
  // Re-revealing stays idempotent.
  await expectStatus(player.call("/cases/alpha/reveal", { body: { questionId: "q1" } }), 200);
});
