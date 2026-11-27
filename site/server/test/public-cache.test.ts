// The public GETs (/api/event, /api/today, /api/leaderboard) are CDN-cacheable and never personalised;
// instructor writes purge them by tag; personalised routes stay no-store (issue #140).
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryKvStore } from "../repositories/KvStore.ts";
import { eventCacheWindow } from "../controllers/AuthController.ts";
import { createApp } from "../router.ts";
import type { CachePurger, CacheTag } from "../services/CachePurger.ts";
import { secondsUntilNextDay } from "../services/ScheduleService.ts";
import { ADMIN_KEY, SECRETS } from "./helpers.ts";

const purges: CacheTag[][] = [];
const spy: CachePurger = {
  purge: (tags) => {
    purges.push([...tags]);
    return Promise.resolve();
  },
};

const setup = (now = () => new Date("2026-11-26T12:00:00Z")) => {
  purges.length = 0;
  const app = createApp({ store: new InMemoryKvStore(), staticSecrets: SECRETS, adminKey: () => ADMIN_KEY, now, cachePurger: spy });
  const call = (path: string, init: { method?: string; body?: unknown; admin?: boolean; cookie?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (init.admin) headers["x-admin-key"] = ADMIN_KEY;
    if (init.cookie) headers["cookie"] = init.cookie;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return app.handle(
      new Request(`http://localhost/api${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
      "10.0.0.9",
    );
  };
  return { call };
};

for (const [path, tag] of [["/event", "event"], ["/leaderboard", "leaderboard"], ["/leaderboard?caseId=alpha", "leaderboard"], ["/today", "today"]] as const) {
  test(`GET /api${path} is CDN-cacheable, keyed on the URL only, and tagged "${tag}"`, async () => {
    const { call } = setup();
    const res = await call(path, { cookie: "il_session=someone-elses-session" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate", "browsers always revalidate");
    assert.match(res.headers.get("netlify-cdn-cache-control") ?? "", /^public, durable, max-age=\d+, stale-while-revalidate=\d+$/);
    assert.equal(res.headers.get("netlify-cache-tag"), tag);
    assert.equal(res.headers.get("netlify-vary"), "query", "the cache never varies on (or stores) a cookie");
    assert.equal(res.headers.get("set-cookie"), null, "a cacheable response must never set a cookie");
  });
}

test("personalised routes stay no-store", async () => {
  const { call } = setup();
  for (const path of ["/session", "/admin/accounts"]) {
    const res = await call(path, { admin: path.startsWith("/admin") });
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.equal(res.headers.get("netlify-cdn-cache-control"), null, path);
  }
});

test("a cached today never outlives its day", async () => {
  // 23:59:30 in Jerusalem (UTC+2): 30 s left, so both windows shrink to fit before midnight.
  const { call } = setup(() => new Date("2026-11-26T21:59:30Z"));
  assert.equal((await call("/admin/schedule", { method: "PUT", admin: true, body: { timezone: "Asia/Jerusalem", defaultCaseId: "alpha", days: {}, lockToToday: false } })).status, 200);
  const res = await call("/today");
  const header = res.headers.get("netlify-cdn-cache-control") ?? "";
  const maxAge = Number(/max-age=(\d+)/.exec(header)?.[1]);
  const stale = Number(/stale-while-revalidate=(\d+)/.exec(header)?.[1]);
  assert.ok(maxAge + stale <= 30, `max-age ${maxAge} + stale ${stale} must fit in the 30 s left`);
  assert.ok(maxAge >= 1);
});

test("secondsUntilNextDay counts to local midnight", () => {
  assert.equal(secondsUntilNextDay(new Date("2026-11-26T21:59:30Z"), "Asia/Jerusalem"), 30);
  assert.equal(secondsUntilNextDay(new Date("2026-11-26T00:00:00Z"), "UTC"), 86_400);
  assert.equal(secondsUntilNextDay(new Date("2026-11-26T12:00:00Z"), "UTC"), 43_200);
});

test("instructor writes purge the public responses they change", async () => {
  const { call } = setup();
  const event = { name: "Night", startsAt: null, endsAt: null, freezeAt: null, enforceWindow: false, announcement: null };
  assert.equal((await call("/admin/event", { method: "PUT", admin: true, body: event })).status, 200);
  assert.deepEqual(purges.at(-1), ["event", "leaderboard"]);
  assert.equal((await call("/admin/schedule", { method: "PUT", admin: true, body: { timezone: "UTC", defaultCaseId: null, days: {}, lockToToday: false } })).status, 200);
  assert.deepEqual(purges.at(-1), ["today"]);
  // A refused write purges nothing.
  const before = purges.length;
  assert.equal((await call("/admin/schedule", { method: "PUT", admin: true, body: { timezone: "Mars/Olympus", defaultCaseId: null, days: {}, lockToToday: false } })).status, 400);
  assert.equal(purges.length, before);
});

const ev = (startsAt: string | null, endsAt: string | null) => ({ name: "Night", startsAt, endsAt, freezeAt: null, enforceWindow: false, announcement: null });
const NOW = Date.parse("2026-11-26T12:00:00Z");
const SHORT = { maxAgeSeconds: 10, staleSeconds: 20 };
const QUIET = { maxAgeSeconds: 300, staleSeconds: 600 };

test("the event window is long while no event is near, and short around one (#242)", () => {
  assert.deepEqual(eventCacheWindow(ev(null, null), NOW), QUIET, "a name or announcement only");
  assert.deepEqual(eventCacheWindow(ev("2026-11-27T19:00:00Z", "2026-11-27T21:00:00Z"), NOW), QUIET, "tomorrow");
  assert.deepEqual(eventCacheWindow(ev("2026-11-26T12:15:01Z", null), NOW), QUIET, "starts just past the 15-minute reach");
  assert.deepEqual(eventCacheWindow(ev("2026-11-26T12:15:00Z", null), NOW), SHORT, "starts within the reach");
  assert.deepEqual(eventCacheWindow(ev("2026-11-26T11:00:00Z", "2026-11-26T13:00:00Z"), NOW), SHORT, "running");
  assert.deepEqual(eventCacheWindow(ev("2026-11-26T11:00:00Z", null), NOW), SHORT, "running, open-ended");
  assert.deepEqual(eventCacheWindow(ev(null, "2026-11-26T12:05:00Z"), NOW), SHORT, "no start, ends soon");
  assert.deepEqual(eventCacheWindow(ev("2026-11-26T09:00:00Z", "2026-11-26T11:00:00Z"), NOW), QUIET, "over");
});

test("GET /api/event sends the quiet window with no event near, the short one during an event, and edits purge it", async () => {
  const { call } = setup();
  const header = async (): Promise<string> => (await call("/event")).headers.get("netlify-cdn-cache-control") ?? "";
  assert.equal(await header(), "public, durable, max-age=300, stale-while-revalidate=600");
  assert.equal((await call("/admin/event", { method: "PUT", admin: true, body: ev("2026-11-26T11:30:00Z", "2026-11-26T13:30:00Z") })).status, 200);
  assert.deepEqual(purges.at(-1), ["event", "leaderboard"], "the edit reaches every cached copy at once");
  assert.equal(await header(), "public, durable, max-age=10, stale-while-revalidate=20");
});
