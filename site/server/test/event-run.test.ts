// Event runs that count only on the class board (#253).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SCORING, AdminProgressResponseSchema, AnswerResponseSchema, TrashResponseSchema, ClassBoardResponseSchema, ClassResponseSchema, ProgressResponseSchema, UserStatsResponseSchema } from "../../shared/contract.ts";
import type { ClassBoardResponse, ClassDetail, ProgressView } from "../../shared/contract.ts";
import { eventKeyOf, isEventLive } from "../domain/event-run.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import type { KvStore } from "../repositories/KvStore.ts";
import { generateAccountId, sha256Hex } from "../services/crypto.ts";
import { ALL_ANSWERS, createHarness, expectStatus } from "./helpers.ts";

type Init = { method?: string; body?: unknown };
type Player = { id: string; username: string; call(path: string, init?: Init): Promise<Response> };

const START = Date.parse("2026-12-01T10:00:00Z");
const EVENT = { name: "Class night", startsAt: "2026-12-01T18:00:00Z", endsAt: "2026-12-01T20:00:00Z", freezeAt: "2026-12-01T19:45:00Z", announcement: null };

const setup = () => {
  const kv = new InMemoryKvStore();
  let nowMs = START;
  const harness = createHarness({ store: kv, now: () => new Date(nowMs) });
  const seed = async (username: string): Promise<Player> => {
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
          `10.3.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
        ),
    };
  };
  const anonymous = (path: string): Promise<Response> => harness.app.handle(new Request(`http://localhost/api${path}`), "10.7.7.7");
  const at = (iso: string): void => {
    nowMs = Date.parse(iso);
  };
  return { kv, seed, anonymous, at, harness };
};

const detailOf = async (res: Promise<Response>): Promise<ClassDetail> => {
  const r = await res;
  assert.ok(r.ok, await r.clone().text());
  return ClassResponseSchema.parse(await r.json()).class;
};
const boardOf = async (res: Promise<Response>): Promise<ClassBoardResponse> => {
  const r = await res;
  assert.equal(r.status, 200, await r.clone().text());
  return ClassBoardResponseSchema.parse(await r.json());
};
const progressOf = async (res: Promise<Response>): Promise<ProgressView> => {
  const r = await res;
  assert.equal(r.status, 200, await r.clone().text());
  return ProgressResponseSchema.parse(await r.json()).progress;
};

/** Ada owns a class with Bob (and anyone else given) as an active member and the event set. */
const classWith = async (ada: Player, members: readonly Player[], patch: Record<string, unknown> = { caseIds: ["alpha"], event: EVENT }) => {
  const created = await detailOf(ada.call("/classes", { body: { name: "Night shift" } }));
  assert.ok(created.admin && created.boardToken);
  for (const m of members) await expectStatus(m.call("/classes/join", { body: { code: created.admin.joinCode } }), 200);
  await detailOf(ada.call(`/classes/${created.id}`, { method: "PATCH", body: patch }));
  return { id: created.id, token: created.boardToken };
};

/** Plays the whole case, every answer right, on the own run or an event run. */
const playAll = async (p: Player, run?: { classId: string }, caseId = "alpha"): Promise<void> => {
  const extra = run === undefined ? {} : { run };
  await expectStatus(p.call(`/cases/${caseId}/setup-done`, { body: extra }), 200);
  const answers = [`${caseId}-a1`, ...ALL_ANSWERS];
  for (const [i, answer] of answers.entries()) {
    const res = await p.call(`/cases/${caseId}/answer`, { body: { questionId: `q${i + 1}`, answer, ...extra } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(AnswerResponseSchema.parse(await res.json()).correct, true);
  }
};

const keysOf = async (kv: KvStore, prefix: string): Promise<string[]> => (await kv.listKeys(prefix)).sort();
const snapshot = async (kv: KvStore, prefixes: readonly string[]): Promise<string> => {
  const out: Record<string, unknown> = {};
  for (const prefix of prefixes) for (const key of await keysOf(kv, prefix)) out[key] = (await kv.get(key))?.data;
  return JSON.stringify(out);
};

test("eventKey: stable over the event's name, end and freeze; a new start is a new occurrence", () => {
  const key = eventKeyOf(EVENT);
  assert.match(key ?? "", /^[0-9a-f]{16}$/);
  assert.equal(eventKeyOf({ ...EVENT, startsAt: "2026-12-01T18:00:00.000Z", endsAt: "2026-12-01T21:00:00Z" }), key);
  assert.notEqual(eventKeyOf({ ...EVENT, startsAt: "2026-12-01T18:05:00Z" }), key);
  assert.equal(eventKeyOf({ ...EVENT, endsAt: null }), null);
  assert.equal(isEventLive(EVENT, new Date("2026-12-01T17:59:59Z")), false);
  assert.equal(isEventLive(EVENT, new Date("2026-12-01T18:00:00Z")), true);
  assert.equal(isEventLive(EVENT, new Date("2026-12-01T20:00:00Z")), false, "the end is exclusive");
});

test("event run: a case finished before the event scores that night on the class board only", async () => {
  const { kv, seed, anonymous, at } = setup();
  const [ada, bob] = await Promise.all([seed("Ada"), seed("Bob")]);
  const klass = await classWith(ada, [bob]);
  const run = { classId: klass.id };

  // Bob finishes alpha in the afternoon: his own run, before the event.
  at("2026-12-01T12:00:00Z");
  await playAll(bob);
  await expectStatus(bob.call("/me/board", { method: "PUT", body: { show: true } }), 200);
  const globalEntries = async (): Promise<unknown> => ((await (await anonymous("/leaderboard")).json()) as { entries: unknown }).entries;
  const statsBefore = UserStatsResponseSchema.parse(await (await bob.call("/me/stats")).json()).stats;
  const globalBefore = await globalEntries();
  assert.equal((globalBefore as unknown[]).length, 1, "Bob is on the global board with his own run");
  const untouched = ["progress:", "score:", "firstblood:", "globalboard:"];
  const before = await snapshot(kv, untouched);

  // During the event his own run doesn't count again, but the event run does.
  at("2026-12-01T18:30:00Z");
  assert.deepEqual((await boardOf(anonymous(`/classboard/${klass.token}`))).entries, []);
  const opened = await progressOf(bob.call(`/cases/alpha/progress?run=${klass.id}`));
  assert.equal(opened.setupDoneAt, null, "a fresh record, not his finished own run");
  assert.equal(opened.run?.classId, klass.id);
  assert.equal(opened.run?.className, "Night shift");
  assert.equal(opened.run?.eventKey, eventKeyOf(EVENT));
  await playAll(bob, run);
  const done = await progressOf(bob.call(`/cases/alpha/progress?run=${klass.id}`));
  assert.notEqual(done.completedAt, null);
  await expectStatus(bob.call(`/cases/alpha/debrief?run=${klass.id}`), 200);

  const board = await boardOf(anonymous(`/classboard/${klass.token}`));
  assert.deepEqual(board.entries.map((e) => e.username), ["Bob"]);
  assert.equal(board.entries[0]?.score, done.score + 6 * SCORING.FIRST_BLOOD_BONUS, "the event run's score plus the class's first-solver bonus on all six stages");
  assert.equal(board.entries[0]?.casesCompleted, 1);

  // Nothing of the own run, the summary, first blood or the global board moved; the event run has its own key.
  assert.equal(await snapshot(kv, untouched), before);
  assert.deepEqual(await keysOf(kv, "eventprogress:"), [`eventprogress:${klass.id}:${eventKeyOf(EVENT)}:alpha:${bob.id}`]);
  assert.deepEqual(await globalEntries(), globalBefore);
  const statsAfter = UserStatsResponseSchema.parse(await (await bob.call("/me/stats")).json()).stats;
  assert.deepEqual({ ...statsAfter, lastSeenAt: null }, { ...statsBefore, lastSeenAt: null }, "My stats, achievements and streaks don't change");
  // The own run still reads as it was.
  const own = await progressOf(bob.call("/cases/alpha/progress"));
  assert.equal(own.run, null);
  assert.equal(own.completedAt !== null, true);
});

test("event run: refused for non-members, a closed window and unassigned cases, with no fallback", async () => {
  const { kv, seed, at } = setup();
  const [ada, bob, eve] = await Promise.all([seed("Ada"), seed("Bob"), seed("Eve")]);
  const klass = await classWith(ada, [bob]);
  const run = { classId: klass.id };
  const before = await snapshot(kv, ["progress:", "eventprogress:"]);

  at("2026-12-01T18:30:00Z");
  await expectStatus(eve.call(`/cases/alpha/progress?run=${klass.id}`), 403, "not-a-member");
  await expectStatus(eve.call("/cases/alpha/setup-done", { body: { run } }), 403, "not-a-member");
  await expectStatus(bob.call("/cases/alpha/progress?run=AAAAAAAAAAAA"), 403, "not-a-member");
  await expectStatus(bob.call("/cases/alpha/progress?run=../x"), 400);
  await expectStatus(bob.call("/cases/beta/progress?run=" + klass.id), 409, "event-not-live"); // beta isn't assigned
  await expectStatus(bob.call("/cases/beta/setup-done", { body: { run } }), 409, "event-not-live");

  at("2026-12-01T17:59:00Z");
  await expectStatus(bob.call(`/cases/alpha/progress?run=${klass.id}`), 409, "event-not-live");
  at("2026-12-01T20:00:00Z");
  await expectStatus(bob.call("/cases/alpha/setup-done", { body: { run } }), 409, "event-not-live");
  assert.equal(await snapshot(kv, ["progress:", "eventprogress:"]), before, "no refusal wrote any record");

  // Mid-run, the window closes: answers are refused, never applied to the own run.
  at("2026-12-01T19:00:00Z");
  await expectStatus(bob.call("/cases/alpha/setup-done", { body: { run } }), 200);
  at("2026-12-01T20:00:01Z");
  await expectStatus(bob.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1", run } }), 409, "event-not-live");
  await expectStatus(bob.call("/cases/alpha/hint", { body: { questionId: "q1", expectedHint: 0, run } }), 409, "event-not-live");
  assert.deepEqual(await keysOf(kv, "progress:"), [], "the own run was never opened");

  // A removed member is refused at once; a class with no assigned cases takes any public case.
  at("2026-12-01T18:30:00Z");
  await detailOf(ada.call(`/classes/${klass.id}`, { method: "PATCH", body: { caseIds: [] } }));
  await progressOf(bob.call(`/cases/beta/progress?run=${klass.id}`));
  await expectStatus(ada.call(`/classes/${klass.id}/members/${bob.id}/remove`, { body: {} }), 204);
  await expectStatus(bob.call(`/cases/alpha/progress?run=${klass.id}`), 403, "not-a-member");
});

test("event run: idempotency and stale guards hold, and the board respects the freeze", async () => {
  const { seed, anonymous, at } = setup();
  const [ada, bob] = await Promise.all([seed("Ada"), seed("Bob")]);
  const klass = await classWith(ada, [bob]);
  const run = { classId: klass.id };

  at("2026-12-01T18:30:00Z");
  await expectStatus(bob.call("/cases/alpha/setup-done", { body: { run } }), 200);
  // The same wrong answer twice counts once.
  for (let i = 0; i < 2; i++) await expectStatus(bob.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "nope", run } }), 200);
  // A hint bought twice with the same expectedHint is charged once; the retry is 409 stale with the event progress.
  await expectStatus(bob.call("/cases/alpha/hint", { body: { questionId: "q1", expectedHint: 0, run } }), 200);
  const stale = await bob.call("/cases/alpha/hint", { body: { questionId: "q1", expectedHint: 0, run } });
  assert.equal(stale.status, 409);
  const staleBody = (await stale.json()) as { code: string; progress: ProgressView };
  assert.equal(staleBody.code, "stale");
  assert.equal(staleBody.progress.run?.classId, klass.id, "the stale body is the event run's progress");
  // A command charged to a stage that isn't active is stale too.
  await expectStatus(bob.call("/cases/alpha/reveal-command", { body: { toolId: "grep-5xx", expectedStage: "q2", run } }), 409, "stale");
  // A double-submitted correct answer scores once.
  await expectStatus(bob.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1", run } }), 200);
  await expectStatus(bob.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1", run } }), 200);
  const view = await progressOf(bob.call(`/cases/alpha/progress?run=${klass.id}`));
  const q1 = view.stages.q1;
  assert.equal(q1?.wrongAttempts, 1);
  assert.equal(q1?.hintsRevealed, 1);
  assert.equal(q1?.status, "solved");
  assert.equal(q1?.breakdown?.firstBlood, 0, "an event run claims no site-wide first blood");

  // After the freeze, a later event-run solve doesn't count on the board.
  const atFreeze = await boardOf(anonymous(`/classboard/${klass.token}`));
  at("2026-12-01T19:50:00Z");
  await expectStatus(bob.call("/cases/alpha/answer", { body: { questionId: "q2", answer: "a2", run } }), 200);
  const frozen = await boardOf(anonymous(`/classboard/${klass.token}`));
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.entries[0]?.score, atFreeze.entries[0]?.score);
  assert.equal(frozen.entries[0]?.stagesSolved, 1);
});

test("class board counts event runs and, for players who never opened one, their own runs inside the window", async () => {
  const { seed, anonymous, at } = setup();
  const [ada, bob, cat, dan] = await Promise.all([seed("Ada"), seed("Bob"), seed("Cat"), seed("Dan")]);
  const klass = await classWith(ada, [bob, cat, dan]);
  const run = { classId: klass.id };

  // Dan solves q1 on his own run before the event: never counted.
  at("2026-12-01T12:00:00Z");
  await expectStatus(dan.call("/cases/alpha/setup-done", { body: {} }), 200);
  await expectStatus(dan.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } }), 200);

  at("2026-12-01T18:10:00Z");
  // Cat plays the old way, on her own run, inside the window: counts (back-compat).
  await expectStatus(cat.call("/cases/alpha/setup-done", { body: {} }), 200);
  await expectStatus(cat.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } }), 200);
  // Bob plays an event run.
  at("2026-12-01T18:20:00Z");
  await expectStatus(bob.call("/cases/alpha/setup-done", { body: { run } }), 200);
  await expectStatus(bob.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1", run } }), 200);
  // Dan solves q2 on his own run inside the window, then opens an event run: from then on only the event run counts.
  await expectStatus(dan.call("/cases/alpha/answer", { body: { questionId: "q2", answer: "a2" } }), 200);
  let board = await boardOf(anonymous(`/classboard/${klass.token}`));
  assert.deepEqual(board.entries.map((e) => [e.username, e.stagesSolved]).sort(), [["Bob", 1], ["Cat", 1], ["Dan", 1]]);
  assert.equal(board.entries.find((e) => e.username === "Cat")?.firstBloods, 1, "Cat solved q1 first in the window");
  await progressOf(dan.call(`/cases/alpha/progress?run=${klass.id}`));
  board = await boardOf(anonymous(`/classboard/${klass.token}`));
  assert.deepEqual(board.entries.map((e) => e.username).sort(), ["Bob", "Cat"], "an opened event run replaces the own run, even empty");

  // The event's key follows startsAt: moving the start starts a new occurrence, and the old runs no longer count.
  await detailOf(ada.call(`/classes/${klass.id}`, { method: "PATCH", body: { event: { ...EVENT, startsAt: "2026-12-01T18:15:00Z" } } }));
  board = await boardOf(anonymous(`/classboard/${klass.token}`));
  assert.deepEqual(board.entries.map((e) => e.username).sort(), ["Dan"], "only Dan's own q2 at 18:20 is in the new window");
});

test("event runs go to the trash with a deleted account, come back on restore, and show in class Live (#268)", async () => {
  const { kv, seed, at, harness } = setup();
  const ada = await seed("Ada");
  const bob = await seed("Bob");
  const cls = await classWith(ada, [bob]);
  at("2026-12-01T18:30:00Z"); // the event is live
  const run = { classId: cls.id };
  await expectStatus(bob.call("/cases/alpha/setup-done", { body: { run } }), 200);
  await expectStatus(bob.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1", run } }), 200);
  // Bob never opened his own run: class Live shows the event run while the event is live.
  const liveRes = await ada.call(`/classes/${cls.id}/progress?caseId=alpha`);
  assert.equal(liveRes.status, 200, await liveRes.clone().text());
  const live = AdminProgressResponseSchema.parse(await liveRes.json());
  assert.deepEqual(live.players.map((p) => [p.accountId, p.currentStage]), [[bob.id, "q2"]]);

  const eventKeys = await keysOf(kv, "eventprogress:");
  assert.equal(eventKeys.length, 1);
  await expectStatus(harness.admin(`/admin/accounts/${bob.id}`, { method: "DELETE" }), 204);
  assert.deepEqual(await keysOf(kv, "eventprogress:"), []);
  const trash = TrashResponseSchema.parse(await (await harness.admin("/admin/trash")).json());
  const entry = trash.entries.find((e) => e.kind === "account");
  assert.ok(entry);
  await expectStatus(harness.admin(`/admin/trash/${entry.id}/restore`, { body: {} }), 200);
  assert.deepEqual(await keysOf(kv, "eventprogress:"), eventKeys);
});

test("a progress reset clears event runs of that case, and the weekly sweep drops runs older than 180 days (#268)", async () => {
  const { kv, seed, at, harness } = setup();
  const ada = await seed("Ada");
  const bob = await seed("Bob");
  const cls = await classWith(ada, [bob]);
  at("2026-12-01T18:30:00Z");
  await expectStatus(bob.call("/cases/alpha/setup-done", { body: { run: { classId: cls.id } } }), 200);
  assert.equal((await keysOf(kv, "eventprogress:")).length, 1);
  await expectStatus(harness.admin("/admin/reset", { body: { confirm: "RESET", caseId: "alpha" } }), 204);
  assert.deepEqual(await keysOf(kv, "eventprogress:"), []);

  await expectStatus(bob.call("/cases/alpha/setup-done", { body: { run: { classId: cls.id } } }), 200);
  const { createAccountHygiene } = await import("../services/AccountHygieneService.ts");
  assert.equal((await createAccountHygiene(kv, () => new Date("2027-03-01T00:00:00Z")).run({ apply: true })).oldEventRuns, 0);
  const sweep = createAccountHygiene(kv, () => new Date("2027-06-30T00:00:00Z"));
  assert.equal((await sweep.run({ apply: false })).oldEventRuns, 1);
  assert.equal((await sweep.run({ apply: true })).oldEventRuns, 1);
  assert.deepEqual(await keysOf(kv, "eventprogress:"), []);
});
