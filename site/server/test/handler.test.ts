// Wiring test: the real Netlify entry point with the in-memory store. Since #68 the function reads every case
// from the DB: an empty store releases nothing, and the pipeline's secrets.json is never imported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TodayResponseSchema } from "../../shared/contract.ts";

process.env.INCIDENTLAB_STORE = "memory";
process.env.ADMIN_KEY = "admin-key-for-tests-0123456789";
const { default: handler, resetAppForTests } = await import("../../netlify/functions/api.mts");

test("entry point serves /api/today; an empty store releases no case", async () => {
  resetAppForTests();
  const res = await handler(new Request("http://localhost/api/today"), { ip: "10.0.0.1" });
  assert.equal(res.status, 200);
  // public and CDN-cacheable since #140; browsers always revalidate
  assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.match(res.headers.get("netlify-cdn-cache-control") ?? "", /^public, durable, max-age=\d+/);
  const body = TodayResponseSchema.parse(await res.json());
  assert.deepEqual(body.releasedCaseIds, []);
});

test("admin disabled with a short key", async () => {
  resetAppForTests();
  const saved = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = "short";
  const res = await handler(new Request("http://localhost/api/admin/accounts", { headers: { "x-admin-key": "short" } }), { ip: "10.0.0.1" });
  assert.equal(res.status, 503);
  process.env.ADMIN_KEY = saved;
});

test("entry point: GET /api/cases is empty until a case is published", async () => {
  resetAppForTests();
  const res = await handler(new Request("http://localhost/api/cases"), { ip: "10.0.0.1" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cases: [] });
  assert.equal(res.headers.get("cache-control"), "public, max-age=60, stale-while-revalidate=600");
});

test("no runtime code imports the generated answer keys (generated/secrets.json)", () => {
  const site = fileURLToPath(new URL("../../", import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules" || name === "test" || name === "generated") return [];
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  const sources = ["server", "netlify", "shared", "src"].flatMap((d) => walk(join(site, d))).filter((f) => /\.m?ts$/.test(f));
  assert.ok(sources.length > 50, "walked the sources");
  const importers = sources.filter((f) => /generated\/secrets(\.json)?["']/.test(readFileSync(f, "utf8")));
  assert.deepEqual(importers, []);
});
