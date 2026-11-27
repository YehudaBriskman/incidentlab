// Private cases, class assignment and owner review (#184), end to end through the router on in-memory stores.
// Packages are built in memory from package-fixture.ts (made-up answers only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthorCaseResponseSchema, AuthorCasesResponseSchema, PublishResponseSchema, ReviewsResponseSchema } from "../../shared/author-contract.ts";
import {
  AccountResponseSchema,
  AnswerResponseSchema,
  AuditResponseSchema,
  CasesResponseSchema,
  ClassResponseSchema,
  LeaderboardResponseSchema,
  SessionResponseSchema,
  TodayResponseSchema,
} from "../../shared/contract.ts";
import type { ClassDetail } from "../../shared/contract.ts";
import { CaseContentResponseSchema, CaseMetaSchema } from "../../shared/case-records.ts";
import { uploadCasePackage } from "../../shared/upload-client.ts";
import type { UploadTransport } from "../../shared/upload-client.ts";
import { InMemoryByteStore } from "../repositories/ByteStore.ts";
import { CaseRepository, caseKeys, EvidenceChunkRepository } from "../repositories/case-repository.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { EvidenceService } from "../services/evidenceStream.ts";
import { createApp } from "../router.ts";
import { metaFixture } from "./case-fixtures.ts";
import { ADMIN_KEY, SECRETS, expectStatus } from "./helpers.ts";
import { ANSWERS, build, fixture } from "./package-fixture.ts";

const CASE = "dana-case";

const setup = () => {
  const kv = new InMemoryKvStore();
  const bytes = new InMemoryByteStore();
  const app = createApp({ store: kv, bytes, staticSecrets: SECRETS, adminKey: () => ADMIN_KEY });
  const cases = new CaseRepository(kv);
  const evidence = new EvidenceService({ cases, chunks: new EvidenceChunkRepository(bytes) });

  /** A caller: the admin key (like the CLI), a session cookie, or nobody. */
  const as = (who: { key: string } | { cookie: string } | null): UploadTransport => (path, init) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: init.method,
        headers: { ...init.headers, ...(who && "key" in who ? { "x-admin-key": who.key } : {}), ...(who && "cookie" in who ? { cookie: `il_session=${who.cookie}` } : {}) },
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
      "10.1.1.1",
    );
  const admin = as({ key: ADMIN_KEY });
  const anonymous = as(null);
  const call = (send: UploadTransport, path: string, method = "GET", body?: unknown): Promise<Response> =>
    send(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const parse = async <T>(res: Promise<Response>, schema: { parse(value: unknown): T }): Promise<T> => {
    const r = await res;
    const text = await r.text();
    assert.equal(r.status, 200, text);
    return schema.parse(JSON.parse(text));
  };

  /** Registers an approved account; `author` also gets the author role. */
  const account = async (username: string, role: "author" | "player" = "player"): Promise<{ id: string; send: UploadTransport }> => {
    const res = await call(anonymous, "/api/auth/register", "POST", { username, password: "hunter2hunter2" });
    assert.equal(res.status, 201);
    const cookie = /il_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(cookie);
    const { account: view } = AccountResponseSchema.parse(await res.json());
    if (role === "author") await expectStatus(call(admin, `/api/admin/accounts/${view.id}/role`, "PUT", { role: "author" }), 200);
    return { id: view.id, send: as({ cookie }) };
  };

  /** An admin session (the owner signed in in the browser). */
  const adminSession = async (): Promise<UploadTransport> => {
    const res = await call(anonymous, "/api/auth/login", "POST", { username: "admin", password: ADMIN_KEY });
    const cookie = /il_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(cookie);
    return as({ cookie });
  };

  const createClass = async (owner: UploadTransport, name: string): Promise<ClassDetail> => {
    const res = await call(owner, "/api/classes", "POST", { name });
    assert.equal(res.status, 201, await res.clone().text());
    return ClassResponseSchema.parse(await res.json()).class;
  };
  const join = async (who: UploadTransport, cls: ClassDetail): Promise<void> => {
    assert.ok(cls.admin);
    await expectStatus(call(who, "/api/classes/join", "POST", { code: cls.admin.joinCode }), 200);
  };

  const evidenceAt = (url: string): Promise<Response> => evidence.respond(new Request(`http://localhost${url}`));
  const publishPrivately = async (author: UploadTransport, id = CASE) =>
    uploadCasePackage(await build(fixture(id)), { send: author, sleep: () => Promise.resolve(), publish: true });

  return { kv, app, cases, admin, anonymous, as, call, parse, account, adminSession, createClass, join, evidenceAt, publishPrivately };
};

type Harness = ReturnType<typeof setup>;

/** Every play route of a case answers 404 "unknown-case" for this caller. */
const refusedPlay = async (s: Harness, who: UploadTransport, id = CASE): Promise<void> => {
  await expectStatus(s.call(who, `/api/cases/${id}/progress`), 404, "unknown-case");
  await expectStatus(s.call(who, `/api/cases/${id}/setup-done`, "POST", {}), 404, "unknown-case");
  await expectStatus(s.call(who, `/api/cases/${id}/answer`, "POST", { questionId: "q1", answer: ANSWERS["q1"] }), 404, "unknown-case");
  await expectStatus(s.call(who, `/api/cases/${id}/hint`, "POST", { questionId: "q1" }), 404, "unknown-case");
  await expectStatus(s.call(who, `/api/cases/${id}/debrief`), 404, "unknown-case");
};

/** The caller plays q1 of the case and solves it. */
const playsQ1 = async (s: Harness, who: UploadTransport, id = CASE): Promise<void> => {
  await expectStatus(s.call(who, `/api/cases/${id}/progress`), 200);
  await expectStatus(s.call(who, `/api/cases/${id}/setup-done`, "POST", {}), 200);
  const answered = await s.parse(s.call(who, `/api/cases/${id}/answer`, "POST", { questionId: "q1", answer: ANSWERS["q1"] }), AnswerResponseSchema);
  assert.equal(answered.correct, true);
};

/** No public response may name the case (catalog, today, leaderboard), and the content route says 404 like for an unknown id. */
const hiddenFromPublic = async (s: Harness, id = CASE): Promise<void> => {
  for (const path of ["/api/cases", "/api/today", "/api/leaderboard", "/api/event"]) {
    const res = await s.call(s.anonymous, path);
    assert.equal(res.status, 200, path);
    assert.ok(!(await res.text()).includes(id), `${path} must not name the private case`);
  }
  const unknown = await s.call(s.anonymous, "/api/cases/no-such-case/content");
  const hidden = await s.call(s.anonymous, `/api/cases/${id}/content`);
  assert.equal(hidden.status, 404);
  assert.equal(await hidden.text(), await unknown.text(), "a private case looks exactly like an unknown one");
};

test("metas saved before #184 parse as public cases with no review and no classes", () => {
  const meta = metaFixture("old-case");
  assert.equal(meta.visibility, "public");
  assert.equal(meta.review, "none");
  assert.equal(meta.reviewNote, null);
  assert.equal(meta.reviewAt, null);
  assert.deepEqual(meta.classIds, []);
  assert.equal(meta.pendingVersion, null);
  assert.equal(meta.evidenceKey, null);
  assert.deepEqual(CaseMetaSchema.parse(JSON.parse(JSON.stringify(meta))), meta, "round-trips");
});

test("a published author case stored before #184 stays public: the default does it, no migration", async () => {
  const s = setup();
  const dana = await s.account("Dana", "author");
  await s.publishPrivately(dana.send);
  // Write the meta back the way the code before #184 stored it: none of the new fields.
  const stored = await s.kv.get(caseKeys.meta(CASE));
  assert.ok(stored);
  const legacy = Object.fromEntries(Object.entries(stored.data as Record<string, unknown>).filter(([key]) =>
    !["visibility", "review", "reviewNote", "reviewAt", "classIds", "pendingVersion", "evidenceKey"].includes(key)));
  await s.kv.set(caseKeys.meta(CASE), legacy);

  const catalog = await s.parse(s.call(s.anonymous, "/api/cases"), CasesResponseSchema);
  assert.deepEqual(catalog.cases.map((c) => c.file), [CASE]);
  const content = await s.call(s.anonymous, `/api/cases/${CASE}/content`);
  assert.equal(content.status, 200);
  assert.match(content.headers.get("cache-control") ?? "", /public/);
  const stranger = await s.account("Stranger");
  await playsQ1(s, stranger.send);
});

test("an author's publish is private: hidden from every public response, open to its author and the site admin", async () => {
  const s = setup();
  const dana = await s.account("Dana", "author");
  const stranger = await s.account("Stranger");
  const outcome = await s.publishPrivately(dana.send);
  assert.equal(outcome.published?.visibility, "private");
  assert.equal(outcome.published?.pendingReview, false);

  await hiddenFromPublic(s);
  const today = await s.parse(s.call(s.anonymous, "/api/today"), TodayResponseSchema);
  assert.ok(!today.releasedCaseIds.includes(CASE));
  // A stranger: 404 on content and every play route; no private cases in the session or the personalised catalog.
  await expectStatus(s.call(stranger.send, `/api/cases/${CASE}/content`), 404, "not-found");
  await refusedPlay(s, stranger.send);
  assert.equal((await s.parse(s.call(stranger.send, "/api/session"), SessionResponseSchema)).privateCases, false);
  assert.deepEqual((await s.parse(s.call(stranger.send, "/api/me/cases"), CasesResponseSchema)).cases, []);
  assert.deepEqual((await s.parse(s.call(s.anonymous, "/api/me/cases"), CasesResponseSchema)).cases, []);
  // An admin can't even put it on the site schedule: it is not released.
  await expectStatus(s.call(s.admin, "/api/admin/schedule", "PUT", { timezone: "UTC", defaultCaseId: CASE, days: {}, lockToToday: false }), 400);

  // The author: no-store content with a keyed evidence location, the session hint, the personalised catalog.
  const res = await s.call(dana.send, `/api/cases/${CASE}/content`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("etag"), null);
  const content = CaseContentResponseSchema.parse(await res.json());
  assert.ok(content.evidence);
  const key = /\/v1~([0-9a-f]{32})\.zip$/.exec(content.evidence.zip)?.[1];
  assert.ok(key, content.evidence.zip);
  assert.equal((await s.evidenceAt(content.evidence.zip)).status, 200);
  assert.equal((await s.evidenceAt(`${content.evidence.filesBase}logs/app.log`)).status, 200);
  assert.equal((await s.evidenceAt(`/evidence/db/${CASE}/v1.zip`)).status, 404, "never on the plain URL");
  assert.equal((await s.evidenceAt(`/evidence/db/${CASE}/v1~${"0".repeat(32)}.zip`)).status, 404, "never with a wrong key");
  assert.equal((await s.parse(s.call(dana.send, "/api/session"), SessionResponseSchema)).privateCases, true);
  assert.deepEqual((await s.parse(s.call(dana.send, "/api/me/cases"), CasesResponseSchema)).cases.map((c) => c.file), [CASE]);
  // The author never sees the evidence key in the authoring list (it is only in the member-checked content).
  assert.ok(!JSON.stringify(await (await s.call(dana.send, "/api/author/cases")).json()).includes(key));
  await playsQ1(s, dana.send);

  // The site admin sees it (content only: the admin account doesn't play).
  const owner = await s.adminSession();
  await expectStatus(s.call(owner, `/api/cases/${CASE}/content`), 200);
  assert.deepEqual((await s.parse(s.call(owner, "/api/me/cases"), CasesResponseSchema)).cases.map((c) => c.file), [CASE]);

  // Private plays never count on the public global board.
  await expectStatus(s.call(dana.send, "/api/me/board", "PUT", { show: true }), 200);
  const board = await s.parse(s.call(s.anonymous, "/api/leaderboard"), LeaderboardResponseSchema);
  assert.deepEqual(board.entries, []);
  await hiddenFromPublic(s);
});

test("members of an assigned class play a private case; only class admins assign it", async () => {
  const s = setup();
  const dana = await s.account("Dana", "author");
  const eve = await s.account("Eve", "author");
  const bob = await s.account("Bob");
  await s.publishPrivately(dana.send);
  const danaClass = await s.createClass(dana.send, "Dana's class");
  const eveClass = await s.createClass(eve.send, "Eve's class");
  await s.join(bob.send, danaClass);
  await s.join(dana.send, eveClass); // a plain member of Eve's class, not an admin

  // Before the author assigns a class, its members get the same 404 as anyone.
  await refusedPlay(s, bob.send);
  await expectStatus(s.call(dana.send, `/api/classes/${danaClass.id}`, "PATCH", { caseIds: [CASE] }), 400, "unknown-case");

  // Only the owner assigns, and only classes they admin.
  await expectStatus(s.call(eve.send, `/api/author/cases/${CASE}/classes`, "PUT", { classIds: [eveClass.id] }), 403, "not-owner");
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/classes`, "PUT", { classIds: [eveClass.id] }), 403, "not-class-admin");
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/classes`, "PUT", { classIds: ["nosuchclass0"] }), 403, "not-class-admin");
  await expectStatus(s.call(bob.send, `/api/author/cases/${CASE}/classes`, "PUT", { classIds: [danaClass.id] }), 403, "not-author");
  const assigned = await s.parse(s.call(dana.send, `/api/author/cases/${CASE}/classes`, "PUT", { classIds: [danaClass.id] }), AuthorCaseResponseSchema);
  assert.deepEqual(assigned.case.classIds, [danaClass.id]);

  // A member plays it, sees it in the personalised catalog, and the class admin puts it on the class.
  assert.equal((await s.parse(s.call(bob.send, "/api/session"), SessionResponseSchema)).privateCases, true);
  assert.deepEqual((await s.parse(s.call(bob.send, "/api/me/cases"), CasesResponseSchema)).cases.map((c) => c.file), [CASE]);
  await expectStatus(s.call(bob.send, `/api/cases/${CASE}/content`), 200);
  await playsQ1(s, bob.send);
  const updated = await s.parse(s.call(dana.send, `/api/classes/${danaClass.id}`, "PATCH", { caseIds: [CASE] }), ClassResponseSchema);
  assert.deepEqual(updated.class.caseIds, [CASE]);
  await expectStatus(s.call(eve.send, `/api/classes/${eveClass.id}`, "PATCH", { caseIds: [CASE] }), 400, "unknown-case");
  // The class board (a CDN-cached capability URL) counts the member's points but never names the private case.
  const boardRes = await s.call(s.anonymous, `/api/classboard/${encodeURIComponent(updated.class.boardToken ?? "")}`);
  assert.equal(boardRes.status, 200);
  const boardText = await boardRes.text();
  assert.ok(!boardText.includes(CASE), boardText);
  assert.ok(boardText.includes('"username":"Bob"'), boardText);
  // Members of another class still can't.
  await refusedPlay(s, eve.send);
  await hiddenFromPublic(s);

  // Removed from the class: the 404 is back at once (membership is read live).
  await expectStatus(s.call(dana.send, `/api/classes/${danaClass.id}/members/${bob.id}/remove`, "POST", {}), 204);
  await refusedPlay(s, bob.send);
  await expectStatus(s.call(bob.send, `/api/cases/${CASE}/content`), 404);
});

test("review: submit, reject with a note, resubmit, approve to public", async () => {
  const s = setup();
  const dana = await s.account("Dana", "author");
  const eve = await s.account("Eve", "author");
  const stranger = await s.account("Stranger");

  // A draft can't be submitted: it has to be tried out (published privately) first.
  await uploadCasePackage(await build(fixture(CASE)), { send: dana.send, sleep: () => Promise.resolve() });
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/submit-review`, "POST", {}), 409, "not-published");
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/publish`, "POST", { version: 1, visibility: "public" }), 403, "not-admin");
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/publish`, "POST", { version: 1 }), 200);
  await expectStatus(s.call(eve.send, `/api/author/cases/${CASE}/submit-review`, "POST", {}), 403, "not-owner");

  const submitted = await s.parse(s.call(dana.send, `/api/author/cases/${CASE}/submit-review`, "POST", {}), AuthorCaseResponseSchema);
  assert.equal(submitted.case.review, "submitted");
  await expectStatus(s.call(dana.send, "/api/admin/reviews"), 403, "not-admin");
  await expectStatus(s.call(stranger.send, "/api/admin/reviews"), 403);
  const queue = await s.parse(s.call(s.admin, "/api/admin/reviews"), ReviewsResponseSchema);
  assert.deepEqual(queue.reviews.map((r) => [r.caseId, r.author, r.version, r.visibility, r.answerKeyChanged]), [[CASE, "Dana", 1, "private", false]]);
  assert.ok(!JSON.stringify(queue).includes(ANSWERS["q1"] ?? "?"), "no answers in the queue");

  // Reject: a note is required, and it reaches the author; the case stays private.
  await expectStatus(s.call(s.admin, `/api/admin/cases/${CASE}/review`, "POST", { decision: "reject" }), 400);
  await expectStatus(s.call(dana.send, `/api/admin/cases/${CASE}/review`, "POST", { decision: "approve" }), 403, "not-admin");
  const rejected = await s.parse(s.call(s.admin, `/api/admin/cases/${CASE}/review`, "POST", { decision: "reject", note: "Question 3 is ambiguous." }), AuthorCaseResponseSchema);
  assert.deepEqual([rejected.case.review, rejected.case.reviewNote, rejected.case.visibility], ["rejected", "Question 3 is ambiguous.", "private"]);
  const mine = await s.parse(s.call(dana.send, "/api/author/cases"), AuthorCasesResponseSchema);
  assert.equal(mine.cases[0]?.reviewNote, "Question 3 is ambiguous.");
  assert.deepEqual((await s.parse(s.call(s.admin, "/api/admin/reviews"), ReviewsResponseSchema)).reviews, []);
  await expectStatus(s.call(s.admin, `/api/admin/cases/${CASE}/review`, "POST", { decision: "approve" }), 409, "not-submitted");
  await hiddenFromPublic(s);

  // Resubmit and approve: public everywhere, CDN-cacheable, plain evidence URL.
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/submit-review`, "POST", {}), 200);
  const approved = await s.parse(s.call(s.admin, `/api/admin/cases/${CASE}/review`, "POST", { decision: "approve", note: "Thanks!" }), AuthorCaseResponseSchema);
  assert.deepEqual([approved.case.review, approved.case.visibility, approved.case.publishedVersion], ["approved", "public", 1]);
  const catalog = await s.parse(s.call(s.anonymous, "/api/cases"), CasesResponseSchema);
  assert.deepEqual(catalog.cases.map((c) => c.file), [CASE]);
  const content = await s.call(s.anonymous, `/api/cases/${CASE}/content`);
  assert.equal(content.status, 200);
  assert.match(content.headers.get("cache-control") ?? "", /^public/);
  const body = CaseContentResponseSchema.parse(await content.json());
  assert.equal(body.evidence?.zip, `/evidence/db/${CASE}/v1.zip`);
  assert.equal((await s.evidenceAt(`/evidence/db/${CASE}/v1.zip`)).status, 200);
  assert.ok((await s.parse(s.call(s.anonymous, "/api/today"), TodayResponseSchema)).releasedCaseIds.includes(CASE));
  await playsQ1(s, stranger.send);
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/submit-review`, "POST", {}), 409, "already-public");

  const audit = await s.parse(s.call(s.admin, "/api/admin/audit"), AuditResponseSchema);
  for (const action of ["case.review-submit", "case.review-reject", "case.review-approve"]) assert.ok(audit.entries.some((e) => e.action === action), action);
});

test("re-review: an author's new version of a public case waits for the owner; the public version stays live", async () => {
  const s = setup();
  const dana = await s.account("Dana", "author");
  const player = await s.account("Player");
  await s.publishPrivately(dana.send);
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/submit-review`, "POST", {}), 200);
  await expectStatus(s.call(s.admin, `/api/admin/cases/${CASE}/review`, "POST", { decision: "approve" }), 200);
  await playsQ1(s, player.send); // progress on v1

  // v2 changes the answer key. Publishing it as the author doesn't go live: it is submitted for review.
  const changed = fixture(CASE);
  changed.answers = { ...ANSWERS, q2: "cafef00d" };
  const v2 = await uploadCasePackage(await build(changed), { send: dana.send, sleep: () => Promise.resolve(), publish: true });
  assert.deepEqual([v2.published?.pendingReview, v2.published?.publishedVersion, v2.published?.visibility], [true, 1, "public"]);
  const listed = await s.parse(s.call(dana.send, "/api/author/cases"), AuthorCasesResponseSchema);
  assert.deepEqual([listed.cases[0]?.pendingVersion, listed.cases[0]?.review, listed.cases[0]?.versions.map((v) => v.state)], [2, "submitted", ["published", "pending"]]);

  // Still v1 everywhere public, and v1's answer key is what players are checked against.
  assert.deepEqual((await s.parse(s.call(s.anonymous, "/api/cases"), CasesResponseSchema)).cases.map((c) => [c.file, c.version]), [[CASE, 1]]);
  assert.equal(CaseContentResponseSchema.parse(await (await s.call(s.anonymous, `/api/cases/${CASE}/content`)).json()).version, 1);
  assert.equal((await s.evidenceAt(`/evidence/db/${CASE}/v2.zip`)).status, 404, "the pending version's evidence isn't served");
  const queue = await s.parse(s.call(s.admin, "/api/admin/reviews"), ReviewsResponseSchema);
  assert.deepEqual(queue.reviews.map((r) => [r.version, r.publishedVersion, r.visibility, r.answerKeyChanged]), [[2, 1, "public", true]]);

  // Approval follows the answer-drift rule: players have progress, so it has to be accepted explicitly.
  await expectStatus(s.call(s.admin, `/api/admin/cases/${CASE}/review`, "POST", { decision: "approve" }), 409, "answer-drift");
  const approved = await s.parse(s.call(s.admin, `/api/admin/cases/${CASE}/review`, "POST", { decision: "approve", acceptAnswerChanges: true }), AuthorCaseResponseSchema);
  assert.deepEqual([approved.case.publishedVersion, approved.case.pendingVersion, approved.case.visibility], [2, null, "public"]);
  assert.deepEqual((await s.parse(s.call(s.anonymous, "/api/cases"), CasesResponseSchema)).cases.map((c) => [c.file, c.version]), [[CASE, 2]]);

  // A rejected new version is dropped from review and the public one stays.
  const v3 = fixture(CASE);
  v3.content["title"] = "Fixture case, take three";
  await uploadCasePackage(await build(v3), { send: dana.send, sleep: () => Promise.resolve(), publish: true });
  const rejected = await s.parse(s.call(s.admin, `/api/admin/cases/${CASE}/review`, "POST", { decision: "reject", note: "Keep the old title." }), AuthorCaseResponseSchema);
  assert.deepEqual([rejected.case.publishedVersion, rejected.case.pendingVersion, rejected.case.visibility, rejected.case.review], [2, null, "public", "rejected"]);
  assert.deepEqual((await s.parse(s.call(s.anonymous, "/api/cases"), CasesResponseSchema)).cases.map((c) => c.version), [2]);
});

test("the site admin's own publish chooses visibility, and keeps it when left out", async () => {
  const s = setup();
  await uploadCasePackage(await build(fixture("owner-case")), { send: s.admin, sleep: () => Promise.resolve() });
  const published = await s.parse(s.call(s.admin, "/api/author/cases/owner-case/publish", "POST", { version: 1, visibility: "private" }), PublishResponseSchema);
  assert.equal(published.visibility, "private");
  await hiddenFromPublic(s, "owner-case");
  const made = await s.parse(s.call(s.admin, "/api/author/cases/owner-case/publish", "POST", { version: 1, visibility: "public" }), PublishResponseSchema);
  assert.deepEqual([made.visibility, made.changed], ["public", true]);
  assert.deepEqual((await s.parse(s.call(s.anonymous, "/api/cases"), CasesResponseSchema)).cases.map((c) => c.file), ["owner-case"]);
  // An admin-uploaded case is public by default, as before #184.
  const plain = await uploadCasePackage(await build(fixture("plain-case")), { send: s.admin, sleep: () => Promise.resolve(), publish: true });
  assert.equal(plain.published?.visibility, "public");
});
