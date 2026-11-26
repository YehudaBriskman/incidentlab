import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_POLL_ACTIVE_MS, EVENT_POLL_IDLE_MS, EVENT_SOON_MS, eventPollDelay, isCacheHit, responseServerMs, skewFrom } from "./clock.ts";

test("skew is server time minus the request's local midpoint", () => {
  assert.equal(skewFrom({ serverMs: 10_500, sentAt: 1_000, receivedAt: 1_000 }), 9_500);
  assert.equal(skewFrom({ serverMs: 2_000, sentAt: 1_000, receivedAt: 3_000 }), 0);
});

test("Netlify cache hits are recognised, misses and forwards are not", () => {
  assert.equal(isCacheHit('"Netlify Edge"; hit'), true);
  assert.equal(isCacheHit('"Netlify Durable"; hit; ttl=7'), true);
  assert.equal(isCacheHit('"Netlify Edge"; hit; fwd=stale'), true);
  assert.equal(isCacheHit('"Netlify Edge"; fwd=miss'), false);
  assert.equal(isCacheHit(null), false);
});

test("a cached body time is moved forward by Age, and ignored without it", () => {
  assert.equal(responseServerMs(50_000, false, null), 50_000, "origin response: exact");
  assert.equal(responseServerMs(50_000, true, "12"), 62_000, "cache hit: body time + Age");
  assert.equal(responseServerMs(50_000, true, null), null, "cache hit without Age: unknown");
  assert.equal(responseServerMs(50_000, true, "soon"), null);
  assert.equal(responseServerMs(Number.NaN, false, null), null);
});

test("the event poll stops in hidden tabs and slows down when nothing is live", () => {
  assert.equal(eventPollDelay({ kind: "running" }, true), null);
  assert.equal(eventPollDelay({ kind: "none" }, true), null);
  assert.equal(eventPollDelay({ kind: "running" }, false), EVENT_POLL_ACTIVE_MS);
  assert.equal(eventPollDelay({ kind: "before", msLeft: EVENT_SOON_MS }, false), EVENT_POLL_ACTIVE_MS);
  assert.equal(eventPollDelay({ kind: "before", msLeft: EVENT_SOON_MS + 1 }, false), EVENT_POLL_IDLE_MS);
  assert.equal(eventPollDelay({ kind: "none" }, false), EVENT_POLL_IDLE_MS);
  assert.equal(eventPollDelay({ kind: "over" }, false), EVENT_POLL_IDLE_MS);
});
