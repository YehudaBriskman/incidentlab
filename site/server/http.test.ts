// HTTP-level test: drives the real Netlify handler with Request objects and the in-memory store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { loadSecrets } from "./domain/config.ts";
import { CreatePlayerResponseSchema, ErrorBodySchema, AdminPlayersResponseSchema, AnswerResponseSchema } from "../shared/contract.ts";

process.env.INCIDENTLAB_STORE = "memory";
process.env.ADMIN_KEY = "admin-key-for-tests-0123456789";

const { default: handler, resetAppForTests } = await import("../netlify/functions/api.mts");

const BASE = "http://localhost/api";
const ctx = { ip: "10.0.0.1" };

const call = (path: string, init: RequestInit = {}): Promise<Response> => handler(new Request(`${BASE}${path}`, init), ctx);
const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const readJson = async <T extends z.ZodType>(res: Response, schema: T): Promise<z.infer<T>> => schema.parse(await res.json());

test("full HTTP flow", async () => {
  resetAppForTests();
  const bad = await post("/players", { name: "<script>", caseId: "3am-outage" });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("cache-control"), "no-store");
  await readJson(bad, ErrorBodySchema);

  const created = await post("/players", { name: "שחקן", caseId: "3am-outage" });
  assert.equal(created.status, 201);
  const { token, player } = await readJson(created, CreatePlayerResponseSchema);
  assert.equal(player.name, "שחקן");
  const auth = { authorization: `Bearer ${token}` };

  assert.equal((await call("/me")).status, 401);
  assert.equal((await call("/me", { headers: { authorization: "Bearer nope" } })).status, 401);
  assert.equal((await call("/me", { headers: auth })).status, 200);

  assert.equal((await post("/answer", { questionId: "q2", answer: "x" }, auth)).status, 403);
  assert.equal((await post("/setup-done", {}, auth)).status, 200);
  const wrong = await readJson(await post("/answer", { questionId: "q1", answer: "x" }, auth), AnswerResponseSchema);
  assert.equal(wrong.correct, false);
  // whatever secrets.json holds (DEV placeholder or pipeline output), submit its q1 answer un-normalized
  const q1Answer = ` ${loadSecrets().answers.q1.toUpperCase()} `;
  const right = await readJson(await post("/answer", { questionId: "q1", answer: q1Answer }, auth), AnswerResponseSchema);
  assert.equal(right.correct, true);

  assert.equal((await call("/debrief", { headers: auth })).status, 403);

  // 415 / 413 / 404 / 405
  assert.equal((await call("/answer", { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await post("/answer", { questionId: "q2", answer: "x".repeat(5000) }, auth)).status, 413);
  assert.equal((await call("/nope")).status, 404);
  assert.equal((await call("/me", { method: "DELETE" })).status, 405);
  assert.equal((await call("/answer", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{not json" })).status, 400);
});

test("admin over HTTP", async () => {
  resetAppForTests();
  await post("/players", { name: "Ada", caseId: "3am-outage" });
  assert.equal((await call("/admin/players")).status, 401);
  assert.equal((await call("/admin/players", { headers: { "x-admin-key": "wrong" } })).status, 401);
  const adminHeaders = { "x-admin-key": "admin-key-for-tests-0123456789" };
  const list = await readJson(await call("/admin/players", { headers: adminHeaders }), AdminPlayersResponseSchema);
  assert.equal(list.players.length, 1);
  assert.equal(list.players[0]?.currentStage, "setup");

  assert.equal((await post("/admin/reset", { confirm: "nope" }, adminHeaders)).status, 400);
  assert.equal((await post("/admin/reset", { confirm: "RESET" }, adminHeaders)).status, 204);
  const after = await readJson(await call("/admin/players", { headers: adminHeaders }), AdminPlayersResponseSchema);
  assert.equal(after.players.length, 0);

  const saved = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = "short";
  assert.equal((await call("/admin/players", { headers: { "x-admin-key": "short" } })).status, 503);
  process.env.ADMIN_KEY = saved;
});
