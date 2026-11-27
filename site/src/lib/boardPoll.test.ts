import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_IDLE_PAUSE_MS,
  BOARD_POLL_LIVE_MS,
  BOARD_POLL_QUIET_MS,
  boardPollDecision,
  boardSignature,
  fnv1a,
  type BoardPollInput,
} from "./boardPoll.ts";

const T0 = 1_800_000_000_000;
const base: BoardPollInput = { hidden: false, eventLive: false, msUntilStart: null, projector: false, nowMs: T0, lastInputMs: T0 };
const at = (patch: Partial<BoardPollInput>): BoardPollInput => ({ ...base, ...patch });

test("10 s while the followed event is live, 60 s otherwise", () => {
  assert.deepEqual(boardPollDecision(at({ eventLive: true })), { kind: "wait", delayMs: BOARD_POLL_LIVE_MS });
  assert.deepEqual(boardPollDecision(base), { kind: "wait", delayMs: BOARD_POLL_QUIET_MS });
  assert.equal(BOARD_POLL_LIVE_MS, 10_000);
  assert.equal(BOARD_POLL_QUIET_MS, 60_000);
});

test("an upcoming start shortens the quiet wait to the start, never below a second", () => {
  assert.deepEqual(boardPollDecision(at({ msUntilStart: 25_000 })), { kind: "wait", delayMs: 25_000 });
  assert.deepEqual(boardPollDecision(at({ msUntilStart: 5 * 60_000 })), { kind: "wait", delayMs: BOARD_POLL_QUIET_MS });
  assert.deepEqual(boardPollDecision(at({ msUntilStart: 200 })), { kind: "wait", delayMs: 1_000 });
  assert.deepEqual(boardPollDecision(at({ msUntilStart: -5 })), { kind: "wait", delayMs: BOARD_POLL_QUIET_MS });
});

test("a hidden tab never polls", () => {
  assert.deepEqual(boardPollDecision(at({ hidden: true, eventLive: true, projector: true })), { kind: "hidden" });
});

test("15 idle minutes pause the board; input just before keeps it going", () => {
  assert.equal(BOARD_IDLE_PAUSE_MS, 15 * 60_000);
  assert.deepEqual(boardPollDecision(at({ nowMs: T0 + BOARD_IDLE_PAUSE_MS })), { kind: "paused" });
  assert.deepEqual(boardPollDecision(at({ nowMs: T0 + BOARD_IDLE_PAUSE_MS - 1 })), { kind: "wait", delayMs: BOARD_POLL_QUIET_MS });
  assert.deepEqual(boardPollDecision(at({ nowMs: T0 + BOARD_IDLE_PAUSE_MS, eventLive: true })), { kind: "paused" }, "a player's tab pauses even in an event");
});

test("a projector counts as watched while an event is live, and pauses like any tab otherwise", () => {
  const hourLater = T0 + 60 * 60_000;
  assert.deepEqual(boardPollDecision(at({ projector: true, eventLive: true, nowMs: hourLater })), { kind: "wait", delayMs: BOARD_POLL_LIVE_MS });
  assert.deepEqual(boardPollDecision(at({ projector: true, nowMs: hourLater })), { kind: "paused" });
});

const entry = (username: string, score: number) => ({ rank: 1, username, score, stagesSolved: 3, casesCompleted: 0, firstBloods: 1, lastSolveAt: null });

test("the board signature ignores generatedAt and changes with any drawn field", () => {
  const data = { caseId: null, frozen: false, frozenAt: null, generatedAt: "2026-11-27T10:00:00Z", entries: [entry("ada", 500)] };
  const same = boardSignature(data);
  assert.match(same, /^[0-9a-f]{8}$/);
  assert.equal(boardSignature({ ...data, generatedAt: "2026-11-27T10:00:10Z" }), same);
  assert.notEqual(boardSignature({ ...data, entries: [entry("ada", 510)] }), same);
  assert.notEqual(boardSignature({ ...data, entries: [entry("bob", 500)] }), same);
  assert.notEqual(boardSignature({ ...data, frozen: true, frozenAt: "2026-11-27T10:00:00Z" }), same);
  assert.notEqual(boardSignature({ ...data, caseId: "alpha" }), same);
  assert.notEqual(boardSignature({ ...data, entries: [] }), same);
});

test("fnv1a matches the reference values", () => {
  assert.equal(fnv1a(""), "811c9dc5");
  assert.equal(fnv1a("a"), "e40c292c");
  assert.equal(fnv1a("foobar"), "bf9cf968");
});
