// The shared case schemas (shared/case.ts, shared/case-records.ts) against the real case files.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CaseSchema } from "../../shared/case.ts";
import {
  CaseContentSchema,
  CaseMetaSchema,
  CasePackageManifestSchema,
  CaseSealedSchema,
  EVIDENCE_CHUNK_BYTES,
  EvidenceEntrySchema,
  evidenceChunkCount,
  stripPaidContent,
} from "../../shared/case-records.ts";
import { SecretsSchema } from "../domain/types.ts";

const CASES_DIR = fileURLToPath(new URL("../../src/content/cases/", import.meta.url));
const SECRETS_FILE = fileURLToPath(new URL("../generated/secrets.json", import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const caseFiles = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort();
const realCaseFiles = caseFiles.filter((f) => !f.startsWith("_"));

test("there are five real cases, each in English and Hebrew", () => {
  assert.equal(realCaseFiles.filter((f) => !f.endsWith(".he.json")).length, 5);
  assert.equal(realCaseFiles.filter((f) => f.endsWith(".he.json")).length, 5);
});

for (const file of caseFiles) {
  test(`${file} parses with CaseSchema, and its public form with CaseContentSchema`, () => {
    const raw = readJson(`${CASES_DIR}${file}`);
    const authored = CaseSchema.safeParse(raw);
    assert.ok(authored.success, JSON.stringify(authored.error?.issues));

    const content = CaseContentSchema.safeParse(stripPaidContent(raw));
    assert.ok(content.success, JSON.stringify(content.error?.issues));
    for (const q of content.data.questions) for (const hint of q.hints) assert.deepEqual(Object.keys(hint), ["cost"]);
    for (const section of content.data.toolbox) {
      for (const item of section.items) {
        assert.ok(!("command" in item) && !("powershell" in item), `${file}: paid command left in ${item.title}`);
      }
    }
  });
}

test("CaseContentSchema rejects authored content that still has paid fields", () => {
  const raw = readJson(`${CASES_DIR}${realCaseFiles[0]}`);
  const authored = CaseSchema.parse(raw);
  const hasPaid = authored.questions.some((q) => q.hints.some((h) => h.text !== undefined))
    || authored.toolbox.some((s) => s.items.some((i) => i.command !== undefined));
  assert.ok(hasPaid, "fixture should carry paid fields");
  assert.equal(CaseContentSchema.safeParse(raw).success, false);
});

test("stripPaidContent keeps every free field", () => {
  const raw = readJson(`${CASES_DIR}${realCaseFiles[0]}`);
  const authored = CaseSchema.parse(raw);
  const content = CaseContentSchema.parse(stripPaidContent(raw));
  assert.deepEqual(content.questions.map((q) => q.hints.map((h) => h.cost)), authored.questions.map((q) => q.hints.map((h) => h.cost)));
  assert.deepEqual(
    content.toolbox.flatMap((s) => s.items.map((i) => [i.id, i.title, i.syntax, i.syntaxPowershell, i.explain])),
    authored.toolbox.flatMap((s) => s.items.map((i) => [i.id, i.title, i.syntax, i.syntaxPowershell, i.explain])),
  );
  assert.equal(content.briefing, authored.briefing);
});

test("generated secrets.json cases parse with CaseSealedSchema", { skip: !existsSync(SECRETS_FILE) && "run scripts/build-all.sh first" }, () => {
  const secrets = readJson(SECRETS_FILE);
  assert.ok(SecretsSchema.safeParse(secrets).success);
  const cases = (secrets as { cases: Record<string, unknown> }).cases;
  const ids = Object.keys(cases).sort();
  assert.deepEqual(ids, realCaseFiles.filter((f) => !f.endsWith(".he.json")).map((f) => f.slice(0, -".json".length)));
  for (const id of ids) {
    const parsed = CaseSealedSchema.safeParse(cases[id]);
    assert.ok(parsed.success, `${id}: ${JSON.stringify(parsed.error?.issues)}`);
  }
});

const SHA = "0".repeat(63) + "1";
const sampleManifest = {
  schemaVersion: 1,
  id: "sample-case",
  version: 2,
  langs: ["en", "he"],
  evidence: [
    { path: "README_FIRST.txt", format: "text", size: 1200, sha256: SHA, chunks: 1, explorer: true },
    { path: "nginx/access.log", format: "nginx log (UTC)", size: 40 * 1024 * 1024, sha256: SHA, chunks: 10, explorer: true },
    { path: "capture.pcap", format: "pcap", size: EVIDENCE_CHUNK_BYTES, sha256: SHA, chunks: 1, explorer: false },
    { path: "empty.log", format: "log", size: 0, sha256: SHA, chunks: 0, explorer: true },
  ],
};

test("a package manifest round-trips through JSON", () => {
  const parsed = CasePackageManifestSchema.parse(sampleManifest);
  assert.deepEqual(parsed, sampleManifest);
  assert.deepEqual(CasePackageManifestSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
});

test("package manifest validation", () => {
  const withEvidence = (entry: Record<string, unknown>) => ({ ...sampleManifest, evidence: [{ ...sampleManifest.evidence[0], ...entry }] });
  for (const path of ["/etc/passwd", "../x", "a/../b", "a//b", "a\\b", "./a", ""]) {
    assert.equal(CasePackageManifestSchema.safeParse(withEvidence({ path })).success, false, `path ${JSON.stringify(path)}`);
  }
  assert.equal(CasePackageManifestSchema.safeParse(withEvidence({ chunks: 2 })).success, false, "wrong chunk count");
  assert.equal(CasePackageManifestSchema.safeParse(withEvidence({ sha256: "ABC" })).success, false, "bad sha");
  assert.equal(CasePackageManifestSchema.safeParse({ ...sampleManifest, schemaVersion: 2 }).success, false);
  assert.equal(CasePackageManifestSchema.safeParse({ ...sampleManifest, id: "Not Kebab" }).success, false);
  assert.equal(CasePackageManifestSchema.safeParse({ ...sampleManifest, langs: ["he"] }).success, false, "en required");
  assert.equal(CasePackageManifestSchema.safeParse({ ...sampleManifest, langs: ["en", "en"] }).success, false);
  const dup = { ...sampleManifest, evidence: [sampleManifest.evidence[0], sampleManifest.evidence[0]] };
  assert.equal(CasePackageManifestSchema.safeParse(dup).success, false, "duplicate paths");
});

test("evidence entries default explorer to false and count chunks by EVIDENCE_CHUNK_BYTES", () => {
  assert.equal(EVIDENCE_CHUNK_BYTES, 4 * 1024 * 1024);
  assert.deepEqual([0, 1, EVIDENCE_CHUNK_BYTES, EVIDENCE_CHUNK_BYTES + 1].map(evidenceChunkCount), [0, 1, 1, 2]);
  const entry = EvidenceEntrySchema.parse({ path: "a.log", format: "log", size: 10, sha256: SHA, chunks: 1 });
  assert.equal(entry.explorer, false);
});

test("case meta applies additive defaults and checks its fields", () => {
  const meta = {
    id: "sample-case",
    version: 1,
    status: "draft",
    langs: ["en"],
    title: "Sample",
    difficulty: "medium",
    answerFingerprint: "fp-1",
    contentSha: SHA,
    createdBy: "author-1",
    createdAt: "2026-11-26T00:00:00.000Z",
  };
  const parsed = CaseMetaSchema.parse(meta);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.tags, []);
  assert.equal(CaseMetaSchema.safeParse({ ...meta, status: "archived" }).success, false);
  assert.equal(CaseMetaSchema.safeParse({ ...meta, version: 0 }).success, false);
  assert.equal(CaseMetaSchema.safeParse({ ...meta, langs: ["fr"] }).success, false);
});
