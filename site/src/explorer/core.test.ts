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
