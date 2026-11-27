// The opt-in global leaderboard and the score summaries behind it (#175).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountResponseSchema, LeaderboardResponseSchema, ProgressResponseSchema, UserStatsResponseSchema } from "../../shared/contract.ts";
import { ScoreRecordSchema } from "../domain/score.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import type { KvStore, Versioned } from "../repositories/KvStore.ts";
import type { CachePurger, CacheTag } from "../services/CachePurger.ts";
import { ALL_ANSWERS, createHarness, expectStatus } from "./helpers.ts";
import type { Client } from "./helpers.ts";

type Harness = ReturnType<typeof createHarness>;

const approvedPlayer = async (harness: Harness, username: string) => {
  const player = harness.client();
  await player.call("/auth/register", { body: { username, password: "password1" } });
  const id = (await player.json(await player.call("/me"), AccountResponseSchema)).account.id;
  await expectStatus(harness.admin(`/admin/accounts/${id}/approve`, { body: {} }), 200);
  return { player, id };
};

const optIn = (player: Client, show = true) => player.call("/me/board", { method: "PUT", body: { show } });
const answer = (player: Client, caseId: string, n: number) =>
  player.call(`/cases/${caseId}/answer`, { body: { questionId: `q${n}`, answer: n === 1 ? `${caseId}-a1` : (ALL_ANSWERS[n - 2] ?? "") } });
const board = async (player: Client, query = "") => player.json(await player.call(`/leaderboard${query}`), LeaderboardResponseSchema);
const summaryOf = async (kv: KvStore, id: string) => ScoreRecordSchema.parse((await kv.get(`score:${id}`))?.data);
const myScore = async (player: Client, caseId: string) => (await player.json(await player.call(`/cases/${caseId}/progress`), ProgressResponseSchema)).progress.score;

test("the summary follows solves, hints, reveals and completion, and matches the progress score", async () => {
  const kv = new InMemoryKvStore();
  const harness = createHarness({ store: kv });
  const ada = await approvedPlayer(harness, "Ada");
  await expectStatus(optIn(ada.player), 200);
  await ada.player.call("/cases/alpha/setup-done", { body: {} });

  await expectStatus(ada.player.call("/cases/alpha/hint", { body: { questionId: "q1" } }), 200);
  assert.equal((await summaryOf(kv, ada.id)).total, 0, "a hint alone scores nothing yet");
  await expectStatus(answer(ada.player, "alpha", 1), 200);
  let summary = await summaryOf(kv, ada.id);
  assert.equal(summary.stagesSolved, 1);
  assert.equal(summary.firstBloods, 1);
  assert.equal(summary.total, await myScore(ada.player, "alpha"));

  // A double-submitted correct answer re-derives the same summary: nothing is counted twice.
  await expectStatus(answer(ada.player, "alpha", 1), 200);
  assert.deepEqual(await summaryOf(kv, ada.id), summary);

  await expectStatus(ada.player.call("/cases/alpha/reveal", { body: { questionId: "q2" } }), 200);
  for (const n of [3, 4, 5]) await expectStatus(answer(ada.player, "alpha", n), 200);
  assert.equal((await summaryOf(kv, ada.id)).casesCompleted, 0);
  await expectStatus(ada.player.call("/cases/alpha/reveal", { body: { questionId: "q6" } }), 200); // completes the case
  summary = await summaryOf(kv, ada.id);
  assert.deepEqual([summary.stagesSolved, summary.casesCompleted, summary.cases["alpha"]?.completionBonus], [4, 1, 0]);
  assert.equal(summary.total, await myScore(ada.player, "alpha"));

  // A flawless run earns the completion bonus, in the summary too.
  await ada.player.call("/cases/beta/setup-done", { body: {} });
  for (const n of [1, 2, 3, 4, 5, 6]) await expectStatus(answer(ada.player, "beta", n), 200);
  summary = await summaryOf(kv, ada.id);
  assert.equal(summary.cases["beta"]?.completionBonus, 50);
  assert.equal(summary.casesCompleted, 2);
  const stats = await ada.player.json(await ada.player.call("/me/stats"), UserStatsResponseSchema);
  assert.equal(summary.total, stats.stats.totalScore);
  const overall = await board(ada.player);
  assert.deepEqual(overall.entries.map((e) => [e.username, e.score, e.stagesSolved, e.casesCompleted, e.firstBloods]), [["Ada", summary.total, 10, 2, 10]]);
  assert.equal(stats.stats.rank, 1);

  // Admin resets keep the summary in step.
  await expectStatus(harness.admin(`/admin/progress/${ada.id}/beta`, { method: "DELETE" }), 204);
  assert.equal((await summaryOf(kv, ada.id)).cases["beta"], undefined);
  await expectStatus(harness.admin("/admin/reset", { body: { confirm: "RESET" } }), 204);
  assert.equal((await summaryOf(kv, ada.id)).total, 0);
  assert.equal((await board(ada.player)).entries.length, 0);
});

test("concurrent solves on two cases both land in the summary", async () => {
  const kv = new InMemoryKvStore();
  const harness = createHarness({ store: kv });
  const ada = await approvedPlayer(harness, "Ada");
  await ada.player.call("/cases/alpha/setup-done", { body: {} });
  await ada.player.call("/cases/beta/setup-done", { body: {} });
  await Promise.all([answer(ada.player, "alpha", 1), answer(ada.player, "beta", 1), answer(ada.player, "alpha", 1)]);
  const summary = await summaryOf(kv, ada.id);
  assert.deepEqual(Object.keys(summary.cases), ["alpha", "beta"]);
  assert.equal(summary.stagesSolved, 2);
  assert.equal(summary.total, (await myScore(ada.player, "alpha")) + (await myScore(ada.player, "beta")));
});

test("only opted-in, approved, full accounts are listed; opting out removes you", async () => {
  const kv = new InMemoryKvStore();
  const harness = createHarness({ store: kv });
  const ada = await approvedPlayer(harness, "Ada");
  const bob = await approvedPlayer(harness, "Bob");
  const gus = await approvedPlayer(harness, "Gus");
  for (const p of [ada, bob, gus]) {
    await p.player.call("/cases/alpha/setup-done", { body: {} });
    await expectStatus(answer(p.player, "alpha", 1), 200);
  }
  assert.equal((await board(ada.player)).entries.length, 0, "off by default: the board starts empty");
  const bobStats = await bob.player.json(await bob.player.call("/me/stats"), UserStatsResponseSchema);
  assert.deepEqual([bobStats.stats.rank, bobStats.stats.onGlobalBoard], [null, false]);

  const res = await optIn(ada.player);
  assert.equal((await ada.player.json(res, AccountResponseSchema)).account.showOnGlobalBoard, true);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(await kv.get(`globalboard:${ada.id}`));
  assert.deepEqual((await board(bob.player)).entries.map((e) => e.username), ["Ada"]);
  assert.deepEqual((await board(bob.player, "?caseId=alpha")).entries.map((e) => e.username), ["Ada"]);

  // A guest is never listed, even with a marker and the flag set behind the API's back.
  await expectStatus(optIn(gus.player), 200);
  const gusAccount = await kv.get(`account:${gus.id}`);
  assert.ok(gusAccount);
  await kv.set(`account:${gus.id}`, { ...(gusAccount.data as Record<string, unknown>), kind: "guest" });
  assert.deepEqual((await board(bob.player)).entries.map((e) => e.username), ["Ada"]);
  await expectStatus(optIn(gus.player), 403, "guest");

  // A rejected account drops off at once, even though its marker is still there.
  await expectStatus(optIn(bob.player), 200);
  assert.deepEqual((await board(ada.player)).entries.map((e) => e.username).sort(), ["Ada", "Bob"]);
  await expectStatus(harness.admin(`/admin/accounts/${bob.id}/reject`, { body: {} }), 200);
  assert.deepEqual((await board(ada.player)).entries.map((e) => e.username), ["Ada"]);

  await expectStatus(optIn(ada.player, false), 200);
  assert.equal(await kv.get(`globalboard:${ada.id}`), null);
  assert.equal((await board(ada.player)).entries.length, 0);
  const adaStats = await ada.player.json(await ada.player.call("/me/stats"), UserStatsResponseSchema);
  assert.deepEqual([adaStats.stats.rank, adaStats.stats.onGlobalBoard], [null, false]);

  // Pending accounts and the admin can't opt in; the body is validated.
  // Sign-up approves at once (#173), so a pre-#173 pending account is written into the store directly.
  const pending = harness.client();
  const pendingRes = await pending.call("/auth/register", { body: { username: "Pending", password: "password1" } });
  const pendingId = (await pending.json(pendingRes, AccountResponseSchema)).account.id;
  const pendingAccount = await kv.get(`account:${pendingId}`);
  assert.ok(pendingAccount);
  await kv.set(`account:${pendingId}`, { ...(pendingAccount.data as Record<string, unknown>), status: "pending" });
  await expectStatus(optIn(pending), 403, "pending");
  await expectStatus(harness.admin("/me/board", { method: "PUT", body: { show: true } }), 401);
  await expectStatus(ada.player.call("/me/board", { method: "PUT", body: { show: "yes" } }), 400);
  await expectStatus(ada.player.call("/me/board", { body: { show: true } }), 405);
});

test("a deleted account leaves the board, and a restore puts it back", async () => {
  const kv = new InMemoryKvStore();
  const harness = createHarness({ store: kv });
  const ada = await approvedPlayer(harness, "Ada");
  await expectStatus(optIn(ada.player), 200);
  await ada.player.call("/cases/alpha/setup-done", { body: {} });
  await expectStatus(answer(ada.player, "alpha", 1), 200);
  await expectStatus(harness.admin(`/admin/accounts/${ada.id}`, { method: "DELETE" }), 204);
  assert.equal((await board(harness.client())).entries.length, 0);
  assert.equal(await kv.get(`score:${ada.id}`), null);
  const trash = (await (await harness.admin("/admin/trash")).json()) as { entries: Array<{ id: string }> };
  const entry = trash.entries[0];
  assert.ok(entry);
  await expectStatus(harness.admin(`/admin/trash/${entry.id}/restore`, { body: {} }), 200);
  assert.deepEqual((await board(harness.client())).entries.map((e) => e.username), ["Ada"]);
});

test("the frozen board counts only what was solved by freezeAt, from the summaries", async () => {
  let now = new Date("2026-11-25T10:00:00Z");
  const kv = new InMemoryKvStore();
  const harness = createHarness({ store: kv, now: () => now });
  const ada = await approvedPlayer(harness, "Ada");
  const bob = await approvedPlayer(harness, "Bob");
  for (const p of [ada, bob]) {
    await expectStatus(optIn(p.player), 200);
    await p.player.call("/cases/alpha/setup-done", { body: {} });
  }
  await expectStatus(answer(ada.player, "alpha", 1), 200);
  const event = { name: "Night", startsAt: null, endsAt: null, freezeAt: "2026-11-25T10:30:00Z", enforceWindow: false, announcement: null };
  await expectStatus(harness.admin("/admin/event", { method: "PUT", body: event }), 200);
  now = new Date("2026-11-25T10:45:00Z");
  await expectStatus(answer(ada.player, "alpha", 2), 200);
  await expectStatus(answer(bob.player, "alpha", 1), 200);
  const adaAt1030 = (await summaryOf(kv, ada.id)).cases["alpha"]?.solves[0]?.points;

  for (const query of ["", "?caseId=alpha"]) {
    const frozen = await board(bob.player, query);
    assert.equal(frozen.frozen, true);
    assert.deepEqual(frozen.entries.map((e) => [e.username, e.score, e.stagesSolved]), [["Ada", adaAt1030, 1]], `Bob solved after the freeze (${query})`);
  }
  assert.equal((await board(bob.player, "?caseId=beta")).entries.length, 0);

  // My rank stays live (it compares the current standings), as before.
  const bobStats = await bob.player.json(await bob.player.call("/me/stats"), UserStatsResponseSchema);
  assert.equal(bobStats.stats.rank, 2);
  await expectStatus(harness.admin("/admin/event", { method: "PUT", body: { ...event, freezeAt: null } }), 200);
  assert.deepEqual((await board(bob.player)).entries.map((e) => [e.username, e.stagesSolved]), [["Ada", 2], ["Bob", 1]]);
});

/** Records every key read and every prefix listed. */
class SpyKvStore extends InMemoryKvStore {
  readonly reads: string[] = [];
  readonly lists: string[] = [];
  override async get(key: string): Promise<Versioned<unknown> | null> {
    this.reads.push(key);
    return super.get(key);
  }
  override async listKeys(prefix: string): Promise<string[]> {
    this.lists.push(prefix);
    return super.listKeys(prefix);
  }
}

test("/api/me/stats reads no other account's progress and lists neither accounts nor progress", async () => {
  const kv = new SpyKvStore();
  const harness = createHarness({ store: kv });
  const ada = await approvedPlayer(harness, "Ada");
  const bob = await approvedPlayer(harness, "Bob");
  for (const p of [ada, bob]) {
    await expectStatus(optIn(p.player), 200);
    await p.player.call("/cases/alpha/setup-done", { body: {} });
    await expectStatus(answer(p.player, "alpha", 1), 200);
  }
  kv.reads.length = 0;
  kv.lists.length = 0;
  const stats = await ada.player.json(await ada.player.call("/me/stats"), UserStatsResponseSchema);
  assert.equal(stats.stats.rank, 1);
  const foreignProgress = kv.reads.filter((key) => key.startsWith("progress:") && !key.endsWith(`:${ada.id}`));
  assert.deepEqual(foreignProgress, []);
  assert.ok(!kv.lists.some((prefix) => prefix === "" || "progress:".startsWith(prefix) || "account:".startsWith(prefix)), kv.lists.join(","));
  assert.ok(kv.reads.includes(`score:${bob.id}`), "the rank comes from the opted-in players' summaries");

  // The public board reads the same small set, and within a few seconds shares the read the stats just made (#185).
  kv.reads.length = 0;
  kv.lists.length = 0;
  await board(bob.player);
  assert.ok(!kv.reads.some((key) => key.startsWith("progress:")));
  assert.deepEqual(kv.lists, []);
  assert.deepEqual(kv.reads.filter((key) => !key.startsWith("config:")), []); // only the event (the freeze)

  // A solve clears the shared read: Bob's next point moves him up at once, on this instance.
  await expectStatus(answer(bob.player, "alpha", 2), 200);
  kv.lists.length = 0;
  const after = await board(ada.player);
  assert.deepEqual(kv.lists, ["globalboard:"]);
  assert.equal(after.entries[0]?.username, "Bob");
  // Ada's rank reads her own summary fresh, and the others from the new shared read.
  const adaStats = await ada.player.json(await ada.player.call("/me/stats"), UserStatsResponseSchema);
  assert.equal(adaStats.stats.rank, 2);
});

test("a toggle purges the leaderboard CDN tag; the board stays CDN-cacheable", async () => {
  const purges: CacheTag[][] = [];
  const purger: CachePurger = {
    purge: (tags) => {
      purges.push([...tags]);
      return Promise.resolve();
    },
  };
  const harness = createHarness({ cachePurger: purger });
  const ada = await approvedPlayer(harness, "Ada");
  await expectStatus(optIn(ada.player), 200);
  assert.deepEqual(purges.at(-1), ["leaderboard"]);
  purges.length = 0;
  await expectStatus(optIn(ada.player, false), 200);
  assert.deepEqual(purges, [["leaderboard"]]);
  purges.length = 0;
  await expectStatus(ada.player.call("/me/board", { method: "PUT", body: { show: 1 } }), 400);
  assert.deepEqual(purges, [], "a refused toggle purges nothing");
  const res = await harness.client().call("/leaderboard");
  assert.match(res.headers.get("netlify-cdn-cache-control") ?? "", /public, durable/);
  assert.equal(res.headers.get("netlify-cache-tag"), "leaderboard");
});
