// DB-stored cases (#64): repository, content API, evidence streaming and route wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CasesResponseSchema } from "../../shared/contract.ts";
import { CaseContentResponseSchema, CaseContentSchema, EVIDENCE_CHUNK_BYTES, composeCaseMeta } from "../../shared/case-records.ts";
import { InMemoryByteStore } from "../repositories/ByteStore.ts";
import { CaseRepository, EvidenceChunkRepository, caseKeys, sha256Hex } from "../repositories/case-repository.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { isSnapshotKey } from "../services/BackupService.ts";
import { CaseService } from "../services/CaseService.ts";
import { EvidenceService, parseEvidencePath, parseRange } from "../services/evidenceStream.ts";
import { createApp } from "../router.ts";
import { contentFixture, metaFixture, patternBytes, seedCase } from "./case-fixtures.ts";
import { ADMIN_KEY, SECRETS } from "./helpers.ts";

const BIG = 9 * 1024 * 1024 + 4321; // three chunks, the last one partial

const setup = () => {
  const kv = new InMemoryKvStore();
  const bytes = new InMemoryByteStore();
  const cases = new CaseRepository(kv);
  const chunks = new EvidenceChunkRepository(bytes);
  const evidence = new EvidenceService({ cases, chunks });
  const service = new CaseService({ cases, evidence });
  const app = createApp({ store: kv, bytes, secrets: SECRETS, adminKey: () => ADMIN_KEY });
  const get = (path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> =>
    app.handle(new Request(`http://localhost/api${path}`, { method, headers }), "10.0.0.1");
  const fetchEvidence = (path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> =>
    evidence.respond(new Request(`http://localhost/evidence/db/${path}`, { method, headers }));
  return { kv, bytes, cases, chunks, evidence, service, get, fetchEvidence, repos: { cases, chunks } };
};

const bodyBytes = async (res: Response): Promise<Uint8Array> => new Uint8Array(await res.arrayBuffer());

// ---- repository -----------------------------------------------------------------------------------------

test("repository round-trips every record and writes meta conditionally", async () => {
  const { cases } = setup();
  assert.equal(await cases.getMeta("alpha"), null);
  assert.equal(await cases.saveMeta(metaFixture("alpha"), null), true);
  assert.equal(await cases.saveMeta(metaFixture("alpha"), null), false, "only-if-new fails when it exists");
  const stored = await cases.getMeta("alpha");
  assert.ok(stored);
  assert.deepEqual(stored.data, metaFixture("alpha"));
  assert.equal(await cases.saveMeta(metaFixture("alpha", { version: 2 }), "stale-etag"), false);
  assert.equal(await cases.saveMeta(metaFixture("alpha", { version: 2 }), stored.etag), true);
  assert.equal((await cases.getMeta("alpha"))?.data.version, 2);

  await cases.putContent("alpha", 2, "he", contentFixture("alpha", "he"));
  assert.deepEqual(await cases.getContent("alpha", 2, "he"), contentFixture("alpha", "he"));
  assert.equal(await cases.getContent("alpha", 1, "he"), null);
  const entry = { path: "a/b.log", format: "log", size: 3, sha256: "b".repeat(64), chunks: 1, explorer: true };
  await cases.putEvidenceIndex("alpha", 2, [entry]);
  assert.deepEqual(await cases.getEvidenceIndex("alpha", 2), [entry]);
  await cases.putEvidenceZip("alpha", 2, { ...entry, path: "alpha-evidence.zip" });
  assert.equal((await cases.getEvidenceZip("alpha", 2))?.path, "alpha-evidence.zip");
  assert.deepEqual((await cases.listMetas()).map((m) => m.id), ["alpha"]);
});

test("writes reject invalid records, including content that leaks a paid field", async () => {
  const { cases } = setup();
  const leaky = contentFixture("alpha");
  const withHintText = { ...leaky, questions: leaky.questions.map((q) => ({ ...q, hints: [{ cost: 1, text: "the answer" }] })) };
  assert.equal(CaseContentSchema.safeParse(withHintText).success, false, "a hint text never validates as public content");
  await assert.rejects(cases.saveMeta({ ...metaFixture("alpha"), contentSha: "nope" }, null));
  await assert.rejects(cases.putEvidenceIndex("alpha", 1, [{ path: "../x", format: "log", size: 1, sha256: "c".repeat(64), chunks: 1, explorer: false }]));
  assert.equal(await cases.getMeta("alpha"), null);
});

test("corrupt records are logged and skipped, never thrown", async () => {
  const s = setup();
  await seedCase(s.repos, { id: "good-case" });
  await seedCase(s.repos, { id: "bad-content" });
  await s.kv.set(caseKeys.meta("bad-meta"), { id: "bad-meta", version: "one" });
  await s.kv.set(caseKeys.content("bad-content", 1, "en"), { title: 42 });
  await s.kv.set(caseKeys.evidenceIndex("good-case", 1), [{ path: "../etc/passwd" }]);

  assert.deepEqual((await s.cases.listMetas()).map((m) => m.id), ["bad-content", "good-case"]);
  const catalog = CasesResponseSchema.parse(await (await s.get("/cases")).json());
  assert.deepEqual(catalog.cases.map((c) => c.file), ["good-case"]);
  assert.equal((await s.get("/cases/bad-content/content")).status, 404);
  assert.equal((await s.get("/cases/bad-meta/content")).status, 404);
  assert.equal((await s.fetchEvidence("good-case/v1/files/logs/app.log")).status, 404);
});

test("content-addressed chunks: identical files are stored once across cases", async () => {
  const s = setup();
  const file = patternBytes(BIG);
  await seedCase(s.repos, { id: "case-one", files: [{ path: "big.log", bytes: file }] });
  await seedCase(s.repos, { id: "case-two", files: [{ path: "other/name.log", bytes: file }] });
  const keys = await s.bytes.listKeys("evidence:");
  assert.equal(keys.length, 3);
  assert.deepEqual(keys, [0, 1, 2].map((n) => caseKeys.chunk(keys[0]?.split(":")[1] ?? "", n)));
});

test("JSON snapshots skip the binary evidence: prefix", () => {
  assert.equal(isSnapshotKey("evidence:abc:0"), false);
  assert.equal(isSnapshotKey("case:alpha:meta"), true);
  assert.equal(isSnapshotKey("account:1"), true);
});

// ---- content API ----------------------------------------------------------------------------------------

test("an empty case store serves an empty catalog", async () => {
  const s = setup();
  const res = await s.get("/cases");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cases: [] });
  assert.equal((await s.get("/cases/3am-outage/content")).status, 404);
});

test("drafts, trashed cases and other versions are hidden from public routes", async () => {
  const s = setup();
  await seedCase(s.repos, { id: "draft-case", status: "draft", files: [{ path: "a.log", bytes: patternBytes(10) }], zip: patternBytes(5) });
  await seedCase(s.repos, { id: "gone-case", status: "trashed" });
  await seedCase(s.repos, { id: "live-case", version: 2, files: [{ path: "a.log", bytes: patternBytes(10) }] });

  const catalog = CasesResponseSchema.parse(await (await s.get("/cases")).json());
  assert.deepEqual(catalog.cases.map((c) => c.file), ["live-case"]);
  assert.equal((await s.get("/cases/draft-case/content")).status, 404);
  assert.equal((await s.get("/cases/gone-case/content")).status, 404);
  assert.equal((await s.fetchEvidence("draft-case/v1/files/a.log")).status, 404);
  assert.equal((await s.fetchEvidence("draft-case/v1.zip")).status, 404);
  assert.equal((await s.fetchEvidence("live-case/v1/files/a.log")).status, 404, "only the published version");
  assert.equal((await s.fetchEvidence("live-case/v2/files/a.log")).status, 200);
  assert.equal(await s.service.getSealed("draft-case"), null);
  assert.equal((await s.service.getSealed("live-case"))?.answers.q1, "q1-answer");
  await assert.rejects(s.service.evidenceIndex("draft-case", 1), { status: 404 });
  assert.equal((await s.service.evidenceIndex("live-case", 2)).length, 1);
});

test("a newer draft on top of a published version: public routes keep serving publishedVersion", async () => {
  const s = setup();
  await seedCase(s.repos, { id: "live-case", version: 1, files: [{ path: "a.log", bytes: patternBytes(10) }] });
  const v1 = await s.cases.getMeta("live-case");
  assert.ok(v1);
  // v2 is stored as a draft: its records exist, the meta still points the public at v1.
  await s.cases.putContent("live-case", 2, "en", { ...contentFixture("live-case"), title: "Draft title" });
  const stored = await s.chunks.putFile(patternBytes(20, 3));
  await s.cases.putEvidenceIndex("live-case", 2, [{ path: "b.log", format: "log", size: stored.size, sha256: stored.sha256, chunks: stored.chunks, explorer: true }]);
  const draft = composeCaseMeta({
    id: "live-case", createdBy: "admin", createdAt: v1.data.createdAt, updatedAt: v1.data.createdAt, publishedVersion: 1, status: "published",
    versions: [...v1.data.versions, { ...v1.data.versions[0]!, version: 2, title: "Draft title", answerFingerprint: "fp-2" }],
  });
  assert.equal(await s.cases.saveMeta(draft, v1.etag), true);

  const content = CaseContentResponseSchema.parse(await (await s.get("/cases/live-case/content")).json());
  assert.equal(content.version, 1);
  assert.equal(content.content.title, "Case live-case");
  const catalog = CasesResponseSchema.parse(await (await s.get("/cases")).json());
  assert.equal(catalog.cases[0]?.en.title, "Case live-case");
  assert.equal((await s.fetchEvidence("live-case/v1/files/a.log")).status, 200);
  assert.equal((await s.fetchEvidence("live-case/v2/files/b.log")).status, 404, "a draft is never public");
  await assert.rejects(s.service.evidenceIndex("live-case", 2), { status: 404 });
});

test("content: Hebrew is served when present and falls back to English", async () => {
  const s = setup();
  await seedCase(s.repos, { id: "bilingual", langs: ["en", "he"] });
  await seedCase(s.repos, { id: "english-only" });

  const he = CaseContentResponseSchema.parse(await (await s.get("/cases/bilingual/content?lang=he")).json());
  assert.equal(he.lang, "he");
  assert.equal(he.content.title, "תיק bilingual");
  const fallback = CaseContentResponseSchema.parse(await (await s.get("/cases/english-only/content?lang=he")).json());
  assert.equal(fallback.lang, "en");
  assert.equal(fallback.content.title, "Case english-only");
  const byDefault = CaseContentResponseSchema.parse(await (await s.get("/cases/bilingual/content")).json());
  assert.equal(byDefault.lang, "en");
  assert.equal(byDefault.version, 1);
  assert.equal((await s.get("/cases/bilingual/content?lang=fr")).status, 400);

  const catalog = CasesResponseSchema.parse(await (await s.get("/cases")).json());
  assert.equal(catalog.cases.find((c) => c.file === "bilingual")?.he?.title, "תיק bilingual");
  assert.equal(catalog.cases.find((c) => c.file === "english-only")?.he, undefined);
});

test("content and catalog: public cache headers, ETag and 304", async () => {
  const s = setup();
  await seedCase(s.repos, { id: "cached", langs: ["en", "he"] });

  const first = await s.get("/cases/cached/content?lang=he");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "public, max-age=60, stale-while-revalidate=600");
  const etag = first.headers.get("etag");
  assert.equal(etag, `"${"a".repeat(64)}-v1-he"`);
  const again = await s.get("/cases/cached/content?lang=he", { "if-none-match": `W/${etag ?? ""}` });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  assert.equal((await s.get("/cases/cached/content?lang=en", { "if-none-match": etag ?? "" })).status, 200, "other language, other tag");

  const catalog = await s.get("/cases");
  const catalogTag = catalog.headers.get("etag") ?? "";
  assert.match(catalogTag, /^"[0-9a-f]{32}"$/);
  assert.equal(catalog.headers.get("cache-control"), "public, max-age=60, stale-while-revalidate=600");
  assert.equal((await s.get("/cases", { "if-none-match": catalogTag })).status, 304);
  await seedCase(s.repos, { id: "newer" });
  assert.equal((await s.get("/cases", { "if-none-match": catalogTag })).status, 200, "a new case changes the tag");

  // 404s and per-player routes stay uncached
  assert.equal((await s.get("/cases/missing/content")).headers.get("cache-control"), "no-store");
  assert.equal((await s.get("/cases/cached/progress")).headers.get("cache-control"), "no-store");
});

test("routes: the content routes do not shadow the existing per-player case routes", async () => {
  const s = setup();
  await seedCase(s.repos, { id: "alpha" });
  // existing routes still answer, and still need a session
  for (const [path, method] of [["/cases/alpha/progress", "GET"], ["/cases/alpha/debrief", "GET"], ["/cases/alpha/answer", "POST"], ["/cases/alpha/hint", "POST"], ["/cases/alpha/setup-done", "POST"], ["/cases/alpha/reveal", "POST"], ["/cases/alpha/reveal-command", "POST"]] as const) {
    const res = await s.get(path, {}, method);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  // the new ones need none, and only take GET
  assert.equal((await s.get("/cases/alpha/content")).status, 200);
  assert.equal((await s.get("/cases")).status, 200);
  assert.equal((await s.get("/cases/")).status, 200);
  assert.equal((await s.get("/cases", {}, "POST")).status, 405);
  assert.equal((await s.get("/cases/alpha/content", {}, "POST")).status, 405);
  assert.equal((await s.get("/cases/alpha")).status, 404);
  assert.equal((await s.get("/cases/alpha/content/extra")).status, 404);
  assert.equal((await s.get("/cases/Bad_Id/content")).status, 404);
});

// ---- evidence -------------------------------------------------------------------------------------------

test("evidence: a 9 MiB file streams back whole, chunk by chunk, matching its sha256", async () => {
  const s = setup();
  const file = patternBytes(BIG, 42);
  const { index } = await seedCase(s.repos, { id: "big-case", files: [{ path: "nginx/access.log", bytes: file }] });
  assert.equal(index[0]?.chunks, 3);

  const res = await s.fetchEvidence("big-case/v1/files/nginx/access.log");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(BIG));
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const sha = await sha256Hex(file);
  assert.equal(res.headers.get("etag"), `"${sha}"`);
  const body = await bodyBytes(res);
  assert.equal(body.byteLength, BIG);
  assert.equal(await sha256Hex(body), sha);

  // the service API streams the same bytes
  const read = await s.service.readEvidence("big-case", 1, "nginx/access.log");
  assert.equal(await sha256Hex(await bodyBytes(new Response(read.stream))), sha);

  assert.equal((await s.fetchEvidence("big-case/v1/files/nginx/access.log", { "if-none-match": `"${sha}"` })).status, 304);
  const head = await s.fetchEvidence("big-case/v1/files/nginx/access.log", {}, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(BIG));
  assert.equal((await bodyBytes(head)).byteLength, 0);
  assert.equal((await s.fetchEvidence("big-case/v1/files/nginx/access.log", {}, "POST")).status, 405);
});

test("evidence: Range requests across chunk boundaries return the exact bytes", async () => {
  const s = setup();
  const file = patternBytes(BIG, 7);
  await seedCase(s.repos, { id: "range-case", files: [{ path: "big.log", bytes: file }] });
  const C = EVIDENCE_CHUNK_BYTES;
  const cases: Array<[string, number, number]> = [
    [`bytes=${C - 10}-${C + 9}`, C - 10, C + 9],            // straddles chunk 0 / 1
    [`bytes=${C - 1}-${2 * C}`, C - 1, 2 * C],              // spans all three chunks
    [`bytes=${2 * C + 5}-`, 2 * C + 5, BIG - 1],            // open-ended, inside the last chunk
    ["bytes=-100", BIG - 100, BIG - 1],                    // suffix
    [`bytes=0-${BIG + 999}`, 0, BIG - 1],                  // end clamped to the size
  ];
  for (const [header, start, end] of cases) {
    const res = await s.fetchEvidence("range-case/v1/files/big.log", { range: header });
    assert.equal(res.status, 206, header);
    assert.equal(res.headers.get("content-range"), `bytes ${start}-${end}/${BIG}`, header);
    assert.equal(res.headers.get("content-length"), String(end - start + 1), header);
    assert.deepEqual(await bodyBytes(res), file.subarray(start, end + 1), header);
  }
  const unsatisfiable = await s.fetchEvidence("range-case/v1/files/big.log", { range: `bytes=${BIG}-` });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${BIG}`);
  assert.equal((await s.fetchEvidence("range-case/v1/files/big.log", { range: "bytes=0-1,5-6" })).status, 200, "multi-range: whole file");
  assert.equal((await s.fetchEvidence("range-case/v1/files/big.log", { range: "bytes=0-9", "if-range": '"stale"' })).status, 200, "If-Range mismatch: whole file");

  const viaService = await s.service.readEvidence("range-case", 1, "big.log", { start: C - 3, end: C + 2 });
  assert.deepEqual(await bodyBytes(new Response(viaService.stream)), file.subarray(C - 3, C + 3));
  await assert.rejects(s.service.readEvidence("range-case", 1, "big.log", { start: 0, end: BIG }), { status: 416 });
});

test("evidence: the zip route, unknown files and a missing chunk", async () => {
  const s = setup();
  const zip = patternBytes(2000, 3);
  await seedCase(s.repos, { id: "zip-case", zip, files: [{ path: "small.pcap", bytes: patternBytes(64) }, { path: "empty.log", bytes: new Uint8Array(0) }] });

  const res = await s.fetchEvidence("zip-case/v1.zip");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="zip-case-v1-evidence.zip"');
  assert.deepEqual(await bodyBytes(res), zip);
  assert.equal((await s.fetchEvidence("zip-case/v1/files/small.pcap")).headers.get("content-type"), "application/vnd.tcpdump.pcap");
  const empty = await s.fetchEvidence("zip-case/v1/files/empty.log");
  assert.equal(empty.status, 200);
  assert.equal((await bodyBytes(empty)).byteLength, 0);
  assert.equal((await s.fetchEvidence("zip-case/v1/files/nope.log")).status, 404);
  assert.equal((await s.fetchEvidence("zip-case/v2.zip")).status, 404);
  assert.equal((await s.fetchEvidence("nobody/v1.zip")).headers.get("cache-control"), "no-store");

  // a lost chunk truncates the stream with an error instead of serving wrong bytes
  const big = patternBytes(BIG, 9);
  const { index } = await seedCase(s.repos, { id: "broken-case", files: [{ path: "big.log", bytes: big }] });
  await s.bytes.deleteBytes(caseKeys.chunk(index[0]?.sha256 ?? "", 1));
  const broken = await s.fetchEvidence("broken-case/v1/files/big.log");
  assert.equal(broken.status, 200);
  await assert.rejects(broken.arrayBuffer());
});

test("evidence paths: only the two URL shapes parse, without traversal", () => {
  assert.deepEqual(parseEvidencePath("/evidence/db/alpha/v3/files/logs/app.log"), { kind: "file", caseId: "alpha", version: 3, path: "logs/app.log" });
  assert.deepEqual(parseEvidencePath("/evidence/db/alpha/v3.zip"), { kind: "zip", caseId: "alpha", version: 3 });
  assert.deepEqual(parseEvidencePath("/evidence/db/alpha/v1/files/a%20b.log"), { kind: "file", caseId: "alpha", version: 1, path: "a b.log" });
  for (const bad of [
    "/evidence/db/alpha/v1/files/../secret", "/evidence/db/alpha/v1/files/a/%2e%2e/b", "/evidence/db/alpha/v1/files/",
    "/evidence/db/alpha/v0.zip", "/evidence/db/alpha/1.zip", "/evidence/db/Alpha/v1.zip", "/evidence/db/alpha/v1/raw/a.log",
    "/evidence/alpha/v1.zip", "/evidence/db/alpha/v1/files/%E0%A4%A", "/evidence/db/alpha/v1/files//a.log",
  ]) assert.equal(parseEvidencePath(bad), null, bad);
});

test("parseRange follows RFC 9110 for single ranges", () => {
  assert.equal(parseRange(null, 10), null);
  assert.deepEqual(parseRange("bytes=2-4", 10), { start: 2, end: 4 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=-30", 10), { start: 0, end: 9 });
  assert.equal(parseRange("bytes=10-", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
  assert.equal(parseRange("bytes=5-2", 10), null);
  assert.equal(parseRange("items=0-1", 10), null);
  assert.equal(parseRange("bytes=-", 10), null);
});

test("the Edge Function import map pins the same npm versions as site/package.json", async () => {
  const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
  const { dependencies } = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(await readJson("../../package.json"));
  const { imports } = z.object({ imports: z.record(z.string(), z.string()) }).parse(await readJson("../../netlify/edge-functions/import_map.json"));
  assert.ok(Object.keys(imports).length > 0);
  for (const [name, target] of Object.entries(imports)) assert.equal(target, `npm:${name}@${dependencies[name] ?? "missing"}`, name);
});
