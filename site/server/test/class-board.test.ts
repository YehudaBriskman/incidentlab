// Class boards on capability URLs and class live progress (#181), and gameplay that never blocks on a class (#180).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AdminProgressResponseSchema, ClassBoardResponseSchema, ClassResponseSchema, UserStatsResponseSchema } from "../../shared/contract.ts";
import type { ClassBoardResponse, ClassDetail } from "../../shared/contract.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import type { KvStore } from "../repositories/KvStore.ts";
import type { CachePurger, CacheTag } from "../services/CachePurger.ts";
import { classIdOfToken, sameToken } from "../services/ClassBoardService.ts";
import { sha256Hex, generateAccountId } from "../services/crypto.ts";
import { ALL_ANSWERS, createHarness, expectStatus } from "./helpers.ts";

type Harness = ReturnType<typeof createHarness>;
type Init = { method?: string; body?: unknown };
type Player = { id: string; username: string; call(path: string, init?: Init): Promise<Response> };

const START = Date.parse("2026-12-01T10:00:00Z");

const setup = () => {
  const kv = new InMemoryKvStore();
  let nowMs = START;
  const purges: CacheTag[][] = [];
  const spy: CachePurger = {
    purge: (tags) => {
      purges.push([...tags]);
      return Promise.resolve();
    },
  };
  const harness = createHarness({ store: kv, now: () => new Date(nowMs), cachePurger: spy });
  const seed = (username: string): Promise<Player> => seedPlayer(kv, harness, username);
  /** A request with no cookie at all, like a projector or a member's phone opening the shared link. */
  const anonymous = (path: string): Promise<Response> => harness.app.handle(new Request(`http://localhost/api${path}`), "10.7.7.7");
  const at = (iso: string): void => {
    nowMs = Date.parse(iso);
  };
  return { kv, harness, seed, anonymous, purges, at };
};

/** An approved player written straight into the store with a live session (no scrypt, so tests stay fast). */
const seedPlayer = async (kv: KvStore, harness: Harness, username: string): Promise<Player> => {
  const id = generateAccountId();
  const token = randomBytes(32).toString("base64url");
  const nowIso = new Date(START).toISOString();
  await kv.set(`account:${id}`, {
    id, username, usernameKey: username.toLowerCase(), passwordHash: "x", status: "approved", sessionEpoch: 0,
    createdAt: nowIso, decidedAt: nowIso, lastSeenAt: nowIso, lastLoginAt: null,
  });
  await kv.set(`session:${sha256Hex(token)}`, { role: "player", accountId: id, epoch: 0, createdAt: nowIso, expiresAt: "2099-01-01T00:00:00.000Z" });
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
        `10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      ),
  };
};

const detailOf = async (res: Response | Promise<Response>): Promise<ClassDetail> => {
  const r = await res;
  assert.ok(r.ok, await r.clone().text());
  return ClassResponseSchema.parse(await r.json()).class;
};
const boardOf = async (res: Response | Promise<Response>): Promise<ClassBoardResponse> => {
  const r = await res;
  assert.equal(r.status, 200, await r.clone().text());
  return ClassBoardResponseSchema.parse(await r.json());
};
const names = (board: ClassBoardResponse): string[] => board.entries.map((e) => e.username);

/** Ada owns a class; returns its detail (with the join code and the board token). */
const classOf = async (owner: Player, name = "Night shift"): Promise<ClassDetail & { code: string; token: string }> => {
  const detail = await detailOf(owner.call("/classes", { body: { name } }));
  assert.ok(detail.admin && detail.boardToken);
  return { ...detail, code: detail.admin.joinCode, token: detail.boardToken };
};
const join = (player: Player, code: string): Promise<void> => expectStatus(player.call("/classes/join", { body: { code } }), 200);
const solveQ1 = async (player: Player, caseId = "alpha"): Promise<void> => {
  await expectStatus(player.call(`/cases/${caseId}/setup-done`, { body: {} }), 200);
  await expectStatus(player.call(`/cases/${caseId}/answer`, { body: { questionId: "q1", answer: `${caseId}-a1` } }), 200);
};

test("the board token names its class and is compared in constant time", () => {
  assert.equal(classIdOfToken("AbCdEf123456.secretpart"), "AbCdEf123456");
  for (const bad of ["", "nodot", ".x", "short.x", "AbCdEf12345!.x", `AbCdEf123456.${"x".repeat(200)}`]) assert.equal(classIdOfToken(bad), null, bad);
  assert.equal(sameToken("a.b", "a.b"), true);
  assert.equal(sameToken("a.b", "a.c"), false);
  assert.equal(sameToken("a.b", "a.bb"), false, "different lengths compare without throwing");
});

test("class board: public and CDN-cached, lists only active members, never pending or removed ones", async () => {
  const { seed, anonymous } = setup();
  const [ada, bob, cat, dan, eve] = await Promise.all(["Ada", "Bob", "Cat", "Dan", "Eve"].map((n) => seed(n)));
  if (!ada || !bob || !cat || !dan || !eve) throw new Error("seed failed");
  const klass = await classOf(ada);
  await join(bob, klass.code);
  await join(dan, klass.code);
  await detailOf(ada.call(`/classes/${klass.id}`, { method: "PATCH", body: { joinMode: "approval" } }));
  await join(cat, klass.code); // pending
  await expectStatus(ada.call(`/classes/${klass.id}/members/${dan.id}/remove`, { body: {} }), 204);
  for (const p of [ada, bob, cat, dan, eve]) await solveQ1(p); // Eve never joined

  const res = await anonymous(`/classboard/${klass.token}`);
  assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(res.headers.get("netlify-cdn-cache-control"), "public, durable, max-age=10, stale-while-revalidate=20");
  assert.equal(res.headers.get("netlify-cache-tag"), `class:${klass.id}`);
  assert.equal(res.headers.get("netlify-vary"), "query");
  assert.equal(res.headers.get("set-cookie"), null);
  const board = await boardOf(res);
  assert.deepEqual(names(board).sort(), ["Ada", "Bob"]);
  assert.equal(board.classId, klass.id);
  assert.equal(board.className, "Night shift");
  assert.equal(board.frozen, false);
  assert.equal(board.caseId, null);
  // Members appear on their class board without opting in to the global one, and stay off the global board.
  const global = await anonymous("/leaderboard");
  assert.deepEqual((await global.json() as { entries: unknown[] }).entries, []);

  // Approving Cat puts her on the board.
  await expectStatus(ada.call(`/classes/${klass.id}/members/${cat.id}/approve`, { body: {} }), 200);
  assert.deepEqual(names(await boardOf(anonymous(`/classboard/${klass.token}`))).sort(), ["Ada", "Bob", "Cat"]);
});

test("class board: a wrong token is a generic 404, a rotated token kills the old URL, an archived class is 404", async () => {
  const { seed, anonymous } = setup();
  const ada = await seed("Ada");
  const klass = await classOf(ada);
  await expectStatus(anonymous(`/classboard/${klass.token}`), 200);
  for (const bad of [`${klass.id}.wrong`, `${klass.token}x`, "AAAAAAAAAAAA.x", "garbage", `${klass.id}`]) {
    const res = await anonymous(`/classboard/${encodeURIComponent(bad)}`);
    assert.equal(res.status, 404, bad);
    assert.equal(res.headers.get("cache-control"), "no-store", "a 404 is never cached");
    assert.deepEqual(await res.json(), { error: "not found" });
  }
  await expectStatus(anonymous(`/classboard/${klass.token}?caseId=../x`), 400);

  const rotated = await detailOf(ada.call(`/classes/${klass.id}/board-token/rotate`, { body: {} }));
  assert.ok(rotated.boardToken && rotated.boardToken !== klass.token);
  await expectStatus(anonymous(`/classboard/${klass.token}`), 404);
  await expectStatus(anonymous(`/classboard/${rotated.boardToken}`), 200);

  await detailOf(ada.call(`/classes/${klass.id}/archive`, { body: {} }));
  await expectStatus(anonymous(`/classboard/${rotated.boardToken}`), 404);
  await detailOf(ada.call(`/classes/${klass.id}/restore`, { body: {} }));
  await expectStatus(anonymous(`/classboard/${rotated.boardToken}`), 200);
});

test("class edits purge the board's CDN tag; solves don't", async () => {
  const { seed, purges } = setup();
  const [ada, bob, cat] = await Promise.all(["Ada", "Bob", "Cat"].map((n) => seed(n)));
  if (!ada || !bob || !cat) throw new Error("seed failed");
  const klass = await classOf(ada);
  const tag = `class:${klass.id}`;
  const purgedBy = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    purges.length = 0;
    await run();
    assert.ok(purges.some((tags) => tags.includes(tag as CacheTag)), `${what} purges ${tag}: ${JSON.stringify(purges)}`);
  };
  await purgedBy("an active join", () => join(bob, klass.code));
  await purgedBy("PATCH", () => detailOf(ada.call(`/classes/${klass.id}`, { method: "PATCH", body: { name: "Renamed", joinMode: "approval" } })));
  await join(cat, klass.code); // pending
  await purgedBy("approve", () => expectStatus(ada.call(`/classes/${klass.id}/members/${cat.id}/approve`, { body: {} }), 200));
  await purgedBy("remove", () => expectStatus(ada.call(`/classes/${klass.id}/members/${cat.id}/remove`, { body: {} }), 204));
  await purgedBy("leave", () => expectStatus(bob.call(`/classes/${klass.id}/leave`, { body: {} }), 204));
  await purgedBy("token rotate", () => detailOf(ada.call(`/classes/${klass.id}/board-token/rotate`, { body: {} })));
  await purgedBy("archive", () => detailOf(ada.call(`/classes/${klass.id}/archive`, { body: {} })));
  await purgedBy("restore", () => detailOf(ada.call(`/classes/${klass.id}/restore`, { body: {} })));

  purges.length = 0;
  await solveQ1(ada);
  assert.ok(!purges.some((tags) => tags.includes(tag as CacheTag)), "a solve leaves the 10 s CDN window to expire on its own");
});

test("class board counts the class window: assigned cases, the event window and the freeze", async () => {
  const { seed, anonymous, at } = setup();
  const [ada, bob, cat] = await Promise.all(["Ada", "Bob", "Cat"].map((n) => seed(n)));
  if (!ada || !bob || !cat) throw new Error("seed failed");
  const klass = await classOf(ada);
  for (const p of [bob, cat]) await join(p, klass.code);
  await detailOf(ada.call(`/classes/${klass.id}`, {
    method: "PATCH",
    body: { caseIds: ["alpha"], event: { name: "Class night", startsAt: "2026-12-01T18:00:00Z", endsAt: "2026-12-01T20:00:00Z", freezeAt: "2026-12-01T19:45:00Z", announcement: null } },
  }));

  // Before the night: Cat plays anyway (gameplay never blocks), but nothing counts yet.
  at("2026-12-01T12:00:00Z");
  await solveQ1(cat);
  const board = `/classboard/${klass.token}`;
  assert.deepEqual(names(await boardOf(anonymous(board))), []);

  // During the night: alpha counts, beta (not assigned) doesn't.
  at("2026-12-01T18:30:00Z");
  await solveQ1(ada);
  await solveQ1(bob, "beta");
  at("2026-12-01T18:40:00Z");
  await expectStatus(cat.call("/cases/alpha/answer", { body: { questionId: "q2", answer: "a2" } }), 200);
  const live = await boardOf(anonymous(board));
  assert.deepEqual(names(live), ["Ada", "Cat"]);
  assert.equal(live.event.name, "Class night");
  assert.deepEqual(live.caseIds, ["alpha"]);
  assert.equal(live.entries.find((e) => e.username === "Ada")?.firstBloods, 1, "Ada was the class's first q1 solver in the window");
  assert.equal(live.entries.find((e) => e.username === "Cat")?.stagesSolved, 1, "Cat's q1 was before the window");
  assert.deepEqual(names(await boardOf(anonymous(`${board}?caseId=beta`))), [], "beta isn't assigned");

  // After the freeze: the board is frozen at freezeAt and later solves don't count.
  at("2026-12-01T19:50:00Z");
  await solveQ1(bob);
  const frozen = await boardOf(anonymous(board));
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.frozenAt, "2026-12-01T19:45:00Z");
  assert.deepEqual(names(frozen), ["Ada", "Cat"]);
  // After the end, play goes on, and still doesn't count.
  at("2026-12-01T21:00:00Z");
  await expectStatus(ada.call("/cases/alpha/answer", { body: { questionId: "q2", answer: "a2" } }), 200);
  assert.equal((await boardOf(anonymous(board))).entries.find((e) => e.username === "Ada")?.stagesSolved, 1);
});

test("class live progress: class admins only, active members only, 404 for non-members", async () => {
  const { seed, harness } = setup();
  const [ada, bob, cat, eve] = await Promise.all(["Ada", "Bob", "Cat", "Eve"].map((n) => seed(n)));
  if (!ada || !bob || !cat || !eve) throw new Error("seed failed");
  const klass = await classOf(ada);
  await join(bob, klass.code);
  await detailOf(ada.call(`/classes/${klass.id}`, { method: "PATCH", body: { joinMode: "approval" } }));
  await join(cat, klass.code); // pending
  for (const p of [bob, cat, eve]) await solveQ1(p);
  await expectStatus(bob.call("/cases/alpha/hint", { body: { questionId: "q2" } }), 200);

  const path = `/classes/${klass.id}/progress?caseId=alpha`;
  await expectStatus(eve.call(path), 404);
  await expectStatus(cat.call(path), 403, "not-class-admin"); // pending
  await expectStatus(bob.call(path), 403, "not-class-admin");
  await expectStatus(ada.call(`/classes/${klass.id}/progress`), 400);
  await expectStatus(ada.call(`/classes/${klass.id}/progress?caseId=nope`), 404, "unknown-case");

  const res = await ada.call(path);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const view = AdminProgressResponseSchema.parse(await res.json());
  assert.deepEqual(view.players.map((p) => p.username), ["Bob"], "Ada never opened alpha, Cat is pending, Eve isn't a member");
  const bobRow = view.players[0];
  assert.ok(bobRow);
  assert.equal(bobRow.stages.q1.status, "solved");
  assert.equal(bobRow.stages.q2.hintsRevealed, 1);
  assert.equal(bobRow.currentStage, "q2");
  assert.equal(bobRow.stages.q1.solvedAnswer, null, "admins never see a player's own answer");
  assert.deepEqual(bobRow.unlocked, { hints: {}, commands: {} }, "no paid content");

  const siteAdmin = await harness.admin(path);
  assert.equal(siteAdmin.status, 200);
});

test("gameplay never blocks on the site schedule, the site event or a class window; streaks still count today's case", async () => {
  const { seed, harness, at } = setup();
  const ada = await seed("Ada");
  await expectStatus(harness.admin("/admin/schedule", { method: "PUT", body: { timezone: "UTC", defaultCaseId: null, days: { "2026-12-01": "alpha", "2026-12-02": "beta" }, lockToToday: true } }), 200);
  await expectStatus(harness.admin("/admin/event", { method: "PUT", body: { name: "Later", startsAt: "2026-12-05T10:00:00Z", endsAt: "2026-12-05T12:00:00Z", freezeAt: null, enforceWindow: true, announcement: null } }), 200);
  const klass = await classOf(ada);
  await detailOf(ada.call(`/classes/${klass.id}`, { method: "PATCH", body: { caseIds: ["alpha"], event: { name: "Later", startsAt: "2026-12-05T10:00:00Z", endsAt: "2026-12-05T12:00:00Z", freezeAt: null, announcement: null } } }));

  // beta is neither today's case nor assigned to the class, and every window is in the future: it plays.
  await solveQ1(ada, "beta");
  await expectStatus(ada.call("/cases/beta/hint", { body: { questionId: "q2" } }), 200);
  await expectStatus(ada.call("/cases/beta/reveal-command", { body: { toolId: "grep-5xx" } }), 200);

  // Finishing today's case on its day still builds the streak: alpha on the 1st, beta (started early) on the 2nd.
  at("2026-12-01T15:00:00Z");
  await solveQ1(ada);
  for (const [i, answer] of ALL_ANSWERS.entries()) await expectStatus(ada.call("/cases/alpha/answer", { body: { questionId: `q${i + 2}`, answer } }), 200);
  at("2026-12-02T15:00:00Z");
  for (const [i, answer] of ALL_ANSWERS.entries()) await expectStatus(ada.call("/cases/beta/answer", { body: { questionId: `q${i + 2}`, answer } }), 200);
  const stats = UserStatsResponseSchema.parse(await (await ada.call("/me/stats")).json());
  assert.deepEqual(stats.stats.streak, { current: 2, best: 2 });
});
