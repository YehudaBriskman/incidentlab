// Run: node --test --experimental-strip-types src/explorer/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const core: typeof import("./core") = await import(new URL("./core.ts", import.meta.url).href);
const evidence = new URL("../../../build/evidence/3am-outage/", import.meta.url);

test("pipeline: contains / NOT / regex with case toggle", () => {
  const lines = ["GET /a 200", "POST /api/checkout 502", "get /healthz 200", "POST /api/checkout 200"];
  const idx = core.applyFilters(lines, [
    { kind: "contains", text: "post", ci: true },
    { kind: "regex", text: " 5\\d\\d$", ci: false },
  ]);
  assert.deepEqual([...idx], [1]);
  assert.deepEqual([...core.applyFilters(lines, [{ kind: "not", text: "HEALTHZ", ci: true }])], [0, 1, 3]);
  assert.deepEqual([...core.applyFilters(lines, [{ kind: "contains", text: "GET", ci: false }])], [0]);
});

test("filter honours the deadline", () => {
  const lines = Array.from({ length: 10000 }, (_, i) => `line ${i}`);
  assert.throws(() => core.applyFilters(lines, [{ kind: "regex", text: "x", ci: false }], null, Date.now() - 1));
});

test("countUnique and histogram", () => {
  const lines = ["a cid=1", "b cid=2", "c cid=1", "d"];
  const r = core.countUnique(lines, null, "cid=(\\S+)");
  assert.equal(r.distinct, 2);
  assert.equal(r.matchedLines, 3);
  assert.deepEqual(r.rows[0], ["1", 2]);
  const hist = core.histogram(["[t1] x", "[t1] y", "[t2] z"], null, "\\[(\\w+)\\]");
  assert.deepEqual(hist.buckets, [{ key: "t1", count: 2 }, { key: "t2", count: 1 }]);
});

test("json field filter and match ranges", () => {
  const line = '{"level":"error","msg":"x.y","nested":{"k":3}}';
  assert.ok(core.jsonLineMatches(line, { field: "msg", value: "x.y" }));
  assert.ok(core.jsonLineMatches(line, { field: "nested.k", value: "3" }));
  assert.ok(!core.jsonLineMatches(line, { field: "level", value: "info" }));
  assert.deepEqual(core.parseJsonFilter(" msg = a.b "), { field: "msg", value: "a.b" });
  assert.deepEqual(core.matchRanges("aXbxc", [{ kind: "contains", text: "x", ci: true }]), [[1, 2], [3, 4]]);
});

test("time parsing and zones", () => {
  const ms = Date.UTC(2026, 10, 13, 0, 0, 0);
  assert.equal(core.parseTimeInput(String(ms / 1000)), ms);
  assert.equal(core.parseTimeInput(String(ms)), ms);
  assert.equal(core.parseTimeInput("13/Nov/2026:00:00:00 +0000"), ms);
  assert.equal(core.parseTimeInput("[13/Nov/2026:02:00:00 +0200]"), ms);
  assert.equal(core.parseTimeInput("2026-11-13T02:00:00+02:00"), ms);
  assert.equal(core.parseTimeInput("2026-11-13 00:00:00.000 UTC"), ms);
  assert.equal(core.parseTimeInput("nonsense"), null);
  assert.ok(core.formatInZone(ms, "UTC").startsWith("2026-11-13 00:00:00"));
  assert.ok(core.formatInZone(ms, "Asia/Jerusalem").startsWith("2026-11-13 02:00:00"));
  assert.ok(core.isEpochSeconds("1794528000"));
  assert.ok(!core.isEpochSeconds("282"));
});

test("deep link state round-trips", () => {
  const state = {
    file: "nginx/access.log",
    steps: [{ kind: "regex" as const, text: '" 5\\d\\d &x=?', ci: false }, { kind: "not" as const, text: "healthz", ci: true }],
    json: { field: "msg", value: "a=b" },
    cols: ["ts", "msg"],
    line: null,
  };
  assert.deepEqual(core.decodeState(core.encodeState(state)), state);
  assert.deepEqual(core.parseCsvLine('a,"b,c",d'), ["a", "b,c", "d"]);
});

const accessLog = new URL("nginx/access.log", evidence);
test("real 40MB access.log: filter + unique under 1s each", () => {
  if (!existsSync(accessLog)) return;
  const lines = core.splitLines(readFileSync(accessLog, "utf8"));
  assert.ok(lines.length > 100000);
  let t = Date.now();
  const idx = core.applyFilters(lines, [{ kind: "regex", text: '" 5\\d\\d ', ci: false }, { kind: "not", text: "healthz", ci: true }]);
  const filterMs = Date.now() - t;
  assert.ok(idx.length > 0);
  t = Date.now();
  const all = core.applyFilters(lines, [{ kind: "contains", text: "/api/", ci: true }]);
  const containsMs = Date.now() - t;
  t = Date.now();
  const u = core.countUnique(lines, null, "cid=(\\S+)");
  const uniqueMs = Date.now() - t;
  t = Date.now();
  const hist = core.histogram(lines, all, "\\[(\\d+/\\w+/\\d+:\\d\\d:\\d\\d)");
  const histMs = Date.now() - t;
  console.log(`lines=${lines.length} regex=${filterMs}ms contains=${containsMs}ms unique=${uniqueMs}ms(${u.distinct}) hist=${histMs}ms(${hist.buckets.length})`);
  for (const ms of [filterMs, containsMs, uniqueMs, histMs]) assert.ok(ms < 1000, `took ${ms}ms`);
});

test("real checkout-service.log is detected as JSON lines", () => {
  const p = new URL("app/checkout-service.log", evidence);
  if (!existsSync(p)) return;
  const lines = core.splitLines(readFileSync(p, "utf8"));
  assert.ok(core.looksLikeJsonLines(lines));
  const t = Date.now();
  core.applyFilters(lines, [], { field: "level", value: "*" });
  assert.ok(Date.now() - t < 1000);
});

test("filter can hide a CSV header line", () => {
  const lines = ["a,b", "1,x", "2,y"];
  assert.deepEqual([...core.applyFilters(lines, [], null, Number.POSITIVE_INFINITY, true)], [1, 2]);
  assert.deepEqual([...core.applyFilters(lines, [{ kind: "contains", text: "a", ci: false }], null, Number.POSITIVE_INFINITY, true)], []);
});

test("regex errors are short", () => {
  assert.equal(core.regexError("(a"), "Unterminated group");
  assert.equal(core.regexError("a+"), null);
});

test("histogram buckets times per minute on a real axis, empty minutes included", () => {
  const lines = [
    "[13/Nov/2026:00:00:05 +0000] a",
    "[13/Nov/2026:00:00:59 +0000] b",
    "[13/Nov/2026:00:03:01 +0000] c",
  ];
  const r = core.histogram(lines, null, "\\[(\\d+/\\w+/\\d+:\\d\\d:\\d\\d)");
  assert.deepEqual(r.buckets, []);
  const t0 = Date.UTC(2026, 10, 13, 0, 0);
  assert.deepEqual(r.minutes, [[t0, 2], [t0 + 180_000, 1]]);
  const s = core.timeSeries(r.minutes);
  assert.ok(s);
  assert.equal(s?.step, 1);
  assert.deepEqual(s?.counts, [2, 0, 0, 1]);
  assert.deepEqual(s?.gap, { from: t0 + 60_000, to: t0 + 180_000, buckets: 2 });
  assert.deepEqual(s?.peak, { at: t0, count: 2 });
});

test("histogram reads syslog (with an assumed year), epoch and dpkg keys", () => {
  const sys = core.histogram(["Nov 18 07:00:07 h kernel: x", "Nov 18 07:00:59 h kernel: y"], null, "^(\\w{3} +\\d+ \\d\\d:\\d\\d)", Number.POSITIVE_INFINITY, 2026);
  assert.deepEqual(sys.minutes, [[Date.UTC(2026, 10, 18, 7, 0), 2]]);
  const epoch = core.histogram(["1794528000,1", "1794528030,2", "1794528090,3"], null, "^(\\d{10})");
  assert.deepEqual(epoch.minutes.map(([, n]) => n), [2, 1]);
  const dpkg = core.histogram(["web-05 2026-11-01 06:34:19 status x"], null, "(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d)");
  assert.deepEqual(dpkg.minutes, [[Date.UTC(2026, 10, 1, 6, 34), 1]]);
});

test("long spans get coarser buckets", () => {
  const t0 = Date.UTC(2026, 10, 17, 0, 0);
  const s = core.timeSeries([[t0, 1], [t0 + 2 * 24 * 3600_000, 1]]);
  assert.ok(s !== null && s.counts.length <= 240 && s.step === 15);
});

test("year-less syslog never becomes 2001", () => {
  assert.equal(core.parseTimeInput("Nov 18 07:00:07"), null);
  assert.equal(core.parseTimeInput("Nov 18 07:00:07", 2026), Date.UTC(2026, 10, 18, 7, 0, 7));
  assert.ok(core.isYearless("Nov 18 07:00:07"));
  assert.ok(!core.isYearless("2026-11-18T07:00:07Z"));
  assert.ok(core.isZoneless("2026-11-01 06:01:06"));
  assert.ok(!core.isZoneless("2026-11-01T06:01:06Z"));
  assert.ok(!core.isZoneless("1794528000"));
});

test("zones: EST/EDT, CET and a fixed +02:00", () => {
  const ms = Date.UTC(2026, 10, 18, 7, 0, 0);
  assert.equal(core.formatInZone(ms, "UTC"), "2026-11-18 07:00:00 UTC");
  assert.equal(core.formatInZone(ms, "America/New_York"), "2026-11-18 02:00:00 -05:00");
  assert.equal(core.formatInZone(ms, "Europe/Paris"), "2026-11-18 08:00:00 +01:00");
  assert.equal(core.formatInZone(ms, "+02:00"), "2026-11-18 09:00:00 +02:00");
  // a zone-less dpkg stamp read as CET, and as a fixed +02:00
  const wall = core.parseTimeInput("2026-11-01 06:01:06");
  assert.equal(wall === null ? null : core.wallClockToUtc(wall, "Europe/Paris"), Date.UTC(2026, 10, 1, 5, 1, 6));
  assert.equal(wall === null ? null : core.wallClockToUtc(wall, "+02:00"), Date.UTC(2026, 10, 1, 4, 1, 6));
});

test("year hint and line deep link", () => {
  assert.equal(core.yearHint(["x 2026-11-18T00:00:00Z", "[13/Nov/2026:00:00:00 +0000]", "2025-01-01"]), 2026);
  assert.equal(core.yearHint(["no dates"]), null);
  const st = core.decodeState(core.encodeState({ file: "a.log", steps: [], json: null, cols: [], line: 42 }));
  assert.equal(st.line, 42);
});

test("plural categories", () => {
  assert.equal(core.pluralCategory(1, "en"), "one");
  assert.equal(core.pluralCategory(2, "he"), "two");
  assert.equal(core.pluralCategory(5, "he"), "other");
});
