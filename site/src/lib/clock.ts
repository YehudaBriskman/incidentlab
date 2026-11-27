// Pure helpers for the server clock and the event poll (no DOM, no imports: unit-tested in node).
//
// Countdowns run on the server's clock. Since the public GETs are CDN-cached (server publicJson), a response
// may be up to ~15 minutes old (/api/event with no event near, #242), so its body time can't be trusted blindly:
// - a response that came from the origin (not a cache hit) is exact;
// - a cache hit with an `Age` header is exact to about a second (its time + Age);
// - a cache hit without `Age` says nothing about "now", so it is ignored.

/** One reading of the server clock: `serverMs` was true at some moment between `sentAt` and `receivedAt`. */
export type ClockSample = { readonly serverMs: number; readonly sentAt: number; readonly receivedAt: number };

/** serverTime − local time, in ms (positive when the local clock is behind). */
export function skewFrom(sample: ClockSample): number {
  return sample.serverMs - (sample.sentAt + sample.receivedAt) / 2;
}

/** True when Netlify's `Cache-Status` header says the CDN answered (e.g. `"Netlify Edge"; hit`). */
export function isCacheHit(cacheStatus: string | null): boolean {
  return cacheStatus !== null && /;\s*hit\b/i.test(cacheStatus);
}

/**
 * The server time a response stands for right now, or null when it can't be told. `bodyMs` is the time the
 * server wrote into the body (or its `Date` header); `ageHeader` is the `Age` header of a cached response.
 */
export function responseServerMs(bodyMs: number, cacheHit: boolean, ageHeader: string | null): number | null {
  if (!Number.isFinite(bodyMs)) return null;
  if (!cacheHit) return bodyMs;
  if (ageHeader === null) return null;
  const age = Number(ageHeader);
  return Number.isFinite(age) && age >= 0 ? bodyMs + age * 1000 : null;
}

/** Event phases that drive the poll cadence (mirrors lib/event.ts EventPhase). */
export type PollPhase = { kind: "none" } | { kind: "before"; msLeft: number } | { kind: "running" } | { kind: "over" };

/** Poll often around a live event, rarely otherwise; an instructor's change is purged from the CDN at once. */
export const EVENT_POLL_ACTIVE_MS = 30_000;
export const EVENT_POLL_IDLE_MS = 120_000;
/** An event that starts within this window counts as live (the countdown is on screen). */
export const EVENT_SOON_MS = 60 * 60_000;

/** Milliseconds until the next event poll, or null while the tab is hidden (no polling at all then). */
export function eventPollDelay(phase: PollPhase, hidden: boolean): number | null {
  if (hidden) return null;
  const live = phase.kind === "running" || (phase.kind === "before" && phase.msLeft <= EVENT_SOON_MS);
  return live ? EVENT_POLL_ACTIVE_MS : EVENT_POLL_IDLE_MS;
}
