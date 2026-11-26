// The case package validator (shared/case-package.ts) and leak rules (shared/leak-scan.ts) on a tiny
// fixture package built in the test. The fixture's answers are made up; no real case data is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { EVIDENCE_CHUNK_BYTES } from "../../shared/case-records.ts";
import { packageFileName, validateCasePackage } from "../../shared/case-package.ts";
import { createAnswerScan, createTextScan } from "../../shared/leak-scan.ts";
import { writeZip } from "./zip-writer.ts";
import type { ZipInput } from "./zip-writer.ts";

const ID = "fixture-case";
const QIDS = ["q1", "q2", "q3", "q4", "q5", "q6"] as const;
const ANSWERS: Record<string, string> = {
  q1: "07:15:42", q2: "deadbee", q3: "fixture-role-x", q4: "order-99", q5: "12", q6: "widget-api",
};
const HINT = (qid: string, n: number): string => `Fixture hint ${n} for ${qid}: grep the made-up log for it`;
const COMMAND = "grep -c 'fixture pattern' fixture/app.log | sort -u";

type Json = Record<string, unknown>;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

interface Fixture {
  manifest: Json & { evidence: Json[] };
  content: Json & { questions: Json[] };
  evidence: Map<string, Uint8Array>;
  extra: ZipInput[];
}

function fixture(): Fixture {
  const evidence = new Map<string, Uint8Array>([
    ["README_FIRST.txt", new TextEncoder().encode("Fixture evidence pack. Times are UTC.\n")],
    ["logs/app.log", new TextEncoder().encode("2026-01-01T00:00:00Z INFO fixture line\n".repeat(20))],
    ["pcap/capture.pcap", new Uint8Array(64).map((_, i) => (i * 7) & 0xff)],
  ]);
  const content = {
    id: ID,
    title: "Fixture case",
    subtitle: "A tiny case for tests",
    difficulty: "easy",
    estMinutes: 30,
    tags: ["test"],
    inspiredBy: { title: "Nothing real", year: 2026, summary: "Made up for the test suite." },
    briefing: "Something broke. Find out what.",
    evidenceZip: `/evidence/${ID}-evidence.zip`,
    evidence: [{ path: "logs/app.log", format: "text", description: "The app log." }],
    rules: ["Be kind."],
    questions: QIDS.map((id) => ({
      id,
      title: `Question ${id}`,
      prompt: `What happened in ${id}?`,
      answerFormat: "text",
      placeholder: "answer",
      points: id === "q6" ? 150 : 100,
      hints: [{ cost: 10 }, { cost: 20 }, { cost: 40 }],
      successNote: "Well done.",
    })),
    toolbox: [{ category: "grep", items: [{ id: "count", title: "Count lines", syntax: "grep -c <pattern> <file>", explain: "Counts." }] }],
    debrief: "_Sealed._ Finish all six stages to unlock the debrief.",
  };
  const manifest = {
    schemaVersion: 1,
    id: ID,
    version: 1,
    langs: ["en"],
    evidence: [...evidence].map(([path, bytes]) => ({
      path,
      format: "text",
      size: bytes.length,
      sha256: sha256(bytes),
      chunks: Math.ceil(bytes.length / EVIDENCE_CHUNK_BYTES),
      explorer: !path.endsWith(".pcap"),
    })),
  };
  return { manifest, content, evidence, extra: [] };
}

async function build(f: Fixture): Promise<Uint8Array> {
  const evidenceZip = await writeZip([...f.evidence].map(([path, data]) => ({ name: `${ID}/${path}`, data })));
  const sealedQuestions = Object.fromEntries(QIDS.map((id) => [id, { points: id === "q6" ? 150 : 100, hintCosts: [10, 20, 40], targetSeconds: 300 }]));
  const hints = Object.fromEntries(QIDS.map((id) => [id, [1, 2, 3].map((n) => ({ en: HINT(id, n), he: null }))]));
  return writeZip([
    { name: "manifest.json", data: json(f.manifest) },
    { name: "content.en.json", data: json(f.content) },
    { name: "sealed/answers.json", data: json(ANSWERS) },
    { name: "sealed/hints.json", data: json(hints) },
    { name: "sealed/commands.json", data: json({ count: { command: COMMAND, powershell: null } }) },
    { name: "sealed/scoring.json", data: json({ title: f.content["title"], estMinutes: 30, questions: sealedQuestions }) },
    { name: "sealed/debrief.en.md", data: "# Debrief\n\nThe fixture story.\n" },
    { name: "evidence.zip", data: evidenceZip, method: 0 },
    ...[...f.evidence].map(([path, data]) => ({ name: `evidence/${path}`, data })),
    ...f.extra,
  ]);
}

const validate = async (f: Fixture, fileName = packageFileName(ID, 1)) => validateCasePackage(await build(f), { fileName });
const question = (f: Fixture, i: number): Json => {
  const q = f.content.questions[i];
  assert.ok(q);
  return q;
};
const evidenceItem = (f: Fixture, path: string): Json => {
  const item = f.manifest.evidence.find((e) => e["path"] === path);
  assert.ok(item);
  return item;
};
const hasError = (errors: readonly string[], pattern: RegExp): boolean => errors.some((e) => pattern.test(e));

test("a valid fixture package passes", async () => {
  const report = await validate(fixture());
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
  assert.equal(report.parsed?.manifest.evidence.length, 3);
  assert.equal(report.parsed?.sealed.answers.q3, "fixture-role-x");
  assert.deepEqual(report.parsed?.content.en?.questions[0]?.hints, [{ cost: 10 }, { cost: 20 }, { cost: 40 }]);
});

test("an answer in public content fails, whatever its case and spacing", async () => {
  const f = fixture();
  question(f, 1)["prompt"] = "Was it commit  DEADBEE?";
  const report = await validate(f);
  assert.equal(report.ok, false);
  assert.ok(hasError(report.errors, /content\.en\.json contains the answer to q2$/), report.errors.join("\n"));
  assert.ok(report.errors.every((e) => !e.toLowerCase().includes("deadbee")), "errors must not quote the answer");
});

test("a hint text or command left in public content fails", async () => {
  const f = fixture();
  question(f, 0)["hints"] = [{ cost: 10, text: HINT("q1", 1) }, { cost: 20 }, { cost: 40 }];
  const report = await validate(f);
  assert.equal(report.ok, false);
  assert.ok(hasError(report.errors, /content\.en\.json: questions\.0\.hints\.0/), "strict public schema rejects hint text");
  assert.ok(hasError(report.errors, /contains the hint 1 of q1/));

  const g = fixture();
  g.content["briefing"] = `Try ${COMMAND}`;
  const leak = await validate(g);
  assert.ok(hasError(leak.errors, /contains the command of tool count/), leak.errors.join("\n"));
});

test("an evidence sha256 mismatch fails", async () => {
  const f = fixture();
  const log = f.evidence.get("logs/app.log");
  assert.ok(log);
  const tampered = log.slice();
  tampered[0] = 0x58; // same size, different bytes
  f.evidence.set("logs/app.log", tampered);
  const report = await validate(f);
  assert.equal(report.ok, false);
  assert.ok(hasError(report.errors, /evidence\/logs\/app\.log: sha256 does not match/), report.errors.join("\n"));
});

test("a wrong chunk count fails", async () => {
  const f = fixture();
  evidenceItem(f, "logs/app.log")["chunks"] = 2;
  const report = await validate(f);
  assert.equal(report.ok, false);
  assert.ok(hasError(report.errors, /manifest\.json: evidence\.\d\.chunks/), report.errors.join("\n"));
});

test("a size mismatch, missing or unlisted evidence fails", async () => {
  const f = fixture();
  evidenceItem(f, "README_FIRST.txt")["size"] = 1;
  evidenceItem(f, "README_FIRST.txt")["chunks"] = 1;
  f.extra.push({ name: "evidence/stray.txt", data: "not in the manifest" });
  const report = await validate(f);
  assert.ok(hasError(report.errors, /README_FIRST\.txt: size is \d+, manifest says 1/));
  assert.ok(hasError(report.errors, /evidence\/stray\.txt is not listed/));

  const g = fixture();
  g.evidence.delete("pcap/capture.pcap"); // still listed in the manifest
  const missing = await validate(g);
  assert.ok(hasError(missing.errors, /missing evidence\/pcap\/capture\.pcap/));
  assert.ok(hasError(missing.errors, /evidence\.zip: missing fixture-case\/pcap\/capture\.pcap/));
});

test("layout problems fail: unexpected entry, wrong file name, content language not in manifest", async () => {
  const f = fixture();
  f.extra.push({ name: "notes.txt", data: "stray" }, { name: "content.he.json", data: "{}" });
  const report = await validate(f, "other-case-v1.case.zip");
  assert.ok(hasError(report.errors, /unexpected entry notes\.txt/));
  assert.ok(hasError(report.errors, /file name other-case-v1\.case\.zip does not match/));
  assert.ok(hasError(report.errors, /content\.he\.json: language he is not in manifest langs/));
});

test("a manifest without en, or bytes that are not a zip, fail", async () => {
  const f = fixture();
  f.manifest.langs = ["he"];
  assert.ok(hasError((await validate(f)).errors, /langs must be unique and include en/));
  const notZip = await validateCasePackage(new TextEncoder().encode("definitely not a zip file"));
  assert.equal(notZip.ok, false);
});

test("leak scan: answers match as whole tokens only, short answers are skipped", () => {
  const scan = createAnswerScan('{"prompt": "build 1428 failed at 07:15:42Z; see Order-99."}');
  assert.equal(scan("07:15:42"), true);
  assert.equal(scan("order-99"), true);
  assert.equal(scan("142"), false); // below ANSWER_MIN_LENGTH
  assert.equal(scan("ailed"), false); // a letter continues into a letter
  assert.equal(createAnswerScan("id 91428 ok")("1428"), false); // a digit continues into a digit
  const text = createTextScan('{"a": "line one\\nline \\"two\\""}');
  assert.equal(text('line one\nline "two"'), true);
});
