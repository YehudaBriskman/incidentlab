// Case upload, publish, rollback and soft delete (#66), end to end through the router on in-memory stores.
// Packages are built in memory from package-fixture.ts (made-up answers only).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthorCasesResponseSchema,
  ChunkResponseSchema,
  CreateUploadResponseSchema,
  DeleteCaseResponseSchema,
  PublishResponseSchema,
  RestoreCaseResponseSchema,
  UPLOAD_LIMITS,
} from "../../shared/author-contract.ts";
import type { CreateUploadResponse } from "../../shared/author-contract.ts";
import { AccountResponseSchema, AnswerResponseSchema, AuditResponseSchema, CasesResponseSchema, TrashResponseSchema } from "../../shared/contract.ts";
import { CaseContentResponseSchema, EVIDENCE_CHUNK_BYTES } from "../../shared/case-records.ts";
import { uploadCasePackage, UploadError } from "../../shared/upload-client.ts";
import { openZip } from "../../shared/zip.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_UPLOAD_URL, LOCAL_ADMIN_KEY, resolveAdminKey, uploadCommand } from "../../../scripts/upload-case.ts";
import type { UploadTransport } from "../../shared/upload-client.ts";
import { InMemoryByteStore } from "../repositories/ByteStore.ts";
import { CaseRepository, EvidenceChunkRepository } from "../repositories/case-repository.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { EvidenceService } from "../services/evidenceStream.ts";
import { createApp } from "../router.ts";
import { patternBytes } from "./case-fixtures.ts";
import { ADMIN_KEY, SECRETS, expectStatus } from "./helpers.ts";
import { ID, build, fixture, sha256 } from "./package-fixture.ts";
import type { Fixture } from "./package-fixture.ts";

const BIG = 2 * EVIDENCE_CHUNK_BYTES + 777; // three chunks, the last one partial

const setup = (options: { now?: () => Date } = {}) => {
  const kv = new InMemoryKvStore();
  const bytes = new InMemoryByteStore();
  const app = createApp({ store: kv, bytes, secrets: SECRETS, adminKey: () => ADMIN_KEY, now: options.now });
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
  const call = (send: UploadTransport, path: string, method = "GET", body?: unknown): Promise<Response> =>
    send(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  /** Registers an account; `author` makes it an approved author. Returns a transport with its session. */
  const account = async (username: string, role: "author" | "player"): Promise<{ id: string; send: UploadTransport }> => {
    const res = await call(as(null), "/api/auth/register", "POST", { username, password: "hunter2hunter2" });
    assert.equal(res.status, 201);
    const cookie = /il_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(cookie);
    const { account: view } = AccountResponseSchema.parse(await res.json());
    await expectStatus(call(admin, `/api/admin/accounts/${view.id}/approve`, "POST", {}), 200);
    if (role === "author") await expectStatus(call(admin, `/api/admin/accounts/${view.id}/role`, "PUT", { role: "author" }), 200);
    return { id: view.id, send: as({ cookie }) };
  };
  const fetchEvidence = (path: string): Promise<Response> => evidence.respond(new Request(`http://localhost/evidence/db/${path}`));
  return { kv, bytes, app, cases, admin, as, call, account, fetchEvidence };
};

const noSleep = (): Promise<void> => Promise.resolve();
const withFile = (f: Fixture, path: string, data: Uint8Array): Fixture => {
  f.evidence.set(path, data);
  f.manifest.evidence.push({ path, format: "text", size: data.length, sha256: sha256(data), chunks: Math.ceil(data.length / EVIDENCE_CHUNK_BYTES), explorer: true });
  return f;
};
const bigFixture = (id = ID): Fixture => withFile(fixture(id), "logs/big.log", patternBytes(BIG, 11));

const startUpload = async (s: ReturnType<typeof setup>, send: UploadTransport, pkg: Uint8Array, f: Fixture): Promise<CreateUploadResponse> => {
  const zip = openZip(pkg);
  const evidenceZip = await zip.read("evidence.zip");
  const res = await s.call(send, "/api/author/uploads", "POST", { manifest: f.manifest, evidenceZip: { sha256: sha256(evidenceZip), size: evidenceZip.length } });
  assert.equal(res.status, 201, await res.clone().text());
  return CreateUploadResponseSchema.parse(await res.json());
};

test("a full upload stores a draft, lists it, and publishing makes it public with the right bytes", async () => {
  const s = setup();
  const f = bigFixture();
  const pkg = await build(f);
  const progress: string[] = [];
  const outcome = await uploadCasePackage(pkg, { send: s.admin, sleep: noSleep, onProgress: (p) => progress.push(p.phase) });
  assert.equal(outcome.draft.version, 1);
  assert.equal(outcome.draft.status, "draft");
  assert.equal(outcome.chunksSkipped, 0);
  assert.equal(outcome.chunksSent, outcome.upload.missingChunks.length);
  assert.ok(outcome.chunksSent >= 6, "three chunks for the big file plus the small files and the zip");
  assert.deepEqual(outcome.draft.diff.evidenceAdded, ["README_FIRST.txt", "logs/app.log", "logs/big.log", "pcap/capture.pcap"]);
  assert.equal(outcome.draft.diff.against, null);
  assert.equal(outcome.draft.diff.answerFingerprintChanged, null);
  assert.ok(progress.includes("chunk") && progress.at(-1) === "finalized");

  // A draft is listed for its owner and invisible to the public.
  const listed = AuthorCasesResponseSchema.parse(await (await s.call(s.admin, "/api/author/cases")).json());
  assert.deepEqual(listed.cases.map((c) => [c.id, c.status, c.publishedVersion, c.latestVersion, c.versions[0]?.state]), [[ID, "draft", null, 1, "draft"]]);
  assert.equal(CasesResponseSchema.parse(await (await s.call(s.admin, "/api/cases")).json()).cases.length, 0);
  assert.equal((await s.fetchEvidence(`${ID}/v1/files/logs/big.log`)).status, 404);

  const published = PublishResponseSchema.parse(await (await s.call(s.admin, `/api/author/cases/${ID}/publish`, "POST", { version: 1 })).json());
  assert.deepEqual(published, { caseId: ID, publishedVersion: 1, previousVersion: null, rollback: false, changed: true });
  const catalog = CasesResponseSchema.parse(await (await s.call(s.admin, "/api/cases")).json());
  assert.deepEqual(catalog.cases.map((c) => c.file), [ID]);
  const content = CaseContentResponseSchema.parse(await (await s.call(s.admin, `/api/cases/${ID}/content`)).json());
  assert.equal(content.version, 1);
  const big = await s.fetchEvidence(`${ID}/v1/files/logs/big.log`);
  assert.equal(big.status, 200);
  assert.equal(sha256(new Uint8Array(await big.arrayBuffer())), sha256(patternBytes(BIG, 11)));
  const zip = await s.fetchEvidence(`${ID}/v1.zip`);
  assert.equal(zip.status, 200);
  assert.equal(sha256(new Uint8Array(await zip.arrayBuffer())), sha256(await openZip(pkg).read("evidence.zip")));

  const audit = AuditResponseSchema.parse(await (await s.call(s.admin, "/api/admin/audit")).json());
  // Entries written in the same millisecond have no defined order, so compare as a set.
  assert.deepEqual(audit.entries.map((e) => e.action).filter((a) => a.startsWith("case.")).sort(), ["case.draft", "case.publish", "case.upload"]);
});

test("a published upload is playable at once, and a rollback changes the answer key players are checked against", async () => {
  const s = setup();
  const paul = await s.account("Paul", "player");
  await uploadCasePackage(await build(fixture()), { send: s.admin, sleep: noSleep, publish: true });
  await expectStatus(s.call(paul.send, `/api/cases/${ID}/setup-done`, "POST", {}), 200);
  const answer = async (value: string): Promise<boolean> => {
    const res = await s.call(paul.send, `/api/cases/${ID}/answer`, "POST", { questionId: "q1", answer: value });
    assert.equal(res.status, 200, await res.clone().text());
    return AnswerResponseSchema.parse(await res.json()).correct;
  };
  assert.equal(await answer("08:00:00"), false);
  // v2 changes q1's answer; Paul has progress, so publishing needs acceptAnswerChanges.
  const changed = fixture();
  changed.answers = { q1: "08:00:00", q2: "deadbee", q3: "fixture-role-x", q4: "order-99", q5: "12", q6: "widget-api" };
  await uploadCasePackage(await build(changed), { send: s.admin, sleep: noSleep, publish: true, acceptAnswerChanges: true });
  assert.equal(await answer("08:00:00"), true, "the new answer key applies without waiting for the refresh interval");
});

test("resume: a re-POST lists only the chunks still missing, and a repeated chunk PUT is idempotent", async () => {
  const s = setup();
  const f = bigFixture();
  const pkg = await build(f);
  const first = await startUpload(s, s.admin, pkg, f);
  const big = patternBytes(BIG, 11);
  const bigSha = sha256(big);
  // Send two of the big file's three chunks, then "fail".
  for (const index of [0, 1]) {
    const chunk = big.slice(index * EVIDENCE_CHUNK_BYTES, (index + 1) * EVIDENCE_CHUNK_BYTES);
    const put = (): Promise<Response> => s.admin(`/api/author/uploads/${first.uploadId}/chunks/${bigSha}/${index}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: chunk });
    const r = ChunkResponseSchema.parse(await (await put()).json());
    assert.deepEqual(r, { stored: true, fileComplete: false, verified: false });
    if (index === 0) assert.deepEqual(ChunkResponseSchema.parse(await (await put()).json()), { stored: false, fileComplete: false, verified: false }, "idempotent");
  }
  const second = await startUpload(s, s.admin, pkg, f);
  assert.equal(second.missingChunks.length, first.missingChunks.length - 2);
  assert.ok(!second.missingChunks.some((c) => c.sha256 === bigSha && c.index < 2));

  // The CLI path resumes the same way: it only sends what is missing.
  const outcome = await uploadCasePackage(pkg, { send: s.admin, sleep: noSleep, publish: true });
  assert.equal(outcome.chunksSent, second.missingChunks.length);
  assert.equal(outcome.chunksSkipped, 2);
  // A second upload of the same bytes (a new version) sends no chunk at all, and differs in nothing.
  assert.equal(outcome.published?.publishedVersion, 1);
  const again = await uploadCasePackage(pkg, { send: s.admin, sleep: noSleep });
  assert.equal(again.chunksSent, 0);
  assert.equal(again.draft.version, 2);
  const { diff } = again.draft;
  assert.deepEqual([diff.against, diff.evidenceAdded, diff.evidenceRemoved, diff.evidenceChanged, diff.contentChanged, diff.evidenceZipChanged, diff.answerFingerprintChanged], [1, [], [], [], [], false, false]);
});

test("a chunk that does not hash to its file's sha256 is rejected and dropped", async () => {
  const s = setup();
  const f = fixture();
  const pkg = await build(f);
  const upload = await startUpload(s, s.admin, pkg, f);
  const log = f.evidence.get("logs/app.log");
  assert.ok(log);
  const wrong = log.slice();
  wrong[0] = (wrong[0] ?? 0) ^ 0xff;
  const path = `/api/author/uploads/${upload.uploadId}/chunks/${sha256(log)}/0`;
  const put = (body: Uint8Array): Promise<Response> => s.admin(path, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(body) });
  await expectStatus(put(wrong), 422, "sha-mismatch");
  // The bad bytes were dropped, so the right ones can be sent and are accepted.
  assert.deepEqual(ChunkResponseSchema.parse(await (await put(log)).json()), { stored: true, fileComplete: true, verified: true });
  await expectStatus(put(log.slice(1)), 400, "chunk-size");
  await expectStatus(s.admin(path, { method: "PUT", headers: { "content-type": "text/plain" }, body: new Uint8Array(log) }), 415);
});

test("oversized bodies and packages are rejected", async () => {
  const s = setup();
  const f = bigFixture();
  const pkg = await build(f);
  const upload = await startUpload(s, s.admin, pkg, f);
  const bigSha = sha256(patternBytes(BIG, 11));
  const tooBig = new Uint8Array(EVIDENCE_CHUNK_BYTES + 1);
  await expectStatus(s.admin(`/api/author/uploads/${upload.uploadId}/chunks/${bigSha}/0`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: tooBig }), 413, "too-large");
  await expectStatus(s.admin(`/api/author/uploads/${upload.uploadId}/parts/content.en.json`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(UPLOAD_LIMITS.maxPartBytes + 1) }), 413, "too-large");
  await expectStatus(s.admin(`/api/author/uploads/${upload.uploadId}/parts/evil.json`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(2) }), 400, "part-not-allowed");
  await expectStatus(s.admin(`/api/author/uploads/${upload.uploadId}/parts/content.he.json`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(2) }), 400, "part-not-allowed");

  const huge = { ...f.manifest.evidence[0], size: UPLOAD_LIMITS.maxPackageBytes, chunks: Math.ceil(UPLOAD_LIMITS.maxPackageBytes / EVIDENCE_CHUNK_BYTES) };
  await expectStatus(s.call(s.admin, "/api/author/uploads", "POST", { manifest: { ...f.manifest, evidence: [huge] }, evidenceZip: { sha256: "a".repeat(64), size: 10 } }), 413, "too-large");
  const many = Array.from({ length: UPLOAD_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `f/${i}.log`, format: "log", size: 1, sha256: sha256(new Uint8Array([i % 256, i >> 8])), chunks: 1 }));
  await expectStatus(s.call(s.admin, "/api/author/uploads", "POST", { manifest: { ...f.manifest, evidence: many }, evidenceZip: { sha256: "a".repeat(64), size: 10 } }), 413, "too-many-files");
});

test("the leak scan rejects a package with an answer in its public content", async () => {
  const s = setup();
  const f = fixture();
  const q = f.content.questions[1];
  assert.ok(q);
  q["successNote"] = "Right: it was commit DEADBEE all along."; // the made-up q2 answer, in another case
  const pkg = await build(f);
  // The CLI refuses before sending anything ...
  await assert.rejects(uploadCasePackage(pkg, { send: s.admin, sleep: noSleep }), (e: unknown) => e instanceof UploadError && e.details.some((d) => /answer to q2/.test(d)));
  // ... and the server refuses on its own when a client skips that check.
  const upload = await startUpload(s, s.admin, pkg, f);
  const zip = openZip(pkg);
  const send = (name: string, entry: string): Promise<Response> =>
    zip.read(entry).then((body) => s.admin(`/api/author/uploads/${upload.uploadId}/parts/${name}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body }));
  for (const [name, entry] of [["content.en.json", "content.en.json"], ["sealed.answers.json", "sealed/answers.json"], ["sealed.hints.json", "sealed/hints.json"], ["sealed.commands.json", "sealed/commands.json"], ["sealed.scoring.json", "sealed/scoring.json"], ["sealed.debrief.en.md", "sealed/debrief.en.md"]] as const) {
    await expectStatus(send(name, entry), 200);
  }
  const res = await s.call(s.admin, `/api/author/uploads/${upload.uploadId}/finalize`, "POST", {});
  assert.equal(res.status, 422);
  const body = (await res.json()) as { code?: string; details?: string[] };
  assert.equal(body.code, "invalid-package");
  assert.ok(body.details?.some((d) => /content\.en\.json contains the answer to q2/.test(d)), JSON.stringify(body));
  assert.ok(!JSON.stringify(body).toLowerCase().includes("deadbee"), "the error never quotes the answer");
  assert.equal(await s.cases.getMeta(ID), null, "nothing was stored");
});

test("ownership: other authors, players and signed-out callers are refused", async () => {
  const s = setup();
  const dana = await s.account("Dana", "author");
  const eve = await s.account("Eve", "author");
  const paul = await s.account("Paul", "player");
  const pkg = await build(fixture("dana-case"));
  const mine = await uploadCasePackage(pkg, { send: dana.send, sleep: noSleep });
  assert.equal(mine.draft.caseId, "dana-case");
  const listed = AuthorCasesResponseSchema.parse(await (await s.call(dana.send, "/api/author/cases")).json());
  assert.deepEqual(listed.cases.map((c) => [c.id, c.createdBy]), [["dana-case", dana.id]]);
  assert.deepEqual(AuthorCasesResponseSchema.parse(await (await s.call(eve.send, "/api/author/cases")).json()).cases, []);
  assert.equal(AuthorCasesResponseSchema.parse(await (await s.call(s.admin, "/api/author/cases")).json()).cases.length, 1, "the admin sees every case");

  // Another author can neither upload a version of dana-case, nor publish, delete or restore it.
  await assert.rejects(uploadCasePackage(pkg, { send: eve.send, sleep: noSleep }), (e: unknown) => e instanceof UploadError && e.status === 403 && e.code === "not-owner");
  await expectStatus(s.call(eve.send, "/api/author/cases/dana-case/publish", "POST", { version: 1 }), 403, "not-owner");
  await expectStatus(s.call(eve.send, "/api/author/cases/dana-case", "DELETE"), 403, "not-owner");
  await expectStatus(s.call(eve.send, "/api/author/cases/dana-case/restore", "POST", {}), 403, "not-owner");
  // Nor touch Dana's upload.
  const upload = await startUpload(s, dana.send, await build(fixture("dana-case")), fixture("dana-case"));
  await expectStatus(s.call(eve.send, `/api/author/uploads/${upload.uploadId}/finalize`, "POST", {}), 404);
  // An author cannot claim a bundled case id.
  await assert.rejects(uploadCasePackage(await build(fixture("alpha")), { send: eve.send, sleep: noSleep }), (e: unknown) => e instanceof UploadError && e.code === "id-taken");

  // Players and signed-out callers never get in.
  await expectStatus(s.call(paul.send, "/api/author/cases"), 403, "not-author");
  await expectStatus(s.call(paul.send, "/api/author/uploads", "POST", {}), 403, "not-author");
  await expectStatus(s.call(s.as(null), "/api/author/cases"), 401);
  await expectStatus(s.call(s.as(null), "/api/author/cases/dana-case/publish", "POST", { version: 1 }), 401);
  await expectStatus(s.call(s.as({ key: "wrong-admin-key-000000" }), "/api/author/cases"), 401);

  // The owner publishes; the admin may act on any case.
  await expectStatus(s.call(dana.send, "/api/author/cases/dana-case/publish", "POST", { version: 1 }), 200);
  await expectStatus(s.call(s.admin, "/api/author/cases/dana-case/publish", "POST", { version: 1 }), 200);
});

test("answer drift: a changed answer key is refused while players have progress, unless accepted", async () => {
  const s = setup();
  const v1 = await uploadCasePackage(await build(fixture()), { send: s.admin, sleep: noSleep, publish: true });
  assert.equal(v1.published?.publishedVersion, 1);
  const changed = fixture();
  changed.answers = { q1: "08:00:00", q2: "cafef00d", q3: "fixture-role-y", q4: "order-98", q5: "13", q6: "gadget-api" };
  const v2 = await uploadCasePackage(await build(changed), { send: s.admin, sleep: noSleep });
  assert.equal(v2.draft.diff.answerFingerprintChanged, true);
  assert.equal(v2.draft.diff.against, 1);

  // Without progress the guard has nothing to protect.
  const fresh = setup();
  await uploadCasePackage(await build(fixture()), { send: fresh.admin, sleep: noSleep, publish: true });
  await uploadCasePackage(await build(changed), { send: fresh.admin, sleep: noSleep });
  await expectStatus(fresh.call(fresh.admin, `/api/author/cases/${ID}/publish`, "POST", { version: 2 }), 200);

  // With progress (any progress:<case>:* record), it refuses unless acceptAnswerChanges.
  await s.kv.set(`progress:${ID}:acct00000001`, { placeholder: true });
  await expectStatus(s.call(s.admin, `/api/author/cases/${ID}/publish`, "POST", { version: 2 }), 409, "answer-drift");
  const accepted = PublishResponseSchema.parse(await (await s.call(s.admin, `/api/author/cases/${ID}/publish`, "POST", { version: 2, acceptAnswerChanges: true })).json());
  assert.deepEqual([accepted.publishedVersion, accepted.previousVersion, accepted.rollback], [2, 1, false]);
  const audit = AuditResponseSchema.parse(await (await s.call(s.admin, "/api/admin/audit")).json());
  assert.ok(audit.entries.some((e) => e.action === "case.publish" && /answer changes accepted/.test(e.detail ?? "")));

  // Before a case's first DB publish, a bundled case's answer key is the baseline.
  await s.kv.set("progress:alpha:acct00000001", { placeholder: true });
  await uploadCasePackage(await build(fixture("alpha")), { send: s.admin, sleep: noSleep });
  await expectStatus(s.call(s.admin, "/api/author/cases/alpha/publish", "POST", { version: 1 }), 409, "answer-drift");
});

test("rollback: publishing an older version serves it again, and concurrent publishes cannot both win", async () => {
  const s = setup();
  await uploadCasePackage(await build(fixture()), { send: s.admin, sleep: noSleep, publish: true });
  const v2fixture = fixture();
  v2fixture.content["title"] = "Fixture case, take two";
  const v2 = await uploadCasePackage(await build(v2fixture), { send: s.admin, sleep: noSleep });
  assert.deepEqual(v2.draft.diff.contentChanged, ["en:title"]);
  // The draft does not change what players see.
  assert.equal(CaseContentResponseSchema.parse(await (await s.call(s.admin, `/api/cases/${ID}/content`)).json()).content.title, "Fixture case");

  await expectStatus(s.call(s.admin, `/api/author/cases/${ID}/publish`, "POST", { version: 2 }), 200);
  assert.equal(CaseContentResponseSchema.parse(await (await s.call(s.admin, `/api/cases/${ID}/content`)).json()).version, 2);
  const back = PublishResponseSchema.parse(await (await s.call(s.admin, `/api/author/cases/${ID}/publish`, "POST", { version: 1 })).json());
  assert.deepEqual([back.publishedVersion, back.previousVersion, back.rollback], [1, 2, true]);
  const content = CaseContentResponseSchema.parse(await (await s.call(s.admin, `/api/cases/${ID}/content`)).json());
  assert.deepEqual([content.version, content.content.title], [1, "Fixture case"]);
  const listed = AuthorCasesResponseSchema.parse(await (await s.call(s.admin, "/api/author/cases")).json());
  assert.deepEqual(listed.cases[0]?.versions.map((v) => v.state), ["published", "draft"]);
  await expectStatus(s.call(s.admin, `/api/author/cases/${ID}/publish`, "POST", { version: 9 }), 404);
  const audit = AuditResponseSchema.parse(await (await s.call(s.admin, "/api/admin/audit")).json());
  assert.ok(audit.entries.some((e) => e.action === "case.rollback" && /v1 published \(was v2\)/.test(e.detail ?? "")), JSON.stringify(audit.entries));

  // Two publishes racing on the same meta: setIfMatch lets exactly one through.
  const results = await Promise.all([2, 2].map((version) => s.call(s.admin, `/api/author/cases/${ID}/publish`, "POST", { version })));
  const statuses = results.map((r) => r.status).sort();
  assert.ok(statuses.includes(200), String(statuses));
  assert.ok(statuses.every((st) => st === 200 || st === 409), String(statuses));
});

test("soft delete takes a case down and restore brings it back, for the owner and from the admin trash", async () => {
  const s = setup();
  const dana = await s.account("Dana", "author");
  await uploadCasePackage(await build(fixture("dana-case")), { send: dana.send, sleep: noSleep, publish: true });
  const deleted = DeleteCaseResponseSchema.parse(await (await s.call(dana.send, "/api/author/cases/dana-case", "DELETE")).json());
  assert.equal(deleted.caseId, "dana-case");
  assert.equal(CasesResponseSchema.parse(await (await s.call(s.admin, "/api/cases")).json()).cases.length, 0);
  await expectStatus(s.call(s.admin, "/api/cases/dana-case/content"), 404);
  assert.equal((await s.fetchEvidence("dana-case/v1.zip")).status, 404);
  await expectStatus(s.call(dana.send, "/api/author/cases/dana-case", "DELETE"), 409, "trashed");
  await expectStatus(s.call(dana.send, "/api/author/cases/dana-case/publish", "POST", { version: 1 }), 409, "trashed");
  // Deleted cases still list for their owner (so they can be restored), with status trashed.
  const listed = AuthorCasesResponseSchema.parse(await (await s.call(dana.send, "/api/author/cases")).json());
  assert.equal(listed.cases[0]?.status, "trashed");

  const restored = RestoreCaseResponseSchema.parse(await (await s.call(dana.send, "/api/author/cases/dana-case/restore", "POST", {})).json());
  assert.deepEqual(restored, { caseId: "dana-case", status: "published" });
  assert.equal((await s.fetchEvidence("dana-case/v1.zip")).status, 200);
  await expectStatus(s.call(dana.send, "/api/author/cases/dana-case/restore", "POST", {}), 404);

  // The admin restores from Recently deleted, like an account.
  await expectStatus(s.call(dana.send, "/api/author/cases/dana-case", "DELETE"), 200);
  const trash = TrashResponseSchema.parse(await (await s.call(s.admin, "/api/admin/trash")).json());
  const entry = trash.entries.find((e) => e.kind === "case");
  assert.ok(entry);
  assert.equal(entry.label, "case dana-case");
  await expectStatus(s.call(s.admin, `/api/admin/trash/${entry.id}/restore`, "POST", {}), 200);
  assert.equal(CasesResponseSchema.parse(await (await s.call(s.admin, "/api/cases")).json()).cases.length, 1);
  const audit = AuditResponseSchema.parse(await (await s.call(s.admin, "/api/admin/audit")).json());
  assert.ok(["case.delete", "case.restore"].every((a) => audit.entries.some((e) => e.action === a && /author Dana/.test(e.detail ?? ""))));
});

test("unfinished uploads expire after a day and are swept", async () => {
  let clock = new Date("2026-11-26T10:00:00.000Z");
  const s = setup({ now: () => clock });
  const f = fixture();
  const pkg = await build(f);
  const stale = await startUpload(s, s.admin, pkg, f);
  await expectStatus(s.admin(`/api/author/uploads/${stale.uploadId}/parts/sealed.answers.json`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(4) }), 200);
  assert.ok((await s.kv.listKeys("upload:")).length >= 1);
  clock = new Date(clock.getTime() + (UPLOAD_LIMITS.ttlHours + 1) * 60 * 60 * 1000);
  await expectStatus(s.call(s.admin, `/api/author/uploads/${stale.uploadId}/finalize`, "POST", {}), 404);
  const fresh = await startUpload(s, s.admin, pkg, f); // starting an upload sweeps expired ones
  const keys = await s.kv.listKeys("upload:");
  assert.ok(keys.every((k) => k.startsWith(`upload:${fresh.uploadId}`)), keys.join());
  assert.deepEqual(await s.bytes.listKeys(`upload:${stale.uploadId}`), []);
});

test("upload creation is rate limited per uploader", async () => {
  const s = setup();
  const f = fixture();
  const pkg = await build(f);
  for (let i = 0; i < UPLOAD_LIMITS.createsPerHour; i += 1) await startUpload(s, s.admin, pkg, f);
  const zip = openZip(pkg);
  const evidenceZip = await zip.read("evidence.zip");
  await expectStatus(s.call(s.admin, "/api/author/uploads", "POST", { manifest: f.manifest, evidenceZip: { sha256: sha256(evidenceZip), size: evidenceZip.length } }), 429, "rate-limited");
});

test("CLI: scripts/data.ts upload runs against an in-process server and prints the target first", async () => {
  const s = setup();
  const dir = mkdtempSync(join(tmpdir(), "incidentlab-upload-"));
  const file = join(dir, `${ID}-v1.case.zip`);
  writeFileSync(file, await build(bigFixture()));
  const lines: string[] = [];
  const fetchInProcess = (input: string, init: RequestInit): Promise<Response> => s.app.handle(new Request(input, init), "127.0.0.1");
  try {
    const outcome = await uploadCommand({ file, url: DEFAULT_UPLOAD_URL, publish: true, acceptAnswerChanges: false, adminKey: ADMIN_KEY, fetch: fetchInProcess, log: (l) => lines.push(l) });
    assert.equal(outcome.published?.publishedVersion, 1);
    assert.match(lines[0] ?? "", /^uploading fixture-case-v1\.case\.zip to http:\/\/localhost:8888 \(local\), then publishing$/);
    assert.ok(lines.some((l) => /^published v1$/.test(l)), lines.join("\n"));
    assert.equal(CasesResponseSchema.parse(await (await s.call(s.admin, "/api/cases")).json()).cases[0]?.file, ID);
    // A wrong key is refused before anything is stored.
    await assert.rejects(
      uploadCommand({ file, url: DEFAULT_UPLOAD_URL, publish: false, acceptAnswerChanges: false, adminKey: "not-the-admin-key-0000", fetch: fetchInProcess, log: () => undefined }),
      (e: unknown) => e instanceof UploadError && e.status === 401,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(resolveAdminKey(new URL("http://localhost:8888"), {}), LOCAL_ADMIN_KEY);
  assert.equal(resolveAdminKey(new URL("https://example.org"), { ADMIN_KEY: " from-env " }), "from-env");
});
