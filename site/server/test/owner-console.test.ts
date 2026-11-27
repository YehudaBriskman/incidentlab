// The platform owner console (#185): the paged, filtered users list, the class list with owner names and events,
// and the Live section's progress reading only the accounts on the case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminClassesResponseSchema, AdminProgressResponseSchema, AdminUsersResponseSchema } from "../../shared/contract.ts";
import type { KvStore, Versioned } from "../repositories/KvStore.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { generateAccountId } from "../services/crypto.ts";
import { createHarness, expectStatus } from "./helpers.ts";

/** Counts reads by key prefix, so a test can check what a call did not read. */
class CountingStore extends InMemoryKvStore {
  readonly reads = new Map<string, number>();
  override get(key: string): Promise<Versioned<unknown> | null> {
    const prefix = key.slice(0, key.indexOf(":") + 1);
    this.reads.set(prefix, (this.reads.get(prefix) ?? 0) + 1);
    return super.get(key);
  }
}

const seedAccount = async (kv: KvStore, username: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = generateAccountId();
  const at = new Date(Date.UTC(2026, 0, 1) + Math.floor(Math.random() * 1e9)).toISOString();
  await kv.set(`account:${id}`, {
    id, username, usernameKey: username.toLowerCase(), passwordHash: "x", status: "approved", sessionEpoch: 0,
    createdAt: at, decidedAt: at, lastSeenAt: at, lastLoginAt: null, ...extra,
  });
  return id;
};

/** A valid progress record on case alpha: set up, nothing solved yet. */
const progressFixture = (accountId: string): Record<string, unknown> => {
  const at = "2026-01-01T00:00:00.000Z";
  const stage = (status: string) => ({ status, startedAt: status === "active" ? at : null, finishedAt: null, hintsRevealed: 0, wrongAttempts: 0, points: 0, revealedAnswer: null });
  return {
    accountId, caseId: "alpha", startedAt: at, lastSeenAt: at, setupDoneAt: at, completedAt: null, wrongAnswerTimestamps: {},
    stages: { q1: stage("active"), q2: stage("locked"), q3: stage("locked"), q4: stage("locked"), q5: stage("locked"), q6: stage("locked") },
  };
};

const users = async (h: ReturnType<typeof createHarness>, query: string) => {
  const res = await h.admin(`/admin/users${query}`);
  await expectStatus(res.clone(), 200);
  return AdminUsersResponseSchema.parse(await res.json());
};

test("users: search, kind, role and status filters, paging and counts", async () => {
  const kv = new InMemoryKvStore();
  const h = createHarness({ store: kv });
  for (let i = 0; i < 12; i++) await seedAccount(kv, `night_owl_${String(i).padStart(2, "0")}`);
  await seedAccount(kv, "dana_author", { role: "author", classLimit: 7 });
  await seedAccount(kv, "banned_bob", { status: "rejected" });
  await seedAccount(kv, "waiting_wes", { status: "pending" });
  await seedAccount(kv, "guest-abc123", { kind: "guest" });

  const all = await users(h, "");
  assert.equal(all.total, 16);
  assert.equal(all.matched, 16);
  assert.deepEqual(all.counts, { users: 15, guests: 1, authors: 1, pending: 1, approved: 14, rejected: 1, active24h: 0 });
  assert.deepEqual(all.pending.map((a) => a.username), ["waiting_wes"]);

  const search = await users(h, "?q=OWL&sort=name&limit=5&offset=5");
  assert.equal(search.matched, 12);
  assert.deepEqual(search.accounts.map((a) => a.username), ["night_owl_05", "night_owl_06", "night_owl_07", "night_owl_08", "night_owl_09"]);

  const author = await users(h, "?role=author");
  assert.equal(author.accounts.length, 1);
  assert.equal(author.accounts[0]?.classLimit, 7);
  assert.equal(author.accounts[0]?.kind, "user");
  const guest = await users(h, "?kind=guest");
  assert.deepEqual(guest.accounts.map((a) => [a.username, a.kind, a.rank]), [["guest-abc123", "guest", null]]);
  const banned = await users(h, "?status=rejected&kind=");
  assert.deepEqual(banned.accounts.map((a) => [a.username, a.rank]), [["banned_bob", null]]);

  await expectStatus(h.admin("/admin/users?limit=0"), 400);
  await expectStatus(h.admin("/admin/users?kind=robot"), 400);
});

test("users: one page reads only that page's progress, and the rank comes from the score summaries", async () => {
  const kv = new CountingStore();
  const h = createHarness({ store: kv });
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) ids.push(await seedAccount(kv, `p${String(i).padStart(2, "0")}`));
  for (const [i, id] of ids.entries()) {
    await kv.set(`progress:alpha:${id}`, progressFixture(id));
    await kv.set(`score:${id}`, { accountId: id, total: i * 10, stagesSolved: 0, casesCompleted: 0, firstBloods: 0, lastSolveAt: null, cases: {} });
  }
  kv.reads.clear();
  const page = await users(h, "?sort=rank&limit=10");
  assert.deepEqual(page.accounts.map((a) => a.username).slice(0, 3), ["p29", "p28", "p27"]);
  assert.deepEqual(page.accounts.map((a) => a.rank).slice(0, 3), [1, 2, 3]);
  assert.equal(kv.reads.get("progress:"), 10, "only the page's progress records");
  assert.equal(kv.reads.get("account:"), 30);
  assert.equal(kv.reads.get("score:"), 30);
});

test("classes: the owner's console lists owner names and events; live progress reads only the case's accounts", async () => {
  const kv = new CountingStore();
  const h = createHarness({ store: kv });
  const created = await h.admin("/classes", { body: { name: "Owner class" } });
  await expectStatus(created, 201);
  const list = AdminClassesResponseSchema.parse(await (await h.admin("/admin/classes")).json());
  assert.equal(list.classes.length, 1);
  assert.equal(list.classes[0]?.ownerName, null, "owned by admin");
  assert.equal(list.classes[0]?.event?.name, "");

  for (let i = 0; i < 20; i++) await seedAccount(kv, `idle${i}`);
  const playing = await seedAccount(kv, "on_case");
  await kv.set(`progress:alpha:${playing}`, progressFixture(playing));
  kv.reads.clear();
  const live = AdminProgressResponseSchema.parse(await (await h.admin("/admin/progress?caseId=alpha")).json());
  assert.deepEqual(live.players.map((p) => p.username), ["on_case"]);
  assert.equal(kv.reads.get("account:"), 1);
});
