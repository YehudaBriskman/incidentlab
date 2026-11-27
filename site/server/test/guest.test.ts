// Guest play and upgrade (#176).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountResponseSchema,
  AdminAccountsResponseSchema,
  AnswerResponseSchema,
  LeaderboardResponseSchema,
  ProgressResponseSchema,
  UserStatsResponseSchema,
  usernameKey,
} from "../../shared/contract.ts";
import { AccountRecordSchema } from "../domain/types.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { GUEST_LIMIT } from "../services/GuestService.ts";
import { hashPassword, sha256Hex } from "../services/crypto.ts";
import { createHarness, expectStatus } from "./helpers.ts";

const startGuest = async (harness: ReturnType<typeof createHarness>, ip = "10.0.0.7") => {
  const guest = harness.client(ip);
  const res = await guest.call("/guest", { body: {} });
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("set-cookie") ?? "", /il_session=[^;]+; Path=\/api; HttpOnly/);
  const { account } = await guest.json(res, AccountResponseSchema);
  return { guest, account };
};

const solveStage1 = async (client: Awaited<ReturnType<typeof startGuest>>["guest"]) => {
  await expectStatus(client.call("/cases/alpha/setup-done", { body: {} }), 200);
  const right = await client.json(await client.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } }), AnswerResponseSchema);
  assert.equal(right.correct, true);
};

test("POST /guest creates an approved guest player that can play and read its stats", async () => {
  const store = new InMemoryKvStore();
  const harness = createHarness({ store });
  const { guest, account } = await startGuest(harness);
  assert.equal(account.kind, "guest");
  assert.equal(account.status, "approved");
  assert.equal(account.role, "player");
  assert.equal(account.username, `guest-${account.id}`);

  // the generated name is never claimed in the username index
  assert.equal((await store.listKeys("username:")).length, 0);
  const stored = AccountRecordSchema.parse((await store.get(`account:${account.id}`))?.data);
  assert.equal(stored.passwordHash, "");

  await solveStage1(guest);
  const stats = await guest.json(await guest.call("/me/stats"), UserStatsResponseSchema);
  assert.equal(stats.stats.username, account.username);
  assert.ok(stats.stats.totalScore > 0);
});

test("POST /guest with a live session returns that account instead of a new one", async () => {
  const store = new InMemoryKvStore();
  const harness = createHarness({ store });
  const { guest, account } = await startGuest(harness);
  const again = await guest.call("/guest", { body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("set-cookie"), null); // the cookie is left alone
  assert.equal((await guest.json(again, AccountResponseSchema)).account.id, account.id);
  assert.equal((await store.listKeys("account:")).length, 1);

  // a signed-in user gets their own account back, never a guest
  const user = harness.client();
  await user.call("/auth/register", { body: { username: "Dana", password: "hunter2hunter2" } });
  const mine = await user.json(await user.call("/guest", { body: {} }), AccountResponseSchema);
  assert.equal(mine.account.kind, "user");
  assert.equal(mine.account.username, "Dana");
  assert.equal((await store.listKeys("account:")).length, 2);
});

test("POST /guest is rate limited per IP", async () => {
  let nowMs = Date.parse("2026-11-27T10:00:00Z");
  const harness = createHarness({ now: () => new Date(nowMs) });
  for (let i = 0; i < GUEST_LIMIT.max; i++) await expectStatus(harness.client("10.1.1.1").call("/guest", { body: {} }), 201);
  await expectStatus(harness.client("10.1.1.1").call("/guest", { body: {} }), 429, "rate-limited");
  await expectStatus(harness.client("10.2.2.2").call("/guest", { body: {} }), 201); // another address is unaffected
  nowMs += GUEST_LIMIT.windowMs;
  await expectStatus(harness.client("10.1.1.1").call("/guest", { body: {} }), 201);
});

test("login refuses guests, even with an index entry and a known password", async () => {
  const store = new InMemoryKvStore();
  const harness = createHarness({ store });
  const { account } = await startGuest(harness);
  await expectStatus(harness.client().call("/auth/login", { body: { username: account.username, password: "anything-at-all" } }), 401, "bad-credentials");

  // Belt and braces: even a guest that somehow got a claimed name and a real hash can't sign in.
  const stored = AccountRecordSchema.parse((await store.get(`account:${account.id}`))?.data);
  await store.set(`account:${account.id}`, { ...stored, passwordHash: await hashPassword("password-123") });
  await store.set(`username:${sha256Hex(usernameKey(account.username))}`, { accountId: account.id });
  await expectStatus(harness.client().call("/auth/login", { body: { username: account.username, password: "password-123" } }), 401, "bad-credentials");
});

test("upgrade keeps the id and progress, claims the name and signs in with it", async () => {
  const store = new InMemoryKvStore();
  const harness = createHarness({ store });
  const { guest, account } = await startGuest(harness);
  await solveStage1(guest);

  const res = await guest.call("/auth/upgrade", { body: { username: "Noa", password: "correct-horse" } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get("cache-control"), "no-store");
  const upgraded = (await guest.json(res, AccountResponseSchema)).account;
  assert.equal(upgraded.id, account.id);
  assert.equal(upgraded.kind, "user");
  assert.equal(upgraded.username, "Noa");

  // the new cookie works and the progress is still there
  const progress = await guest.json(await guest.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(progress.progress.stages.q1.status, "solved");
  assert.deepEqual(await store.listKeys(`progress:alpha:${account.id}`), [`progress:alpha:${account.id}`]);

  // a fresh browser signs in with the new name and sees the same progress
  const other = harness.client();
  const login = await other.json(await other.call("/auth/login", { body: { username: "noa", password: "correct-horse" } }), AccountResponseSchema);
  assert.equal(login.account.id, account.id);
  assert.equal((await other.json(await other.call("/cases/alpha/progress"), ProgressResponseSchema)).progress.stages.q1.status, "solved");

  // a user can't upgrade again
  await expectStatus(guest.call("/auth/upgrade", { body: { username: "Noa2", password: "correct-horse" } }), 409, "not-guest");
});

test("upgrade ends the guest's other sessions", async () => {
  const store = new InMemoryKvStore();
  const harness = createHarness({ store });
  const { guest } = await startGuest(harness);
  const cookie = guest.cookie() ?? "";
  const secondTab = harness.client();
  const asSecond = (path: string) => secondTab.call(path, { headers: { cookie: `il_session=${cookie}` } });
  await expectStatus(asSecond("/me"), 200);
  await expectStatus(guest.call("/auth/upgrade", { body: { username: "Lior", password: "correct-horse" } }), 200);
  await expectStatus(asSecond("/me"), 401, "signed-out");
});

test("upgrade refuses a taken, reserved or guest-style name and leaves the guest as it was", async () => {
  const store = new InMemoryKvStore();
  const harness = createHarness({ store });
  await harness.client().call("/auth/register", { body: { username: "Dana", password: "hunter2hunter2" } });
  const { guest, account } = await startGuest(harness);
  await expectStatus(guest.call("/auth/upgrade", { body: { username: "DANA", password: "correct-horse" } }), 409, "username-taken");
  await expectStatus(guest.call("/auth/upgrade", { body: { username: "admin", password: "correct-horse" } }), 409, "reserved");
  await expectStatus(guest.call("/auth/upgrade", { body: { username: "guest-abc", password: "correct-horse" } }), 409, "reserved");
  await expectStatus(guest.call("/auth/upgrade", { body: { username: "ok", password: "correct-horse" } }), 400); // too short
  const me = await guest.json(await guest.call("/me"), AccountResponseSchema);
  assert.equal(me.account.kind, "guest");
  assert.equal(me.account.id, account.id);
  assert.equal((await store.listKeys("username:")).length, 1); // only Dana's
});

test("two guests racing for one name: exactly one gets it", async () => {
  const store = new InMemoryKvStore();
  const harness = createHarness({ store });
  const a = await startGuest(harness, "10.3.0.1");
  const b = await startGuest(harness, "10.3.0.2");
  const results = await Promise.all([
    a.guest.call("/auth/upgrade", { body: { username: "Racer", password: "correct-horse" } }),
    b.guest.call("/auth/upgrade", { body: { username: "racer", password: "correct-horse" } }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const accounts = await Promise.all([a, b].map(async (g) => (await g.guest.json(await g.guest.call("/me"), AccountResponseSchema)).account));
  assert.deepEqual(accounts.map((x) => x.kind).sort(), ["guest", "user"]);
  const keys = await store.listKeys("username:");
  assert.equal(keys.length, 1);
  const owner = accounts.find((x) => x.kind === "user");
  assert.deepEqual((await store.get(keys[0] ?? ""))?.data, { accountId: owner?.id });
});

test("upgrade needs a guest session", async () => {
  const harness = createHarness();
  await expectStatus(harness.client().call("/auth/upgrade", { body: { username: "Nobody", password: "correct-horse" } }), 401, "signed-out");
  await expectStatus(harness.admin("/auth/upgrade", { body: { username: "Nobody", password: "correct-horse" } }), 401, "signed-out");
});

test("guests never appear on a leaderboard, before or after other players", { todo: "lane B (#175) filters the boards on kind" }, async () => {
  const harness = createHarness();
  const { guest, account } = await startGuest(harness);
  await solveStage1(guest);
  const overall = await guest.json(await guest.call("/leaderboard"), LeaderboardResponseSchema);
  const perCase = await guest.json(await guest.call("/leaderboard?caseId=alpha"), LeaderboardResponseSchema);
  for (const board of [overall, perCase]) assert.equal(board.entries.some((e) => e.username === account.username), false);
  // the admin list still shows the guest (it is a real account), without a rank
  const list = await guest.json(await harness.admin("/admin/accounts"), AdminAccountsResponseSchema);
  assert.equal(list.accounts.find((a) => a.accountId === account.id)?.rank ?? null, null);
});
