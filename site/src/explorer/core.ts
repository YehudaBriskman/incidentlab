// Pure helpers for the evidence explorer. No DOM access here: this module is
// shared by the UI, the Web Worker and the node:test suite.

export type StepKind = "contains" | "not" | "regex";

export interface FilterStep {
  kind: StepKind;
  text: string;
  /** case-insensitive */
  ci: boolean;
}

/** One JSON condition: `eq` equals, `ne` differs (or is missing), `has` contains, `exists` is present. */
export type JsonOp = "eq" | "ne" | "has" | "exists";

export interface JsonFilter {
  field: string;
  op: JsonOp;
  value: string;
}

/** A time window over a timestamp capture (the histogram's pattern). Wall clock as written, read as UTC. */
export interface TimeRange {
  pattern: string;
  year: number | null;
  /** epoch ms, inclusive */
  from: number;
  /** epoch ms, exclusive */
  to: number;
}

/** Sort the view by one header column: a CSV column index, or a JSON field path (column view). */
export type SortKey = { kind: "csv"; index: number } | { kind: "json"; path: string };

export interface UniqueResult {
  rows: Array<[string, number]>;
  distinct: number;
  matchedLines: number;
}

export interface HistogramBucket {
  key: string;
  count: number;
}

export interface HistogramResult {
  /** keys that do not read as a time, first-seen order */
  buckets: HistogramBucket[];
  truncated: boolean;
  /** [epoch ms of the minute (wall clock as written, read as UTC), count], sorted by time */
  minutes: Array<[number, number]>;
}

export const MAX_HISTOGRAM_BUCKETS = 2000;

/* ------------------------------------------------------------ lines */

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (text.includes("\r")) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined && line.endsWith("\r")) lines[i] = line.slice(0, -1);
    }
  }
  return lines;
}

/** Returns an error message when the pattern is not a valid JS regex. */
export function regexError(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (err) {
    return err instanceof Error ? shortRegexMessage(err.message) : "invalid regex";
  }
}

/** V8 says "Invalid regular expression: /(a/: Unterminated group"; the pattern is already on screen, so keep the reason. */
export function shortRegexMessage(message: string): string {
  const m = /^Invalid regular expression: \/[\s\S]*\/[a-z]*: ([\s\S]+)$/.exec(message);
  return m?.[1] ?? message;
}

type Matcher = (line: string) => boolean;

/** Compiles one step; returns null for an empty step (it is skipped). Throws on an invalid regex. */
export function compileStep(step: FilterStep): Matcher | null {
  if (step.text === "") return null;
  if (step.kind === "regex") {
    const re = new RegExp(step.text, step.ci ? "i" : "");
    return (line) => re.test(line);
  }
  const negate = step.kind === "not";
  if (step.ci) {
    const needle = step.text.toLowerCase();
    return (line) => line.toLowerCase().includes(needle) !== negate;
  }
  const needle = step.text;
  return (line) => line.includes(needle) !== negate;
}

/* ------------------------------------------------------------ json */

const JSON_OPS: ReadonlyArray<[string, JsonOp]> = [["!=", "ne"], ["~=", "has"], ["=", "eq"]];

/** `field = value` (eq), `field != value`, `field ~= value` (contains), `field = *` (exists). */
export function parseJsonFilter(input: string): JsonFilter | null {
  let at = -1;
  let len = 0;
  let op: JsonOp = "eq";
  for (const [token, o] of JSON_OPS) {
    const i = input.indexOf(token);
    if (i > 0 && (at < 0 || i < at)) {
      at = i;
      len = token.length;
      op = o;
    }
  }
  if (at <= 0) return null;
  const field = input.slice(0, at).trim();
  const value = input.slice(at + len).trim();
  if (field === "") return null;
  if (op === "eq" && value === "*") return { field, op: "exists", value: "" };
  return { field, op, value };
}

export function formatJsonFilter(f: JsonFilter): string {
  switch (f.op) {
    case "eq":
      return `${f.field}=${f.value}`;
    case "ne":
      return `${f.field}!=${f.value}`;
    case "has":
      return `${f.field}~=${f.value}`;
    case "exists":
      return `${f.field}=*`;
  }
}

export function getJsonField(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function parseJsonLine(line: string): unknown {
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed;
  } catch {
    return undefined;
  }
}

export function stringifyField(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function jsonValueMatches(obj: unknown, f: JsonFilter): boolean {
  const value = getJsonField(obj, f.field);
  switch (f.op) {
    case "exists":
      return value !== undefined;
    case "eq":
      return value !== undefined && (f.value === "*" || stringifyField(value) === f.value);
    case "ne":
      return value === undefined || stringifyField(value) !== f.value;
    case "has":
      return value !== undefined && stringifyField(value).toLowerCase().includes(f.value.toLowerCase());
  }
}

const asList = (json: JsonFilter | readonly JsonFilter[] | null): readonly JsonFilter[] =>
  json === null ? [] : isFilterList(json) ? json : [json];

function isFilterList(json: JsonFilter | readonly JsonFilter[]): json is readonly JsonFilter[] {
  return Array.isArray(json);
}

/** True when the line is a JSON object that meets every condition. */
export function jsonLineMatches(line: string, filter: JsonFilter | readonly JsonFilter[]): boolean {
  const obj = parseJsonLine(line);
  if (obj === undefined) return false;
  for (const f of asList(filter)) if (!jsonValueMatches(obj, f)) return false;
  return true;
}

/** Dot paths of the scalar fields in a JSON object (arrays count as one value), in key order. */
export function flattenJson(obj: unknown, prefix = "", out: Array<[string, string]> = [], depth = 0): Array<[string, string]> {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj) || depth > 6) {
    if (prefix !== "") out.push([prefix, stringifyField(obj)]);
    return out;
  }
  const entries = Object.entries(obj);
  if (entries.length === 0 && prefix !== "") out.push([prefix, "{}"]);
  for (const [k, v] of entries) flattenJson(v, prefix === "" ? k : `${prefix}.${k}`, out, depth + 1);
  return out;
}

/** Field paths seen in the first `sample` JSON lines, most common first (ties in first-seen order). */
export function jsonFieldPaths(lines: readonly string[], sample = 300, max = 200): string[] {
  const seen = new Map<string, number>();
  let n = 0;
  for (const line of lines) {
    if (n >= sample) break;
    const obj = parseJsonLine(line);
    if (obj === undefined) continue;
    n++;
    for (const [path] of flattenJson(obj)) seen.set(path, (seen.get(path) ?? 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([p]) => p);
}

export function looksLikeJsonLines(lines: readonly string[]): boolean {
  let checked = 0;
  let ok = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    checked++;
    if (parseJsonLine(line) !== undefined) ok++;
    if (checked >= 20) break;
  }
  return checked > 0 && ok / checked >= 0.8;
}

/* ------------------------------------------------------------ filtering */

export class FilterTimeout extends Error {}

/** A matcher for lines whose timestamp capture falls inside `range`. Parsed keys are cached. */
export function timeMatcher(range: TimeRange): (line: string) => boolean {
  const re = new RegExp(range.pattern);
  const cache = new Map<string, number | null>();
  return (line) => {
    const m = re.exec(line);
    if (!m) return false;
    const key = m[1] ?? m[0];
    let ms = cache.get(key);
    if (ms === undefined) {
      ms = parseTimeKey(key, range.year);
      if (cache.size < 100_000) cache.set(key, ms);
    }
    return ms !== null && ms >= range.from && ms < range.to;
  };
}

export interface FilterExtras {
  time?: TimeRange | null;
}

/**
 * Runs the pipeline and returns the indices of kept lines.
 * `deadline` (epoch ms) is checked periodically; FilterTimeout is thrown past it.
 */
export function applyFilters(
  lines: readonly string[],
  steps: readonly FilterStep[],
  json: JsonFilter | readonly JsonFilter[] | null = null,
  deadline = Number.POSITIVE_INFINITY,
  skipFirst = false,
  extras: FilterExtras = {},
): Uint32Array {
  const matchers: Matcher[] = [];
  for (const step of steps) {
    const m = compileStep(step);
    if (m) matchers.push(m);
  }
  if (extras.time) matchers.push(timeMatcher(extras.time));
  const conds = asList(json);
  const out = new Uint32Array(lines.length);
  let n = 0;
  for (let i = skipFirst ? 1 : 0; i < lines.length; i++) {
    if ((i & 2047) === 0 && Date.now() > deadline) throw new FilterTimeout("regex took too long");
    const line = lines[i] ?? "";
    let keep = true;
    for (const m of matchers) {
      if (!m(line)) {
        keep = false;
        break;
      }
    }
    if (keep && conds.length > 0 && !jsonLineMatches(line, conds)) keep = false;
    if (keep) out[n++] = i;
  }
  return out.slice(0, n);
}

/* ------------------------------------------------------------ sorting */

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** The value a sort key reads from one line ("" when missing). */
export function sortValue(line: string, key: SortKey): string {
  if (key.kind === "csv") return parseCsvLine(line)[key.index] ?? "";
  const obj = parseJsonLine(line);
  return obj === undefined ? "" : stringifyField(getJsonField(obj, key.path));
}

/**
 * Sorts view `indices` (file line numbers) by one column. Numeric when every non-empty value is a number,
 * otherwise a natural string compare. Empty values sort last both ways; ties keep file order (stable).
 */
export function sortIndices(
  lines: readonly string[],
  indices: ArrayLike<number>,
  key: SortKey,
  desc: boolean,
  deadline = Number.POSITIVE_INFINITY,
): Uint32Array {
  const n = indices.length;
  const values = new Array<string>(n);
  let numeric = true;
  for (let k = 0; k < n; k++) {
    if ((k & 2047) === 0 && Date.now() > deadline) throw new FilterTimeout("sort took too long");
    const v = sortValue(lines[indices[k] ?? 0] ?? "", key);
    values[k] = v;
    if (numeric && v !== "" && !NUMERIC.test(v.trim())) numeric = false;
  }
  const order = Array.from({ length: n }, (_, k) => k);
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const nums = numeric ? values.map((v) => (v === "" ? 0 : Number(v))) : null;
  order.sort((a, b) => {
    const va = values[a] ?? "";
    const vb = values[b] ?? "";
    if (va === "" || vb === "") return va === vb ? a - b : va === "" ? 1 : -1;
    const d = nums ? (nums[a] ?? 0) - (nums[b] ?? 0) : collator.compare(va, vb);
    if (d !== 0) return desc ? -d : d;
    return a - b;
  });
  const out = new Uint32Array(n);
  for (let k = 0; k < n; k++) out[k] = indices[order[k] ?? 0] ?? 0;
  return out;
}

/** Width of the inline time shown after an epoch value: ` 2026-11-13 00:00:00Z`. */
export const EPOCH_SUFFIX_CH = 21;

/**
 * Column widths in characters for a CSV file: the longest of the header and the first `sample` rows,
 * plus room for an inline epoch time, clamped to [4, max] (one more for the gap).
 */
export function csvColumnWidths(lines: readonly string[], sample = 2000, max = 48): number[] {
  const widths: number[] = [];
  const epoch: boolean[] = [];
  const end = Math.min(lines.length, sample + 1);
  for (let i = 0; i < end; i++) {
    const cells = parseCsvLine(lines[i] ?? "");
    for (let c = 0; c < cells.length; c++) {
      const v = cells[c] ?? "";
      widths[c] = Math.max(widths[c] ?? 0, v.length);
      if (i > 0 && isEpochSeconds(v)) epoch[c] = true;
    }
  }
  return Array.from(widths, (w, c) => Math.min(max, Math.max(4, (w ?? 0) + (epoch[c] ? EPOCH_SUFFIX_CH : 0))) + 1);
}

/** The UTC time an epoch-seconds value stands for, as `YYYY-MM-DD HH:MM:SSZ`. */
export function epochLabel(value: string): string {
  const ms = Math.round(Number(value) * 1000);
  return `${formatInZone(ms, "UTC").replace(/ UTC$/, "")}Z`;
}

/** `key=value` and `key="quoted value"` pairs in a text line (iptables, logfmt), first `limit` of them. */
export function kvPairs(line: string, limit = 40): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of line.matchAll(/(?:^|[\s,;])([A-Za-z_][\w.-]{0,40})=("(?:[^"\\]|\\.)*"|[^\s,;]*)/g)) {
    const raw = m[2] ?? "";
    out.push([m[1] ?? "", raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw]);
    if (out.length >= limit) break;
  }
  return out;
}

/** Epoch-seconds tokens in a free-text line (VPC flow logs, CSV rows), with their UTC time. */
export function epochTokens(line: string, limit = 8): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const m of line.matchAll(/(?<![\d.])\d{9,10}(?:\.\d+)?(?![\d.])/g)) {
    const v = m[0];
    if (seen.has(v) || !isEpochSeconds(v)) continue;
    seen.add(v);
    out.push([v, epochLabel(v)]);
    if (out.length >= limit) break;
  }
  return out;
}

function* iterIndices(lineCount: number, indices: ArrayLike<number> | null): Generator<number> {
  if (indices === null) {
    for (let i = 0; i < lineCount; i++) yield i;
  } else {
    for (let i = 0; i < indices.length; i++) yield indices[i] ?? 0;
  }
}

/** Extracts capture group 1 (or the whole match) of `pattern` from every line and counts values. */
export function countUnique(
  lines: readonly string[],
  indices: ArrayLike<number> | null,
  pattern: string,
  ci = false,
  deadline = Number.POSITIVE_INFINITY,
): UniqueResult {
  const re = new RegExp(pattern, ci ? "i" : "");
  const counts = new Map<string, number>();
  let matchedLines = 0;
  let k = 0;
  for (const i of iterIndices(lines.length, indices)) {
    if ((k++ & 2047) === 0 && Date.now() > deadline) throw new FilterTimeout("regex took too long");
    const m = re.exec(lines[i] ?? "");
    if (!m) continue;
    const value = m[1] ?? m[0];
    matchedLines++;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { rows, distinct: counts.size, matchedLines };
}

/**
 * Buckets lines by capture group 1. Keys that read as a time (nginx, ISO, syslog, dpkg/postgres, epoch) are
 * counted per minute in `minutes` (sorted); anything else stays a raw key in `buckets`, in first-seen order.
 * `year` fills in year-less syslog stamps.
 */
export function histogram(
  lines: readonly string[],
  indices: ArrayLike<number> | null,
  pattern: string,
  deadline = Number.POSITIVE_INFINITY,
  year: number | null = null,
): HistogramResult {
  const re = new RegExp(pattern);
  const counts = new Map<string, number>();
  const perMinute = new Map<number, number>();
  const keyCache = new Map<string, number | null>();
  let truncated = false;
  let k = 0;
  for (const i of iterIndices(lines.length, indices)) {
    if ((k++ & 2047) === 0 && Date.now() > deadline) throw new FilterTimeout("regex took too long");
    const m = re.exec(lines[i] ?? "");
    if (!m) continue;
    const key = m[1] ?? m[0];
    let minute = keyCache.get(key);
    if (minute === undefined) {
      const ms = parseTimeKey(key, year);
      minute = ms === null ? null : Math.floor(ms / 60_000) * 60_000;
      if (keyCache.size < 100_000) keyCache.set(key, minute);
    }
    if (minute !== null) {
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
      continue;
    }
    const prev = counts.get(key);
    if (prev === undefined) {
      if (counts.size >= MAX_HISTOGRAM_BUCKETS) {
        truncated = true;
        continue;
      }
      counts.set(key, 1);
    } else {
      counts.set(key, prev + 1);
    }
  }
  const minutes = [...perMinute.entries()].sort((a, b) => a[0] - b[0]);
  return { buckets: [...counts.entries()].map(([key, count]) => ({ key, count })), truncated, minutes };
}

export interface TimeSeries {
  /** epoch ms of the first bucket (wall clock as written in the file, read as UTC) */
  start: number;
  /** bucket width in minutes */
  step: number;
  counts: number[];
  total: number;
  peak: { at: number; count: number };
  /** longest run of empty buckets, or null when there is none */
  gap: { from: number; to: number; buckets: number } | null;
}

const STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];

/** A real time axis: sorted per-minute counts → equal-width buckets, empty ones included (gaps stay visible). */
export function timeSeries(minutes: ReadonlyArray<readonly [number, number]>, maxBars = 240): TimeSeries | null {
  const first = minutes[0];
  const lastEntry = minutes[minutes.length - 1];
  if (!first || !lastEntry) return null;
  const spanMin = (lastEntry[0] - first[0]) / 60_000 + 1;
  const step = STEPS_MIN.find((s) => Math.ceil(spanMin / s) <= maxBars) ?? Math.ceil(spanMin / maxBars / 1440) * 1440;
  const stepMs = step * 60_000;
  const start = Math.floor(first[0] / stepMs) * stepMs;
  const n = Math.floor((lastEntry[0] - start) / stepMs) + 1;
  const counts = new Array<number>(n).fill(0);
  let total = 0;
  for (const [at, c] of minutes) {
    const idx = Math.floor((at - start) / stepMs);
    counts[idx] = (counts[idx] ?? 0) + c;
    total += c;
  }
  let peakIdx = 0;
  for (let i = 1; i < n; i++) if ((counts[i] ?? 0) > (counts[peakIdx] ?? 0)) peakIdx = i;
  let gap: TimeSeries["gap"] = null;
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const empty = i < n && counts[i] === 0;
    if (empty && runStart < 0) runStart = i;
    if (!empty && runStart >= 0) {
      const len = i - runStart;
      if (!gap || len > gap.buckets) gap = { from: start + runStart * stepMs, to: start + i * stepMs, buckets: len };
      runStart = -1;
    }
  }
  return { start, step, counts, total, peak: { at: start + peakIdx * stepMs, count: counts[peakIdx] ?? 0 }, gap };
}

/** `YYYY-MM-DD HH:MM` of a wall-clock bucket (the time as written in the file). */
export function fmtBucket(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Ranges to highlight in a line for the positive steps (contains / regex). */
export function matchRanges(line: string, steps: readonly FilterStep[], limit = 40): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const step of steps) {
    if (step.text === "" || step.kind === "not") continue;
    if (step.kind === "contains") {
      const hay = step.ci ? line.toLowerCase() : line;
      const needle = step.ci ? step.text.toLowerCase() : step.text;
      let from = 0;
      while (ranges.length < limit) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        ranges.push([at, at + needle.length]);
        from = at + needle.length;
      }
    } else {
      let re: RegExp;
      try {
        re = new RegExp(step.text, step.ci ? "gi" : "g");
      } catch {
        continue;
      }
      let m: RegExpExecArray | null;
      while (ranges.length < limit && (m = re.exec(line)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        ranges.push([m.index, m.index + m[0].length]);
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  // merge overlaps
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/* ------------------------------------------------------------ csv */

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Plausible epoch seconds (2000..2100), optionally fractional. */
export function isEpochSeconds(value: string): boolean {
  if (!/^\d{9,10}(\.\d+)?$/.test(value)) return false;
  const n = Number(value);
  return n >= 946684800 && n <= 4102444800;
}

/* ------------------------------------------------------------ time */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const SYSLOG_RE = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/;

function stripBrackets(raw: string): string {
  return raw.trim().replace(/^\[|\]$/g, "").trim();
}

/** True when the input is a year-less syslog stamp such as `Nov 18 07:00:07`. */
export function isYearless(raw: string): boolean {
  return SYSLOG_RE.test(stripBrackets(raw));
}

/** True when the input carries no zone (no Z, offset or UTC/GMT) and is not an epoch number. */
export function isZoneless(raw: string): boolean {
  const input = stripBrackets(raw);
  if (/^\d+(\.\d+)?$/.test(input)) return false;
  return !/(Z|UTC|GMT|[+-]\d{2}:?\d{2})$/i.test(input);
}

/**
 * Parses epoch seconds/ms, ISO-8601, nginx `13/Nov/2026:00:00:00 +0000`, `YYYY-MM-DD HH:MM:SS[.fff] [UTC]`
 * (postgres, dpkg) and year-less syslog `Nov 18 07:00:07` (only with `assumeYear`). Times without a zone are
 * read as UTC; the caller shifts them when the player picks another zone. Returns epoch ms.
 */
export function parseTimeInput(raw: string, assumeYear: number | null = null): number | null {
  const input = stripBrackets(raw);
  if (input === "") return null;
  if (/^\d+(\.\d+)?$/.test(input)) {
    const n = Number(input);
    if (!Number.isFinite(n)) return null;
    // 13+ digit integers are milliseconds
    return input.split(".")[0]!.length >= 13 ? Math.round(n) : Math.round(n * 1000);
  }
  const nginx = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2})(?::(\d{2}))?(?:\s*([+-])(\d{2}):?(\d{2}))?$/.exec(input);
  if (nginx) {
    const [, d, mon, y, hh, mm, ss, sign, oh, om] = nginx;
    const month = MONTHS[(mon ?? "").toLowerCase()];
    if (month === undefined) return null;
    const utc = Date.UTC(Number(y), month, Number(d), Number(hh), Number(mm), Number(ss ?? 0));
    const offsetMin = sign ? (Number(oh) * 60 + Number(om)) * (sign === "-" ? -1 : 1) : 0;
    return utc - offsetMin * 60_000;
  }
  const syslog = SYSLOG_RE.exec(input);
  if (syslog) {
    const [, mon, d, hh, mm, ss, frac] = syslog;
    const month = MONTHS[(mon ?? "").toLowerCase()];
    if (month === undefined || assumeYear === null) return null;
    return Date.UTC(assumeYear, month, Number(d), Number(hh), Number(mm), Number(ss ?? 0)) + Math.round(Number(frac ?? 0) * 1000);
  }
  let iso = input;
  const pg = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(UTC|GMT|Z)?$/i.exec(input);
  if (pg) iso = `${pg[1]}T${pg[2]}Z`;
  // Date.parse invents a year (2001) for year-less input, so only trust it when a 4-digit year is present.
  if (!/\b\d{4}\b/.test(iso)) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Histogram keys: epoch numbers or a stamp with at least HH:MM. Wall clock as written, read as UTC. */
export function parseTimeKey(key: string, year: number | null): number | null {
  const k = key.trim();
  if (/^\d{9,13}(\.\d+)?$/.test(k)) {
    const ms = parseTimeInput(k);
    return ms !== null && ms >= 946684800_000 && ms <= 4102444800_000 ? ms : null;
  }
  if (!/\d{1,2}:\d{2}/.test(k)) return null;
  return parseTimeInput(k, year);
}

/** The year most evidence lines mention (ISO dates or nginx stamps), or null. Used for year-less syslog. */
export function yearHint(lines: readonly string[], sample = 400): number | null {
  const votes = new Map<number, number>();
  const re = /\b(20\d{2})-[01]\d-[0-3]\d|\/[A-Z][a-z]{2}\/(20\d{2}):/g;
  for (let i = 0; i < Math.min(lines.length, sample); i++) {
    const line = (lines[i] ?? "").slice(0, 2000);
    for (const m of line.matchAll(re)) {
      const y = Number(m[1] ?? m[2]);
      votes.set(y, (votes.get(y) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  let bestVotes = 0;
  for (const [y, v] of votes) {
    if (v > bestVotes) {
      best = y;
      bestVotes = v;
    }
  }
  return best;
}

/** Like yearHint, then falls back to the most common bare `20xx` (a README says "November 2026"). */
export function yearInText(text: string): number | null {
  const fromDates = yearHint(text.split("\n"), 2000);
  if (fromDates !== null) return fromDates;
  const votes = new Map<number, number>();
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) votes.set(Number(m[1]), (votes.get(Number(m[1])) ?? 0) + 1);
  let best: number | null = null;
  for (const [y, v] of votes) if (best === null || v > (votes.get(best) ?? 0)) best = y;
  return best;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(ms: number, timeZone: string): Record<string, string> {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return parts;
}

const FIXED_OFFSET = /^([+-])(\d{2}):(\d{2})$/;

/** Offset of `zone` from UTC at instant `ms`, in minutes. `zone` is an IANA name or a fixed `+02:00`. */
export function zoneOffsetMin(ms: number, zone: string): number {
  const fixed = FIXED_OFFSET.exec(zone);
  if (fixed) return (Number(fixed[2]) * 60 + Number(fixed[3])) * (fixed[1] === "-" ? -1 : 1);
  if (zone === "UTC") return 0;
  const whole = ms - (((ms % 1000) + 1000) % 1000);
  const p = wallParts(whole, zone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - whole) / 60_000);
}

/** Reads a zone-less wall-clock time (parsed as UTC) as local time in `zone`. */
export function wallClockToUtc(wallMs: number, zone: string): number {
  const guess = wallMs - zoneOffsetMin(wallMs, zone) * 60_000;
  return wallMs - zoneOffsetMin(guess, zone) * 60_000; // second pass settles DST edges
}

function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** `YYYY-MM-DD HH:MM:SS` (plus `.mmm` when non-zero) in the given zone, then `UTC` or the offset (`+02:00`). */
export function formatInZone(ms: number, timeZone: string): string {
  const offset = zoneOffsetMin(ms, timeZone);
  const p = wallParts(ms + offset * 60_000, "UTC");
  const frac = ((ms % 1000) + 1000) % 1000;
  const millis = frac === 0 ? "" : `.${String(frac).padStart(3, "0")}`;
  const zone = timeZone === "UTC" ? "UTC" : fmtOffset(offset);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}${millis} ${zone}`;
}

/** CLDR plural category for `n` in `lang` (Hebrew has one / two / other). */
export function pluralCategory(n: number, lang: string): Intl.LDMLPluralRule {
  return new Intl.PluralRules(lang).select(n);
}

/* ------------------------------------------------------------ deep links */

export interface ViewState {
  file: string | null;
  steps: FilterStep[];
  json: JsonFilter[];
  cols: string[];
  /** 1-based line number to focus (`l=`), or null */
  line?: number | null;
  /** header column to sort by (`s=2` ascending, `s=-2` descending, 0-based index) */
  sort?: { col: number; desc: boolean } | null;
  /** time window from a histogram bar (`t=from-to[-year]`, `tp=pattern`) */
  time?: TimeRange | null;
}

const KIND_CODE: Record<StepKind, string> = { contains: "c", not: "n", regex: "r" };

export function encodeState(state: ViewState): string {
  const p = new URLSearchParams();
  if (state.file) p.set("f", state.file);
  for (const s of state.steps) {
    if (s.text === "") continue;
    p.append("q", `${KIND_CODE[s.kind]}${s.ci ? "i" : ""}:${s.text}`);
  }
  for (const j of state.json) p.append("jf", formatJsonFilter(j));
  if (state.cols.length > 0) p.set("cols", state.cols.join(","));
  if (state.sort) p.set("s", `${state.sort.desc ? "-" : ""}${state.sort.col}`);
  if (state.time) {
    p.set("t", `${state.time.from}-${state.time.to}${state.time.year !== null ? `-${state.time.year}` : ""}`);
    p.set("tp", state.time.pattern);
  }
  if (state.line !== undefined && state.line !== null && state.line > 0) p.set("l", String(state.line));
  return p.toString();
}

export function decodeState(query: string): ViewState {
  const p = new URLSearchParams(query.replace(/^\?/, ""));
  const steps: FilterStep[] = [];
  for (const raw of p.getAll("q")) {
    const m = /^([cnr])(i?):([\s\S]*)$/.exec(raw);
    if (!m) continue;
    const kind: StepKind = m[1] === "n" ? "not" : m[1] === "r" ? "regex" : "contains";
    steps.push({ kind, ci: m[2] === "i", text: m[3] ?? "" });
  }
  const json = p.getAll("jf").map(parseJsonFilter).filter((j): j is JsonFilter => j !== null);
  const cols = (p.get("cols") ?? "").split(",").map((c) => c.trim()).filter((c) => c !== "");
  const l = Number(p.get("l") ?? "");
  const sm = /^(-?)(\d{1,3})$/.exec(p.get("s") ?? "");
  const tm = /^(\d{1,15})-(\d{1,15})(?:-(\d{4}))?$/.exec(p.get("t") ?? "");
  const tp = p.get("tp");
  const time: TimeRange | null = tm && tp !== null && tp !== "" && regexError(tp) === null
    ? { pattern: tp, from: Number(tm[1]), to: Number(tm[2]), year: tm[3] ? Number(tm[3]) : null }
    : null;
  return {
    file: p.get("f"),
    steps,
    json,
    cols,
    line: Number.isInteger(l) && l > 0 ? l : null,
    sort: sm ? { col: Number(sm[2]), desc: sm[1] === "-" } : null,
    time,
  };
}

/* ------------------------------------------------------------ file list */

export interface FileGroup<T> {
  /** top-level folder, or "" for files at the root */
  dir: string;
  items: T[];
}

/** Groups by the first path segment, keeping the input order of groups and files (root files first). */
export function groupByDir<T>(items: readonly T[], pathOf: (item: T) => string): Array<FileGroup<T>> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const path = pathOf(item);
    const slash = path.indexOf("/");
    const dir = slash > 0 ? path.slice(0, slash) : "";
    const list = groups.get(dir);
    if (list) list.push(item);
    else groups.set(dir, [item]);
  }
  const out = [...groups.entries()].map(([dir, list]) => ({ dir, items: list }));
  return out.sort((a, b) => Number(b.dir === "") - Number(a.dir === ""));
}

/** True when every whitespace-separated term appears in one of the fields (case-insensitive). */
export function matchesQuery(query: string, fields: readonly string[]): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t !== "");
  if (terms.length === 0) return true;
  const hay = fields.join("\n").toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
