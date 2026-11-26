// The case package validator (shared/case-package.ts) and leak rules (shared/leak-scan.ts) on a tiny
// fixture package built in the test. The fixture's answers are made up; no real case data is used.
import assert from "node:assert/strict";
import { test } from "node:test";
import { packageFileName, validateCasePackage } from "../../shared/case-package.ts";
import { createAnswerScan, createTextScan } from "../../shared/leak-scan.ts";
import { COMMAND, HINT, ID, build, fixture } from "./package-fixture.ts";
import type { Fixture, Json } from "./package-fixture.ts";

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
