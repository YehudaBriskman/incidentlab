// Audit actors (#185): every entry names who did it (the site owner, or the acting account's id), old entries
// without the field still parse, and the log comes with the names behind its ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AuditResponseSchema, ClassResponseSchema } from "../../shared/contract.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { generateAccountId, sha256Hex } from "../services/crypto.ts";
import { createHarness, expectStatus } from "./helpers.ts";

test("audit entries carry the actor: admin for the owner, the account id for a player", async () => {
  const kv = new InMemoryKvStore();
  const harness = createHarness({ store: kv });
  // An entry from before #185 (no actor) still parses, as null.
  await kv.set("audit:2026-01-01T00:00:00.000Z:abcd1234", { at: "2026-01-01T00:00:00.000Z", action: "event.save", target: null, detail: null, via: "key" });

  const id = generateAccountId();
  const token = randomBytes(32).toString("base64url");
  const nowIso = new Date().toISOString();
  await kv.set(`account:${id}`, {
    id, username: "dana_k", usernameKey: "dana_k", passwordHash: "x", status: "approved", sessionEpoch: 0,
    createdAt: nowIso, decidedAt: nowIso, lastSeenAt: nowIso, lastLoginAt: null,
  });
  await kv.set(`session:${sha256Hex(token)}`, { role: "player", accountId: id, epoch: 0, createdAt: nowIso, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const asPlayer = (path: string, body: unknown): Promise<Response> =>
    harness.app.handle(
      new Request(`http://localhost/api${path}`, { method: "POST", headers: { cookie: `il_session=${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
      "10.0.0.5",
    );

  const created = await asPlayer("/classes", { name: "Night shift" });
  await expectStatus(created.clone(), 201);
  const classId = ClassResponseSchema.parse(await created.json()).class.id;
  await expectStatus(harness.admin(`/admin/accounts/${id}/role`, { method: "PUT", body: { role: "author" } }), 200);

  const res = await harness.admin("/admin/audit?limit=10");
  await expectStatus(res.clone(), 200);
  const log = AuditResponseSchema.parse(await res.json());
  const create = log.entries.find((e) => e.action === "class.create");
  const role = log.entries.find((e) => e.action === "account.role");
  const old = log.entries.find((e) => e.action === "event.save");
  assert.equal(create?.actor, id);
  assert.equal(create?.via, "session");
  assert.equal(role?.actor, "admin");
  assert.equal(role?.via, "key");
  assert.equal(old?.actor, null);
  // The names behind the ids: the actor's username, the class's name and the role target's username.
  assert.equal(log.names[id], "dana_k");
  assert.equal(log.names[classId], "Night shift");
});
