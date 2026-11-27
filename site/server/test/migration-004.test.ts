// Migration 004 (#179): today's class becomes "Class 1". Dry run, apply, idempotency, and old records parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClassResponseSchema, normalizeClassCode } from "../../shared/contract.ts";
import { ClassMemberRecordSchema, ClassRecordSchema } from "../domain/classes.ts";
import { DEFAULT_CLASS_ID, MIGRATIONS } from "../migrations/index.ts";
import { readLedger, runMigrations } from "../migrations/runner.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import type { KvStore } from "../repositories/KvStore.ts";
import { TrashBundleSchema } from "../repositories/trash-repository.ts";
import { takeSnapshot } from "../services/BackupService.ts";
import { sha256Hex } from "../services/crypto.ts";
import { createHarness, expectStatus } from "./helpers.ts";

const only004 = MIGRATIONS.filter((m) => m.id === "004-default-class");

/** The round-2 account shape (no schemaVersion, kind, classLimit...), as production still holds some. */
const oldAccount = (id: string, username: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, username, usernameKey: username.toLowerCase(), passwordHash: "x", status, sessionEpoch: 0,
  createdAt: "2026-11-01T00:00:00Z", decidedAt: null, lastSeenAt: null, lastLoginAt: null, ...extra,
});

const seedStore = async (kv: KvStore, inviteCode: string | null) => {
  await kv.set("account:AAAAAAAAAAAA", oldAccount("AAAAAAAAAAAA", "Ada", "approved"));
  await kv.set("account:BBBBBBBBBBBB", oldAccount("BBBBBBBBBBBB", "Bob", "approved", { kind: "user" }));
  await kv.set("account:RRRRRRRRRRRR", oldAccount("RRRRRRRRRRRR", "Nope", "rejected"));
  await kv.set("account:GGGGGGGGGGGG", oldAccount("GGGGGGGGGGGG", "guest-GGGG", "approved", { kind: "guest" }));
  await kv.set("account:broken", { nonsense: true });
  await kv.set("config:schedule", { timezone: "Asia/Jerusalem", defaultCaseId: "alpha", days: { "2026-12-01": "beta" }, lockToToday: true });
  await kv.set("config:event", { name: "Finals", startsAt: "2026-12-01T10:00:00Z", endsAt: "2026-12-01T12:00:00Z", freezeAt: "2026-12-01T11:45:00Z", enforceWindow: true, announcement: { text: "Good luck", level: "info" } });
  await kv.set("config:settings", { inviteCode });
};

const snapshot = async (kv: KvStore) => (await takeSnapshot(kv, { source: "t", now: new Date(0) })).entries;

test("migration 004 creates Class 1 from today's class: dry run, apply, then a no-op second run", async () => {
  const kv = new InMemoryKvStore();
  await seedStore(kv, "night-owls");
  assert.equal(only004.length, 1);

  const before = await snapshot(kv);
  const dry = await runMigrations({ kv, legacy: null, migrations: only004, dryRun: true });
  assert.equal(dry.results[0]?.changed, 4, "the class, its code index entry and two members");
  assert.deepEqual(await snapshot(kv), before, "a dry run writes nothing");

  const applied = await runMigrations({ kv, legacy: null, migrations: only004, dryRun: false, now: () => new Date("2026-11-28T08:00:00Z") });
  assert.equal(applied.results[0]?.note, "Class 1 created, 2 members added");
  const record = ClassRecordSchema.parse((await kv.get(`class:${DEFAULT_CLASS_ID}`))?.data);
  assert.equal(record.name, "Class 1");
  assert.equal(record.ownerId, "admin");
  assert.equal(record.joinMode, "code");
  assert.equal(record.joinCode, "night-owls");
  assert.equal(record.memberLimit, 60);
  assert.deepEqual(record.schedule, { timezone: "Asia/Jerusalem", defaultCaseId: "alpha", days: { "2026-12-01": "beta" } });
  assert.deepEqual(record.event, { name: "Finals", startsAt: "2026-12-01T10:00:00Z", endsAt: "2026-12-01T12:00:00Z", freezeAt: "2026-12-01T11:45:00Z", announcement: { text: "Good luck", level: "info" } });
  assert.deepEqual(record.caseIds, []);
  assert.deepEqual((await kv.get(`classcode:${sha256Hex(normalizeClassCode("NIGHT OWLS"))}`))?.data, { classId: DEFAULT_CLASS_ID });
  assert.deepEqual(await kv.listKeys(`classmember:${DEFAULT_CLASS_ID}:`), [`classmember:${DEFAULT_CLASS_ID}:AAAAAAAAAAAA`, `classmember:${DEFAULT_CLASS_ID}:BBBBBBBBBBBB`]);
  const ada = ClassMemberRecordSchema.parse((await kv.get(`classmember:${DEFAULT_CLASS_ID}:AAAAAAAAAAAA`))?.data);
  assert.deepEqual([ada.role, ada.status, ada.isOwner], ["member", "active", false]);
  assert.deepEqual((await kv.get(`memberof:AAAAAAAAAAAA:${DEFAULT_CLASS_ID}`))?.data, { role: "member", status: "active", isOwner: false });
  assert.equal(await kv.get(`memberof:GGGGGGGGGGGG:${DEFAULT_CLASS_ID}`), null, "guests are not members");
  assert.equal(await kv.get(`memberof:RRRRRRRRRRRR:${DEFAULT_CLASS_ID}`), null, "rejected accounts are not members");
  // The old gates keep working: #180 moves gameplay to classes.
  assert.equal(((await kv.get("config:event"))?.data as Record<string, unknown>)["enforceWindow"], true);
  assert.deepEqual((await kv.get("config:settings"))?.data, { inviteCode: "night-owls" });
  assert.ok((await readLedger(kv)).applied.some((a) => a.id === "004-default-class"));

  const afterApply = await snapshot(kv);
  assert.equal((await runMigrations({ kv, legacy: null, migrations: only004, dryRun: false })).results.length, 0, "the ledger skips it");
  const migration = only004[0];
  assert.ok(migration);
  const again = await migration.run({ kv, legacy: null, now: () => new Date("2026-11-29T00:00:00Z"), dryRun: false, log: () => undefined });
  assert.equal(again.changed, 0);
  assert.deepEqual(await snapshot(kv), afterApply, "running the step again changes nothing");
});

test("migration 004 generates a code when there is none, and finishes an interrupted run", async () => {
  const kv = new InMemoryKvStore();
  await seedStore(kv, null);
  const migration = only004[0];
  assert.ok(migration);
  await migration.run({ kv, legacy: null, now: () => new Date(), dryRun: false, log: () => undefined });
  const record = ClassRecordSchema.parse((await kv.get(`class:${DEFAULT_CLASS_ID}`))?.data);
  assert.match(record.joinCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  // An interrupted run: one reverse row and the index entry never made it.
  await kv.delete(`memberof:BBBBBBBBBBBB:${DEFAULT_CLASS_ID}`);
  await kv.delete(`classcode:${sha256Hex(normalizeClassCode(record.joinCode))}`);
  const resumed = await migration.run({ kv, legacy: null, now: () => new Date(), dryRun: false, log: () => undefined });
  assert.equal(resumed.changed, 2);
  assert.ok(await kv.get(`memberof:BBBBBBBBBBBB:${DEFAULT_CLASS_ID}`));
  assert.equal(ClassRecordSchema.parse((await kv.get(`class:${DEFAULT_CLASS_ID}`))?.data).joinCode, record.joinCode, "the class is not recreated");
});

test("after migration 004, members can open Class 1, players join with the old class code, and the site admin manages it", async () => {
  const kv = new InMemoryKvStore();
  const harness = createHarness({ store: kv });
  await harness.admin("/admin/settings", { method: "PUT", body: { inviteCode: "class-2026" } });
  const early = harness.client("10.5.0.1");
  await expectStatus(early.call("/auth/register", { body: { username: "Early", password: "password1" } }), 201);
  await runMigrations({ kv, legacy: null, migrations: only004, dryRun: false });
  await expectStatus(early.call(`/classes/${DEFAULT_CLASS_ID}`), 200);

  const late = harness.client("10.5.0.2");
  await expectStatus(late.call("/auth/register", { body: { username: "Late", password: "password1" } }), 201);
  await expectStatus(late.call(`/classes/${DEFAULT_CLASS_ID}`), 404);
  await expectStatus(late.call("/classes/join", { body: { code: "CLASS2026" } }), 200);
  const admin = ClassResponseSchema.parse(await (await harness.admin(`/classes/${DEFAULT_CLASS_ID}`)).json()).class;
  assert.equal(admin.admin?.joinCode, "class-2026");
});

test("an old store parses: class records with only the first fields, member rows without isOwner, trash without memberships", () => {
  const minimal = ClassRecordSchema.parse({ id: "AAAAAAAAAAAA", name: "Old", ownerId: "BBBBBBBBBBBB", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", boardToken: "AAAAAAAAAAAA.x", joinCode: "ABCDE-FGHJK" });
  assert.deepEqual([minimal.status, minimal.joinMode, minimal.memberLimit, minimal.caseIds, minimal.schemaVersion], ["active", "code", 60, [], 1]);
  assert.equal(minimal.schedule.timezone, "Asia/Jerusalem");
  assert.equal(ClassMemberRecordSchema.parse({ role: "member", status: "active", joinedAt: "2026-11-01T00:00:00Z" }).isOwner, false);
  const bundle = TrashBundleSchema.parse({ kind: "account", label: "account old", deletedAt: "2026-11-01T00:00:00Z", account: null, progress: [], firstBlood: {} });
  assert.deepEqual(bundle.memberships, []);
});
