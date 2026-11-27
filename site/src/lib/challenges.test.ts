import { test } from "node:test";
import assert from "node:assert/strict";
import { boardEntryFor, classEventPhase, classRoleKind, dateInZone, homeClasses, isClassBoardFrozen, nextAchievement } from "./challenges.ts";

const NOW = Date.parse("2026-11-27T20:00:00Z");
const IDS = ["first-blood", "clean-case", "speedrun", "no-hints-5", "all-cases", "streak-3", "streak-7"];

test("class event phase: none, before, live with and without an end, over; freeze", () => {
  assert.deepEqual(classEventPhase(undefined, NOW), { kind: "none" });
  assert.deepEqual(classEventPhase({ startsAt: null, endsAt: null }, NOW), { kind: "none" });
  assert.deepEqual(classEventPhase({ startsAt: "2026-11-27T21:00:00Z", endsAt: null }, NOW), { kind: "before", msLeft: 3_600_000 });
  assert.deepEqual(classEventPhase({ startsAt: "2026-11-27T19:00:00Z", endsAt: "2026-11-27T20:30:00Z" }, NOW), { kind: "live", msLeft: 1_800_000 });
  assert.deepEqual(classEventPhase({ startsAt: "2026-11-27T19:00:00Z", endsAt: null }, NOW), { kind: "live", msLeft: null });
  assert.deepEqual(classEventPhase({ startsAt: null, endsAt: "2026-11-27T19:00:00Z" }, NOW), { kind: "over" });
  assert.equal(isClassBoardFrozen({ freezeAt: "2026-11-27T19:59:00Z" }, NOW), true);
  assert.equal(isClassBoardFrozen({ freezeAt: "2026-11-27T20:01:00Z" }, NOW), false);
  assert.equal(isClassBoardFrozen({ freezeAt: null }, NOW), false);
});

test("dates in a time zone", () => {
  // 20:00 UTC is already the 28th in Tokyo
  assert.equal(dateInZone("Asia/Tokyo", NOW), "2026-11-28");
  assert.equal(dateInZone("Not/AZone", NOW), null);
});

test("home lists active memberships first, skips archived classes and the admin's, and caps the list", () => {
  const cls = (id: string, status: "active" | "archived", membership: "active" | "pending" | null) => ({
    id,
    name: id,
    status,
    membership: membership === null ? null : { role: "member" as const, status: membership, isOwner: false },
  });
  const { shown, more } = homeClasses([cls("a", "active", "pending"), cls("b", "archived", "active"), cls("c", "active", null), cls("d", "active", "active")], 5);
  assert.deepEqual(shown.map((c) => c.id), ["d", "a"]);
  assert.equal(more, 0);
  const many = homeClasses(Array.from({ length: 7 }, (_, i) => cls(String(i), "active", "active")), 5);
  assert.equal(many.shown.length, 5);
  assert.equal(many.more, 2);
  assert.equal(classRoleKind(cls("p", "active", "pending")), "pending");
  assert.equal(classRoleKind({ ...cls("o", "active", "active"), membership: { role: "admin", status: "active", isOwner: true } }), "owner");
});

test("board entry matches usernames the way the server keys them", () => {
  const entries = [{ rank: 2, username: "Alice", score: 10, stagesSolved: 1, casesCompleted: 0, firstBloods: 0, lastSolveAt: null }];
  assert.equal(boardEntryFor(entries, " alice ")?.rank, 2);
  assert.equal(boardEntryFor(entries, "bob"), null);
});

test("next achievement: the closest measurable one, else the first locked, else none", () => {
  const base = { achievements: [], streak: { current: 0, best: 0, activeToday: false }, cases: [{}, {}, {}, {}] as never[], casesCompleted: 0 };
  assert.deepEqual(nextAchievement(base, IDS), { id: "streak-3", have: 0, need: 3 });
  assert.deepEqual(nextAchievement({ ...base, casesCompleted: 3 }, IDS), { id: "all-cases", have: 3, need: 4 });
  const streakDone = [{ id: "streak-3", earnedAt: "x" }];
  assert.deepEqual(nextAchievement({ ...base, achievements: streakDone, streak: { current: 4, best: 4, activeToday: false } }, IDS), { id: "streak-7", have: 4, need: 7 });
  const allButFirst = IDS.filter((id) => !["first-blood"].includes(id)).map((id) => ({ id, earnedAt: "x" }));
  assert.deepEqual(nextAchievement({ ...base, achievements: allButFirst }, IDS), { id: "first-blood", have: null, need: null });
  assert.equal(nextAchievement({ ...base, achievements: IDS.map((id) => ({ id, earnedAt: "x" })) }, IDS), null);
});
