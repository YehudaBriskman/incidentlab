// Today's scheduled case for the shell (the navbar's Today link and the live strip's countdown).
// Wraps lib/session's cached /api/today so both parts redraw together when the day rolls over.
import type { TodayResponse } from "../../shared/contract";
import { loadToday } from "../lib/session";

let current: TodayResponse | null = null;
const listeners = new Set<(today: TodayResponse | null) => void>();

export function cachedToday(): TodayResponse | null {
  return current;
}

export function onTodayChange(fn: (today: TodayResponse | null) => void): void {
  listeners.add(fn);
}

/** Fetches /api/today (cached for the page load unless `refresh`); a failure keeps the last value. */
export function refreshToday(refresh = false): void {
  loadToday(refresh).then(
    (today) => {
      current = today;
      for (const fn of listeners) fn(today);
    },
    () => undefined,
  );
}

/** Milliseconds until the date changes in `timeZone`, or null for an unknown zone. */
export function msUntilNextDay(timeZone: string, now: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(now));
    const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
    const elapsed = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000 + (now % 1000);
    return 86_400_000 - elapsed;
  } catch {
    return null;
  }
}
