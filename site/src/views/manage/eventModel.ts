// The event form's model: the LiveEvent draft (copy, compare, normalise for the server) and the conversions
// between ISO instants and <input type="datetime-local"> values in the browser's time zone.
import type { LiveEvent } from "../../../shared/contract";
import { ms, pad2 } from "./format";

/** ISO instant -> "YYYY-MM-DDTHH:mm" in this browser's local time (what <input type="datetime-local"> expects). */
export function isoToLocalInput(iso: string | null): string {
  const t = ms(iso);
  if (t === null) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "YYYY-MM-DDTHH:mm" (local) -> ISO UTC, or null when empty/invalid. */
export function localInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const d = new Date(value); // no offset in the string: parsed as local time
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function browserTimeZone(): { name: string; offset: string } {
  let name = "local";
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    // keep "local"
  }
  const mins = -new Date().getTimezoneOffset();
  const sign = mins >= 0 ? "+" : "−";
  const abs = Math.abs(mins);
  return { name, offset: `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}` };
}

export const cloneEvent = (e: LiveEvent): LiveEvent => ({ ...e, announcement: e.announcement ? { ...e.announcement } : null });
export const eventSig = (e: LiveEvent): string =>
  JSON.stringify([e.name.trim(), e.startsAt, e.endsAt, e.freezeAt, e.enforceWindow, e.announcement?.text.trim() ?? "", e.announcement?.level ?? null]);

/** Turns the form draft into what the server expects: trimmed name, empty announcement -> null. */
export function normalizeEvent(e: LiveEvent): LiveEvent {
  const text = e.announcement?.text.trim() ?? "";
  return { ...e, name: e.name.trim(), announcement: text ? { text, level: e.announcement?.level ?? "info" } : null };
}
