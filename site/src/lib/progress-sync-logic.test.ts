import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTION_ORDER, type ProgressView, type StageProgress } from "../../shared/contract.ts";
import { decideIncoming, parseSyncMessage, progressWeight, sameProgress, shouldRefetch, REFETCH_FLOOR_MS } from "./progress-sync-logic.ts";

const stage = (over: Partial<StageProgress> = {}): StageProgress => ({
  status: "locked",
  startedAt: null,
  finishedAt: null,
  hintsRevealed: 0,
  wrongAttempts: 0,
  points: 0,
  revealedAnswer: null,
  commandsRevealed: 0,
  breakdown: null,
  solvedAnswer: null,
  ...over,
});

const progress = (q1: Partial<StageProgress> = {}, over: Partial<ProgressView> = {}): ProgressView => ({
  accountId: "acc-1",
  username: "Ada",
  caseId: "alpha",
  startedAt: "2026-11-27T10:00:00.000Z",
  setupDoneAt: "2026-11-27T10:01:00.000Z",
  completedAt: null,
  score: 0,
  maxScore: 1000,
  completionBonus: 0,
  stages: Object.fromEntries(QUESTION_ORDER.map((q) => [q, q === "q1" ? stage({ status: "active", ...q1 }) : stage()])) as ProgressView["stages"],
  commandsRevealed: {},
  unlocked: { hints: {}, commands: {} },
  ...over,
});

test("shouldRefetch keeps a 15 s floor", () => {
  assert.equal(REFETCH_FLOOR_MS, 15_000);
  assert.equal(shouldRefetch(1_000, 15_999), false);
  assert.equal(shouldRefetch(1_000, 16_000), true);
  assert.equal(shouldRefetch(0, 100, 50), true);
});

test("parseSyncMessage accepts only well-formed progress messages", () => {
  const ok = { kind: "progress", lang: "en", progress: progress() };
  assert.equal(parseSyncMessage(ok)?.progress.caseId, "alpha");
  assert.equal(parseSyncMessage(null), null);
  assert.equal(parseSyncMessage({ kind: "progress", lang: "fr", progress: progress() }), null);
  assert.equal(parseSyncMessage({ kind: "other", lang: "en", progress: progress() }), null);
  assert.equal(parseSyncMessage({ kind: "progress", lang: "en", progress: { caseId: "alpha" } }), null);
});

test("progressWeight grows with every paid or counted action", () => {
  const base = progressWeight(progress());
  assert.equal(progressWeight(progress({ hintsRevealed: 1 })), base + 1);
  assert.equal(progressWeight(progress({ wrongAttempts: 2, commandsRevealed: 1 })), base + 3);
  assert.equal(progressWeight(progress({ status: "solved" })), base + 1);
  assert.equal(progressWeight(progress({}, { setupDoneAt: null })), base - 1);
});

test("decideIncoming applies newer progress of the same case and account only", () => {
  const current = progress({ hintsRevealed: 1 });
  const newer = { kind: "progress" as const, lang: "en" as const, progress: progress({ hintsRevealed: 2 }) };
  assert.equal(decideIncoming(current, "en", newer), "apply");
  assert.equal(decideIncoming(current, "he", newer), "refetch"); // paid texts in the other language
  assert.equal(decideIncoming(current, "en", { ...newer, progress: progress({ hintsRevealed: 1 }) }), "ignore"); // same
  assert.equal(decideIncoming(current, "en", { ...newer, progress: progress() }), "ignore"); // older, arrived late
  assert.equal(decideIncoming(current, "en", { ...newer, progress: progress({ hintsRevealed: 2 }, { caseId: "beta" }) }), "ignore");
  assert.equal(decideIncoming(current, "en", { ...newer, progress: progress({ hintsRevealed: 2 }, { accountId: "acc-2" }) }), "ignore");
});

test("sameProgress compares the whole view", () => {
  assert.equal(sameProgress(progress(), progress()), true);
  assert.equal(sameProgress(progress(), progress({ wrongAttempts: 1 })), false);
});
