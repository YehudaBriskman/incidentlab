import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountResponseSchema, AdminAccountsResponseSchema, ProgressResponseSchema, TrashResponseSchema, TrashRestoreResponseSchema } from "../../shared/contract.ts";
import { MIGRATIONS } from "../migrations/index.ts";
import { pendingMigrations, readLedger, runMigrations } from "../migrations/runner.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { diffSnapshot, restoreSnapshot, takeSnapshot, writeDailySnapshot } from "../services/BackupService.ts";
import { createApp } from "../router.ts";
import { ADMIN_KEY, SECRETS, createHarness, expectStatus } from "./helpers.ts";

const approved = async (harness: ReturnType<typeof createHarness>, username: string) => {
  const player = harness.client();
  await player.call("/auth/register", { body: { username, password: "password1" } });
  const id = (await player.json(await player.call("/me"), AccountResponseSchema)).account.id;
  await harness.admin(`/admin/accounts/${id}/approve`, { body: {} });
  return { player, id };
};

test("migration 001 stamps old records once and is idempotent", async () => {
  const kv = new InMemoryKvStore();
  const old = { id: "AAAAAAAAAAAA", username: "Old", usernameKey: "old", passwordHash: "x", status: "approved", sessionEpoch: 0, createdAt: "2026-11-01T00:00:00Z", decidedAt: null, lastSeenAt: null, lastLoginAt: null };
  await kv.set("account:AAAAAAAAAAAA", old);
  await kv.set("account:BROKEN000000", { nope: true });
  const dry = await runMigrations({ kv, legacy: null, migrations: MIGRATIONS, dryRun: true });
  assert.equal(dry.results.find((r) => r.id === "001-stamp-schema-version")?.changed, 1);
  assert.equal(((await kv.get("account:AAAAAAAAAAAA"))?.data as Record<string, unknown>)["schemaVersion"], undefined, "dry run writes nothing");
  assert.equal((await readLedger(kv)).applied.length, 0, "dry run records nothing");

  await runMigrations({ kv, legacy: null, migrations: MIGRATIONS, dryRun: false });
  const stamped = (await kv.get("account:AAAAAAAAAAAA"))?.data as Record<string, unknown>;
  assert.equal(stamped["schemaVersion"], 1);
  assert.equal(stamped["mustChangePassword"], false); // defaults written out
  assert.deepEqual((await kv.get("account:BROKEN000000"))?.data, { nope: true }); // unparseable data untouched
  assert.equal((await pendingMigrations(kv, MIGRATIONS)).length, 0);
  const again = await runMigrations({ kv, legacy: null, migrations: MIGRATIONS, dryRun: false });
  assert.equal(again.results.length, 0);
});

test("migration 002 copies legacy players without touching the old store", async () => {
  const kv = new InMemoryKvStore();
  const legacy = new InMemoryKvStore();
  await legacy.set("Abc123Abc123", { id: "Abc123Abc123", name: "Round One", caseId: "3am-outage", createdAt: "2026-11-19T10:00:00Z", stages: {} });
  await legacy.set("ratelimit:xyz", [1, 2]);
  await runMigrations({ kv, legacy, migrations: MIGRATIONS, dryRun: false });
  const copied = (await kv.get("legacy:Abc123Abc123"))?.data as Record<string, unknown>;
  assert.equal(copied["name"], "Round One");
  assert.equal(copied["source"], "incidentlab-players");
  assert.ok(await legacy.get("Abc123Abc123"), "old store untouched");
  assert.equal(await kv.get("legacy:ratelimit:xyz"), null);
});

test("backup -> wipe -> restore round-trips the store exactly (sessions excluded)", async () => {
  const harness = createHarness();
  // reach into the harness store through a fresh app sharing one KV
  const kv = new InMemoryKvStore();
  const app = createApp({ store: kv, staticSecrets: SECRETS, adminKey: () => ADMIN_KEY });
  const call = (path: string, body?: unknown, cookie?: string) =>
    app.handle(new Request(`http://localhost/api${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), "10.0.0.1");
  const reg = await call("/auth/register", { username: "Backup", password: "password1" });
  const cookie = /il_session=[^;]+/.exec(reg.headers.get("set-cookie") ?? "")?.[0] ?? "";
  assert.ok(cookie);
  void harness;

  const snapshot = await takeSnapshot(kv, { source: "test", now: new Date() });
  assert.ok(Object.keys(snapshot.entries).some((k) => k.startsWith("account:")));
  assert.ok(!Object.keys(snapshot.entries).some((k) => k.startsWith("session:") || k.startsWith("ratelimit:")));

  for (const key of await kv.listKeys("account:")) await kv.delete(key);
  await kv.set("config:extra", { added: "after backup" });
  const diff = await diffSnapshot(kv, snapshot);
  assert.equal(diff.added.length, 1);
  assert.deepEqual(diff.extra, ["config:extra"]);

  await restoreSnapshot(kv, snapshot, { prune: false });
  const after = await diffSnapshot(kv, snapshot);
  assert.deepEqual([after.added.length, after.changed.length], [0, 0]);
  assert.ok(await kv.get("config:extra"), "newer keys kept without prune");
  assert.equal((await call("/me", undefined, cookie)).status, 200, "the session still resolves to the restored account");

  await restoreSnapshot(kv, snapshot, { prune: true });
  assert.equal(await kv.get("config:extra"), null);
});

test("daily snapshots rotate after the retention window", async () => {
  const primary = new InMemoryKvStore();
  const backups = new InMemoryKvStore();
  await primary.set("account:x", { a: 1 });
  for (const day of ["2026-10-01", "2026-11-20", "2026-11-25"]) {
    await writeDailySnapshot({ primary, backups, now: new Date(`${day}T03:00:00Z`), retentionDays: 30 });
  }
  assert.deepEqual(await backups.listKeys("daily/"), ["daily/2026-11-20.json", "daily/2026-11-25.json"]);
});

test("deleting an account goes to the trash and can be restored; username conflicts are refused", async () => {
  const harness = createHarness();
  const { player, id } = await approved(harness, "Deleteme");
  await player.call("/cases/alpha/setup-done", { body: {} });
  await player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } });
  await expectStatus(harness.admin(`/admin/accounts/${id}`, { method: "DELETE" }), 204);
  await expectStatus(player.call("/me"), 401);

  const trash = await player.json(await harness.admin("/admin/trash"), TrashResponseSchema);
  assert.equal(trash.entries.length, 1);
  assert.equal(trash.entries[0]?.kind, "account");
  assert.equal(trash.entries[0]?.records, 1);
  const trashId = trash.entries[0]?.id ?? "";

  const restored = await player.json(await harness.admin(`/admin/trash/${encodeURIComponent(trashId)}/restore`, { body: {} }), TrashRestoreResponseSchema);
  assert.deepEqual(restored, { restored: 2, skipped: 0 });
  await expectStatus(harness.client().call("/auth/login", { body: { username: "deleteme", password: "password1" } }), 200);
  const back = await harness.client();
  await back.call("/auth/login", { body: { username: "deleteme", password: "password1" } });
  const progress = await back.json(await back.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(progress.progress.stages.q1.status, "solved", "progress came back");
  await expectStatus(harness.admin(`/admin/trash/${encodeURIComponent(trashId)}/restore`, { body: {} }), 404); // already restored

  // delete again, someone takes the name, restore must refuse
  await harness.admin(`/admin/accounts/${id}`, { method: "DELETE" });
  await harness.client().call("/auth/register", { body: { username: "DeleteMe", password: "password2" } });
  const second = (await back.json(await harness.admin("/admin/trash"), TrashResponseSchema)).entries[0]?.id ?? "";
  await expectStatus(harness.admin(`/admin/trash/${encodeURIComponent(second)}/restore`, { body: {} }), 409, "conflict");
});

test("resetting a case goes to the trash; restore keeps newer progress", async () => {
  const harness = createHarness();
  const ada = await approved(harness, "Ada");
  const bob = await approved(harness, "Bob");
  for (const p of [ada, bob]) {
    await p.player.call("/cases/alpha/setup-done", { body: {} });
    await p.player.call("/cases/alpha/answer", { body: { questionId: "q1", answer: "alpha-a1" } });
  }
  await expectStatus(harness.admin("/admin/reset", { body: { confirm: "RESET", caseId: "alpha" } }), 204);
  await bob.player.call("/cases/alpha/setup-done", { body: {} }); // Bob starts over after the reset
  const entry = (await ada.player.json(await harness.admin("/admin/trash"), TrashResponseSchema)).entries[0];
  assert.match(entry?.label ?? "", /alpha \(2 players\)/);
  const res = await ada.player.json(await harness.admin(`/admin/trash/${encodeURIComponent(entry?.id ?? "")}/restore`, { body: {} }), TrashRestoreResponseSchema);
  assert.deepEqual(res, { restored: 1, skipped: 1 }); // Ada back, Bob's newer run kept
  const adaNow = await ada.player.json(await ada.player.call("/cases/alpha/progress"), ProgressResponseSchema);
  assert.equal(adaNow.progress.stages.q1.status, "solved");
  assert.equal(adaNow.progress.stages.q1.breakdown?.firstBlood, 15, "first blood restored with it");
});

test("trash entries expire after 7 days", async () => {
  let now = new Date("2026-11-01T10:00:00Z");
  const harness = createHarness({ now: () => now });
  const { id } = await approved(harness, "Expiring");
  await harness.admin(`/admin/accounts/${id}`, { method: "DELETE" });
  now = new Date("2026-11-08T09:59:00Z");
  assert.equal((TrashResponseSchema.parse(await (await harness.admin("/admin/trash")).json())).entries.length, 1);
  now = new Date("2026-11-08T10:00:01Z");
  assert.equal((TrashResponseSchema.parse(await (await harness.admin("/admin/trash")).json())).entries.length, 0);
});

test("a rejected player keeps the session and sees the rejected state", async () => {
  const harness = createHarness();
  const { player, id } = await approved(harness, "Rejectee");
  await harness.admin(`/admin/accounts/${id}/reject`, { body: {} });
  const me = await player.json(await player.call("/me"), AccountResponseSchema);
  assert.equal(me.account.status, "rejected");
  await expectStatus(player.call("/cases/alpha/progress"), 403, "rejected");
  const list = await player.json(await harness.admin("/admin/accounts"), AdminAccountsResponseSchema);
  assert.equal(list.accounts[0]?.status, "rejected");
});
