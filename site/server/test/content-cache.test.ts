// The public content routes (GET /api/cases, GET /api/cases/:id/content) are durable at the CDN for 1 h plus a
// day stale, tagged `catalog` and `case:<id>`, and every change to a case's live version purges both (#243).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DeleteCaseResponseSchema } from "../../shared/author-contract.ts";
import { AccountResponseSchema } from "../../shared/contract.ts";
import { uploadCasePackage } from "../../shared/upload-client.ts";
import type { UploadTransport } from "../../shared/upload-client.ts";
import { InMemoryByteStore } from "../repositories/ByteStore.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { createApp } from "../router.ts";
import type { CachePurger, CacheTag } from "../services/CachePurger.ts";
import { ADMIN_KEY, SECRETS, expectStatus } from "./helpers.ts";
import { ID, build, fixture } from "./package-fixture.ts";

const DURABLE = "public, durable, max-age=3600, stale-while-revalidate=86400";
const CHANGE: CacheTag[] = ["catalog", `case:${ID}`];

const setup = () => {
  const purges: CacheTag[][] = [];
  const spy: CachePurger = {
    purge: (tags) => {
      purges.push([...tags]);
      return Promise.resolve();
    },
  };
  const app = createApp({ store: new InMemoryKvStore(), bytes: new InMemoryByteStore(), staticSecrets: SECRETS, adminKey: () => ADMIN_KEY, cachePurger: spy });
  const as = (who: { key: string } | { cookie: string } | null): UploadTransport => (path, init) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: init.method,
        headers: { ...init.headers, ...(who && "key" in who ? { "x-admin-key": who.key } : {}), ...(who && "cookie" in who ? { cookie: `il_session=${who.cookie}` } : {}) },
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
      "10.1.1.2",
    );
  const admin = as({ key: ADMIN_KEY });
  const anonymous = as(null);
  const call = (send: UploadTransport, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    send(path, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const author = async (username: string): Promise<UploadTransport> => {
    const res = await call(anonymous, "/api/auth/register", "POST", { username, password: "hunter2hunter2" });
    assert.equal(res.status, 201);
    const cookie = /il_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(cookie);
    const { account } = AccountResponseSchema.parse(await res.json());
    await expectStatus(call(admin, `/api/admin/accounts/${account.id}/approve`, "POST", {}), 200);
    await expectStatus(call(admin, `/api/admin/accounts/${account.id}/role`, "PUT", { role: "author" }), 200);
    return as({ cookie });
  };
  return { purges, admin, anonymous, call, author };
};

const noSleep = (): Promise<void> => Promise.resolve();

const assertDurable = (res: Response, tag: string): void => {
  assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate", "browsers always ask the CDN, so a purge reaches them");
  assert.equal(res.headers.get("netlify-cdn-cache-control"), DURABLE);
  assert.equal(res.headers.get("netlify-cache-tag"), tag);
  assert.equal(res.headers.get("netlify-vary"), "query");
  assert.equal(res.headers.get("set-cookie"), null);
};

test("catalog and public content are durable, tagged and keep their headers on a 304", async () => {
  const s = setup();
  await uploadCasePackage(await build(fixture()), { send: s.admin, sleep: noSleep, publish: true });

  const catalog = await s.call(s.anonymous, "/api/cases");
  assert.equal(catalog.status, 200);
  assertDurable(catalog, "catalog");
  const notModified = await s.call(s.anonymous, "/api/cases", "GET", undefined, { "if-none-match": catalog.headers.get("etag") ?? "" });
  assert.equal(notModified.status, 304);
  assertDurable(notModified, "catalog");

  for (const lang of ["en", "he"]) {
    const content = await s.call(s.anonymous, `/api/cases/${ID}/content?lang=${lang}&v=1`);
    assert.equal(content.status, 200);
    assertDurable(content, `case:${ID}`);
    const again = await s.call(s.anonymous, `/api/cases/${ID}/content?lang=${lang}&v=1`, "GET", undefined, { "if-none-match": content.headers.get("etag") ?? "" });
    assert.equal(again.status, 304);
    assertDurable(again, `case:${ID}`);
  }

  // A miss is never cached, so an unknown or unpublished case can't stick at the edge.
  const missing = await s.call(s.anonymous, "/api/cases/nope/content");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.equal(missing.headers.get("netlify-cdn-cache-control"), null);
});

test("publish, rollback, delete and both restores purge the catalog and the case", async () => {
  const s = setup();
  await uploadCasePackage(await build(fixture()), { send: s.admin, sleep: noSleep, publish: true });
  assert.deepEqual(s.purges.at(-1), CHANGE, "first publish");

  const v2 = fixture();
  v2.content["title"] = "Fixture case, take two";
  await uploadCasePackage(await build(v2), { send: s.admin, sleep: noSleep });
  const afterDraft = s.purges.length;
  assert.equal(afterDraft, 1, "a draft upload changes nothing public, so it purges nothing");

  await expectStatus(s.call(s.admin, `/api/author/cases/${ID}/publish`, "POST", { version: 2 }), 200);
  assert.deepEqual(s.purges.at(-1), CHANGE, "publish v2");
  await expectStatus(s.call(s.admin, `/api/author/cases/${ID}/publish`, "POST", { version: 1 }), 200);
  assert.deepEqual(s.purges.at(-1), CHANGE, "rollback to v1");
  const count = s.purges.length;
  await expectStatus(s.call(s.admin, `/api/author/cases/${ID}/publish`, "POST", { version: 1 }), 200);
  assert.equal(s.purges.length, count, "re-publishing the live version changes nothing and purges nothing");

  // Unpublish (soft delete), then restore from the author route.
  await expectStatus(s.call(s.admin, `/api/author/cases/${ID}`, "DELETE"), 200);
  assert.deepEqual(s.purges.at(-1), CHANGE, "delete");
  await expectStatus(s.call(s.admin, `/api/author/cases/${ID}/restore`, "POST", {}), 200);
  assert.deepEqual(s.purges.at(-1), CHANGE, "author restore");

  // And from the admin trash.
  const deleted = DeleteCaseResponseSchema.parse(await (await s.call(s.admin, `/api/author/cases/${ID}`, "DELETE")).json());
  const before = s.purges.length;
  await expectStatus(s.call(s.admin, `/api/admin/trash/${encodeURIComponent(deleted.trashId)}/restore`, "POST", {}), 200);
  assert.equal(s.purges.length, before + 1);
  assert.deepEqual(s.purges.at(-1), CHANGE, "admin trash restore");
});

test("review: an approval that makes a case public purges it; a pending version or a rejection does not", async () => {
  const s = setup();
  const dana = await s.author("Dana");
  await uploadCasePackage(await build(fixture()), { send: dana, sleep: noSleep, publish: true }); // private publish
  await expectStatus(s.call(dana, `/api/author/cases/${ID}/submit-review`, "POST", {}), 200);
  await expectStatus(s.call(s.admin, `/api/admin/cases/${ID}/review`, "POST", { decision: "approve", note: null }), 200);
  assert.deepEqual(s.purges.at(-1), CHANGE, "approved: now in the public catalog");

  // A new version of a public case waits for review: the public copy is unchanged, so no purge.
  const v2 = fixture();
  v2.content["title"] = "Fixture case, take two";
  await uploadCasePackage(await build(v2), { send: dana, sleep: noSleep });
  const before = s.purges.length;
  await expectStatus(s.call(dana, `/api/author/cases/${ID}/publish`, "POST", { version: 2 }), 200);
  assert.equal(s.purges.length, before, "pending review");
  await expectStatus(s.call(s.admin, `/api/admin/cases/${ID}/review`, "POST", { decision: "reject", note: "not yet" }), 200);
  assert.equal(s.purges.length, before, "rejected");
});
