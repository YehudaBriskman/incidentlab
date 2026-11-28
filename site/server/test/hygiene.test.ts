// The weekly hygiene pass (#177): idle guests, expired sessions and rate limits, old audit, expired trash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AccountResponseSchema, AnswerResponseSchema, TrashResponseSchema, TrashRestoreResponseSchema } from "../../shared/contract.ts";
import { SessionRecordSchema } from "../domain/types.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { AUDIT_RETENTION_DAYS, createAccountHygiene } from "../services/AccountHygieneService.ts";
import { createHarness, expectStatus } from "./helpers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-10-01T09:00:00Z");

/** A store with an idle guest (with progress), an active guest, a user, sessions, rate limits and audit. */
const seed = async () => {
  let nowMs = START;
  const now = () => new Date(nowMs);
  const store = new InMemoryKvStore();
  const harness = createHarness({ store, now });

  const idle = harness.client("10.0.0.1");
  const idleId = (await idle.json(await idle.call("/guest", { body: {} }), AccountResponseSchema)).account.id;
  await expectStatus(idle.call("/cases/alpha/setup-done", { body: {} }), 200);
  assert.equal((await idle.json(await idle.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } }), AnswerResponseSchema)).correct, true);

  const active = harness.client("10.0.0.2");
  const activeId = (await active.json(await active.call("/guest", { body: {} }), AccountResponseSchema)).account.id;
  const user = harness.client("10.0.0.3");
  const userId = (await user.json(await user.call("/auth/register", { body: { username: "Dana", password: "hunter2hunter2" } }), AccountResponseSchema)).account.id;
  await expectStatus(harness.client("10.0.0.4").call("/auth/login", { body: { username: "Dana", password: "wrong-password" } }), 401); // a login-ip and login-user window
  await expectStatus(harness.admin("/admin/settings", { method: "PUT", body: { inviteCode: "class-a" } }), 200); // an old audit entry

  // Forward past the guest idle limit and the audit retention. The active guest comes back every 20 days
  // (which renews its 30-day session); everyone else stays away, so their sessions expire.
  const target = START + (AUDIT_RETENTION_DAYS + 1) * DAY_MS;
  while (nowMs + 20 * DAY_MS < target) {
    nowMs += 20 * DAY_MS;
    await expectStatus(active.call("/me"), 200);
  }
  nowMs = target;
  await expectStatus(active.call("/me"), 200);
  await expectStatus(harness.client("10.0.0.5").call("/guest", { body: {} }), 201); // a fresh guest-ip window
  await expectStatus(harness.admin("/admin/settings", { method: "PUT", body: { inviteCode: "class-b" } }), 200); // a recent audit entry
  await store.set("audit:not-a-timestamp:abcd", { at: "x", action: "x", target: null, detail: null, via: "key" }); // left alone
  return { store, harness, now, idle, idleId, active, activeId, user, userId, advance: (ms: number) => void (nowMs += ms) };
};

const snapshot = async (store: InMemoryKvStore): Promise<string[]> => {
  const keys = await store.listKeys("");
  return Promise.all(keys.map(async (k) => `${k}=${JSON.stringify((await store.get(k))?.data)}`));
};

test("dry run reports and changes nothing", async () => {
  const { store, now, idleId } = await seed();
  const before = await snapshot(store);
  const report = await createAccountHygiene(store, now).run({ apply: false });
  assert.equal(report.applied, false);
  assert.deepEqual(report.idleGuests, [`guest-${idleId}`]);
  assert.equal(report.guestProgress, 1);
  assert.ok(report.expiredSessions >= 2, `expired sessions ${report.expiredSessions}`); // the idle guest's and Dana's
  assert.ok(report.staleRateLimits >= 3, `stale rate limits ${report.staleRateLimits}`);
  assert.equal(report.oldAudit, 1);
  assert.deepEqual(await snapshot(store), before);
});

test("apply trashes the idle guest with its progress, keeps active guests and users, sweeps the rest", async () => {
  const { store, harness, now, idle, idleId, activeId, userId } = await seed();
  assert.notEqual(await store.get(`score:${idleId}`), null); // the solve wrote a score summary (#175)
  const report = await createAccountHygiene(store, now).run({ apply: true });
  assert.equal(report.applied, true);
  assert.deepEqual(report.idleGuests, [`guest-${idleId}`]);

  // idle guest gone, with its progress; the others stay
  assert.equal(await store.get(`account:${idleId}`), null);
  assert.deepEqual(await store.listKeys(`progress:alpha:${idleId}`), []);
  assert.equal(await store.get(`score:${idleId}`), null); // the summary goes with the progress
  assert.deepEqual(await store.listKeys("globalboard:"), []);
  assert.notEqual(await store.get(`account:${activeId}`), null);
  assert.notEqual(await store.get(`account:${userId}`), null);
  await expectStatus(idle.call("/me"), 401, "signed-out");

  // only live sessions are left
  for (const key of await store.listKeys("session:")) {
    const expiresAt = SessionRecordSchema.parse((await store.get(key))?.data).expiresAt;
    assert.ok(Date.parse(expiresAt) > now().getTime(), `${key} expired at ${expiresAt}`);
  }
  // rate limits: only windows with a hit in the last day remain (the guest-ip from 59 days ago is gone too)
  for (const key of await store.listKeys("ratelimit:")) {
    const hits = z.array(z.number()).parse((await store.get(key))?.data);
    assert.ok(now().getTime() - Math.max(...hits) < DAY_MS, key);
  }
  // audit: the recent entry and the unparseable key stay; the old one is gone
  const audit = await store.listKeys("audit:");
  assert.equal(audit.length, 2);
  assert.ok(audit.includes("audit:not-a-timestamp:abcd"));

  // the guest is restorable for 7 days, with its progress, and its name is still not claimed
  const entries = (await idle.json(await harness.admin("/admin/trash"), TrashResponseSchema)).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, "account");
  assert.equal(entries[0]?.records, 1);
  const restored = await idle.json(await harness.admin(`/admin/trash/${encodeURIComponent(entries[0]?.id ?? "")}/restore`, { body: {} }), TrashRestoreResponseSchema);
  assert.deepEqual(restored, { restored: 2, skipped: 0 });
  assert.notEqual(await store.get(`account:${idleId}`), null);
  assert.equal((await store.listKeys("username:")).length, 1); // Dana only
  assert.deepEqual(await store.listKeys(`progress:alpha:${idleId}`), [`progress:alpha:${idleId}`]);
  assert.notEqual(await store.get(`score:${idleId}`), null); // the restore re-derives the summary
  assert.deepEqual(await store.listKeys("globalboard:"), []); // and never puts a guest on the board

  // a second run right away finds nothing new to do except the restored (still idle) guest
  const again = await createAccountHygiene(store, now).run({ apply: false });
  assert.equal(again.expiredSessions, 0);
  assert.equal(again.staleRateLimits, 0);
  assert.equal(again.oldAudit, 0);
});

test("trash entries past the restore window are dropped; live ones stay", async () => {
  const { store, now, advance } = await seed();
  await createAccountHygiene(store, now).run({ apply: true }); // trashes the idle guest
  advance(6 * DAY_MS);
  assert.equal((await createAccountHygiene(store, now).run({ apply: true })).expiredTrash, 0);
  assert.equal((await store.listKeys("trash:")).length, 1);
  advance(2 * DAY_MS);
  const dry = await createAccountHygiene(store, now).run({ apply: false });
  assert.equal(dry.expiredTrash, 1);
  assert.equal((await store.listKeys("trash:")).length, 1);
  assert.equal((await createAccountHygiene(store, now).run({ apply: true })).expiredTrash, 1);
  assert.deepEqual(await store.listKeys("trash:"), []);
});

test("an empty store is a no-op", async () => {
  const report = await createAccountHygiene(new InMemoryKvStore(), () => new Date()).run({ apply: true });
  assert.deepEqual(report, { applied: true, idleGuests: [], guestProgress: 0, expiredSessions: 0, staleRateLimits: 0, oldAudit: 0, expiredTrash: 0, expiredResetRequests: 0, oldEventRuns: 0 });
});
