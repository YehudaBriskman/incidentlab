import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountResponseSchema, AdminAccountsResponseSchema, UsernameSchema, usernameKey } from "../../shared/contract.ts";
import { hashPassword, verifyPassword } from "../services/crypto.ts";
import { createHarness, expectStatus } from "./helpers.ts";

test("username rules and canonical key", () => {
  assert.equal(UsernameSchema.safeParse("<script>").success, false);
  assert.equal(UsernameSchema.safeParse("has space").success, false);
  assert.equal(UsernameSchema.safeParse("ab").success, false);
  assert.equal(UsernameSchema.safeParse("יהודה_ב").success, true);
  assert.equal(UsernameSchema.safeParse("dana.k-2").success, true);
  assert.equal(usernameKey(" Dana "), usernameKey("dana"));
  assert.equal(usernameKey("ＤＡＮＡ"), "dana"); // NFKC folds full-width letters
});

test("password hashing round-trips and rejects wrong passwords", async () => {
  const stored = await hashPassword("correct horse");
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse", stored), true);
  assert.equal(await verifyPassword("correct horsE", stored), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});

test("register -> pending -> approved, cookie session survives", async () => {
  const { client, admin } = createHarness();
  const dana = client();
  const created = await dana.call("/auth/register", { body: { username: "Dana", password: "hunter2hunter2" } });
  assert.equal(created.status, 201);
  const cookie = created.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api/);
  assert.equal((await dana.json(created, AccountResponseSchema)).account.status, "pending");

  // signed in but not approved: can read /me, can't play
  assert.equal((await dana.json(await dana.call("/me"), AccountResponseSchema)).account.username, "Dana");
  await expectStatus(dana.call("/cases/alpha/progress"), 403, "pending");

  const list = await dana.json(await admin("/admin/accounts"), AdminAccountsResponseSchema);
  const id = list.accounts[0]?.accountId ?? "";
  await expectStatus(admin(`/admin/accounts/${id}/approve`, { body: {} }), 200);
  await expectStatus(dana.call("/cases/alpha/progress"), 200);
});

test("usernames are unique case-insensitively", async () => {
  const { client } = createHarness();
  await expectStatus(client().call("/auth/register", { body: { username: "Dana", password: "password1" } }), 201);
  await expectStatus(client().call("/auth/register", { body: { username: "dana", password: "password2" } }), 409, "username-taken");
  await expectStatus(client().call("/auth/register", { body: { username: "DANA", password: "password2" } }), 409, "username-taken");
});

test("concurrent registrations of one name: exactly one wins", async () => {
  const { client } = createHarness();
  const results = await Promise.all(Array.from({ length: 6 }, () => client().call("/auth/register", { body: { username: "racer", password: "password1" } })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
});

test("login, wrong password, logout", async () => {
  const { client } = createHarness();
  await client().call("/auth/register", { body: { username: "Amir", password: "password1" } });
  const browser = client();
  await expectStatus(browser.call("/auth/login", { body: { username: "amir", password: "nope-nope" } }), 401, "bad-credentials");
  await expectStatus(browser.call("/auth/login", { body: { username: "ghost", password: "password1" } }), 401, "bad-credentials");
  await expectStatus(browser.call("/auth/login", { body: { username: "AMIR", password: "password1" } }), 200);
  await expectStatus(browser.call("/me"), 200);
  const token = browser.cookie();
  await expectStatus(browser.call("/auth/logout", { body: {} }), 204);
  assert.equal(browser.cookie(), null);
  await expectStatus(browser.call("/me"), 401, "signed-out");
  // the old token is dead server-side too
  await expectStatus(browser.call("/me", { headers: { cookie: `il_session=${token ?? ""}` } }), 401);
});

test("login is rate limited per username", async () => {
  const { client } = createHarness();
  await client().call("/auth/register", { body: { username: "target", password: "password1" } });
  for (let i = 0; i < 8; i++) await expectStatus(client(`10.1.0.${i}`).call("/auth/login", { body: { username: "target", password: "wrong-pass" } }), 401);
  await expectStatus(client("10.2.0.1").call("/auth/login", { body: { username: "target", password: "password1" } }), 429, "rate-limited");
});

test("reject shows the rejected state and blocks login; delete frees the name", async () => {
  const { client, admin } = createHarness();
  const eve = client();
  await eve.call("/auth/register", { body: { username: "eve", password: "password1" } });
  const id = (await eve.json(await eve.call("/me"), AccountResponseSchema)).account.id;
  await expectStatus(admin(`/admin/accounts/${id}/reject`, { body: {} }), 200);
  assert.equal((await eve.json(await eve.call("/me"), AccountResponseSchema)).account.status, "rejected"); // session kept so the UI can say so
  await expectStatus(client().call("/auth/login", { body: { username: "eve", password: "password1" } }), 403, "rejected");
  await expectStatus(admin(`/admin/accounts/${id}`, { method: "DELETE" }), 204);
  await expectStatus(client().call("/auth/register", { body: { username: "eve", password: "password1" } }), 201);
});

test("garbage cookies and admin auth", async () => {
  const { client, app } = createHarness();
  await expectStatus(client().call("/me", { headers: { cookie: "il_session=not-a-token" } }), 401);
  await expectStatus(client().call("/admin/accounts"), 401);
  await expectStatus(client().call("/admin/accounts", { headers: { "x-admin-key": "wrong" } }), 401);
  await expectStatus(app.handle(new Request("http://localhost/api/nope"), "1.1.1.1"), 404);
  await expectStatus(app.handle(new Request("http://localhost/api/me", { method: "DELETE" }), "1.1.1.1"), 405);
  await expectStatus(client().call("/auth/register", { body: { username: "<b>x</b>", password: "password1" } }), 400);
  await expectStatus(client().call("/auth/register", { body: { username: "shorty", password: "short" } }), 400);
});
