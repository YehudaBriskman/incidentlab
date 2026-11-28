// Formatting for the manage panels: numbers, durations, dates and relative times in the app locale (en-GB /
// he-IL, never the browser's default), plus small storage helpers for remembered preferences.
import { T } from "../../i18n/strings-tools";
import { getLang } from "../../i18n/i18n";
import { dateTimeZoneNode } from "../../lib/bidi";

export const locale = (): string => (getLang() === "he" ? "he-IL" : "en-GB");

export function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

type DurationUnit = "hour" | "minute" | "second";
const unitFormats = new Map<string, Intl.NumberFormat>();
/** "33 min" / "33 דק׳": one Intl unit formatter per locale and unit (cached; the poll formats hundreds a minute). */
export function formatUnit(n: number, unit: DurationUnit | "day"): string {
  const key = `${locale()}|${unit}`;
  let f = unitFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(), { style: "unit", unit, unitDisplay: "short" });
    unitFormats.set(key, f);
  }
  return f.format(n);
}

/** Localized duration with two units at most: "1 hr 05 min", "33 min 38 sec", "33 דק׳ 38 שנ׳". */
export function formatDuration(totalMs: number): string {
  const totalSec = Math.max(0, Math.round(totalMs / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) return mins > 0 ? `${formatUnit(hrs, "hour")} ${formatUnit(mins, "minute")}` : formatUnit(hrs, "hour");
  if (mins > 0) return secs > 0 ? `${formatUnit(mins, "minute")} ${formatUnit(secs, "second")}` : formatUnit(mins, "minute");
  return formatUnit(secs, "second");
}

/** A finish time: under a minute reads "< 1 min", not a broken-looking "0 sec". */
export const formatFinish = (totalMs: number): string => (totalMs < 60000 ? T().admUnderMinute : formatDuration(totalMs));

/** Whole minutes ("12 min" / "12 דק׳"), for stuck and idle times. */
export const formatMinutes = (min: number): string => formatUnit(Math.max(0, Math.floor(min)), "minute");

export function formatSeconds(sec: number | null): string {
  return sec === null ? "—" : formatDuration(sec * 1000);
}

/** Date and time in the app locale (en-GB / he-IL), never the browser's (often en-US) default. */
export function formatDateTime(iso: string | null): string {
  const t = ms(iso);
  if (t === null) return "—";
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(t);
}

/** Date and time to the second ("25 Nov 2026, 14:04:11"), for the audit log. */
export function formatDateTimeSec(iso: string | null): string {
  const t = ms(iso);
  return t === null ? "—" : new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "medium" }).format(t);
}

/** Same, with the browser's time zone named ("25 Nov 2026, 14:04:11 GMT+2"): the audit log's full-time tooltip. */
export function formatDateTimeSecZone(iso: string | null): string {
  const t = ms(iso);
  if (t === null) return "—";
  return new Intl.DateTimeFormat(locale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(t);
}

const dateTimeZoneFmt = (): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

/** Same, with the time zone named ("25 Nov 2026, 18:30 GMT+2"): for values typed in a browser-formatted picker. */
export function formatDateTimeZone(iso: string | null): string {
  const t = ms(iso);
  return t === null ? "—" : dateTimeZoneFmt().format(t);
}

/** The same date and time as an element whose zone name is an LTR isolate kept on the time's line (#248). */
export function dateTimeZoneEl(iso: string | null): Node {
  const t = ms(iso);
  return t === null ? document.createTextNode("—") : dateTimeZoneNode(dateTimeZoneFmt(), t);
}

const numFormats = new Map<string, Intl.NumberFormat>();
export function numFormat(key: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = `${locale()}|${key}`;
  let f = numFormats.get(k);
  if (!f) {
    f = new Intl.NumberFormat(locale(), opts);
    numFormats.set(k, f);
  }
  return f;
}
/** Counts and scores with locale grouping ("1,475"). */
export const fmtInt = (n: number): string => numFormat("int", { maximumFractionDigits: 0 }).format(n);
/** Averages with one decimal ("2.3"). */
export const fmtDec1 = (n: number): string => numFormat("dec1", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);

export function formatPct(ratio: number | null): string {
  return ratio === null ? "—" : numFormat("pct", { style: "percent", maximumFractionDigits: 0 }).format(ratio);
}

/** "6 min ago" / "לפני 6 דק׳": the unit comes from Intl, the sentence from the catalogue. */
export function relativeAgo(iso: string | null, now: number): string {
  const t = ms(iso);
  if (t === null) return "—";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 10) return T().admJustNow;
  if (sec < 60) return T().admAgo(formatUnit(sec, "second"));
  const min = Math.floor(sec / 60);
  if (min < 60) return T().admAgo(formatUnit(min, "minute"));
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return T().admAgo(formatUnit(hrs, "hour"));
  return T().admAgo(formatUnit(Math.floor(hrs / 24), "day"));
}

/** "in 6 days" / "בעוד 6 ימים" for a future instant (localized by Intl). */
export function relativeIn(iso: string | null, now: number): string {
  const t = ms(iso);
  if (t === null) return "—";
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  const diffMin = Math.max(0, Math.round((t - now) / 60000));
  if (diffMin >= 24 * 60) return rtf.format(Math.round(diffMin / (24 * 60)), "day");
  if (diffMin >= 60) return rtf.format(Math.round(diffMin / 60), "hour");
  return rtf.format(diffMin, "minute");
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return hi;
  const lo = sorted[mid - 1] ?? hi;
  return (lo + hi) / 2;
}

export const pad2 = (n: number): string => String(n).padStart(2, "0");
export const isoDay = (y: number, m0: number, d: number): string => `${y}-${pad2(m0 + 1)}-${pad2(d)}`;

export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : T().admUnknownError);

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: defaults apply
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: the preference lasts for this page only
  }
}
