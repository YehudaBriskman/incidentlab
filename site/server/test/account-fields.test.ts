// Open-access account fields (#172): additive, so every account stored before them still parses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountViewSchema, SessionResponseSchema } from "../../shared/contract.ts";
import { AccountRecordSchema } from "../domain/types.ts";
import { createHarness } from "./helpers.ts";

test("an account stored before #172 parses with the open-access defaults", () => {
  const old = {
    schemaVersion: 1, id: "abc123def456", username: "ada", usernameKey: "ada", passwordHash: "scrypt$x",
    status: "approved", sessionEpoch: 0, createdAt: "2026-11-01T00:00:00Z", decidedAt: null,
    lastSeenAt: null, lastLoginAt: null, mustChangePassword: false, role: "player",
  };
  const parsed = AccountRecordSchema.parse(old);
  assert.equal(parsed.kind, "user");
  assert.equal(parsed.showOnGlobalBoard, false);
  assert.equal(parsed.recoveryCodeHash, null);
  assert.equal(parsed.classLimit, null);
});

test("an account view from an older server parses with defaults", () => {
  const view = AccountViewSchema.parse({ id: "x", username: "ada", status: "approved", createdAt: "2026-11-01T00:00:00Z", role: "player", mustChangePassword: false });
  assert.equal(view.kind, "user");
  assert.equal(view.showOnGlobalBoard, false);
});

test("a new account reports kind user and is off the global board by default", async () => {
  const h = createHarness();
  const c = h.client();
  const res = await c.call("/auth/register", { body: { username: "new_player", password: "a-good-password-1" } });
  assert.equal(res.status, 201);
  const session = await c.json(await c.call("/session"), SessionResponseSchema);
  assert.equal(session.account?.kind, "user");
  assert.equal(session.account?.showOnGlobalBoard, false);
  // the recovery hash never leaves the server
  assert.equal(JSON.stringify(session).includes("recoveryCodeHash"), false);
});
