// Classes (#179): limits, joining, rotation, the non-member 404, the permission matrix, guests, concurrency,
// index consistency and account deletion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  AccountResponseSchema,
  AdminClassesResponseSchema,
  ClassesResponseSchema,
  ClassJoinResponseSchema,
  ClassMembersResponseSchema,
  ClassResponseSchema,
  TrashResponseSchema,
} from "../../shared/contract.ts";
import type { ClassDetail } from "../../shared/contract.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import type { KvStore } from "../repositories/KvStore.ts";
import { generateAccountId, sha256Hex } from "../services/crypto.ts";
import { ADMIN_KEY, createHarness, expectStatus } from "./helpers.ts";

type Harness = ReturnType<typeof createHarness>;
type Init = { method?: string; body?: unknown; ip?: string };
type Player = { id: string; username: string; call(path: string, init?: Init): Promise<Response> };

/** An approved player written straight into the store with a live session (no scrypt, so tests stay fast). */
const seedPlayer = async (kv: KvStore, harness: Harness, username: string, extra: Record<string, unknown> = {}): Promise<Player> => {
  const id = generateAccountId();
  const token = randomBytes(32).toString("base64url");
  const nowIso = new Date().toISOString();
  await kv.set(`account:${id}`, {
    id, username, usernameKey: username.toLowerCase(), passwordHash: "x", status: "approved", sessionEpoch: 0,
    createdAt: nowIso, decidedAt: nowIso, lastSeenAt: nowIso, lastLoginAt: null, ...extra,
  });
  await kv.set(`session:${sha256Hex(token)}`, { role: "player", accountId: id, epoch: 0, createdAt: nowIso, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
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
        init.ip ?? `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      ),
  };
};

const detailOf = async (res: Response | Promise<Response>): Promise<ClassDetail> => ClassResponseSchema.parse(await (await res).json()).class;
const createClass = async (player: Player, name = "Night shift"): Promise<ClassDetail> => {
  const res = await player.call("/classes", { body: { name } });
  await expectStatus(res.clone(), 201);
  return detailOf(res);
};
const joinCode = (detail: ClassDetail): string => {
  assert.ok(detail.admin, "admins see the settings");
  return detail.admin.joinCode;
};
const keys = (kv: KvStore, prefix: string) => kv.listKeys(prefix);

const setup = () => {
  const kv = new InMemoryKvStore();
  const harness = createHarness({ store: kv });
  return { kv, harness, seed: (name: string, extra?: Record<string, unknown>) => seedPlayer(kv, harness, name, extra) };
};

test("creating a class: the creator is the active owner admin; 3 owned at most, archive frees one, a raised limit allows more", async () => {
  const { kv, harness, seed } = setup();
  const ada = await seed("Ada");
  const first = await createClass(ada, "  Red team  ");
  assert.equal(first.name, "Red team");
  assert.deepEqual(first.membership, { role: "admin", status: "active", isOwner: true });
  assert.ok(first.admin);
  assert.equal(first.admin.memberLimit, 60);
  assert.equal(first.admin.joinMode, "code");
  assert.match(first.admin.joinCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.ok(first.boardToken?.startsWith(`${first.id}.`) && first.boardToken.length > 40);
  assert.deepEqual(await keys(kv, `classmember:${first.id}:`), [`classmember:${first.id}:${ada.id}`]);
  assert.deepEqual(await keys(kv, `memberof:${ada.id}:`), [`memberof:${ada.id}:${first.id}`]);

  await createClass(ada, "Two");
  const third = await createClass(ada, "Three");
  await expectStatus(ada.call("/classes", { body: { name: "Four" } }), 409, "class-limit");
  assert.equal((await keys(kv, "class:")).length, 3);

  await expectStatus(ada.call(`/classes/${third.id}/archive`, { body: {} }), 200);
  await createClass(ada, "Four");
  await expectStatus(ada.call(`/classes/${third.id}/restore`, { body: {} }), 409, "class-limit");

  await expectStatus(harness.admin(`/admin/accounts/${ada.id}/class-limit`, { method: "PUT", body: { classLimit: 5 } }), 200);
  await createClass(ada, "Five");
  await expectStatus(ada.call(`/classes/${third.id}/restore`, { body: {} }), 200);
  await expectStatus(ada.call("/classes", { body: { name: "Six" } }), 409, "class-limit");

  const mine = ClassesResponseSchema.parse(await (await ada.call("/classes")).json()).classes;
  assert.equal(mine.length, 5);
  assert.ok(mine.every((c) => c.membership?.isOwner === true));
});

test("concurrent creates can't go past the owned-class limit", async () => {
  const { kv, seed } = setup();
  const ada = await seed("Ada");
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => ada.call("/classes", { body: { name: `C${i}` } })));
  const created = results.filter((r) => r.status === 201).length;
  assert.ok(created <= 3 && created >= 1, `created ${created}`);
  assert.equal((await keys(kv, "class:")).length, created, "rolled-back creates leave no class behind");
  assert.equal((await keys(kv, `memberof:${ada.id}:`)).length, created);
  assert.equal((await keys(kv, "classcode:")).length, created, "nor a code index entry");
});

test("creates are rate-limited per account (10 a day)", async () => {
  const { seed, harness } = setup();
  const ada = await seed("Ada");
  await expectStatus(harness.admin(`/admin/accounts/${ada.id}/class-limit`, { method: "PUT", body: { classLimit: 50 } }), 200);
  for (let i = 0; i < 10; i++) await createClass(ada, `C${i}`);
  await expectStatus(ada.call("/classes", { body: { name: "C11" } }), 429, "rate-limited");
});

test("join by code is active at once and idempotent; approval mode makes a pending request", async () => {
  const { kv, seed } = setup();
  const owner = await seed("Owner");
  const bob = await seed("Bob");
  const cleo = await seed("Cleo");
  const cls = await createClass(owner);
  const code = joinCode(cls);

  const joined = ClassJoinResponseSchema.parse(await (await bob.call("/classes/join", { body: { code: code.toLowerCase().replace("-", " ") } })).json()).class;
  assert.deepEqual(joined.membership, { role: "member", status: "active", isOwner: false });
  await expectStatus(bob.call("/classes/join", { body: { code } }), 200); // again: no change, no error
  assert.equal((await keys(kv, `classmember:${cls.id}:`)).length, 2);

  const asMember = await detailOf(bob.call(`/classes/${cls.id}`));
  assert.equal(asMember.admin, undefined, "members don't see the settings or the code");
  assert.equal(asMember.boardToken, cls.boardToken);
  assert.deepEqual(asMember.caseIds, []);
  assert.ok(asMember.schedule && asMember.event);

  await expectStatus(owner.call(`/classes/${cls.id}`, { method: "PATCH", body: { joinMode: "approval" } }), 200);
  const pending = ClassJoinResponseSchema.parse(await (await cleo.call("/classes/join", { body: { code } })).json()).class;
  assert.equal(pending.membership?.status, "pending");
  const asPending = await detailOf(cleo.call(`/classes/${cls.id}`));
  assert.deepEqual(Object.keys(asPending).sort(), ["id", "membership", "name", "status"], "a pending request sees the name only");
  await expectStatus(cleo.call(`/classes/${cls.id}/members`), 403, "not-class-admin");

  const members = ClassMembersResponseSchema.parse(await (await owner.call(`/classes/${cls.id}/members`)).json()).members;
  assert.deepEqual(members.map((m) => [m.username, m.role, m.status, m.isOwner]), [["Owner", "admin", "active", true], ["Bob", "member", "active", false], ["Cleo", "member", "pending", false]]);
  assert.deepEqual(Object.keys(members[0] ?? {}).sort(), ["accountId", "decidedAt", "isOwner", "joinedAt", "role", "status", "username"], "usernames only, nothing else of the account");

  await expectStatus(owner.call(`/classes/${cls.id}/members/${cleo.id}/approve`, { body: {} }), 200);
  assert.equal((await detailOf(cleo.call(`/classes/${cls.id}`))).membership?.status, "active");
  assert.deepEqual((await kv.get(`memberof:${cleo.id}:${cls.id}`))?.data, { role: "member", status: "active", isOwner: false });
});

test("an unknown code is a generic 404, and wrong codes are rate-limited per account and per address", async () => {
  const { seed } = setup();
  const owner = await seed("Owner");
  const cls = await createClass(owner);
  const guesser = await seed("Guesser");
  for (let i = 0; i < 10; i++) await expectStatus(guesser.call("/classes/join", { body: { code: `WRONG-${i}AAAA` } }), 404);
  await expectStatus(guesser.call("/classes/join", { body: { code: joinCode(cls) } }), 429, "rate-limited");

  const ip = "10.7.7.7";
  const others = await Promise.all(Array.from({ length: 4 }, (_, i) => seed(`Other${i}`)));
  let failures = 0;
  for (const other of others) {
    for (let i = 0; i < 9 && failures < 30; i++, failures++) await expectStatus(other.call("/classes/join", { body: { code: `NOPE${i}NOPE` }, ip }), 404);
  }
  const fresh = await seed("Fresh");
  await expectStatus(fresh.call("/classes/join", { body: { code: joinCode(cls) }, ip }), 429, "rate-limited");
  await expectStatus(fresh.call("/classes/join", { body: { code: joinCode(cls) }, ip: "10.8.8.8" }), 200);
});

test("rotating the join code stops the old one at once; rotating the board token replaces it", async () => {
  const { kv, seed } = setup();
  const owner = await seed("Owner");
  const bob = await seed("Bob");
  const cls = await createClass(owner);
  const rotated = await detailOf(owner.call(`/classes/${cls.id}/join-code/rotate`, { body: {} }));
  assert.notEqual(joinCode(rotated), joinCode(cls));
  await expectStatus(bob.call("/classes/join", { body: { code: joinCode(cls) } }), 404);
  assert.equal((await keys(kv, "classcode:")).length, 1, "the old index entry is gone");
  await expectStatus(bob.call("/classes/join", { body: { code: joinCode(rotated) } }), 200);

  const token = await detailOf(owner.call(`/classes/${cls.id}/board-token/rotate`, { body: {} }));
  assert.notEqual(token.boardToken, cls.boardToken);
  assert.equal((await detailOf(bob.call(`/classes/${cls.id}`))).boardToken, token.boardToken);
});

test("non-members (and unknown ids) get 404 on every class route", async () => {
  const { seed } = setup();
  const owner = await seed("Owner");
  const stranger = await seed("Stranger");
  const cls = await createClass(owner);
  const routes: Array<[string, Init]> = [
    [`/classes/${cls.id}`, {}],
    [`/classes/${cls.id}`, { method: "PATCH", body: { name: "Mine now" } }],
    [`/classes/${cls.id}/archive`, { body: {} }],
    [`/classes/${cls.id}/restore`, { body: {} }],
    [`/classes/${cls.id}/leave`, { body: {} }],
    [`/classes/${cls.id}/members`, {}],
    [`/classes/${cls.id}/join-code/rotate`, { body: {} }],
    [`/classes/${cls.id}/board-token/rotate`, { body: {} }],
    [`/classes/${cls.id}/members/${owner.id}/approve`, { body: {} }],
    [`/classes/${cls.id}/members/${owner.id}/remove`, { body: {} }],
    [`/classes/${cls.id}/members/${owner.id}/role`, { body: { role: "member" } }],
    ["/classes/AAAAAAAAAAAA", {}],
    ["/classes/not-a-class-id", {}],
  ];
  for (const [path, init] of routes) await expectStatus(stranger.call(path, init), 404);
});

/** owner, co-admin, member, pending member and the site admin, in one class, plus spare targets. */
const matrixFixture = async () => {
  const base = setup();
  const { seed, harness } = base;
  const owner = await seed("Owner");
  const coadmin = await seed("Coadmin");
  const coadmin2 = await seed("Coadmin2");
  const member = await seed("Member");
  const member2 = await seed("Member2");
  const pending = await seed("Pending");
  const pending2 = await seed("Pending2");
  const cls = await createClass(owner);
  const code = joinCode(cls);
  for (const p of [coadmin, coadmin2, member, member2]) await expectStatus(p.call("/classes/join", { body: { code } }), 200);
  await expectStatus(owner.call(`/classes/${cls.id}`, { method: "PATCH", body: { joinMode: "approval" } }), 200);
  for (const p of [pending, pending2]) await expectStatus(p.call("/classes/join", { body: { code } }), 200);
  for (const p of [coadmin, coadmin2]) await expectStatus(owner.call(`/classes/${cls.id}/members/${p.id}/role`, { body: { role: "admin" } }), 200);
  const siteAdmin: Player = {
    id: "admin",
    username: "admin",
    call: (path, init = {}) => harness.admin(path, { ...(init.method === undefined ? {} : { method: init.method }), ...(init.body === undefined ? {} : { body: init.body }) }),
  };
  return { ...base, cls, owner, coadmin, coadmin2, member, member2, pending, pending2, siteAdmin };
};

type Fixture = Awaited<ReturnType<typeof matrixFixture>>;
type ActorName = "owner" | "coadmin" | "member" | "pending" | "siteAdmin";
const ACTORS: readonly ActorName[] = ["owner", "coadmin", "member", "pending", "siteAdmin"];

/** Each cell: [action, expected status per actor (with the error code when refused)]. A fresh fixture per cell. */
const MATRIX: Array<{ name: string; run: (f: Fixture, actor: Player) => Promise<Response>; expect: Record<ActorName, [number, string?]> }> = [
  { name: "view", run: (f, a) => a.call(`/classes/${f.cls.id}`), expect: { owner: [200], coadmin: [200], member: [200], pending: [200], siteAdmin: [200] } },
  {
    name: "edit settings",
    run: (f, a) => a.call(`/classes/${f.cls.id}`, { method: "PATCH", body: { name: "Renamed" } }),
    expect: { owner: [200], coadmin: [200], member: [403, "not-class-admin"], pending: [403, "not-class-admin"], siteAdmin: [200] },
  },
  {
    name: "list members",
    run: (f, a) => a.call(`/classes/${f.cls.id}/members`),
    expect: { owner: [200], coadmin: [200], member: [403, "not-class-admin"], pending: [403, "not-class-admin"], siteAdmin: [200] },
  },
  {
    name: "rotate join code",
    run: (f, a) => a.call(`/classes/${f.cls.id}/join-code/rotate`, { body: {} }),
    expect: { owner: [200], coadmin: [200], member: [403, "not-class-admin"], pending: [403, "not-class-admin"], siteAdmin: [200] },
  },
  {
    name: "rotate board token",
    run: (f, a) => a.call(`/classes/${f.cls.id}/board-token/rotate`, { body: {} }),
    expect: { owner: [200], coadmin: [200], member: [403, "not-class-admin"], pending: [403, "not-class-admin"], siteAdmin: [200] },
  },
  {
    name: "archive",
    run: (f, a) => a.call(`/classes/${f.cls.id}/archive`, { body: {} }),
    expect: { owner: [200], coadmin: [403, "not-class-owner"], member: [403, "not-class-owner"], pending: [403, "not-class-owner"], siteAdmin: [200] },
  },
  {
    name: "approve a pending request",
    run: (f, a) => a.call(`/classes/${f.cls.id}/members/${f.pending2.id}/approve`, { body: {} }),
    expect: { owner: [200], coadmin: [200], member: [403, "not-class-admin"], pending: [403, "not-class-admin"], siteAdmin: [200] },
  },
  {
    name: "remove a member",
    run: (f, a) => a.call(`/classes/${f.cls.id}/members/${f.member2.id}/remove`, { body: {} }),
    expect: { owner: [204], coadmin: [204], member: [403, "not-class-admin"], pending: [403, "not-class-admin"], siteAdmin: [204] },
  },
  {
    name: "remove a co-admin",
    run: (f, a) => a.call(`/classes/${f.cls.id}/members/${f.coadmin2.id}/remove`, { body: {} }),
    expect: { owner: [204], coadmin: [403, "not-class-owner"], member: [403, "not-class-admin"], pending: [403, "not-class-admin"], siteAdmin: [204] },
  },
  {
    name: "remove the owner",
    run: (f, a) => a.call(`/classes/${f.cls.id}/members/${f.owner.id}/remove`, { body: {} }),
    expect: { owner: [409, "owner-locked"], coadmin: [409, "owner-locked"], member: [403, "not-class-admin"], pending: [403, "not-class-admin"], siteAdmin: [409, "owner-locked"] },
  },
  {
    name: "promote a member",
    run: (f, a) => a.call(`/classes/${f.cls.id}/members/${f.member2.id}/role`, { body: { role: "admin" } }),
    expect: { owner: [200], coadmin: [403, "not-class-owner"], member: [403, "not-class-admin"], pending: [403, "not-class-admin"], siteAdmin: [200] },
  },
  {
    name: "demote a co-admin",
    run: (f, a) => a.call(`/classes/${f.cls.id}/members/${f.coadmin2.id}/role`, { body: { role: "member" } }),
    expect: { owner: [200], coadmin: [403, "not-class-owner"], member: [403, "not-class-admin"], pending: [403, "not-class-admin"], siteAdmin: [200] },
  },
  {
    name: "demote the owner",
    run: (f, a) => a.call(`/classes/${f.cls.id}/members/${f.owner.id}/role`, { body: { role: "member" } }),
    expect: { owner: [409, "owner-locked"], coadmin: [403, "not-class-owner"], member: [403, "not-class-admin"], pending: [403, "not-class-admin"], siteAdmin: [409, "owner-locked"] },
  },
  {
    name: "leave",
    run: (f, a) => a.call(`/classes/${f.cls.id}/leave`, { body: {} }),
    expect: { owner: [409, "owner-locked"], coadmin: [204], member: [204], pending: [204], siteAdmin: [403, "admin"] },
  },
];

for (const cell of MATRIX) {
  test(`permission matrix: ${cell.name}`, async () => {
    for (const actorName of ACTORS) {
      const f = await matrixFixture();
      const [status, code] = cell.expect[actorName];
      const res = await cell.run(f, f[actorName]);
      const text = await res.text();
      assert.equal(res.status, status, `${actorName}: ${text}`);
      if (code !== undefined) assert.equal((JSON.parse(text) as { code?: string }).code, code, `${actorName}: ${text}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });
}

test("a promoted pending member is refused, and an archived class takes no edits or joins", async () => {
  const f = await matrixFixture();
  await expectStatus(f.owner.call(`/classes/${f.cls.id}/members/${f.pending.id}/role`, { body: { role: "admin" } }), 409, "pending-member");
  await expectStatus(f.owner.call(`/classes/${f.cls.id}/archive`, { body: {} }), 200);
  await expectStatus(f.coadmin.call(`/classes/${f.cls.id}`, { method: "PATCH", body: { name: "x" } }), 409, "class-archived");
  await expectStatus(f.coadmin.call(`/classes/${f.cls.id}/members/${f.pending.id}/approve`, { body: {} }), 409, "class-archived");
  const outsider = await f.seed("Outsider");
  await expectStatus(outsider.call("/classes/join", { body: { code: joinCode(f.cls) } }), 404);
  assert.equal((await detailOf(f.member.call(`/classes/${f.cls.id}`))).status, "archived", "members can still see it");
  await expectStatus(f.member.call(`/classes/${f.cls.id}/leave`, { body: {} }), 204);
});

test("settings are validated: published case ids, time zone, event window", async () => {
  const { seed } = setup();
  const owner = await seed("Owner");
  const cls = await createClass(owner);
  const patch = (body: unknown) => owner.call(`/classes/${cls.id}`, { method: "PATCH", body });
  await expectStatus(patch({ caseIds: ["nope-case"] }), 400, "unknown-case");
  await expectStatus(patch({ schedule: { timezone: "Mars/Olympus", defaultCaseId: null, days: {} } }), 400);
  await expectStatus(patch({ schedule: { timezone: "UTC", defaultCaseId: "nope-case", days: {} } }), 400, "unknown-case");
  await expectStatus(patch({ event: { name: "x", startsAt: "2026-12-01T10:00:00Z", endsAt: "2026-12-01T09:00:00Z", freezeAt: null, announcement: null } }), 400);
  await expectStatus(patch({}), 400);
  await expectStatus(patch({ memberLimit: 500 }), 400, undefined); // the site admin's field, not the class admin's
  const saved = await detailOf(
    patch({
      name: "Blue",
      caseIds: ["alpha", "beta", "alpha"],
      schedule: { timezone: "UTC", defaultCaseId: "alpha", days: { "2026-12-01": "beta" } },
      event: { name: "Finals", startsAt: "2026-12-01T10:00:00Z", endsAt: "2026-12-01T12:00:00Z", freezeAt: "2026-12-01T11:30:00Z", announcement: { text: "Go", level: "info" } },
    }),
  );
  assert.deepEqual(saved.caseIds, ["alpha", "beta"]);
  assert.equal(saved.schedule?.defaultCaseId, "alpha");
  assert.equal(saved.event?.name, "Finals");
});

test("member cap: 60 by default, counting pending requests; the site admin can raise it", async () => {
  const { kv, harness, seed } = setup();
  const owner = await seed("Owner");
  const cls = await createClass(owner);
  // 59 more members written straight into the forward index (the cap counts those records).
  for (let i = 0; i < 58; i++) await kv.set(`classmember:${cls.id}:FAKE${String(i).padStart(8, "0")}`, { role: "member", status: "active", isOwner: false, joinedAt: "2026-11-01T00:00:00Z", decidedAt: null });
  await kv.set(`classmember:${cls.id}:PENDING00000`, { role: "member", status: "pending", isOwner: false, joinedAt: "2026-11-01T00:00:00Z", decidedAt: null });
  const late = await seed("Late");
  await expectStatus(late.call("/classes/join", { body: { code: joinCode(cls) } }), 409, "class-full");
  assert.equal(await kv.get(`memberof:${late.id}:${cls.id}`), null);

  await expectStatus(harness.admin(`/admin/classes/${cls.id}/limits`, { method: "PUT", body: { memberLimit: 61 } }), 200);
  await expectStatus(late.call("/classes/join", { body: { code: joinCode(cls) } }), 200);
  const listed = AdminClassesResponseSchema.parse(await (await harness.admin("/admin/classes")).json()).classes;
  assert.deepEqual(listed.map((c) => [c.id, c.members, c.memberLimit]), [[cls.id, 61, 61]]);
  await expectStatus(owner.call(`/admin/classes/${cls.id}/limits`, { method: "PUT", body: { memberLimit: 100 } }), 401);
});

test("concurrent joins never exceed the cap, and every member is in both indexes", async () => {
  const { kv, harness, seed } = setup();
  const owner = await seed("Owner");
  const cls = await createClass(owner);
  await expectStatus(harness.admin(`/admin/classes/${cls.id}/limits`, { method: "PUT", body: { memberLimit: 5 } }), 200);
  const players = await Promise.all(Array.from({ length: 12 }, (_, i) => seed(`P${i}`)));
  const results = await Promise.all(players.map((p) => p.call("/classes/join", { body: { code: joinCode(cls) } })));
  const joined = players.filter((_, i) => results[i]?.status === 200);
  assert.ok(results.every((r) => r.status === 200 || r.status === 409));
  const forward = await keys(kv, `classmember:${cls.id}:`);
  assert.ok(forward.length <= 5 && joined.length >= 1, `${forward.length} members`);
  assert.equal(forward.length, joined.length + 1);
  for (const p of players) {
    const inForward = forward.includes(`classmember:${cls.id}:${p.id}`);
    assert.equal(inForward, joined.includes(p));
    assert.equal((await kv.get(`memberof:${p.id}:${cls.id}`)) !== null, inForward, "the reverse index matches");
  }
});

test("index repair: a missing reverse row is rewritten, a stale one dropped", async () => {
  const { kv, seed } = setup();
  const owner = await seed("Owner");
  const bob = await seed("Bob");
  const cls = await createClass(owner);
  await expectStatus(bob.call("/classes/join", { body: { code: joinCode(cls) } }), 200);
  await kv.delete(`memberof:${bob.id}:${cls.id}`);
  await expectStatus(bob.call(`/classes/${cls.id}`), 200);
  assert.ok(await kv.get(`memberof:${bob.id}:${cls.id}`));

  await kv.set(`memberof:${bob.id}:ZZZZZZZZZZZZ`, { role: "member", status: "active", isOwner: false });
  const mine = ClassesResponseSchema.parse(await (await bob.call("/classes")).json()).classes;
  assert.deepEqual(mine.map((c) => c.id), [cls.id]);
  assert.equal(await kv.get(`memberof:${bob.id}:ZZZZZZZZZZZZ`), null);
});

test("guests can't create or join classes and see none", async () => {
  const { harness, seed } = setup();
  const owner = await seed("Owner");
  const cls = await createClass(owner);
  const guest = harness.client("10.3.3.3");
  await expectStatus(guest.call("/guest", { body: {} }), 201);
  await expectStatus(guest.call("/classes", { body: { name: "Mine" } }), 403, "guest");
  await expectStatus(guest.call("/classes/join", { body: { code: joinCode(cls) } }), 403, "guest");
  await expectStatus(guest.call(`/classes/${cls.id}`), 404);
  assert.deepEqual(ClassesResponseSchema.parse(await (await guest.call("/classes")).json()).classes, []);
  const anonymous = harness.client("10.3.3.4");
  await expectStatus(anonymous.call("/classes"), 401);
});

test("the site admin can create, edit and list classes, and its classes are open to admin-key callers only", async () => {
  const { harness, seed } = setup();
  const created = await detailOf(harness.admin("/classes", { body: { name: "Owner's class" } }));
  assert.equal(created.membership, null);
  assert.equal(created.admin?.ownerId, "admin");
  const bob = await seed("Bob");
  await expectStatus(bob.call("/classes/join", { body: { code: joinCode(created) } }), 200);
  await expectStatus(bob.call(`/classes/${created.id}/members`), 403, "not-class-admin");
  await expectStatus(harness.admin(`/classes/${created.id}/members/${bob.id}/role`, { body: { role: "admin" } }), 200);
  await expectStatus(bob.call(`/classes/${created.id}/members`), 200);
  const wrongKey = await harness.app.handle(new Request(`http://localhost/api/classes/${created.id}`, { headers: { "x-admin-key": `${ADMIN_KEY}x` } }), "10.0.0.1");
  assert.equal(wrongKey.status, 401);
});

test("deleting an account removes its memberships from both indexes; restoring it puts them back", async () => {
  const { kv, harness, seed } = setup();
  const owner = await seed("Owner");
  const bob = await seed("Bob");
  const cls = await createClass(owner);
  const other = await createClass(owner, "Other");
  for (const c of [cls, other]) await expectStatus(bob.call("/classes/join", { body: { code: joinCode(c) } }), 200);
  await expectStatus(owner.call(`/classes/${cls.id}/members/${bob.id}/role`, { body: { role: "admin" } }), 200);

  await expectStatus(harness.admin(`/admin/accounts/${bob.id}`, { method: "DELETE" }), 204);
  assert.deepEqual(await keys(kv, `memberof:${bob.id}:`), []);
  assert.equal(await kv.get(`classmember:${cls.id}:${bob.id}`), null);
  assert.equal(await kv.get(`classmember:${other.id}:${bob.id}`), null);
  const members = ClassMembersResponseSchema.parse(await (await owner.call(`/classes/${cls.id}/members`)).json()).members;
  assert.deepEqual(members.map((m) => m.username), ["Owner"]);

  const trash = TrashResponseSchema.parse(await (await harness.admin("/admin/trash")).json()).entries;
  const entry = trash.find((e) => e.kind === "account");
  assert.ok(entry);
  await expectStatus(harness.admin(`/admin/trash/${entry.id}/restore`, { body: {} }), 200);
  assert.equal((await keys(kv, `memberof:${bob.id}:`)).length, 2);
  assert.deepEqual((await kv.get(`memberof:${bob.id}:${cls.id}`))?.data, { role: "admin", status: "active", isOwner: false });
  assert.ok(await kv.get(`classmember:${other.id}:${bob.id}`));
});

test("the hygiene job's guest delete also clears class memberships (generic delete path)", async () => {
  const { kv, harness } = setup();
  const guest = harness.client("10.4.4.4");
  const guestId = (await guest.json(await guest.call("/guest", { body: {} }), AccountResponseSchema)).account.id;
  // Guests can't join; a stray membership (from before an upgrade was undone, say) must still be cleaned up.
  await kv.set(`classmember:DefaultClass:${guestId}`, { role: "member", status: "active", isOwner: false, joinedAt: "2026-01-01T00:00:00Z", decidedAt: null });
  await kv.set(`memberof:${guestId}:DefaultClass`, { role: "member", status: "active", isOwner: false });
  const account = (await kv.get(`account:${guestId}`))?.data as Record<string, unknown>;
  await kv.set(`account:${guestId}`, { ...account, lastSeenAt: "2020-01-01T00:00:00Z" });
  const { createAccountHygiene } = await import("../services/AccountHygieneService.ts");
  const report = await createAccountHygiene(kv, () => new Date()).run({ apply: true });
  assert.equal(report.idleGuests.length, 1);
  assert.equal(await kv.get(`classmember:DefaultClass:${guestId}`), null);
  assert.deepEqual(await keys(kv, `memberof:${guestId}:`), []);
});

test("leaving removes both index rows; a removed member can't see the class any more", async () => {
  const { kv, seed } = setup();
  const owner = await seed("Owner");
  const bob = await seed("Bob");
  const cls = await createClass(owner);
  await expectStatus(bob.call("/classes/join", { body: { code: joinCode(cls) } }), 200);
  await expectStatus(bob.call(`/classes/${cls.id}/leave`, { body: {} }), 204);
  assert.equal(await kv.get(`classmember:${cls.id}:${bob.id}`), null);
  assert.equal(await kv.get(`memberof:${bob.id}:${cls.id}`), null);
  await expectStatus(bob.call(`/classes/${cls.id}`), 404);
});

test("class writes are audited", async () => {
  const { harness, seed } = setup();
  const owner = await seed("Owner");
  const cls = await createClass(owner);
  await expectStatus(owner.call(`/classes/${cls.id}/join-code/rotate`, { body: {} }), 200);
  const audit = (await (await harness.admin("/admin/audit")).json()) as { entries: Array<{ action: string; target: string | null; detail: string | null }> };
  assert.deepEqual(audit.entries.map((e) => e.action).filter((a) => a.startsWith("class.")).sort(), ["class.create", "class.join-code.rotate"]);
  assert.ok(audit.entries.every((e) => !e.action.startsWith("class.") || (e.target === cls.id && e.detail?.includes("by Owner"))));
});
