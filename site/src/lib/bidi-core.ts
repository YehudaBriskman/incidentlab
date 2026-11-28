// Pure bidi helpers (no DOM, no i18n imports), so node:test can cover them. lib/bidi.ts turns them into elements.

/** Any Hebrew letter or mark. */
export const HEBREW = /[֐-׿]/;

/** One piece of a string: `ltr` pieces are isolated (<bdi dir="ltr">) inside right-to-left text. */
export type BidiSegment = { readonly text: string; readonly ltr: boolean };

const STRONG_LTR = /[A-Za-z0-9]/;
const LETTER = /[A-Za-z]/;
const SIGN = /[+\-−]/;
/** Characters that end an LTR run as part of it ("build-aux/", "50%", "_id_"), not sentence punctuation. */
const TRAILING = /[/%_*#]/;

/** Where the LTR core of a non-Hebrew chunk starts, or -1. A leading sign counts only before a digit and not right after a Hebrew letter ("ב-5" is a prefix, "−5" is a number). */
function coreStart(chunk: string, afterHebrew: boolean): number {
  for (let j = 0; j < chunk.length; j++) {
    const ch = chunk[j] ?? "";
    if (STRONG_LTR.test(ch)) return j;
    // A path prefix ("/page.html", "./run.sh", "~/notes") belongs to its run, or the slash ends up on the wrong
    // side in Hebrew (#286); a lone "/" ("ב-/,") is not a path.
    if (/[/.~]/.test(ch)) {
      let k = j;
      while (/[/.~]/.test(chunk[k] ?? "")) k++;
      const before = j === 0 ? (afterHebrew ? "א" : " ") : (chunk[j - 1] ?? " ");
      if (k > j && STRONG_LTR.test(chunk[k] ?? "") && /[\s(\[]/.test(before)) return j;
    }
    const next = chunk[j + 1] ?? "";
    if (SIGN.test(ch) && /[0-9]/.test(next)) {
      const before = j === 0 ? (afterHebrew ? "א" : " ") : (chunk[j - 1] ?? " ");
      if (/[\s(\[]/.test(before)) return j;
    }
  }
  return -1;
}

/** Index just past the LTR core that starts at `start`. */
function coreEnd(chunk: string, start: number): number {
  let end = start;
  for (let k = start; k < chunk.length; k++) if (STRONG_LTR.test(chunk[k] ?? "")) end = k + 1;
  for (;;) {
    const ch = chunk[end] ?? "";
    if (ch === "") break;
    const core = chunk.slice(start, end);
    const opens = (core.match(/[(\[]/g) ?? []).length;
    const closes = (core.match(/[)\]]/g) ?? []).length;
    if (TRAILING.test(ch) || ((ch === ")" || ch === "]") && opens > closes)) end++;
    else break;
  }
  return end;
}

/** True when a core needs isolating: it has a Latin letter, or digits joined by signs or separators ("−5", "10:30", "192.0.2.10"). */
const needsIsolation = (core: string): boolean => LETTER.test(core) || (/[0-9]/.test(core) && /[^0-9]/.test(core));

/**
 * Splits text that sits in a right-to-left paragraph into the runs to isolate as LTR (paths, commands, field
 * names, IPs, timestamps, usernames, signed numbers, English phrases) and the text around them. Concatenating
 * the segments gives back the input.
 */
export function ltrRuns(text: string): BidiSegment[] {
  const out: BidiSegment[] = [];
  const push = (t: string, ltr: boolean): void => {
    if (t === "") return;
    const last = out[out.length - 1];
    if (last !== undefined && !last.ltr && !ltr) out[out.length - 1] = { text: last.text + t, ltr: false };
    else out.push({ text: t, ltr });
  };
  const chunks = /[^֐-׿]+/g;
  let pos = 0;
  for (let m = chunks.exec(text); m !== null; m = chunks.exec(text)) {
    push(text.slice(pos, m.index), false);
    let chunk = m[0];
    let afterHebrew = m.index > 0;
    // a chunk can hold several runs ("(UTC+01:00), ה-" has one; "a, b" stays one, as the browser would show it)
    while (chunk !== "") {
      const start = coreStart(chunk, afterHebrew);
      if (start < 0) {
        push(chunk, false);
        break;
      }
      const end = coreEnd(chunk, start);
      const core = chunk.slice(start, end);
      push(chunk.slice(0, start), false);
      push(core, needsIsolation(core));
      chunk = chunk.slice(end);
      afterHebrew = false;
    }
    pos = m.index + m[0].length;
  }
  push(text.slice(pos), false);
  return out;
}

/**
 * A mixed-language name ("The Insider Commit – ה-commit של איש הפנים") split at its " – " separator, each part to
 * be shown as its own isolated, unbreakable-as-a-unit box. A Hebrew prefix glued to a Latin word keeps a
 * non-breaking hyphen ("ה‑commit"), so "ה-" is never orphaned at a line end.
 */
export function nameParts(name: string): string[] {
  return name
    .replace(/([֐-׿])-(?=[A-Za-z0-9])/g, "$1‑")
    .split(" – ")
    .filter((p) => p !== "");
}

/** A list ("a, b and c") in the locale's own form, as its literal glue and its items, so each item can be isolated. */
export function listParts(locale: string, items: readonly string[], type: Intl.ListFormatType = "unit"): BidiSegment[] {
  if (items.length === 0) return [];
  const fmt = new Intl.ListFormat(locale, { type, style: "short" });
  return fmt.formatToParts([...items]).map((p) => ({ text: p.value, ltr: p.type === "element" }));
}

/**
 * A date and time with its time-zone name in three strings: the date with its trailing separator
 * ("שבת, 28 בנוב׳ 2026, "), the time ("10:07") and the zone ("GMT+2"), so the time and zone can stay on one line
 * and the zone can be isolated. Missing pieces are "".
 */
export function dateTimeZoneParts(fmt: Intl.DateTimeFormat, at: number | Date): { readonly date: string; readonly time: string; readonly zone: string } {
  const parts = fmt.formatToParts(at);
  const zone = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const rest = parts.filter((p) => p.type !== "timeZoneName");
  const TIME = new Set<string>(["hour", "minute", "second", "dayPeriod", "fractionalSecond"]);
  const first = rest.findIndex((p) => TIME.has(p.type));
  const join = (xs: Intl.DateTimeFormatPart[]): string => xs.map((p) => p.value).join("");
  if (first < 0) return { date: join(rest).trim(), time: "", zone };
  return { date: join(rest.slice(0, first)), time: join(rest.slice(first)).trim(), zone };
}

/** A calendar date ("2026-11-28") in the locale's own form, read as that day wherever the browser is. */
export function formatIsoDay(locale: string, isoDate: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (m === null) return isoDate;
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}
