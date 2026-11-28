// Name moderation and ban reasons (#236): the owner's forced rename (unique, the username index moved atomically,
// audited with both names), hiding a player from every board without a ban, and the ban reason the player reads at
// sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  AccountResponseSchema,
  AdminBoardVisibilityResponseSchema,
  AdminUsersResponseSchema,
  AuditResponseSchema,
  ClassBoardResponseSchema,
  ClassResponseSchema,
  ErrorBodySchema,
  LeaderboardResponseSchema,
  SessionResponseSchema,
  UserStatsResponseSchema,
} from "../../shared/contract.ts";
import type { KvStore } from "../repositories/KvStore.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import type { CachePurger, CacheTag } from "../services/CachePurger.ts";
import { generateAccountId, sha256Hex } from "../services/crypto.ts";
import { createHarness, expectStatus } from "./helpers.ts";

type Harness = ReturnType<typeof createHarness>;
type Init = { method?: string; body?: unknown };
type Player = { id: string; username: string; call(path: string, init?: Init): Promise<Response> };

const NOW = "2026-12-01T10:00:00.000Z";

const seedPlayer = async (kv: KvStore, harness: Harness, username: string): Promise<Player> => {
  const id = generateAccountId();
  const token = randomBytes(32).toString("base64url");
  await kv.set(`account:${id}`, {
    id, username, usernameKey: username.toLowerCase(), passwordHash: "x", status: "approved", sessionEpoch: 0,
    createdAt: NOW, decidedAt: NOW, lastSeenAt: NOW, lastLoginAt: null,
  });
  await kv.set(`username:${sha256Hex(username.toLowerCase())}`, { accountId: id });
  await kv.set(`session:${sha256Hex(token)}`, { role: "player", accountId: id, epoch: 0, createdAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z" });
  return {
    id,
    username,
    call: (path, init = {}) =>
      harness.app.handle(
        new Request(`http://localhost/api${path}`, {
          method: init.method ?? (init.body === undefined ? "GET" : "POST"),
          headers: { cookie: `il_session=${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        }),
        "10.3.3.3",
      ),
  };
};

const setup = () => {
  const kv = new InMemoryKvStore();
  const purges: CacheTag[][] = [];
  const purger: CachePurger = {
    purge: (tags) => {
      purges.push([...tags]);
      return Promise.resolve();
    },
  };
  const harness = createHarness({ store: kv, now: () => new Date(NOW), cachePurger: purger });
  const anonymous = (path: string): Promise<Response> => harness.app.handle(new Request(`http://localhost/api${path}`), "10.7.7.7");
  return { kv, harness, purges, anonymous, seed: (name: string) => seedPlayer(kv, harness, name) };
};

const solveQ1 = async (p: Player, caseId = "alpha"): Promise<void> => {
  await expectStatus(p.call(`/cases/${caseId}/setup-done`, { body: {} }), 200);
  await expectStatus(p.call(`/cases/${caseId}/answer`, { body: { questionId: "q1", answer: `${caseId}-a1` } }), 200);
};
const boardNames = async (res: Promise<Response>): Promise<string[]> => LeaderboardResponseSchema.parse(await (await res).json()).entries.map((e) => e.username);
const audit = async (h: Harness) => AuditResponseSchema.parse(await (await h.admin("/admin/audit")).json()).entries;

test("rename: the new name is unique, the username index moves, sign-in follows, and the audit names both", async () => {
  const { kv, harness } = setup();
  const browser = harness.client();
  await expectStatus(browser.call("/auth/register", { body: { username: "RudeName", password: "password1" } }), 201);
  const session = SessionResponseSchema.parse(await (await browser.call("/session")).json());
  const id = session.account?.id ?? "";
  await seedPlayer(kv, harness, "taken_name");

  // Taken (any case), reserved, invalid, and a guest's name: refused, nothing changes.
  await expectStatus(harness.admin(`/admin/accounts/${id}/username`, { method: "PUT", body: { username: "TAKEN_NAME" } }), 409, "username-taken");
  await expectStatus(harness.admin(`/admin/accounts/${id}/username`, { method: "PUT", body: { username: "admin" } }), 409, "reserved");
  await expectStatus(harness.admin(`/admin/accounts/${id}/username`, { method: "PUT", body: { username: "has space" } }), 400);
  await expectStatus(harness.admin("/admin/accounts/AAAAAAAAAAAA/username", { method: "PUT", body: { username: "fresh_name" } }), 404);

  const res = await harness.admin(`/admin/accounts/${id}/username`, { method: "PUT", body: { username: "night_owl" } });
  await expectStatus(res.clone(), 200);
  assert.equal(AccountResponseSchema.parse(await res.json()).account.username, "night_owl");
  assert.equal(await kv.get(`username:${sha256Hex("rudename")}`), null, "the old name is free again");
  assert.deepEqual((await kv.get(`username:${sha256Hex("night_owl")}`))?.data, { accountId: id });

  // The same account signs in with the new name and its old password; the old name no longer exists.
  await expectStatus(harness.client().call("/auth/login", { body: { username: "night_owl", password: "password1" } }), 200);
  await expectStatus(harness.client().call("/auth/login", { body: { username: "RudeName", password: "password1" } }), 401, "bad-credentials");
  // The old name can be registered by someone else now; the session that was open keeps working.
  await expectStatus(harness.client().call("/auth/register", { body: { username: "rudename", password: "password2" } }), 201);
  await expectStatus(browser.call("/me"), 200);

  // A case-only change keeps the same index entry.
  await expectStatus(harness.admin(`/admin/accounts/${id}/username`, { method: "PUT", body: { username: "Night_Owl" } }), 200);
  assert.deepEqual((await kv.get(`username:${sha256Hex("night_owl")}`))?.data, { accountId: id });

  const entries = (await audit(harness)).filter((e) => e.action === "account.rename");
  assert.deepEqual(entries.map((e) => e.detail).sort(), ["RudeName -> night_owl", "night_owl -> Night_Owl"]);
});

test("rename: two concurrent renames to one name give it to exactly one account", async () => {
  const { kv, harness, seed } = setup();
  const a = await seed("alpha_one");
  const b = await seed("beta_two");
  const [ra, rb] = await Promise.all([
    harness.admin(`/admin/accounts/${a.id}/username`, { method: "PUT", body: { username: "same_name" } }),
    harness.admin(`/admin/accounts/${b.id}/username`, { method: "PUT", body: { username: "same_name" } }),
  ]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  const winner = ra.status === 200 ? a : b;
  const loser = ra.status === 200 ? b : a;
  assert.deepEqual((await kv.get(`username:${sha256Hex("same_name")}`))?.data, { accountId: winner.id });
  assert.deepEqual((await kv.get(`username:${sha256Hex(loser.username)}`))?.data, { accountId: loser.id }, "the loser keeps its own name");
});

/** Fails every conditional write to the account record once, as a concurrent edit would. */
class LosingStore extends InMemoryKvStore {
  loseNext = "";
  override setIfMatch(key: string, value: unknown, etag: string | null): Promise<boolean> {
    if (key === this.loseNext) {
      this.loseNext = "";
      return Promise.resolve(false);
    }
    return super.setIfMatch(key, value, etag);
  }
}

test("rename: when the account write loses a race, the new name is released and the old one kept", async () => {
  const kv = new LosingStore();
  const harness = createHarness({ store: kv, now: () => new Date(NOW) });
  const p = await seedPlayer(kv, harness, "old_name");
  kv.loseNext = `account:${p.id}`;
  await expectStatus(harness.admin(`/admin/accounts/${p.id}/username`, { method: "PUT", body: { username: "new_name" } }), 409);
  assert.equal(await kv.get(`username:${sha256Hex("new_name")}`), null, "no dangling claim");
  assert.deepEqual((await kv.get(`username:${sha256Hex("old_name")}`))?.data, { accountId: p.id });
  const account = (await kv.get(`account:${p.id}`))?.data as { username: string };
  assert.equal(account.username, "old_name");
});

test("hide from boards: off the global board, every per-case board, class boards and the rank; still plays; audited", async () => {
  const { harness, seed, anonymous, purges } = setup();
  const ada = await seed("Ada");
  const bob = await seed("Bob");
  for (const p of [ada, bob]) await expectStatus(p.call("/me/board", { method: "PUT", body: { show: true } }), 200);
  const klass = ClassResponseSchema.parse(await (await ada.call("/classes", { body: { name: "Night shift" } })).json()).class;
  const code = klass.admin?.joinCode ?? "";
  const token = klass.boardToken ?? "";
  await expectStatus(bob.call("/classes/join", { body: { code } }), 200);
  for (const p of [ada, bob]) await solveQ1(p);

  assert.deepEqual((await boardNames(anonymous("/leaderboard"))).sort(), ["Ada", "Bob"]);
  purges.length = 0;
  const res = await harness.admin(`/admin/accounts/${bob.id}/board-visibility`, { method: "PUT", body: { hidden: true } });
  await expectStatus(res.clone(), 200);
  assert.deepEqual(AdminBoardVisibilityResponseSchema.parse(await res.json()), { accountId: bob.id, hiddenFromBoards: true });
  assert.ok(purges.some((tags) => tags.includes("leaderboard") && tags.includes(`class:${klass.id}`)), "the CDN copies are purged");

  assert.deepEqual(await boardNames(anonymous("/leaderboard")), ["Ada"]);
  assert.deepEqual(await boardNames(anonymous("/leaderboard?caseId=alpha")), ["Ada"]);
  const classBoard = ClassBoardResponseSchema.parse(await (await anonymous(`/classboard/${token}`)).json());
  assert.deepEqual(classBoard.entries.map((e) => e.username), ["Ada"]);
  const stats = UserStatsResponseSchema.parse(await (await bob.call("/me/stats")).json()).stats;
  assert.equal(stats.rank, null);
  // Not a ban: Bob still plays.
  await expectStatus(bob.call("/cases/alpha/answer", { body: { questionId: "q2", answer: "a2" } }), 200);
  const users = AdminUsersResponseSchema.parse(await (await harness.admin("/admin/users?q=bob")).json());
  assert.equal(users.accounts[0]?.hiddenFromBoards, true);

  // Shown again: back on every board.
  await expectStatus(harness.admin(`/admin/accounts/${bob.id}/board-visibility`, { method: "PUT", body: { hidden: false } }), 200);
  assert.deepEqual((await boardNames(anonymous("/leaderboard"))).sort(), ["Ada", "Bob"]);
  assert.equal(ClassBoardResponseSchema.parse(await (await anonymous(`/classboard/${token}`)).json()).entries.length, 2);
  const actions = (await audit(harness)).map((e) => e.action);
  assert.ok(actions.includes("account.board-hide") && actions.includes("account.board-show"));
  await expectStatus(harness.admin(`/admin/accounts/${bob.id}/board-visibility`, { method: "PUT", body: { hidden: "yes" } }), 400);
  await expectStatus(bob.call(`/admin/accounts/${bob.id}/board-visibility`, { method: "PUT", body: { hidden: true } }), 401);
});

test("ban reason: shown at sign-in only after the right password, in the session's view, cleared by an unban", async () => {
  const { harness } = setup();
  const browser = harness.client();
  await expectStatus(browser.call("/auth/register", { body: { username: "spammer", password: "password1" } }), 201);
  const id = SessionResponseSchema.parse(await (await browser.call("/session")).json()).account?.id ?? "";
  const reason = "Offensive messages in the class board name";
  const banned = await harness.admin(`/admin/accounts/${id}/reject`, { body: { reason } });
  await expectStatus(banned.clone(), 200);
  assert.equal(AccountResponseSchema.parse(await banned.json()).account.banReason, reason);

  const login = await harness.client().call("/auth/login", { body: { username: "spammer", password: "password1" } });
  assert.equal(login.status, 403);
  const body = ErrorBodySchema.parse(await login.json());
  assert.equal(body.code, "rejected");
  assert.equal(body.banReason, reason);
  // A wrong password learns nothing about the ban.
  const wrong = await harness.client().call("/auth/login", { body: { username: "spammer", password: "password2" } });
  assert.equal(wrong.status, 401);
  assert.equal(ErrorBodySchema.parse(await wrong.json()).banReason, undefined);
  // The open session sees its own reason on the "not approved" screen.
  const view = SessionResponseSchema.parse(await (await browser.call("/session")).json()).account;
  assert.equal(view?.status, "rejected");
  assert.equal(view?.banReason, reason);
  // The owner sees it in the users list; the audit keeps it.
  const users = AdminUsersResponseSchema.parse(await (await harness.admin("/admin/users?q=spammer")).json());
  assert.equal(users.accounts[0]?.banReason, reason);
  assert.equal((await audit(harness)).find((e) => e.action === "account.reject")?.detail, `reason: ${reason}`);

  // Unban clears it; a ban without a reason has none; an over-long reason is refused.
  await expectStatus(harness.admin(`/admin/accounts/${id}/approve`, { body: {} }), 200);
  await expectStatus(harness.client().call("/auth/login", { body: { username: "spammer", password: "password1" } }), 200);
  await expectStatus(harness.admin(`/admin/accounts/${id}/reject`, { body: {} }), 200);
  const plain = ErrorBodySchema.parse(await (await harness.client().call("/auth/login", { body: { username: "spammer", password: "password1" } })).json());
  assert.equal(plain.code, "rejected");
  assert.equal(plain.banReason, undefined);
  await expectStatus(harness.admin(`/admin/accounts/${id}/reject`, { body: { reason: "x".repeat(201) } }), 400);
});
