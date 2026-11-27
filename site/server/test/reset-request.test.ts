// Teacher-vouched password reset (#254): a class admin vouches, only the site owner's approval sets a temporary
// password, and the session it opens may do nothing but change the password (which issues a new recovery code).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AdminPasswordResetRequestsResponseSchema,
  AuditResponseSchema,
  AuthResponseSchema,
  ClassJoinResponseSchema,
  ClassResetRequestResponseSchema,
  ClassResetRequestsResponseSchema,
  ClassResponseSchema,
  RecoveryCodeResponseSchema,
  ResetPasswordResponseSchema,
} from "../../shared/contract.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { createAccountHygiene } from "../services/AccountHygieneService.ts";
import { createHarness, expectStatus } from "./helpers.ts";
import type { Client } from "./helpers.ts";

const PASSWORD = "password-123";
const DAY_MS = 24 * 60 * 60 * 1000;

type Harness = ReturnType<typeof createHarness>;
type Person = { client: Client & { cookie(): string | null }; id: string; username: string };

const signUp = async (h: Harness, username: string, ip = "10.0.0.1"): Promise<Person> => {
  const client = h.client(ip);
  const res = await client.call("/auth/register", { body: { username, password: PASSWORD } });
  await expectStatus(res.clone(), 201);
  return { client, id: (await client.json(res, AuthResponseSchema)).account.id, username };
};

/** A teacher with a class, and the given students as active members of it. */
const classWith = async (teacher: Person, students: readonly Person[], name = "Night shift"): Promise<string> => {
  const created = ClassResponseSchema.parse(await (await teacher.client.call("/classes", { body: { name } })).json()).class;
  assert.ok(created.admin);
  for (const s of students) {
    const joined = ClassJoinResponseSchema.parse(await (await s.client.call("/classes/join", { body: { code: created.admin.joinCode } })).json());
    assert.equal(joined.class.membership?.status, "active");
  }
  return created.id;
};

const requestReset = (h: Harness, username: string, ip = "10.5.0.1"): Promise<Response> => h.client(ip).call("/auth/reset-request", { body: { username } });

const setup = async (now?: () => Date) => {
  const store = new InMemoryKvStore();
  const h = createHarness({ store, ...(now === undefined ? {} : { now }) });
  const teacher = await signUp(h, "teacher");
  const student = await signUp(h, "student");
  const classId = await classWith(teacher, [student]);
  return { store, h, teacher, student, classId };
};

test("a reset request answers the same 202 for a known name, an unknown name, a guest and the admin", async () => {
  const { h, store, student } = await setup();
  const bodies: string[] = [];
  for (const name of ["student", "nobody-at-all", "admin", "guest-abc"]) {
    const res = await requestReset(h, name);
    assert.equal(res.status, 202);
    bodies.push(await res.text());
  }
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(JSON.parse(bodies[0] ?? ""), { status: "received" });
  // only the existing user account got a request, and only it was audited
  assert.deepEqual(await store.listKeys("resetrequest:"), [`resetrequest:${student.id}`]);
  const audit = AuditResponseSchema.parse(await (await h.admin("/admin/audit")).json());
  const requests = audit.entries.filter((e) => e.action === "account.reset-request");
  assert.deepEqual(requests.map((e) => [e.target, e.actor]), [[student.id, null]]);
  // a filled honeypot: the same answer, nothing written for a new name
  const teacherReq = await h.client("10.5.0.9").call("/auth/reset-request", { body: { username: "teacher", website: "http://spam" } });
  assert.equal(teacherReq.status, 202);
  assert.equal(await teacherReq.text(), bodies[0]);
  assert.equal((await store.listKeys("resetrequest:")).length, 1);
});

test("reset requests are rate limited per address and per username", async () => {
  const { h } = await setup();
  for (let i = 0; i < 5; i++) await expectStatus(requestReset(h, "student", `10.6.0.${i}`), 202);
  await expectStatus(requestReset(h, "student", "10.6.1.1"), 429, "rate-limited");
  for (let i = 0; i < 20; i++) await expectStatus(requestReset(h, `name-${i}`, "10.7.0.1"), 202);
  await expectStatus(requestReset(h, "someone-else", "10.7.0.1"), 429, "rate-limited");
});

test("without a vouch the owner can neither see nor approve the request", async () => {
  const { h, student } = await setup();
  await expectStatus(requestReset(h, "student"), 202);
  const list = AdminPasswordResetRequestsResponseSchema.parse(await (await h.admin("/admin/reset-requests")).json());
  assert.deepEqual(list.requests, []);
  await expectStatus(h.admin(`/admin/reset-requests/${student.id}/approve`, { body: {} }), 409, "no-vouch");
  // the password still works: nothing changed
  await expectStatus(h.client().call("/auth/login", { body: { username: "student", password: PASSWORD } }), 200);
});

test("only a class admin of a class the student is an active member of can vouch", async () => {
  const { h, teacher, student, classId } = await setup();
  const stranger = await signUp(h, "stranger");
  const otherClass = await classWith(stranger, []);
  const classmate = await signUp(h, "classmate");
  const joinCode = ClassResponseSchema.parse(await (await teacher.client.call(`/classes/${classId}`)).json()).class.admin?.joinCode ?? "";
  await expectStatus(classmate.client.call("/classes/join", { body: { code: joinCode } }), 200);
  await expectStatus(requestReset(h, "student"), 202);

  // an admin of an unrelated class: 404 on that class (the student isn't in it) and on the teacher's class
  await expectStatus(stranger.client.call(`/classes/${otherClass}/reset-requests/${student.id}/vouch`, { body: {} }), 404);
  await expectStatus(stranger.client.call(`/classes/${classId}/reset-requests/${student.id}/vouch`, { body: {} }), 404);
  const strangerList = ClassResetRequestsResponseSchema.parse(await (await stranger.client.call(`/classes/${otherClass}/reset-requests`)).json());
  assert.deepEqual(strangerList.requests, []);
  // a plain member of the class can't vouch or list
  await expectStatus(classmate.client.call(`/classes/${classId}/reset-requests/${student.id}/vouch`, { body: {} }), 403, "not-class-admin");
  await expectStatus(classmate.client.call(`/classes/${classId}/reset-requests`), 403, "not-class-admin");
  // the site owner doesn't vouch (it would skip the second person)
  await expectStatus(h.admin(`/classes/${classId}/reset-requests/${student.id}/vouch`, { body: {} }), 403);
  // nothing counted: the owner still can't approve
  await expectStatus(h.admin(`/admin/reset-requests/${student.id}/approve`, { body: {} }), 409, "no-vouch");

  // the class's admin sees it and vouches
  const before = ClassResetRequestsResponseSchema.parse(await (await teacher.client.call(`/classes/${classId}/reset-requests`)).json());
  assert.deepEqual(before.requests.map((r) => [r.username, r.vouchedByMe]), [["student", false]]);
  const vouched = ClassResetRequestResponseSchema.parse(await (await teacher.client.call(`/classes/${classId}/reset-requests/${student.id}/vouch`, { body: {} })).json());
  assert.equal(vouched.request.vouchedByMe, true);
  // a second vouch is idempotent
  await expectStatus(teacher.client.call(`/classes/${classId}/reset-requests/${student.id}/vouch`, { body: {} }), 200);
  const owner = AdminPasswordResetRequestsResponseSchema.parse(await (await h.admin("/admin/reset-requests")).json());
  assert.equal(owner.requests.length, 1);
  assert.deepEqual(owner.requests[0]?.vouches.map((v) => [v.byUsername, v.className]), [["teacher", "Night shift"]]);
  const audit = AuditResponseSchema.parse(await (await h.admin("/admin/audit")).json());
  assert.ok(audit.entries.some((e) => e.action === "account.reset-vouch" && e.target === student.id && e.actor === teacher.id));
});

test("a class admin never sees or sets a password: no route answers with one, and vouching changes nothing", async () => {
  const { h, teacher, student, classId } = await setup();
  await expectStatus(requestReset(h, "student"), 202);
  const responses = [
    await teacher.client.call(`/classes/${classId}/reset-requests`),
    await teacher.client.call(`/classes/${classId}/reset-requests/${student.id}/vouch`, { body: {} }),
    await teacher.client.call(`/classes/${classId}/members`),
  ];
  for (const res of responses) {
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.doesNotMatch(text, /password|passwordHash|recoveryCode|scrypt/i, text);
  }
  // the owner-only routes refuse a class admin's session
  await expectStatus(teacher.client.call(`/admin/reset-requests/${student.id}/approve`, { body: {} }), 401);
  await expectStatus(teacher.client.call(`/admin/accounts/${student.id}/reset-password`, { body: {} }), 401);
  await expectStatus(teacher.client.call("/admin/reset-requests"), 401);
  // the student's password and sessions are untouched by the vouch
  await expectStatus(student.client.call("/me"), 200);
  await expectStatus(h.client().call("/auth/login", { body: { username: "student", password: PASSWORD } }), 200);
});

test("an expired request can't be vouched for or approved, and the weekly sweep deletes it", async () => {
  let nowMs = Date.parse("2026-11-01T10:00:00Z");
  const now = (): Date => new Date(nowMs);
  const { h, store, teacher, student, classId } = await setup(now);
  await expectStatus(requestReset(h, "student"), 202);
  await expectStatus(teacher.client.call(`/classes/${classId}/reset-requests/${student.id}/vouch`, { body: {} }), 200);
  nowMs += 7 * DAY_MS + 1000;
  await expectStatus(h.admin(`/admin/reset-requests/${student.id}/approve`, { body: {} }), 404, "no-reset-request");
  assert.deepEqual(AdminPasswordResetRequestsResponseSchema.parse(await (await h.admin("/admin/reset-requests")).json()).requests, []);
  await expectStatus(teacher.client.call(`/classes/${classId}/reset-requests/${student.id}/vouch`, { body: {} }), 404);
  const hygiene = createAccountHygiene(store, now);
  assert.equal((await hygiene.run({ apply: false })).expiredResetRequests, 1);
  assert.equal((await hygiene.run({ apply: true })).expiredResetRequests, 1);
  assert.deepEqual(await store.listKeys("resetrequest:"), []);
  // a new request starts over, without the old vouch
  await expectStatus(requestReset(h, "student", "10.5.0.2"), 202);
  await expectStatus(h.admin(`/admin/reset-requests/${student.id}/approve`, { body: {} }), 409, "no-vouch");
});

test("a vouch stops counting when the teacher is no longer an admin of the class", async () => {
  const { h, teacher, student, classId } = await setup();
  const coAdmin = await signUp(h, "co-admin");
  const joinCode = ClassResponseSchema.parse(await (await teacher.client.call(`/classes/${classId}`)).json()).class.admin?.joinCode ?? "";
  await expectStatus(coAdmin.client.call("/classes/join", { body: { code: joinCode } }), 200);
  await expectStatus(teacher.client.call(`/classes/${classId}/members/${coAdmin.id}/role`, { body: { role: "admin" } }), 200);
  await expectStatus(requestReset(h, "student"), 202);
  await expectStatus(coAdmin.client.call(`/classes/${classId}/reset-requests/${student.id}/vouch`, { body: {} }), 200);
  await expectStatus(teacher.client.call(`/classes/${classId}/members/${coAdmin.id}/role`, { body: { role: "member" } }), 200);
  await expectStatus(h.admin(`/admin/reset-requests/${student.id}/approve`, { body: {} }), 409, "no-vouch");
});

test("approval ends every session; the temporary password only allows the password change, which issues a recovery code", async () => {
  const { h, teacher, student, classId } = await setup();
  await expectStatus(requestReset(h, "student"), 202);
  await expectStatus(teacher.client.call(`/classes/${classId}/reset-requests/${student.id}/vouch`, { body: {} }), 200);
  const approved = await h.admin(`/admin/reset-requests/${student.id}/approve`, { body: {} });
  assert.equal(approved.status, 200);
  const { temporaryPassword } = ResetPasswordResponseSchema.parse(await approved.json());
  assert.ok(temporaryPassword.length >= 10);
  // a second approval finds nothing open
  await expectStatus(h.admin(`/admin/reset-requests/${student.id}/approve`, { body: {} }), 404, "no-reset-request");
  // the audit names the approval and the voucher, never the password
  const audit = await (await h.admin("/admin/audit")).text();
  assert.match(audit, /account\.reset-approve/);
  assert.match(audit, /vouched by teacher/);
  assert.ok(!audit.includes(temporaryPassword));

  // the old session is gone and the old password no longer works
  await expectStatus(student.client.call("/me"), 401, "signed-out");
  await expectStatus(h.client().call("/auth/login", { body: { username: "student", password: PASSWORD } }), 401, "bad-credentials");

  const tempSession = h.client();
  const signedIn = await tempSession.json(await tempSession.call("/auth/login", { body: { username: "student", password: temporaryPassword } }), AuthResponseSchema);
  assert.equal(signedIn.account.mustChangePassword, true);
  await expectStatus(tempSession.call("/me"), 200);
  await expectStatus(tempSession.call("/session"), 200);
  for (const [path, body] of [
    ["/cases/alpha/progress", undefined],
    ["/me/stats", undefined],
    ["/classes", undefined],
    [`/classes/${classId}`, undefined],
    ["/me/recovery-code", { currentPassword: temporaryPassword }],
    ["/me/board", { show: true }],
    ["/classes", { name: "Mine" }],
  ] as const) {
    const method = path === "/me/board" ? "PUT" : undefined;
    await expectStatus(tempSession.call(path, { ...(body === undefined ? {} : { body }), ...(method === undefined ? {} : { method }) }), 403, "password-change-required");
  }

  const changed = await tempSession.call("/me/password", { body: { currentPassword: temporaryPassword, newPassword: "my-new-password-1" } });
  assert.equal(changed.status, 200);
  const after = AuthResponseSchema.parse(await changed.json());
  assert.equal(after.account.mustChangePassword, false);
  assert.ok(after.recoveryCode, "the change issues a new recovery code");
  await expectStatus(tempSession.call("/cases/alpha/progress"), 200);
  // the temporary password is spent; the new one and the new recovery code work
  await expectStatus(h.client().call("/auth/login", { body: { username: "student", password: temporaryPassword } }), 401, "bad-credentials");
  await expectStatus(h.client().call("/auth/login", { body: { username: "student", password: "my-new-password-1" } }), 200);
  const recovered = await h.client().call("/auth/recover", { body: { username: "student", recoveryCode: after.recoveryCode, newPassword: "third-password-1" } });
  assert.equal(recovered.status, 200);
  RecoveryCodeResponseSchema.parse(await recovered.json());
  // an ordinary password change issues no code
  const normal = h.client();
  await normal.call("/auth/login", { body: { username: "student", password: "third-password-1" } });
  const plain = AuthResponseSchema.parse(await (await normal.call("/me/password", { body: { currentPassword: "third-password-1", newPassword: "fourth-password-1" } })).json());
  assert.equal(plain.recoveryCode, undefined);
});

test("the owner can reject a vouched request; it then needs a new request", async () => {
  const { h, teacher, student, classId } = await setup();
  await expectStatus(requestReset(h, "student"), 202);
  await expectStatus(teacher.client.call(`/classes/${classId}/reset-requests/${student.id}/vouch`, { body: {} }), 200);
  await expectStatus(h.admin(`/admin/reset-requests/${student.id}/reject`, { body: {} }), 204);
  assert.deepEqual(AdminPasswordResetRequestsResponseSchema.parse(await (await h.admin("/admin/reset-requests")).json()).requests, []);
  await expectStatus(h.admin(`/admin/reset-requests/${student.id}/approve`, { body: {} }), 404, "no-reset-request");
  assert.deepEqual(ClassResetRequestsResponseSchema.parse(await (await teacher.client.call(`/classes/${classId}/reset-requests`)).json()).requests, []);
  await expectStatus(h.client().call("/auth/login", { body: { username: "student", password: PASSWORD } }), 200);
});
