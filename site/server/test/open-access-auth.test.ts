// Open sign-up (#173) and recovery codes (#174).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthResponseSchema,
  RECOVERY_CODE_ALPHABET,
  RecoveryCodeResponseSchema,
  ResetPasswordResponseSchema,
  normalizeRecoveryCode,
} from "../../shared/contract.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { createRepositories } from "../repositories/repositories.ts";
import { ADMIN_KEY, createHarness, expectStatus, type Client } from "./helpers.ts";

const PASSWORD = "hunter2hunter2";
const CODE_PATTERN = new RegExp(`^[${RECOVERY_CODE_ALPHABET}]{5}(-[${RECOVERY_CODE_ALPHABET}]{5}){3}$`);

/** Signs up `username` and returns the client (signed in), its id and the recovery code from the response. */
const signUp = async (client: Client, username: string): Promise<{ id: string; code: string }> => {
  const res = await client.call("/auth/register", { body: { username, password: PASSWORD } });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await client.json(res, AuthResponseSchema);
  assert.ok(body.recoveryCode);
  return { id: body.account.id, code: body.recoveryCode };
};

const recover = (client: Client, body: { username: string; recoveryCode: string; newPassword: string }): Promise<Response> =>
  client.call("/auth/recover", { body });

/** No response may ever carry a password or recovery-code hash. */
const assertNoHashes = async (res: Response): Promise<void> => {
  const text = await res.clone().text();
  assert.doesNotMatch(text, /scrypt\$/);
  assert.doesNotMatch(text, /passwordHash|recoveryCodeHash/);
};

// ---- #173 open sign-up ------------------------------------------------------

test("sign-up is approved at once and returns a one-time recovery code", async () => {
  const { client } = createHarness();
  const dana = client();
  const res = await dana.call("/auth/register", { body: { username: "Dana", password: PASSWORD } });
  assert.equal(res.status, 201);
  await assertNoHashes(res);
  const body = await dana.json(res, AuthResponseSchema);
  assert.equal(body.account.status, "approved");
  assert.match(body.recoveryCode ?? "", CODE_PATTERN);
  await expectStatus(dana.call("/cases/alpha/progress"), 200);
  // the code is in the register response only: /me and a later sign-in don't repeat it
  const me = await dana.call("/me");
  assert.equal((await me.clone().text()).includes(body.recoveryCode ?? "-"), false);
  const again = await dana.json(await dana.call("/auth/login", { body: { username: "dana", password: PASSWORD } }), AuthResponseSchema);
  assert.equal(again.recoveryCode, undefined);
});

test("bot checks: a filled honeypot or a too-fast form gets a generic 400; real and older clients pass", async () => {
  const { client } = createHarness();
  const base = { password: PASSWORD };
  await expectStatus(client().call("/auth/register", { body: { ...base, username: "botone", website: "http://spam.example" } }), 400, "signup-refused");
  await expectStatus(client().call("/auth/register", { body: { ...base, username: "bottwo", elapsedMs: 300 } }), 400, "signup-refused");
  // refused sign-ups create nothing: both names are still free
  await expectStatus(client().call("/auth/login", { body: { username: "botone", password: PASSWORD } }), 401, "bad-credentials");
  await expectStatus(client().call("/auth/register", { body: { ...base, username: "botone", website: "", elapsedMs: 4_000 } }), 201);
  // an older client sends neither field
  await expectStatus(client().call("/auth/register", { body: { ...base, username: "oldclient" } }), 201);
});

test("sign-ups are limited to 20 an hour per address; reserved names stay reserved", async () => {
  const { client } = createHarness();
  for (let i = 0; i < 20; i++) await expectStatus(client("10.5.5.5").call("/auth/register", { body: { username: `crowd${i}`, password: PASSWORD } }), 201);
  await expectStatus(client("10.5.5.5").call("/auth/register", { body: { username: "crowd20", password: PASSWORD } }), 429, "rate-limited");
  await expectStatus(client("10.6.6.6").call("/auth/register", { body: { username: "Instructor", password: PASSWORD } }), 409, "reserved");
});

// ---- #174 recovery codes ----------------------------------------------------

test("recover sets the new password, ends every session and rotates the code", async () => {
  const { client } = createHarness();
  const first = client();
  const { code } = await signUp(first, "Rina");
  const second = client();
  await expectStatus(second.call("/auth/login", { body: { username: "rina", password: PASSWORD } }), 200);

  // typed in lower case without dashes: still the same code
  const typed = normalizeRecoveryCode(code).toLowerCase();
  const res = await recover(client(), { username: "RINA", recoveryCode: typed, newPassword: "brand-new-pass" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("set-cookie"), null); // no session: the player signs in with the new password
  await assertNoHashes(res);
  const { recoveryCode: next } = RecoveryCodeResponseSchema.parse(await res.json());
  assert.match(next, CODE_PATTERN);
  assert.notEqual(next, code);

  await expectStatus(first.call("/me"), 401, "signed-out");
  await expectStatus(second.call("/me"), 401, "signed-out");
  await expectStatus(client().call("/auth/login", { body: { username: "rina", password: PASSWORD } }), 401, "bad-credentials");
  await expectStatus(client().call("/auth/login", { body: { username: "rina", password: "brand-new-pass" } }), 200);
  // the spent code is dead, the new one works
  await expectStatus(recover(client(), { username: "rina", recoveryCode: code, newPassword: "another-pass-1" }), 401, "bad-recovery-code");
  await expectStatus(recover(client(), { username: "rina", recoveryCode: next, newPassword: "another-pass-1" }), 200);
});

test("recover clears a forced password change after an admin reset", async () => {
  const { client, admin } = createHarness();
  const { id, code } = await signUp(client(), "Forced");
  const reset = ResetPasswordResponseSchema.parse(await (await admin(`/admin/accounts/${id}/reset-password`, { body: {} })).json());
  const temp = await client().json(await client().call("/auth/login", { body: { username: "forced", password: reset.temporaryPassword } }), AuthResponseSchema);
  assert.equal(temp.account.mustChangePassword, true);
  await expectStatus(recover(client(), { username: "forced", recoveryCode: code, newPassword: "my-own-pass-1" }), 200);
  const after = client();
  const signedIn = await after.json(await after.call("/auth/login", { body: { username: "forced", password: "my-own-pass-1" } }), AuthResponseSchema);
  assert.equal(signedIn.account.mustChangePassword, false);
  await expectStatus(after.call("/cases/alpha/progress"), 200);
});

test("wrong recovery codes are refused the same way for unknown names, and rate limited per username", async () => {
  const { client } = createHarness();
  const { code } = await signUp(client(), "Target");
  const wrong = "AAAAA-BBBBB-CCCCC-DDDDD";
  await expectStatus(recover(client(), { username: "nobody-here", recoveryCode: wrong, newPassword: "new-password-1" }), 401, "bad-recovery-code");
  await expectStatus(recover(client(), { username: "admin", recoveryCode: wrong, newPassword: "new-password-1" }), 401, "bad-recovery-code");
  for (let i = 0; i < 8; i++) {
    await expectStatus(recover(client(`10.3.0.${i}`), { username: "target", recoveryCode: wrong, newPassword: "new-password-1" }), 401, "bad-recovery-code");
  }
  // locked for this username, even with the right code and from a new address
  await expectStatus(recover(client("10.4.0.1"), { username: "target", recoveryCode: code, newPassword: "new-password-1" }), 429, "rate-limited");
  // failed recoveries don't lock sign-in
  await expectStatus(client().call("/auth/login", { body: { username: "target", password: PASSWORD } }), 200);
  // and a weak new password is refused before any check
  await expectStatus(recover(client(), { username: "other", recoveryCode: code, newPassword: "short" }), 400);
});

test("regenerating the code needs the current password, and replaces the old code", async () => {
  const { client } = createHarness();
  const dana = client();
  const { code } = await signUp(dana, "Regen");
  await expectStatus(client().call("/me/recovery-code", { body: { currentPassword: PASSWORD } }), 401);
  await expectStatus(dana.call("/me/recovery-code", { body: { currentPassword: "not-my-password" } }), 400, "bad-credentials");
  const res = await dana.call("/me/recovery-code", { body: { currentPassword: PASSWORD } });
  assert.equal(res.status, 200);
  await assertNoHashes(res);
  const { recoveryCode: fresh } = RecoveryCodeResponseSchema.parse(await res.json());
  assert.match(fresh, CODE_PATTERN);
  assert.notEqual(fresh, code);
  await expectStatus(dana.call("/me"), 200); // regenerating doesn't sign anyone out
  await expectStatus(recover(client(), { username: "regen", recoveryCode: code, newPassword: "new-password-1" }), 401, "bad-recovery-code");
  await expectStatus(recover(client(), { username: "regen", recoveryCode: fresh, newPassword: "new-password-1" }), 200);

  const admin = client();
  await admin.call("/auth/login", { body: { username: "admin", password: ADMIN_KEY } });
  await expectStatus(admin.call("/me/recovery-code", { body: { currentPassword: ADMIN_KEY } }), 403, "admin");
});

test("accounts from before recovery codes get one at their next sign-in, once", async () => {
  const store = new InMemoryKvStore();
  const { client } = createHarness({ store });
  const { id } = await signUp(client(), "Veteran");
  const repos = createRepositories(store);
  const found = await repos.accounts.get(id);
  assert.ok(found);
  assert.ok(await repos.accounts.saveIfMatch({ ...found.data, recoveryCodeHash: null }, found.etag));

  const first = await client().call("/auth/login", { body: { username: "veteran", password: PASSWORD } });
  await assertNoHashes(first);
  const issued = AuthResponseSchema.parse(await first.json()).recoveryCode;
  assert.match(issued ?? "", CODE_PATTERN);
  const second = AuthResponseSchema.parse(await (await client().call("/auth/login", { body: { username: "veteran", password: PASSWORD } })).json());
  assert.equal(second.recoveryCode, undefined);
  await expectStatus(recover(client(), { username: "veteran", recoveryCode: issued ?? "", newPassword: "new-password-1" }), 200);
});

test("no account or admin response carries a password or recovery-code hash", async () => {
  const { client, admin } = createHarness();
  const dana = client();
  await signUp(dana, "Hashless");
  for (const res of [
    await dana.call("/me"),
    await dana.call("/session"),
    await dana.call("/me/stats"),
    await dana.call("/auth/login", { body: { username: "hashless", password: PASSWORD } }),
    await admin("/admin/accounts"),
    await admin("/admin/export.csv"),
  ]) {
    assert.equal(res.status, 200);
    await assertNoHashes(res);
  }
});
