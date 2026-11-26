import { test } from "node:test";
import assert from "node:assert/strict";
import {
  csvField,
  nextSort,
  parseColumnChoice,
  pruneSelection,
  selectionState,
  sortRows,
  sortRowsWith,
  syncKeyed,
  toCsv,
  virtualWindow,
  visibleColumnIds,
  type KeyedContainer,
  type KeyedEntry,
} from "./table-core.ts";

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

test("sortRowsWith flips only the comparator: ties keep the input order both ways", () => {
  const byScore = (a: Row, b: Row): number => (a.score ?? -1) - (b.score ?? -1);
  assert.deepEqual(sortRowsWith(rows, byScore, "desc").map((r) => r.name), ["noa", "dana", "amir", "Ada"]);
  assert.deepEqual(sortRowsWith(rows, byScore, "asc").map((r) => r.name), ["Ada", "amir", "noa", "dana"]);
});

test("column picker: fixed columns always show, hideable ones follow the choice or the defaults", () => {
  const cols = [{ id: "name" }, { id: "score", hideable: true }, { id: "hints", hideable: true, defaultHidden: true }, { id: "menu" }];
  assert.deepEqual(visibleColumnIds(cols, null), ["name", "score", "menu"]);
  assert.deepEqual(visibleColumnIds(cols, new Set(["hints", "nope"])), ["name", "hints", "menu"]);
  assert.deepEqual(visibleColumnIds(cols, new Set()), ["name", "menu"]);
  assert.deepEqual(parseColumnChoice('["a",1,"b"]'), new Set(["a", "b"]));
  assert.equal(parseColumnChoice("{bad"), null);
  assert.equal(parseColumnChoice('{"a":1}'), null);
  assert.equal(parseColumnChoice(null), null);
});

test("selection: header state and pruning of rows that are gone", () => {
  const sel = new Set(["a", "b", "gone"]);
  assert.equal(selectionState(sel, ["a", "b"]), "all");
  assert.equal(selectionState(sel, ["a", "c"]), "some");
  assert.equal(selectionState(new Set(), ["a"]), "none");
  assert.equal(pruneSelection(sel, ["a", "b", "c"]), true);
  assert.deepEqual([...sel], ["a", "b"]);
  assert.equal(pruneSelection(sel, ["a", "b"]), false);
});

test("virtualWindow renders the visible rows plus overscan and keeps the full height in spacers", () => {
  const w = virtualWindow({ total: 1000, rowHeight: 40, scrollTop: 4000, viewport: 400, overscan: 5 });
  assert.deepEqual(w, { start: 95, end: 116, padStart: 3800, padEnd: 884 * 40 });
  assert.equal(w.padStart + (w.end - w.start) * 40 + w.padEnd, 1000 * 40);
  assert.deepEqual(virtualWindow({ total: 10, rowHeight: 40, scrollTop: 0, viewport: 400, overscan: 5 }), { start: 0, end: 10, padStart: 0, padEnd: 0 });
  // scrolled past the end (the list shrank): still a valid window at the bottom
  const past = virtualWindow({ total: 10, rowHeight: 40, scrollTop: 9999, viewport: 400, overscan: 2 });
  assert.equal(past.end, 10);
  assert.ok(past.start < past.end);
  assert.deepEqual(virtualWindow({ total: 0, rowHeight: 40, scrollTop: 0, viewport: 400 }), { start: 0, end: 0, padStart: 0, padEnd: 0 });
});

test("syncKeyed reuses unchanged nodes, rebuilds changed ones, moves and removes", () => {
  type Node = { id: string };
  const kids: Node[] = [];
  const parent: KeyedContainer<Node> = {
    childAt: (i) => kids[i] ?? null,
    insertBefore: (n, ref) => {
      const at = kids.indexOf(n);
      if (at >= 0) kids.splice(at, 1);
      const r = ref === null ? -1 : kids.indexOf(ref);
      if (r < 0) kids.push(n);
      else kids.splice(r, 0, n);
    },
    remove: (n) => {
      const at = kids.indexOf(n);
      if (at >= 0) kids.splice(at, 1);
    },
  };
  const cache = new Map<string, KeyedEntry<Node>>();
  let builds = 0;
  const item = (key: string, sig: string, extra = false) => ({
    key,
    sig,
    build: () => {
      builds += 1;
      return extra ? [{ id: `${key}${sig}` }, { id: `${key}-detail` }] : [{ id: `${key}${sig}` }];
    },
  });
  syncKeyed(parent, cache, [item("a", "1"), item("b", "1"), item("c", "1")]);
  assert.deepEqual(kids.map((k) => k.id), ["a1", "b1", "c1"]);
  const b = kids[1];
  syncKeyed(parent, cache, [item("c", "1"), item("b", "1"), item("a", "2", true)]);
  assert.deepEqual(kids.map((k) => k.id), ["c1", "b1", "a2", "a-detail"]);
  assert.equal(kids[1], b, "an unchanged row keeps its node");
  assert.equal(builds, 4);
  syncKeyed(parent, cache, [item("b", "1")]);
  assert.deepEqual(kids.map((k) => k.id), ["b1"]);
  assert.equal(cache.size, 1);
  // a leading fixed node (a spacer) is left in place with `from`
  kids.unshift({ id: "spacer" });
  syncKeyed(parent, cache, [item("x", "1"), item("b", "1")], 1);
  assert.deepEqual(kids.map((k) => k.id), ["spacer", "x1", "b1"]);
});
