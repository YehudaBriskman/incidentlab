// Evidence chunk garbage collection (#122): what is kept, what is swept, and when it refuses to run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVIDENCE_CHUNK_BYTES } from "../../shared/case-records.ts";
import { InMemoryByteStore } from "../repositories/ByteStore.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { EvidenceGcService, GcAbort } from "../services/EvidenceGcService.ts";

const sha = (c: string): string => c.repeat(64);
// sizes must be real: `chunks` is validated against ceil(size / EVIDENCE_CHUNK_BYTES)
const sizeOf = (chunks: number): number => chunks * EVIDENCE_CHUNK_BYTES;
const entry = (path: string, sha256: string, chunks: number) => ({ path, format: "text", size: sizeOf(chunks), sha256, chunks, explorer: true });
const NOW = new Date("2026-11-26T12:00:00Z");

const upload = (id: string, files: { sha256: string; chunks: number }[], zip: { sha256: string; chunks: number }, opts: { expiresAt: string; finalized?: boolean }) => ({
  schemaVersion: 1,
  id,
  caseId: "gamma",
  owner: "admin",
  createdAt: "2026-11-26T11:00:00Z",
  expiresAt: opts.expiresAt,
  manifest: { schemaVersion: 1, id: "gamma", version: 1, langs: ["en"], evidence: files.map((f, i) => entry(`f${i}.log`, f.sha256, f.chunks)) },
  evidenceZip: { sha256: zip.sha256, size: sizeOf(zip.chunks), chunks: zip.chunks },
  finalized: opts.finalized ? { version: 1, diff: { previousVersion: null, contentKeysChanged: 0, evidence: { added: [], removed: [], changed: [] }, answerKeyChanged: false } } : null,
});

const setup = async () => {
  const kv = new InMemoryKvStore();
  const bytes = new InMemoryByteStore();
  const chunk = (s: string, n: number) => bytes.setBytes(`evidence:${s}:${n}`, new Uint8Array([1]));
  // alpha v1: file a (2 chunks) and zip z (1 chunk); alpha v2 (a trashed-or-old version still counts): file b
  await kv.set("case:alpha:v1:evidence-index", [entry("a.log", sha("a"), 2)]);
  await kv.set("case:alpha:v1:evidence-zip", entry("alpha.zip", sha("1"), 1));
  await kv.set("case:alpha:v2:evidence-index", [entry("b.log", sha("b"), 1)]);
  await kv.set("case:alpha:v2:evidence-zip", entry("alpha.zip", sha("2"), 1));
  for (const [s, n] of [["a", 2], ["1", 1], ["b", 1], ["2", 1]] as const) for (let i = 0; i < n; i++) await chunk(sha(s), i);
  await chunk(sha("a"), 2); // past the file's end
  await chunk(sha("d"), 0); // nobody's
  await chunk(sha("d"), 1);
  // a live upload (its chunks are arriving) and an expired one
  await kv.set("upload:aaaaaaaaaaaaaaaaaaaaaaaa", upload("aaaaaaaaaaaaaaaaaaaaaaaa", [{ sha256: sha("c"), chunks: 1 }], { sha256: sha("3"), chunks: 1 }, { expiresAt: "2026-11-27T12:00:00Z" }));
  await chunk(sha("c"), 0);
  await kv.set("upload:bbbbbbbbbbbbbbbbbbbbbbbb", upload("bbbbbbbbbbbbbbbbbbbbbbbb", [{ sha256: sha("e"), chunks: 1 }], { sha256: sha("4"), chunks: 1 }, { expiresAt: "2026-11-25T12:00:00Z" }));
  await chunk(sha("e"), 0);
  return { kv, bytes, gc: new EvidenceGcService({ kv, bytes, now: () => NOW }) };
};

test("plan keeps every version's and every live upload's chunks, and lists the rest", async () => {
  const { gc } = await setup();
  const plan = await gc.plan();
  assert.equal(plan.liveUploads, 1);
  assert.deepEqual(
    [...plan.candidates].map((c) => `${c.key.slice(9, 10)}:${c.key.split(":")[2]} ${c.reason}`).sort(),
    ["a:2 past-end", "d:0 unreferenced", "d:1 unreferenced", "e:0 unreferenced"],
  );
});

test("sweep refuses while an upload is live, then deletes exactly the plan once it is done", async () => {
  const { kv, bytes, gc } = await setup();
  await assert.rejects(gc.sweep(), GcAbort);
  assert.equal((await bytes.listKeys("evidence:")).length, 10, "nothing deleted while refusing");
  await kv.delete("upload:aaaaaaaaaaaaaaaaaaaaaaaa");
  const deleted = await gc.sweep();
  assert.equal(deleted.length, 5, "the four candidates plus the finished upload's chunk c");
  const left = await bytes.listKeys("evidence:");
  for (const s of ["a", "1", "b", "2"]) assert.ok(left.includes(`evidence:${sha(s)}:0`), `kept ${s}`);
  assert.ok(left.includes(`evidence:${sha("a")}:1`));
  assert.equal(left.length, 5, "a:0, a:1, 1, b and 2 remain");
});

test("an unreadable index aborts instead of sweeping its chunks", async () => {
  const { kv, gc } = await setup();
  await kv.set("case:alpha:v1:evidence-index", { not: "an index" });
  await assert.rejects(gc.plan(), (err: unknown) => err instanceof GcAbort && /case:alpha:v1:evidence-index/.test(err.message));
});

test("chunks with no references at all abort (an empty listing must not look like garbage)", async () => {
  const kv = new InMemoryKvStore();
  const bytes = new InMemoryByteStore();
  await bytes.setBytes(`evidence:${sha("a")}:0`, new Uint8Array([1]));
  await assert.rejects(new EvidenceGcService({ kv, bytes, now: () => NOW }).plan(), GcAbort);
});
