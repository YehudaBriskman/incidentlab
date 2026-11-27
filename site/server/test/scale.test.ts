// Scale check (#185) on every PR: the public-site-sized store from tests/load/seed-scale.ts (2,000 accounts,
// 100 classes, 20 cases), and a read budget per call on a CDN miss. Store reads, not time: a regression that
// brings back a full scan on a player path fails here. The table: node --experimental-strip-types tests/load/scale-check.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureScale, overBudget } from "../../../tests/load/scale-check.ts";

test("scale: every measured call stays within its store-read budget", async () => {
  const { rows, counts } = await measureScale();
  assert.equal(counts["accounts"], 2000);
  assert.equal(counts["classes"], 100);
  assert.deepEqual(overBudget(rows), []);
  // The console's users list must stay far below the old full scan it replaced.
  const users = rows.find((r) => r.name === "adminUsers");
  const old = rows.find((r) => r.name === "adminAccountsOld");
  assert.ok(users !== undefined && old !== undefined && users.gets * 2 < old.gets, `${users?.gets} vs ${old?.gets}`);
  // A warm instance answers a player's stats without reading the board again.
  const warm = rows.find((r) => r.name === "meStatsWarm");
  assert.ok(warm !== undefined && warm.gets < 60, `${warm?.gets}`);
});
