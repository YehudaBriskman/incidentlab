import { test } from "node:test";
import assert from "node:assert/strict";
import { SCORING } from "../../shared/contract.ts";
import { ProgressRecordSchema } from "../domain/types.ts";
import { scoreStage, timeBonus } from "../services/scoring.ts";

test("time bonus: full within target, fades linearly to 0 at 3x", () => {
  assert.equal(timeBonus(0, 600), SCORING.TIME_BONUS_MAX);
  assert.equal(timeBonus(600, 600), 30);
  assert.equal(timeBonus(1200, 600), 15);
  assert.equal(timeBonus(1800, 600), 0);
  assert.equal(timeBonus(99999, 600), 0);
});

test("stage score: penalties floor at 0, bonuses on top", () => {
  const base = { basePoints: 100, hintCosts: [10, 20, 40], targetSeconds: 600, solveSeconds: 300, isFirstBlood: false };
  const clean = scoreStage({ ...base, stage: { hintsRevealed: 0, wrongAttempts: 0, commandsRevealed: 0 } });
  assert.deepEqual([clean.total, clean.clean, clean.time], [140, 10, 30]);

  const messy = scoreStage({ ...base, stage: { hintsRevealed: 2, wrongAttempts: 3, commandsRevealed: 2 } });
  assert.deepEqual([messy.hints, messy.wrong, messy.commands, messy.clean], [-30, -6, -10, 0]);
  assert.equal(messy.total, 100 - 30 - 6 - 10 + 30);

  const capped = scoreStage({ ...base, stage: { hintsRevealed: 0, wrongAttempts: 50, commandsRevealed: 0 } });
  assert.equal(capped.wrong, -SCORING.WRONG_CAP);

  const floored = scoreStage({ ...base, solveSeconds: 5000, isFirstBlood: true, stage: { hintsRevealed: 3, wrongAttempts: 20, commandsRevealed: 10 } });
  assert.equal(floored.total, 0 + 0 + 0 + 15); // penalised base floors at 0, first blood still counts
});

test("old progress records (pre scoring v2) still parse", () => {
  const stage = { status: "solved", startedAt: "2026-11-20T10:00:00Z", finishedAt: "2026-11-20T10:05:00Z", hintsRevealed: 1, wrongAttempts: 0, points: 90, revealedAnswer: null };
  const parsed = ProgressRecordSchema.parse({
    accountId: "a", caseId: "c", startedAt: "x", lastSeenAt: "x", setupDoneAt: "x", completedAt: null,
    stages: { q1: stage, q2: stage, q3: stage, q4: stage, q5: stage, q6: stage }, wrongAnswerTimestamps: {},
  });
  assert.equal(parsed.stages.q1?.points, 90);
  assert.equal(parsed.stages.q1?.breakdown, null);
  assert.equal(parsed.stages.q1?.commandsRevealed, 0);
  assert.deepEqual(parsed.commandsRevealed, {});
  assert.equal(parsed.completionBonus, 0);
});
