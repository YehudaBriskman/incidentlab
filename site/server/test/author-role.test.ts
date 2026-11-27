import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountResponseSchema, AdminAccountsResponseSchema, AuditResponseSchema, ResetPasswordResponseSchema, SessionResponseSchema } from "../../shared/contract.ts";
import { AccountRecordSchema, AppError } from "../domain/types.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { SettingsRepository } from "../repositories/config-repositories.ts";
import { createRepositories } from "../repositories/repositories.ts";
import { AuthService } from "../services/AuthService.ts";
import { RateLimiter } from "../services/RateLimiter.ts";
import { ADMIN_KEY, createHarness, expectStatus } from "./helpers.ts";

/** The harness app plus an AuthService on the same store, to exercise requireAuthor before any route uses it. */
const setup = () => {
  const store = new InMemoryKvStore();
  const harness = createHarness({ store });
  const repos = createRepositories(store);
  const now = (): Date => new Date();
  const auth = new AuthService({ repos, settings: new SettingsRepository(store), limiter: new RateLimiter(repos.rateLimits, now), adminKey: () => ADMIN_KEY, now });
  return { ...harness, auth, repos };
};

/** Sign-up approves at once (#173); accounts from before it can still be pending, so tests write one directly. */
const markPending = async (h: ReturnType<typeof setup>, id: string): Promise<void> => {
  const found = await h.repos.accounts.get(id);
  assert.ok(found);
  assert.ok(await h.repos.accounts.saveIfMatch({ ...found.data, status: "pending", decidedAt: null }, found.etag));
};

const register = async (h: ReturnType<typeof setup>, username: string) => {
  const c = h.client();
  const res = await c.call("/auth/register", { body: { username, password: "hunter2hunter2" } });
  assert.equal(res.status, 201);
  const { account } = await c.json(res, AccountResponseSchema);
  const token = c.cookie();
  assert.ok(token);
  return { c, id: account.id, token };
};

const rejectsWith = async (promise: Promise<unknown>, status: number, code: string): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.status === status && error.code === code);
};

test("account records saved before the author role parse as players", () => {
  const old = {
    id: "acc_old", username: "Old", usernameKey: "old", passwordHash: "scrypt$x", status: "approved",
    sessionEpoch: 0, createdAt: "2026-01-01T00:00:00.000Z", decidedAt: null, lastSeenAt: null, lastLoginAt: null,
  };
  assert.equal(AccountRecordSchema.parse(old).role, "player");
});

test("admin grants and revokes the author role; it shows in session, accounts list and audit", async () => {
  const h = setup();
  const dana = await register(h, "Dana");
  assert.equal((await dana.c.json(await dana.c.call("/session"), SessionResponseSchema)).account?.role, "player");

  const granted = await h.admin(`/admin/accounts/${dana.id}/role`, { method: "PUT", body: { role: "author" } });
  assert.equal(granted.status, 200);
  assert.equal(AccountResponseSchema.parse(await granted.json()).account.role, "author");
  // the existing session sees the new role without signing in again
  assert.equal((await dana.c.json(await dana.c.call("/session"), SessionResponseSchema)).account?.role, "author");

  const list = AdminAccountsResponseSchema.parse(await (await h.admin("/admin/accounts")).json());
  assert.equal(list.accounts.find((a) => a.accountId === dana.id)?.role, "author");

  const revoked = await h.admin(`/admin/accounts/${dana.id}/role`, { method: "PUT", body: { role: "player" } });
  assert.equal(AccountResponseSchema.parse(await revoked.json()).account.role, "player");

  const audit = AuditResponseSchema.parse(await (await h.admin("/admin/audit")).json());
  assert.deepEqual(audit.entries.filter((e) => e.action === "account.role").map((e) => e.detail), ["player", "author"]);
});

test("only the admin can change roles, and only to player or author", async () => {
  const h = setup();
  const dana = await register(h, "Dana");
  const eve = await register(h, "Eve");
  await expectStatus(eve.c.call(`/admin/accounts/${dana.id}/role`, { method: "PUT", body: { role: "author" } }), 401);
  await expectStatus(h.admin(`/admin/accounts/${dana.id}/role`, { method: "PUT", body: { role: "admin" } }), 400);
  await expectStatus(h.admin(`/admin/accounts/missing00000/role`, { method: "PUT", body: { role: "author" } }), 404);
});

test("requireAuthor: admin and approved authors pass; players, pending authors and forced password changes don't", async () => {
  const h = setup();
  await rejectsWith(h.auth.requireAuthor(null), 401, "signed-out");

  const dana = await register(h, "Dana");
  await rejectsWith(h.auth.requireAuthor(dana.token), 403, "not-author");

  await h.admin(`/admin/accounts/${dana.id}/role`, { method: "PUT", body: { role: "author" } });
  await markPending(h, dana.id);
  await rejectsWith(h.auth.requireAuthor(dana.token), 403, "pending");

  await h.admin(`/admin/accounts/${dana.id}/approve`, { body: {} });
  const principal = await h.auth.requireAuthor(dana.token);
  assert.equal(principal.kind === "player" ? principal.account.id : null, dana.id);

  await h.admin(`/admin/accounts/${dana.id}/reject`, { body: {} });
  await rejectsWith(h.auth.requireAuthor(dana.token), 403, "rejected");

  const admin = h.client();
  await admin.call("/auth/login", { body: { username: "admin", password: ADMIN_KEY } });
  assert.equal((await h.auth.requireAuthor(admin.cookie())).kind, "admin");
});

test("a password reset blocks authoring until the author sets a new password", async () => {
  const h = setup();
  const dana = await register(h, "Dana");
  await h.admin(`/admin/accounts/${dana.id}/approve`, { body: {} });
  await h.admin(`/admin/accounts/${dana.id}/role`, { method: "PUT", body: { role: "author" } });
  const { temporaryPassword } = ResetPasswordResponseSchema.parse(await (await h.admin(`/admin/accounts/${dana.id}/reset-password`, { body: {} })).json());
  const again = h.client();
  await again.call("/auth/login", { body: { username: "Dana", password: temporaryPassword } });
  await rejectsWith(h.auth.requireAuthor(again.cookie()), 403, "password-change-required");
});
