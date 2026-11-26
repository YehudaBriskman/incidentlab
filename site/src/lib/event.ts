// The live event (name, window, announcement): polled from GET /api/event and shared by the header banner,
// the countdown, the home page and the leaderboard. Countdowns use the server clock (corrected for skew).
//
// Every open tab runs this poll, so it is the site's biggest source of function calls (Netlify's free plan
// allows 125k a month). It pauses while the tab is hidden, slows to 2 minutes when no event is live, and the
// response is CDN-cached for 10 s (server publicJson), so most polls never reach the function.
import { z } from "zod";
import { EventSchema, type LiveEvent } from "../../shared/contract";
import { fetchEvent, onServerClock } from "./api";
import { eventPollDelay, responseServerMs, skewFrom, type ClockSample } from "./clock";
import { readSnapshot, writeSnapshot } from "./snapshot";
import { TO } from "../i18n/strings-onboard";

type Listener = (event: LiveEvent | null) => void;

/** The last answer, reused for the first paint of the next page load (see lib/snapshot.ts). */
const SNAPSHOT_KEY = "event";
const SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
const SnapshotSchema = z.object({ event: EventSchema, skewMs: z.number() });
const snapshot = readSnapshot(SNAPSHOT_KEY, SnapshotSchema, SNAPSHOT_MAX_AGE_MS);

let current: LiveEvent | null = snapshot?.event ?? null;
/** serverTime − local time, in ms (positive when the local clock is behind). */
let skewMs = snapshot?.skewMs ?? 0;
/** True once an exact (millisecond) reading came from an origin /api/event response; coarser ones then step aside. */
let exactSkew = false;
let timer: number | null = null;
let polling = false;
const listeners = new Set<Listener>();

export function onEventChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function cachedEvent(): LiveEvent | null {
  return current;
}

/** "Now" on the server's clock. */
export function serverNow(): number {
  return Date.now() + skewMs;
}

// Any response the origin answered carries a `Date` header: a whole-second reading, used until the event poll
// gives an exact one (an origin answer to /api/event, whose body time has milliseconds).
onServerClock((sample) => {
  if (!exactSkew) skewMs = skewFrom(sample);
});

async function poll(): Promise<void> {
  try {
    const sentAt = Date.now();
    const { event, serverTime, cacheHit, age } = await fetchEvent();
    const receivedAt = Date.now();
    const serverMs = responseServerMs(Date.parse(serverTime), cacheHit, age);
    if (serverMs !== null) {
      const sample: ClockSample = { serverMs, sentAt, receivedAt };
      // A cached copy is only good to the second (Age): it may not replace an exact origin reading.
      if (!cacheHit || !exactSkew) skewMs = skewFrom(sample);
      if (!cacheHit) exactSkew = true;
    }
    current = event;
    writeSnapshot(SNAPSHOT_KEY, { event, skewMs });
    for (const fn of listeners) fn(event);
  } catch {
    /* keep the last known event; the next poll retries */
  }
}

/** Poll now (e.g. after the server refused an action with "event-closed"). */
export function refreshEvent(): void {
  void poll();
}

function schedule(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  const phase = eventPhase(current);
  const delay = eventPollDelay(phase.kind === "running" ? { kind: "running" } : phase, document.hidden);
  if (delay === null) return; // hidden: nothing until the tab is visible again
  timer = window.setTimeout(() => {
    timer = null;
    void poll().finally(schedule);
  }, delay);
}

/** Starts the poll once per page: now, then on a cadence that follows the event and the tab's visibility. */
export function startEventPolling(): void {
  if (polling) return;
  polling = true;
  void poll().finally(schedule);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) schedule(); // clears the timer
    else void poll().finally(schedule); // catch up at once, then resume
  });
}

export type EventPhase =
  | { kind: "none" }
  | { kind: "before"; msLeft: number }
  | { kind: "running"; msLeft: number | null }
  | { kind: "over" };

/** Where the event window stands right now (server clock). "none" when the event has no window. */
export function eventPhase(event: LiveEvent | null, now: number = serverNow()): EventPhase {
  if (event === null || (event.startsAt === null && event.endsAt === null)) return { kind: "none" };
  const start = event.startsAt === null ? null : Date.parse(event.startsAt);
  const end = event.endsAt === null ? null : Date.parse(event.endsAt);
  if (start !== null && now < start) return { kind: "before", msLeft: start - now };
  if (end !== null && now >= end) return { kind: "over" };
  return { kind: "running", msLeft: end === null ? null : end - now };
}

/** An event worth showing: it has a name or a window. */
export function isEventActive(event: LiveEvent | null): event is LiveEvent {
  return event !== null && (event.name.length > 0 || event.startsAt !== null || event.endsAt !== null);
}

/** "1:02:03" / "12:05" / localized "2d 4h 5m" countdown text. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (days > 0) return TO().countdownLong(days, hours, minutes);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
