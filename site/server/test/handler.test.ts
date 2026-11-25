// Wiring test: the real Netlify entry point with the in-memory store and the pipeline's secrets.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TodayResponseSchema } from "../../shared/contract.ts";
import { loadSecrets } from "../domain/config.ts";

process.env.INCIDENTLAB_STORE = "memory";
process.env.ADMIN_KEY = "admin-key-for-tests-0123456789";
const { default: handler, resetAppForTests } = await import("../../netlify/functions/api.mts");

test("entry point serves /api/today with every released case", async () => {
  resetAppForTests();
  const res = await handler(new Request("http://localhost/api/today"), { ip: "10.0.0.1" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = TodayResponseSchema.parse(await res.json());
  assert.deepEqual(body.releasedCaseIds, Object.keys(loadSecrets().cases));
  assert.ok(body.releasedCaseIds.includes("3am-outage"));
});

test("admin disabled with a short key", async () => {
  resetAppForTests();
  const saved = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = "short";
  const res = await handler(new Request("http://localhost/api/admin/accounts", { headers: { "x-admin-key": "short" } }), { ip: "10.0.0.1" });
  assert.equal(res.status, 503);
  process.env.ADMIN_KEY = saved;
});
