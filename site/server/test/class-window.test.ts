// Class scoring windows (#180): the pure rules in domain/class-board.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCORING } from "../../shared/contract.ts";
import { caseCounts, classBoardRows, classFirstSolvers, classTotals, classWindow, momentCounts } from "../domain/class-board.ts";
import type { ClassBoardMember, ClassWindowSource } from "../domain/class-board.ts";
import type { ScoreCase } from "../domain/score.ts";

const PUBLIC = ["alpha", "beta"];
const NOW = new Date("2026-12-01T12:00:00Z");
const source = (over: Partial<ClassWindowSource["event"]> & { caseIds?: string[] } = {}): ClassWindowSource => ({
  caseIds: over.caseIds ?? [],
  event: { startsAt: over.startsAt ?? null, endsAt: over.endsAt ?? null, freezeAt: over.freezeAt ?? null },
});
const windowOf = (over: Parameters<typeof source>[0] = {}, now = NOW) => classWindow(source(over), { now, publicCaseIds: PUBLIC });
const NIGHT = { startsAt: "2026-12-01T10:00:00Z", endsAt: "2026-12-01T12:00:00Z" };

const solve = (q: "q1" | "q2" | "q3", at: string | null, points = 100, firstBlood = false) => ({ q, at, points, firstBlood });
const caseOf = (solves: ScoreCase["solves"], completedAt: string | null = null, completionBonus = 0): ScoreCase => ({ solves, completedAt, completionBonus });
const member = (accountId: string, cases: Record<string, ScoreCase>): ClassBoardMember => ({ accountId, username: accountId, cases });

test("case rule: assigned cases only, or any public case when none are assigned", () => {
  assert.equal(caseCounts("alpha", windowOf()), true);
  assert.equal(caseCounts("beta", windowOf()), true);
  assert.equal(caseCounts("private-draft", windowOf()), false, "an empty list means public cases, not every case");
  assert.equal(caseCounts("alpha", windowOf({ caseIds: ["beta"] })), false);
  assert.equal(caseCounts("beta", windowOf({ caseIds: ["beta"] })), true);
});

test("window rule: inside counts, before and after don't; start inclusive, end exclusive", () => {
  const w = windowOf(NIGHT);
  assert.equal(momentCounts("2026-12-01T09:59:59.999Z", w), false, "before the start");
  assert.equal(momentCounts("2026-12-01T10:00:00.000Z", w), true, "exactly the start");
  assert.equal(momentCounts("2026-12-01T11:30:00Z", w), true, "inside");
  assert.equal(momentCounts("2026-12-01T11:59:59.999Z", w), true, "the last moment");
  assert.equal(momentCounts("2026-12-01T12:00:00.000Z", w), false, "exactly the end");
  assert.equal(momentCounts("2026-12-02T08:00:00Z", w), false, "the next day");
  assert.equal(momentCounts(null, w), false, "an unknown time can't be placed in a window");
});

test("window rule: a half-set window (only a start or only an end) restricts nothing", () => {
  assert.equal(momentCounts("2020-01-01T00:00:00Z", windowOf({ startsAt: NIGHT.startsAt })), true);
  assert.equal(momentCounts("2030-01-01T00:00:00Z", windowOf({ endsAt: NIGHT.endsAt })), true);
  assert.equal(momentCounts(null, windowOf()), true, "no time rule: an unknown time counts, like the global board");
});

test("freeze rule: only once now has reached freezeAt; the freeze moment itself still counts", () => {
  const freezeAt = "2026-12-01T11:45:00Z";
  const before = windowOf({ ...NIGHT, freezeAt }, new Date("2026-12-01T11:44:59Z"));
  assert.equal(before.cutoff, null, "not frozen yet");
  assert.equal(momentCounts("2026-12-01T11:50:00Z", before), true);
  const frozen = windowOf({ ...NIGHT, freezeAt }, new Date(freezeAt));
  assert.equal(frozen.cutoff, freezeAt);
  assert.equal(momentCounts("2026-12-01T11:45:00.000Z", frozen), true, "at the freeze");
  assert.equal(momentCounts("2026-12-01T11:45:00.001Z", frozen), false, "after the freeze");
  assert.equal(momentCounts(null, frozen), false);
  // A freeze without a window freezes the all-time class board.
  const onlyFreeze = windowOf({ freezeAt }, NOW);
  assert.equal(momentCounts("2026-11-01T00:00:00Z", onlyFreeze), true);
  assert.equal(momentCounts("2026-12-01T11:46:00Z", onlyFreeze), false);
});

test("completion bonus counts by completedAt with the same rules", () => {
  const w = windowOf({ ...NIGHT, caseIds: ["alpha"] });
  const first = { caseId: null, firstSolvers: new Map<string, string>() };
  const inside = member("a", { alpha: caseOf([solve("q1", "2026-12-01T10:10:00Z")], "2026-12-01T11:00:00Z", SCORING.COMPLETION_BONUS) });
  assert.deepEqual(classTotals(inside, w, first), { score: 100 + SCORING.COMPLETION_BONUS, stagesSolved: 1, casesCompleted: 1, firstBloods: 0, lastSolveAt: "2026-12-01T10:10:00Z" });
  // Solved inside, completed after the end: the stage counts, the bonus doesn't.
  const lateFinish = member("b", { alpha: caseOf([solve("q1", "2026-12-01T10:10:00Z")], "2026-12-01T12:30:00Z", SCORING.COMPLETION_BONUS) });
  assert.equal(classTotals(lateFinish, w, first).casesCompleted, 0);
  assert.equal(classTotals(lateFinish, w, first).score, 100);
  // Completed on an unassigned case: nothing counts.
  const otherCase = member("c", { beta: caseOf([solve("q1", "2026-12-01T10:10:00Z")], "2026-12-01T11:00:00Z", SCORING.COMPLETION_BONUS) });
  assert.equal(classTotals(otherCase, w, first).score, 0);
});

test("first solver per case and question comes from the counted solve times", () => {
  const w = windowOf(NIGHT);
  const members = [
    member("ada", { alpha: caseOf([solve("q1", "2026-12-01T10:05:00Z"), solve("q2", "2026-12-01T10:30:00Z")]) }),
    member("bob", { alpha: caseOf([solve("q1", "2026-12-01T10:06:00Z"), solve("q2", "2026-12-01T10:20:00Z")]) }),
    // Solved q1 earlier than anyone, but before the window: that solve doesn't count, so it can't be first.
    member("cat", { alpha: caseOf([solve("q1", "2026-11-30T10:00:00Z")]) }),
  ];
  const first = classFirstSolvers(members, w);
  assert.equal(first.get("alpha:q1"), "ada");
  assert.equal(first.get("alpha:q2"), "bob");
  // Same moment: the lower account id wins, whatever the order.
  const tied = classFirstSolvers([member("zed", { alpha: caseOf([solve("q1", "2026-12-01T10:05:00Z")]) }), member("amy", { alpha: caseOf([solve("q1", "2026-12-01T10:05:00Z")]) })], w);
  assert.equal(tied.get("alpha:q1"), "amy");
});

test("the class first solver gets the first-blood bonus instead of the site-wide one", () => {
  const w = windowOf(NIGHT);
  // Bob took site-wide first blood on q1 (his points include the bonus) but solved after Ada within the class.
  const ada = member("ada", { alpha: caseOf([solve("q1", "2026-12-01T10:05:00Z", 100, false)]) });
  const bob = member("bob", { alpha: caseOf([solve("q1", "2026-12-01T10:06:00Z", 100 + SCORING.FIRST_BLOOD_BONUS, true)]) });
  const rows = classBoardRows([bob, ada], w, { caseId: null });
  assert.deepEqual(rows.map((r) => [r.username, r.score, r.firstBloods, r.rank]), [["ada", 100 + SCORING.FIRST_BLOOD_BONUS, 1, 1], ["bob", 100, 0, 2]]);
});

test("board rows: only members with a counted solve, ranked with shared ranks, optional per case", () => {
  const w = windowOf({ ...NIGHT, caseIds: ["alpha", "beta"] });
  const members = [
    member("ada", { alpha: caseOf([solve("q1", "2026-12-01T10:05:00Z")]), beta: caseOf([solve("q1", "2026-12-01T10:40:00Z", 50)]) }),
    member("bob", { alpha: caseOf([solve("q1", "2026-12-01T10:07:00Z", 100 + SCORING.FIRST_BLOOD_BONUS)]) }),
    member("cat", { alpha: caseOf([solve("q1", "2026-12-01T09:00:00Z")]) }), // only outside the window
    member("dan", {}),
  ];
  const all = classBoardRows(members, w, { caseId: null });
  assert.deepEqual(all.map((r) => r.username), ["ada", "bob"]);
  assert.equal(all[0]?.score, 100 + SCORING.FIRST_BLOOD_BONUS + 50 + SCORING.FIRST_BLOOD_BONUS);
  const beta = classBoardRows(members, w, { caseId: "beta" });
  assert.deepEqual(beta.map((r) => [r.username, r.score]), [["ada", 50 + SCORING.FIRST_BLOOD_BONUS]]);
  const tie = classBoardRows([member("x", { alpha: caseOf([solve("q2", "2026-12-01T10:01:00Z")]) }), member("y", { alpha: caseOf([solve("q3", "2026-12-01T10:02:00Z")]) })], w, { caseId: null });
  assert.deepEqual(tie.map((r) => r.rank), [1, 1], "the same score shares a rank");
  assert.deepEqual(tie.map((r) => r.username), ["x", "y"], "whoever got there first is listed first");
  assert.deepEqual(classBoardRows(members, windowOf({ caseIds: ["beta"] }), { caseId: "alpha" }), [], "an unassigned case shows an empty board");
});
