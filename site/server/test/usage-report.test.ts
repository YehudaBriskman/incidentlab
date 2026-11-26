// server/ops/netlify-usage.ts formatting: bandwidth shares, the 70% warning, unknown counters (issue #142).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUsage, type UsageReport } from "../ops/netlify-usage.ts";

const report = (rows: UsageReport["rows"]): UsageReport => ({ account: "acct", plan: "Free", periodStart: "2026-11-01T00:00:00Z", periodEnd: "2026-12-01T00:00:00Z", rows });
const now = new Date("2026-11-26T12:00:00Z");

test("shows bandwidth with its share and the days left", () => {
  const lines = formatUsage(report([{ label: "Bandwidth", used: 343 * 1024 ** 2, included: 100 * 1024 ** 3, unit: "bytes" }]), now);
  assert.match(lines[0] ?? "", /plan Free \(legacy: never switch to credit-based pricing\)/);
  assert.match(lines[1] ?? "", /5 days left/);
  assert.match(lines[2] ?? "", /Bandwidth: 343\.0 MB of 100\.00 GB \(0\.3%\)$/);
});

test("warns at 70% of a limit", () => {
  const lines = formatUsage(report([{ label: "Function calls", used: 90_000, included: 125_000, unit: "count" }]), now);
  assert.match(lines[2] ?? "", /90,000 of 125,000 \(72\.0%\)\s+WARNING/);
});

test("a counter the API reports as 0 or not at all is shown as unknown, not as unused", () => {
  const lines = formatUsage(
    report([
      { label: "Function calls", used: 0, included: 125_000, unit: "count" },
      { label: "Edge function calls", used: null, included: 1_000_000, unit: "count" },
    ]),
    now,
  );
  assert.match(lines[2] ?? "", /Function calls: not reported by the API \(limit 125,000\/month/);
  assert.match(lines[3] ?? "", /Edge function calls: not reported/);
});
