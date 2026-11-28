// The leaderboard's week and month periods (#239): computed from the `score:` summaries' solve times, served
// from the same CDN-cached route with ?period=, and purged with the board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountResponseSchema, LeaderboardResponseSchema } from "../../shared/contract.ts";
import { periodStart, zonedMidnight } from "../domain/period.ts";
import { boardTotals } from "../domain/score.ts";
import type { CachePurger, CacheTag } from "../services/CachePurger.ts";
import { ALL_ANSWERS, createHarness, expectStatus } from "./helpers.ts";
import type { Client } from "./helpers.ts";

test("a week starts on Monday 00:00 and a month on the 1st 00:00, in the schedule's time zone", () => {
  // Saturday 28 Nov 2026, 10:00 UTC = 12:00 in Jerusalem (UTC+2 in winter).
  const now = new Date("2026-11-28T10:00:00Z");
  assert.equal(periodStart("all", now, "Asia/Jerusalem"), null);
  assert.equal(periodStart("week", now, "Asia/Jerusalem"), "2026-11-22T22:00:00.000Z", "Mon 23 Nov 00:00 in Jerusalem");
  assert.equal(periodStart("month", now, "Asia/Jerusalem"), "2026-10-31T22:00:00.000Z", "1 Nov 00:00 in Jerusalem");
  assert.equal(periodStart("week", now, "UTC"), "2026-11-23T00:00:00.000Z");
  // A Monday at 00:30 local is already in the new week; 23:30 on the Sunday before is still in the old one.
  assert.equal(periodStart("week", new Date("2026-11-22T22:30:00Z"), "Asia/Jerusalem"), "2026-11-22T22:00:00.000Z");
  assert.equal(periodStart("week", new Date("2026-11-22T21:30:00Z"), "Asia/Jerusalem"), "2026-11-15T22:00:00.000Z");
  // On a Sunday the week began six days earlier.
  assert.equal(periodStart("week", new Date("2026-11-29T12:00:00Z"), "UTC"), "2026-11-23T00:00:00.000Z");
});

test("period starts follow daylight saving time", () => {
  // Jerusalem is UTC+3 in summer: 1 Jul 2026 00:00 local = 30 Jun 21:00 UTC.
  assert.equal(new Date(zonedMidnight(2026, 7, 1, "Asia/Jerusalem")).toISOString(), "2026-06-30T21:00:00.000Z");
  // New York, the month DST ends (1 Nov 2026): the month began at 00:00 EDT (UTC-4) on 1 Nov.
  assert.equal(periodStart("month", new Date("2026-11-20T12:00:00Z"), "America/New_York"), "2026-11-01T04:00:00.000Z");
  // A week that spans the change: Monday 2 Nov 00:00 EST (UTC-5).
  assert.equal(periodStart("week", new Date("2026-11-04T12:00:00Z"), "America/New_York"), "2026-11-02T05:00:00.000Z");
});

test("boardTotals counts only what happened from `since`, with the freeze cut on top", () => {
  const cases = {
    alpha: {
      solves: [
        { q: "q1" as const, points: 100, at: "2026-11-20T10:00:00Z", firstBlood: true },
        { q: "q2" as const, points: 80, at: "2026-11-24T10:00:00Z", firstBlood: false },
        { q: "q3" as const, points: 60, at: null, firstBlood: false },
      ],
      completedAt: "2026-11-25T10:00:00Z",
      completionBonus: 50,
    },
  };
  const since = "2026-11-23T00:00:00Z";
  assert.deepEqual(boardTotals(cases, { caseId: null, cutoff: null, since }), {
    score: 130, stagesSolved: 1, casesCompleted: 1, firstBloods: 0, lastSolveAt: "2026-11-24T10:00:00Z",
  });
  assert.equal(boardTotals(cases, { caseId: null, cutoff: null }).score, 290, "all time counts undated solves too");
  assert.equal(boardTotals(cases, { caseId: null, cutoff: "2026-11-24T12:00:00Z", since }).score, 80, "the freeze still applies");
});

type Harness = ReturnType<typeof createHarness>;

const approvedPlayer = async (harness: Harness, username: string): Promise<Client> => {
  const player = harness.client();
  await player.call("/auth/register", { body: { username, password: "password1" } });
  const id = (await player.json(await player.call("/me"), AccountResponseSchema)).account.id;
  await expectStatus(harness.admin(`/admin/accounts/${id}/approve`, { body: {} }), 200);
  await expectStatus(player.call("/me/board", { method: "PUT", body: { show: true } }), 200);
  await player.call("/cases/alpha/setup-done", { body: {} });
  return player;
};
const answer = (player: Client, n: number) => player.call("/cases/alpha/answer", { body: { questionId: `q${n}`, answer: n === 1 ? "alpha-a1" : (ALL_ANSWERS[n - 2] ?? "") } });

test("GET /api/leaderboard?period= ranks by what each player scored in the period", async () => {
  let nowMs = Date.parse("2026-11-20T10:00:00Z"); // Friday of the week before
  const purges: CacheTag[][] = [];
  const spy: CachePurger = { purge: (tags) => { purges.push([...tags]); return Promise.resolve(); } };
  const harness = createHarness({ now: () => new Date(nowMs), cachePurger: spy });
  const ada = await approvedPlayer(harness, "Ada");
  const bob = await approvedPlayer(harness, "Bob");
  for (const n of [1, 2, 3]) await expectStatus(answer(ada, n), 200); // Ada: three stages last week
  nowMs = Date.parse("2026-11-24T10:00:00Z"); // Tuesday of this week
  await expectStatus(answer(bob, 1), 200); // Bob: one stage this week
  nowMs = Date.parse("2026-11-28T10:00:00Z");

  const get = async (query: string) => {
    const res = await ada.call(`/leaderboard${query}`);
    assert.equal(res.status, 200, query);
    assert.equal(res.headers.get("netlify-cache-tag"), "leaderboard", `${query}: purged with the board`);
    assert.equal(res.headers.get("netlify-vary"), "query", `${query}: one CDN copy per period`);
    assert.equal(res.headers.get("set-cookie"), null);
    return LeaderboardResponseSchema.parse(await res.json());
  };
  const all = await get("");
  assert.equal(all.period, "all");
  assert.equal(all.periodStart, null);
  assert.deepEqual(all.entries.map((e) => [e.rank, e.username]), [[1, "Ada"], [2, "Bob"]]);

  const week = await get("?period=week");
  assert.equal(week.period, "week");
  assert.equal(week.periodStart, "2026-11-22T22:00:00.000Z");
  assert.deepEqual(week.entries.map((e) => [e.rank, e.username, e.stagesSolved]), [[1, "Bob", 1]], "Ada scored nothing this week");

  const month = await get("?period=month&caseId=alpha");
  assert.deepEqual(month.entries.map((e) => e.username), ["Ada", "Bob"]);
  assert.equal(month.caseId, "alpha");

  await expectStatus(ada.call("/leaderboard?period=year"), 400);
  // Opting out purges the one tag that every period's copy carries.
  purges.length = 0;
  await expectStatus(bob.call("/me/board", { method: "PUT", body: { show: false } }), 200);
  assert.ok(purges.some((tags) => tags.includes("leaderboard")));
  assert.equal((await get("?period=week")).entries.length, 0);
});
