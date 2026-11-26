import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminAccountsResponseSchema, AnswerResponseSchema, TodayResponseSchema } from "../../shared/contract.ts";
import type { CaseSecrets } from "../domain/types.ts";
import { InMemoryByteStore } from "../repositories/ByteStore.ts";
import { CaseRepository, EvidenceChunkRepository } from "../repositories/case-repository.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { createApp } from "../router.ts";
import { CaseSecretsProvider, type PublishedSealedSource } from "../services/CaseSecretsProvider.ts";
import { sealedFixture, seedCase } from "./case-fixtures.ts";
import { ADMIN_KEY, SECRETS } from "./helpers.ts";

const call = (app: ReturnType<typeof createApp>, path: string, init: { method?: string; body?: unknown; cookie?: string | null; admin?: boolean } = {}) => {
  const headers: Record<string, string> = {};
  if (init.cookie) headers["cookie"] = `il_session=${init.cookie}`;
  if (init.admin) headers["x-admin-key"] = ADMIN_KEY;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return app.handle(new Request(`http://localhost/api${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), "10.0.0.1");
};
const cookieOf = (res: Response): string | null => /il_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? null;

const fakeSource = (cases: Record<string, CaseSecrets>, failing = { now: false }): PublishedSealedSource & { reads: number } => {
  const source = {
    reads: 0,
    async publishedIds(): Promise<string[]> {
      source.reads += 1;
      if (failing.now) throw new Error("blobs down");
      return Object.keys(cases);
    },
    async getSealed(id: string): Promise<CaseSecrets | null> {
      return cases[id] ?? null;
    },
  };
  return source;
};

test("provider: bundled only until refreshed; DB cases overlay and win over a bundled id", async () => {
  let nowMs = 0;
  const dbAlpha = { ...sealedFixture("alpha"), title: "alpha from the DB" };
  const source = fakeSource({ alpha: dbAlpha, gamma: sealedFixture("gamma") });
  const provider = new CaseSecretsProvider({ bundled: SECRETS, source, now: () => new Date(nowMs), ttlMs: 1000 });
  assert.deepEqual(Object.keys(provider.cases).sort(), ["alpha", "beta"]);
  await provider.refresh();
  assert.deepEqual(Object.keys(provider.cases).sort(), ["alpha", "beta", "gamma"]);
  assert.equal(provider.cases.alpha?.title, "alpha from the DB");
  assert.equal(provider.cases.beta?.title, "Case beta"); // bundled, untouched

  await provider.refresh(); // within the TTL: no second read
  assert.equal(source.reads, 1);
  nowMs = 1500;
  await provider.refresh();
  assert.equal(source.reads, 2);
});

test("provider: a failing DB keeps the last good copy, and no source means bundled only", async () => {
  let nowMs = 0;
  const failing = { now: false };
  const provider = new CaseSecretsProvider({ bundled: SECRETS, source: fakeSource({ gamma: sealedFixture("gamma") }, failing), now: () => new Date(nowMs), ttlMs: 10 });
  await provider.refresh();
  failing.now = true;
  nowMs = 100;
  const logged = console.error;
  console.error = () => undefined; // the provider logs the failure; keep test output clean
  try {
    await provider.refresh();
  } finally {
    console.error = logged;
  }
  assert.ok(provider.cases.gamma, "kept after a failed reload");

  const bundledOnly = new CaseSecretsProvider({ bundled: SECRETS, source: null, now: () => new Date(0) });
  await bundledOnly.refresh();
  assert.deepEqual(Object.keys(bundledOnly.cases).sort(), ["alpha", "beta"]);
});

test("a case published only in the DB is released, scheduled and playable through the API", async () => {
  const store = new InMemoryKvStore();
  const bytes = new InMemoryByteStore();
  const app = createApp({ store, bytes, secrets: SECRETS, adminKey: () => ADMIN_KEY });
  await seedCase({ cases: new CaseRepository(store), chunks: new EvidenceChunkRepository(bytes) }, { id: "gamma" });

  const today = TodayResponseSchema.parse(await (await call(app, "/today")).json());
  assert.ok(today.releasedCaseIds.includes("gamma"), "DB case is released");
  assert.ok(today.releasedCaseIds.includes("alpha"), "bundled cases stay released");

  const reg = await call(app, "/auth/register", { body: { username: "Dana", password: "hunter2hunter2" } });
  const cookie = cookieOf(reg);
  const accounts = AdminAccountsResponseSchema.parse(await (await call(app, "/admin/accounts", { admin: true })).json());
  await call(app, `/admin/accounts/${accounts.accounts[0]?.accountId}/approve`, { body: {}, admin: true });

  assert.equal((await call(app, "/cases/gamma/progress", { cookie })).status, 200);
  assert.equal((await call(app, "/cases/gamma/setup-done", { body: {}, cookie })).status, 200);
  const wrong = AnswerResponseSchema.parse(await (await call(app, "/cases/gamma/answer", { body: { questionId: "q1", answer: "nope" }, cookie })).json());
  assert.equal(wrong.correct, false);
  const right = AnswerResponseSchema.parse(await (await call(app, "/cases/gamma/answer", { body: { questionId: "q1", answer: " Q1-ANSWER " }, cookie })).json());
  assert.equal(right.correct, true);
});
