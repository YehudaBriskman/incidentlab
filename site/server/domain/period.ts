// The leaderboard's periods (#239). "This week" starts on Monday 00:00 and "this month" on the 1st at 00:00, both
// in the schedule's time zone, so a board's week turns over at the same moment as its "today". Pure: the
// boundary is computed from `now`, so every cached copy of a period board agrees on where it starts.
import type { LeaderboardPeriod } from "../../shared/contract.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** The wall-clock parts of `ms` in `timezone`; `weekday` counts from Monday = 0. */
function localParts(ms: number, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const num = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const weekday = WEEKDAYS[parts.find((p) => p.type === "weekday")?.value ?? "Mon"] ?? 0;
  return { year: num("year"), month: num("month"), day: num("day"), hour: num("hour"), minute: num("minute"), second: num("second"), weekday };
}

/** How far `timezone` is ahead of UTC at `ms`, in milliseconds. */
function offsetAt(ms: number, timezone: string): number {
  const p = localParts(ms, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of 00:00 on the local date (year, month, day) in `timezone`, DST included. */
export function zonedMidnight(year: number, month: number, day: number, timezone: string): number {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - offsetAt(wall, timezone);
  return wall - offsetAt(first, timezone);
}

/** When `period` began at `now` (an ISO instant), or null for all time. */
export function periodStart(period: LeaderboardPeriod, now: Date, timezone: string): string | null {
  if (period === "all") return null;
  const today = localParts(now.getTime(), timezone);
  if (period === "month") return new Date(zonedMidnight(today.year, today.month, 1, timezone)).toISOString();
  // Monday of this week, as a calendar date (UTC arithmetic on the date alone never meets a DST gap).
  const monday = new Date(Date.UTC(today.year, today.month - 1, today.day) - today.weekday * DAY_MS);
  return new Date(zonedMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), timezone)).toISOString();
}
