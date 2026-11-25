// The live event (name, window, announcement): polled from GET /api/event and shared by the header banner,
// the countdown, the home page and the leaderboard. Countdowns use the server clock (corrected for skew).
import type { LiveEvent } from "../../shared/contract";
import { fetchEvent } from "./api";
import { TO } from "../i18n/strings-onboard";

const POLL_MS = 30_000;

type Listener = (event: LiveEvent | null) => void;

let current: LiveEvent | null = null;
/** serverTime − local time, in ms (positive when the local clock is behind). */
let skewMs = 0;
let timer: number | null = null;
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

async function poll(): Promise<void> {
  try {
    const sentAt = Date.now();
    const { event, serverTime } = await fetchEvent();
    const receivedAt = Date.now();
    const server = Date.parse(serverTime);
    if (Number.isFinite(server)) skewMs = server - (sentAt + receivedAt) / 2;
    current = event;
    for (const fn of listeners) fn(event);
  } catch {
    /* keep the last known event; the next poll retries */
  }
}

/** Poll now (e.g. after the server refused an action with "event-closed"). */
export function refreshEvent(): void {
  void poll();
}

export function startEventPolling(): void {
  if (timer !== null) return;
  void poll();
  timer = window.setInterval(() => void poll(), POLL_MS);
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
