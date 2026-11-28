// Owner and author tools (#234, #235): the owner overview's aggregates and its hourly usage cache, the review
// screen's content preview (public content only), "request author access", and assigning a private case to the
// author's classes in one step. Packages are built in memory from package-fixture.ts (made-up answers only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewContentResponseSchema, SetCaseClassesResponseSchema } from "../../shared/author-contract.ts";
import {
  AccountResponseSchema,
  AdminOverviewSchema,
  AuditResponseSchema,
  AuthorAccessRequestResponseSchema,
  AuthorAccessRequestsResponseSchema,
  ClassResponseSchema,
  FUNCTION_CALL_LIMIT,
} from "../../shared/contract.ts";
import type { ClassDetail } from "../../shared/contract.ts";
import { uploadCasePackage } from "../../shared/upload-client.ts";
import type { UploadTransport } from "../../shared/upload-client.ts";
import type { UsageReport } from "../ops/netlify-usage.ts";
import { InMemoryByteStore } from "../repositories/ByteStore.ts";
import type { Versioned } from "../repositories/KvStore.ts";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { createApp } from "../router.ts";
import { generateAccountId } from "../services/crypto.ts";
import type { UsageSource } from "../services/UsageService.ts";
import { ADMIN_KEY, SECRETS, expectStatus } from "./helpers.ts";
import { ANSWERS, COMMAND, HINT, build, fixture } from "./package-fixture.ts";

const CASE = "dana-case";
const NOW = Date.parse("2026-11-28T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** Counts reads by key prefix, so a test can check what a call did not read. */
class CountingStore extends InMemoryKvStore {
  readonly reads = new Map<string, number>();
  override get(key: string): Promise<Versioned<unknown> | null> {
    const prefix = key.slice(0, key.indexOf(":") + 1);
    this.reads.set(prefix, (this.reads.get(prefix) ?? 0) + 1);
    return super.get(key);
  }
}

const setup = (options: { usage?: UsageSource } = {}) => {
  const kv = new CountingStore();
  let nowMs = NOW;
  const app = createApp({ store: kv, bytes: new InMemoryByteStore(), staticSecrets: SECRETS, adminKey: () => ADMIN_KEY, now: () => new Date(nowMs), ...(options.usage ? { usage: options.usage } : {}) });
  const as = (who: { key: string } | { cookie: string } | null): UploadTransport => (path, init) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: init.method,
        headers: { ...init.headers, ...(who && "key" in who ? { "x-admin-key": who.key } : {}), ...(who && "cookie" in who ? { cookie: `il_session=${who.cookie}` } : {}) },
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
      `10.1.${Math.floor(Math.random() * 250)}.1`,
    );
  const admin = as({ key: ADMIN_KEY });
  const anonymous = as(null);
  const call = (send: UploadTransport, path: string, method = "GET", body?: unknown): Promise<Response> =>
    send(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const parse = async <T>(res: Promise<Response>, schema: { parse(value: unknown): T }, status = 200): Promise<T> => {
    const r = await res;
    const text = await r.text();
    assert.equal(r.status, status, text);
    return schema.parse(JSON.parse(text));
  };
  const account = async (username: string, role: "author" | "player" = "player"): Promise<{ id: string; send: UploadTransport }> => {
    const res = await call(anonymous, "/api/auth/register", "POST", { username, password: "hunter2hunter2" });
    assert.equal(res.status, 201, await res.clone().text());
    const cookie = /il_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(cookie);
    const { account: view } = AccountResponseSchema.parse(await res.json());
    if (role === "author") await expectStatus(call(admin, `/api/admin/accounts/${view.id}/role`, "PUT", { role: "author" }), 200);
    return { id: view.id, send: as({ cookie }) };
  };
  const createClass = async (owner: UploadTransport, name: string): Promise<ClassDetail> => {
    const res = await call(owner, "/api/classes", "POST", { name });
    assert.equal(res.status, 201, await res.clone().text());
    return ClassResponseSchema.parse(await res.json()).class;
  };
  const publishPrivately = async (author: UploadTransport, id = CASE) =>
    uploadCasePackage(await build(fixture(id)), { send: author, sleep: () => Promise.resolve(), publish: true });
  const overview = () => parse(call(admin, "/api/admin/overview"), AdminOverviewSchema);
  const at = (ms: number): void => {
    nowMs = ms;
  };
  return { kv, app, admin, anonymous, call, parse, account, createClass, publishPrivately, overview, at };
};

const seedAccount = async (kv: InMemoryKvStore, fields: Record<string, unknown>): Promise<void> => {
  const id = generateAccountId();
  await kv.set(`account:${id}`, {
    id, username: `u_${id}`, usernameKey: `u_${id}`.toLowerCase(), passwordHash: "x", status: "approved", sessionEpoch: 0,
    createdAt: new Date(NOW).toISOString(), decidedAt: null, lastSeenAt: null, lastLoginAt: null, ...fields,
  });
};

test("overview: sign-ups per day (users vs guests), active players, classes, queues; never reads progress", async () => {
  const s = setup();
  const iso = (ms: number): string => new Date(ms).toISOString();
  // Today 2 users + 1 guest; yesterday 1 user; 10 days ago 1 guest; 40 days ago 1 user (outside the 30 days).
  await seedAccount(s.kv, { createdAt: iso(NOW - 60_000), lastSeenAt: iso(NOW - 60_000) });
  await seedAccount(s.kv, { createdAt: iso(NOW - 120_000), lastSeenAt: iso(NOW - 3 * DAY), role: "author" });
  await seedAccount(s.kv, { createdAt: iso(NOW - 180_000), kind: "guest", lastSeenAt: iso(NOW - 180_000) });
  await seedAccount(s.kv, { createdAt: iso(NOW - DAY), lastSeenAt: iso(NOW - 20 * DAY), status: "rejected" });
  await seedAccount(s.kv, { createdAt: iso(NOW - 10 * DAY), kind: "guest", hiddenFromBoards: true });
  await seedAccount(s.kv, { createdAt: iso(NOW - 40 * DAY), lastSeenAt: iso(NOW - 40 * DAY), status: "pending" });
  // A progress record that must not be read.
  await s.kv.set("progress:alpha:AAAAAAAAAAAA", { accountId: "AAAAAAAAAAAA" });

  const o = await s.overview();
  assert.equal(o.timezone, "Asia/Jerusalem");
  assert.equal(o.signups.length, 30);
  assert.equal(o.signups.at(-1)?.date, "2026-11-28");
  assert.deepEqual(o.signups.at(-1), { date: "2026-11-28", users: 2, guests: 1 });
  assert.deepEqual(o.signups.at(-2), { date: "2026-11-27", users: 1, guests: 0 });
  assert.deepEqual(o.signups.at(-11), { date: "2026-11-18", users: 0, guests: 1 });
  assert.equal(o.signups.reduce((n, d) => n + d.users + d.guests, 0), 5, "the 40-day-old sign-up is outside the window");
  assert.deepEqual(o.accounts, { users: 4, guests: 2, authors: 1, banned: 1, hidden: 1 });
  assert.deepEqual(o.active, { d1: 2, d7: 3, d30: 4 });
  assert.deepEqual(o.queues, { reviews: 0, resetRequests: 0, authorRequests: 0, pendingSignups: 1 });
  assert.equal(o.usage.status, "not-configured");
  assert.equal(o.usage.limit, FUNCTION_CALL_LIMIT);
  assert.equal(s.kv.reads.get("progress:") ?? 0, 0, "the overview never reads progress");
  assert.equal(s.kv.reads.get("score:") ?? 0, 0);

  // Players can't see it.
  const player = await s.account("curious");
  await expectStatus(s.call(player.send, "/api/admin/overview"), 401);
  const res = await s.call(s.admin, "/api/admin/overview");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("overview: classes (active, archived, live events now), pending reviews and author requests", async () => {
  const s = setup();
  const ada = await s.account("ada_teacher");
  const live = await s.createClass(ada.send, "Live tonight");
  await s.createClass(ada.send, "Quiet class");
  const old = await s.createClass(ada.send, "Old class");
  await expectStatus(s.call(ada.send, `/api/classes/${old.id}/archive`, "POST", {}), 200);
  const startsAt = new Date(NOW - 30 * 60_000).toISOString();
  const endsAt = new Date(NOW + 60 * 60_000).toISOString();
  await expectStatus(s.call(ada.send, `/api/classes/${live.id}`, "PATCH", { event: { name: "Night", startsAt, endsAt, freezeAt: null, announcement: null } }), 200);

  const dana = await s.account("dana_author", "author");
  await s.publishPrivately(dana.send);
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/submit-review`, "POST", {}), 200);
  const eve = await s.account("eve_writer");
  await expectStatus(s.call(eve.send, "/api/me/author-request", "POST", { note: "I teach DNS" }), 201);

  const o = await s.overview();
  assert.deepEqual(o.classes, { active: 2, archived: 1, liveEvents: 1 });
  assert.equal(o.queues.reviews, 1);
  assert.equal(o.queues.authorRequests, 1);
});

test("overview usage: read from the Netlify API at most once an hour, cached in Blobs; 0 means not reported", async () => {
  let calls = 0;
  let functions = 41_250;
  let fail = false;
  const report = (): UsageReport => ({
    account: "team", plan: "Free", periodStart: "2026-11-01T00:00:00Z", periodEnd: "2026-12-01T00:00:00Z",
    rows: [
      { label: "Bandwidth", used: 3 * 1024 ** 3, included: 100 * 1024 ** 3, unit: "bytes" },
      { label: "Function calls", used: functions, included: 125_000, unit: "count" },
    ],
  });
  let token: string | undefined;
  const source: UsageSource = {
    token: () => token,
    siteId: () => "site-1",
    fetch: (t, site) => {
      calls += 1;
      assert.equal(t, "secret-token");
      assert.equal(site, "site-1");
      return fail ? Promise.reject(new Error("HTTP 500")) : Promise.resolve(report());
    },
  };
  const s = setup({ usage: source });
  assert.equal((await s.overview()).usage.status, "not-configured");
  assert.equal(calls, 0, "no token: no API call");

  token = "secret-token";
  const first = (await s.overview()).usage;
  assert.equal(first.status, "ok");
  assert.equal(first.functionCalls, 41_250);
  assert.equal(first.limit, 125_000);
  assert.equal(first.bandwidthBytes, 3 * 1024 ** 3);
  assert.equal(first.periodEnd, "2026-12-01T00:00:00Z");
  functions = 50_000;
  assert.equal((await s.overview()).usage.functionCalls, 41_250, "served from the cache");
  assert.equal(calls, 1);
  assert.ok((await s.kv.get("config:usage")) !== null, "the cache lives in Blobs");

  s.at(NOW + 61 * 60_000);
  assert.equal((await s.overview()).usage.functionCalls, 50_000);
  assert.equal(calls, 2);

  functions = 0; // the legacy plan reports 0: unknown, never "0 calls"
  s.at(NOW + 122 * 60_000);
  const zero = (await s.overview()).usage;
  assert.equal(zero.status, "not-reported");
  assert.equal(zero.functionCalls, null);

  fail = true;
  s.at(NOW + 183 * 60_000);
  const failed = (await s.overview()).usage;
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /HTTP 500/);
  await s.overview();
  assert.equal(calls, 4, "an error is cached too");
});

test("review content: the owner reads the reviewed version's public content per language, with no answers", async () => {
  const s = setup();
  const dana = await s.account("dana_author", "author");
  await s.publishPrivately(dana.send);
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/submit-review`, "POST", {}), 200);

  const en = await s.parse(s.call(s.admin, `/api/admin/cases/${CASE}/review-content?lang=en`), ReviewContentResponseSchema);
  assert.equal(en.caseId, CASE);
  assert.equal(en.version, 1);
  assert.equal(en.lang, "en");
  assert.ok(en.content.questions.length > 0);
  const text = JSON.stringify(en.content);
  for (const answer of Object.values(ANSWERS)) assert.ok(!text.includes(answer), `answer ${answer} leaked`);
  assert.ok(!text.includes(HINT("q1", 1)), "hint text leaked");
  assert.ok(!text.includes(COMMAND), "command leaked");
  // No Hebrew content in this package: English is served.
  const he = await s.parse(s.call(s.admin, `/api/admin/cases/${CASE}/review-content?lang=he`), ReviewContentResponseSchema);
  assert.equal(he.lang, "en");

  await expectStatus(s.call(dana.send, `/api/admin/cases/${CASE}/review-content?lang=en`), 403, "not-admin");
  await expectStatus(s.call(s.admin, "/api/admin/cases/no-such-case/review-content"), 404);
  await expectStatus(s.call(s.admin, `/api/admin/cases/${CASE}/review-content?lang=fr`), 400);
});

test("author access: a player asks once (the note can change), the owner grants or declines, rate-limited, audited", async () => {
  const s = setup();
  const eve = await s.account("eve_writer");
  assert.equal((await s.parse(s.call(eve.send, "/api/me/author-request"), AuthorAccessRequestResponseSchema)).request, null);
  const first = await s.parse(s.call(eve.send, "/api/me/author-request", "POST", { note: "A DNS case" }), AuthorAccessRequestResponseSchema, 201);
  assert.equal(first.request?.note, "A DNS case");
  s.at(NOW + 60_000);
  const second = await s.parse(s.call(eve.send, "/api/me/author-request", "POST", { note: "A TLS case" }), AuthorAccessRequestResponseSchema, 201);
  assert.equal(second.request?.note, "A TLS case");
  assert.equal(second.request?.createdAt, first.request?.createdAt, "the request keeps its place in the queue");
  await expectStatus(s.call(eve.send, "/api/me/author-request", "POST", {}), 201);
  await expectStatus(s.call(eve.send, "/api/me/author-request", "POST", {}), 429, "rate-limited");
  await expectStatus(s.call(eve.send, "/api/me/author-request", "POST", { note: "x".repeat(301) }), 400);

  const queue = await s.parse(s.call(s.admin, "/api/admin/author-requests"), AuthorAccessRequestsResponseSchema);
  assert.deepEqual(queue.requests.map((r) => [r.username, r.note]), [["eve_writer", null]]);
  await expectStatus(s.call(eve.send, "/api/admin/author-requests"), 401);

  const granted = await s.parse(s.call(s.admin, `/api/admin/author-requests/${eve.id}/approve`, "POST", {}), AccountResponseSchema);
  assert.equal(granted.account.role, "author");
  assert.equal((await s.parse(s.call(s.admin, "/api/admin/author-requests"), AuthorAccessRequestsResponseSchema)).requests.length, 0);
  await expectStatus(s.call(s.admin, `/api/admin/author-requests/${eve.id}/approve`, "POST", {}), 404, "no-author-request");
  // An author can't ask again.
  await expectStatus(s.call(eve.send, "/api/me/author-request", "POST", {}), 409, "already-author");

  const finn = await s.account("finn_maybe");
  await expectStatus(s.call(finn.send, "/api/me/author-request", "POST", {}), 201);
  await expectStatus(s.call(s.admin, `/api/admin/author-requests/${finn.id}/reject`, "POST", {}), 204);
  assert.equal((await s.parse(s.call(finn.send, "/api/me/author-request"), AuthorAccessRequestResponseSchema)).request, null);

  // Guests can't ask; signed out is a 401.
  const guestRes = await s.call(s.anonymous, "/api/guest", "POST", {});
  const guestCookie = /il_session=([^;]*)/.exec(guestRes.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const guestCall: UploadTransport = (path, init) => s.app.handle(new Request(`http://localhost${path}`, { method: init.method, headers: { ...init.headers, cookie: `il_session=${guestCookie}` }, ...(init.body === undefined ? {} : { body: init.body }) }), "10.5.5.5");
  await expectStatus(s.call(guestCall, "/api/me/author-request", "POST", {}), 403, "guest");
  await expectStatus(s.call(s.anonymous, "/api/me/author-request", "POST", {}), 401);

  const audit = AuditResponseSchema.parse(await (await s.call(s.admin, "/api/admin/audit")).json()).entries.map((e) => e.action);
  assert.ok(audit.includes("author.request") && audit.includes("author.request-decline"));
  assert.ok(audit.filter((a) => a === "account.role").length >= 1);
});

test("one-step assignment: saving the case's classes also puts it on those classes' case lists", async () => {
  const s = setup();
  const dana = await s.account("dana_author", "author");
  const mine = await s.createClass(dana.send, "Dana's class");
  const theirs = await s.createClass((await s.account("other_teacher")).send, "Not Dana's");

  // A draft only: assigned, but it can't be listed until it is live.
  await uploadCasePackage(await build(fixture(CASE)), { send: dana.send, sleep: () => Promise.resolve(), publish: false });
  const draft = await s.parse(s.call(dana.send, `/api/author/cases/${CASE}/classes`, "PUT", { classIds: [mine.id], addToClassCases: true }), SetCaseClassesResponseSchema);
  assert.deepEqual(draft.addedToClasses, []);

  await s.publishPrivately(dana.send);
  const res = await s.parse(s.call(dana.send, `/api/author/cases/${CASE}/classes`, "PUT", { classIds: [mine.id], addToClassCases: true }), SetCaseClassesResponseSchema);
  assert.deepEqual(res.case.classIds, [mine.id]);
  assert.deepEqual(res.addedToClasses, [mine.id]);
  const detail = ClassResponseSchema.parse(await (await s.call(dana.send, `/api/classes/${mine.id}`)).json()).class;
  assert.deepEqual(detail.caseIds, [CASE]);
  // Idempotent, and the old two-step call (no flag) leaves the case lists alone.
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/classes`, "PUT", { classIds: [mine.id], addToClassCases: true }), 200);
  assert.deepEqual(ClassResponseSchema.parse(await (await s.call(dana.send, `/api/classes/${mine.id}`)).json()).class.caseIds, [CASE]);
  const plain = await s.parse(s.call(dana.send, `/api/author/cases/${CASE}/classes`, "PUT", { classIds: [mine.id] }), SetCaseClassesResponseSchema);
  assert.deepEqual(plain.addedToClasses, []);
  // A class the author doesn't admin is still refused.
  await expectStatus(s.call(dana.send, `/api/author/cases/${CASE}/classes`, "PUT", { classIds: [mine.id, theirs.id], addToClassCases: true }), 403, "not-class-admin");
  const audit = AuditResponseSchema.parse(await (await s.call(s.admin, "/api/admin/audit")).json()).entries;
  assert.ok(audit.some((e) => e.action === "case.classes" && (e.detail ?? "").includes("on the case list of")));
});
