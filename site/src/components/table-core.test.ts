import { test } from "node:test";
import assert from "node:assert/strict";
import { csvField, nextSort, sortRows, toCsv } from "./table-core.ts";

type Row = { name: string; score: number | null };
const rows: Row[] = [
  { name: "noa", score: 824 },
  { name: "Ada", score: null },
  { name: "amir", score: 551 },
  { name: "dana", score: 824 },
];

test("numeric sort keeps ties stable and sinks missing values in both directions", () => {
  assert.deepEqual(sortRows(rows, (r) => r.score, "desc", "en").map((r) => r.name), ["noa", "dana", "amir", "Ada"]);
  assert.deepEqual(sortRows(rows, (r) => r.score, "asc", "en").map((r) => r.name), ["amir", "noa", "dana", "Ada"]);
});

test("string sort uses the locale collation, case-insensitive and number-aware", () => {
  assert.deepEqual(sortRows(rows, (r) => r.name, "asc", "en").map((r) => r.name), ["Ada", "amir", "dana", "noa"]);
  const cases = [{ id: "case-10" }, { id: "case-2" }];
  assert.deepEqual(sortRows(cases, (r) => r.id, "asc", "en").map((r) => r.id), ["case-2", "case-10"]);
  const hebrew = [{ n: "תמר" }, { n: "אבי" }];
  assert.deepEqual(sortRows(hebrew, (r) => r.n, "asc", "he").map((r) => r.n), ["אבי", "תמר"]);
});

test("nextSort starts a new column at its preferred direction and flips the same column", () => {
  assert.deepEqual(nextSort(null, "score", "desc"), { id: "score", dir: "desc" });
  assert.deepEqual(nextSort({ id: "score", dir: "desc" }, "score", "desc"), { id: "score", dir: "asc" });
  assert.deepEqual(nextSort({ id: "score", dir: "asc" }, "name", "asc"), { id: "name", dir: "asc" });
});

test("CSV quotes, doubles quotes, neutralises formulas but keeps negative numbers", () => {
  assert.equal(csvField('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvField("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvField("@cmd"), "'@cmd");
  assert.equal(csvField("-12"), "-12");
  assert.equal(csvField(-3.5), "-3.5");
  assert.equal(csvField(null), "");
  const csv = toCsv([{ header: "name", value: (r: Row) => r.name }, { header: "score", value: (r: Row) => r.score }], rows.slice(0, 2));
  assert.equal(csv, "name,score\r\nnoa,824\r\nAda,\r\n");
});
