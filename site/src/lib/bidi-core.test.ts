import { test } from "node:test";
import assert from "node:assert/strict";
import { dateTimeZoneParts, formatIsoDay, listParts, ltrRuns, nameParts, type BidiSegment } from "./bidi-core.ts";

const isolated = (segs: BidiSegment[]): string[] => segs.filter((s) => s.ltr).map((s) => s.text);
const joined = (segs: BidiSegment[]): string => segs.map((s) => s.text).join("");

test("ltrRuns isolates paths, commands, times and English phrases, and keeps the text intact", () => {
  const cases: Array<[string, string[]]> = [
    ["dns/zone-audit.log: מה היה פעם בכתובת הזאת?", ["dns/zone-audit.log"]],
    // an English phrase with its bracket stays one run, as the browser would show it: splitting it would reverse its words
    ["dpkg ב-CET (UTC+01:00), ה-CSV ב-epoch (UTC)", ["dpkg", "CET (UTC+01:00)", "CSV", "epoch (UTC)"]],
    ["ראו את build-aux/ ושם", ["build-aux/"]],
    ["השורה מ-2024-03-01 03:12:00 היא הראשונה", ["2024-03-01 03:12:00"]],
    ["כתובת 192.0.2.10 בלבד", ["192.0.2.10"]],
    ["עולה −5 נק׳ ובונוס +10", ["−5", "+10"]],
    ["ב-5 דקות", []],
    ["bench-03 קיבל את אותם עדכונים", ["bench-03"]],
    ["הוא מוצא את הקלט (grep -aErls) לפי תוכן", ["grep -aErls"]],
    ["3 שלבים", []],
    ["What happened here?", ["What happened here"]],
  ];
  for (const [text, want] of cases) {
    const segs = ltrRuns(text);
    assert.equal(joined(segs), text, text);
    assert.deepEqual(isolated(segs), want, text);
  }
});

test("ltrRuns keeps a closing bracket only when its opener is inside the run", () => {
  assert.deepEqual(isolated(ltrRuns("קראו את f(x) כאן")), ["f(x)"]);
  assert.deepEqual(isolated(ltrRuns("(see x) כאן")), ["see x"]);
});

test("nameParts splits a bilingual title and glues Hebrew prefixes to Latin words", () => {
  assert.deepEqual(nameParts("The Insider Commit – ה-commit של איש הפנים"), ["The Insider Commit", "ה‑commit של איש הפנים"]);
  assert.deepEqual(nameParts("Ghost in the Network"), ["Ghost in the Network"]);
});

test("listParts uses the locale's list glue, with each item separate", () => {
  const he = listParts("he-IL", ["tcpdump", "wireshark", "mtu"]);
  assert.deepEqual(isolated(he), ["tcpdump", "wireshark", "mtu"]);
  assert.equal(he.filter((s) => !s.ltr).every((s) => !/[A-Za-z]/.test(s.text)), true);
  assert.equal(joined(listParts("en-GB", ["a", "b"])), "a, b");
  assert.deepEqual(listParts("en-GB", []), []);
});

test("dateTimeZoneParts separates the time-zone name", () => {
  const fmt = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem", timeZoneName: "short" });
  const { date, time, zone } = dateTimeZoneParts(fmt, Date.UTC(2026, 10, 27, 6, 37));
  assert.match(zone, /GMT/);
  assert.equal(time, "08:37");
  assert.match(date, /^27 /);
  const none = dateTimeZoneParts(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }), 0);
  assert.deepEqual(none, { date: "", time: "00:00", zone: "" });
  const dayOnly = dateTimeZoneParts(new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }), 0);
  assert.deepEqual(dayOnly, { date: "1 Jan", time: "", zone: "" });
});

test("formatIsoDay reads the calendar day, not the browser's zone", () => {
  assert.equal(formatIsoDay("en-GB", "2026-11-28"), "28 Nov 2026");
  assert.equal(formatIsoDay("en-GB", "not-a-date"), "not-a-date");
});
