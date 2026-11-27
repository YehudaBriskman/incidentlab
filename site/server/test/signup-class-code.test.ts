// A class code at sign-up (#204): it joins the class (or asks to, in approval mode), a code no class has creates no
// account, and the legacy site invite code still passes while it is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClassesResponseSchema, ClassResponseSchema, RegisterResponseSchema } from "../../shared/contract.ts";
import type { ClassDetail } from "../../shared/contract.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { createHarness, expectStatus } from "./helpers.ts";

const setup = async () => {
  const kv = new InMemoryKvStore();
  const harness = createHarness({ store: kv });
  const owner = harness.client("10.2.0.1");
  await expectStatus(owner.call("/auth/register", { body: { username: "teacher", password: "password1" } }), 201);
  const created = await owner.call("/classes", { body: { name: "Night shift" } });
  const cls: ClassDetail = ClassResponseSchema.parse(await created.json()).class;
  assert.ok(cls.admin);
  return { kv, harness, owner, cls, code: cls.admin.joinCode };
};

const accountCount = async (kv: InMemoryKvStore): Promise<number> => (await kv.listKeys("account:")).length;

test("a class code at sign-up joins the class and the answer names it", async () => {
  const { harness, cls, code } = await setup();
  const student = harness.client("10.2.0.2");
  const res = await student.call("/auth/register", { body: { username: "student", password: "password1", inviteCode: ` ${code.toLowerCase()} ` } });
  await expectStatus(res.clone(), 201);
  const body = RegisterResponseSchema.parse(await res.json());
  assert.equal(body.class?.id, cls.id);
  assert.deepEqual(body.class?.membership, { role: "member", status: "active", isOwner: false });
  assert.ok(body.recoveryCode);
  const mine = ClassesResponseSchema.parse(await (await student.call("/classes")).json()).classes;
  assert.deepEqual(mine.map((c) => c.id), [cls.id]);
});

test("in approval mode the sign-up asks to join: a pending request", async () => {
  const { harness, owner, cls, code } = await setup();
  await expectStatus(owner.call(`/classes/${cls.id}`, { method: "PATCH", body: { joinMode: "approval" } }), 200);
  const res = await harness.client("10.2.0.3").call("/auth/register", { body: { username: "asker", password: "password1", inviteCode: code } });
  await expectStatus(res.clone(), 201);
  assert.equal(RegisterResponseSchema.parse(await res.json()).class?.membership?.status, "pending");
});

test("a code no class has is refused with bad-class-code and creates no account", async () => {
  const { kv, harness } = await setup();
  const before = await accountCount(kv);
  const client = harness.client("10.2.0.4");
  await expectStatus(client.call("/auth/register", { body: { username: "typo", password: "password1", inviteCode: "ZZZZZ-ZZZZZ" } }), 400, "bad-class-code");
  assert.equal(await accountCount(kv), before);
  assert.equal(client.cookie(), null);
  // The name is still free: the same sign-up without the code goes through.
  const ok = await client.call("/auth/register", { body: { username: "typo", password: "password1" } });
  await expectStatus(ok.clone(), 201);
  assert.equal(RegisterResponseSchema.parse(await ok.json()).class, undefined);
});

test("an archived class's code is refused like an unknown one", async () => {
  const { kv, harness, owner, cls, code } = await setup();
  await expectStatus(owner.call(`/classes/${cls.id}/archive`, { body: {} }), 200);
  const before = await accountCount(kv);
  await expectStatus(harness.client("10.2.0.5").call("/auth/register", { body: { username: "late", password: "password1", inviteCode: code } }), 400, "bad-class-code");
  assert.equal(await accountCount(kv), before);
});

test("the legacy site invite code still passes while it is set, and joins no class", async () => {
  const { harness } = await setup();
  await expectStatus(harness.admin("/admin/settings", { method: "PUT", body: { inviteCode: "Night-Owls" } }), 200);
  const client = harness.client("10.2.0.6");
  const res = await client.call("/auth/register", { body: { username: "legacy", password: "password1", inviteCode: " night-owls " } });
  await expectStatus(res.clone(), 201);
  assert.equal(RegisterResponseSchema.parse(await res.json()).class, undefined);
  await expectStatus(harness.admin("/admin/settings", { method: "PUT", body: { inviteCode: null } }), 200);
  await expectStatus(harness.client("10.2.0.7").call("/auth/register", { body: { username: "legacy2", password: "password1", inviteCode: "night-owls" } }), 400, "bad-class-code");
});
