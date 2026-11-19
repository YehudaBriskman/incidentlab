// Pure helpers for the evidence explorer. No DOM access here: this module is
// shared by the UI, the Web Worker and the node:test suite.

export type StepKind = "contains" | "not" | "regex";

export interface FilterStep {
  kind: StepKind;
  text: string;
  /** case-insensitive */
  ci: boolean;
}

export interface JsonFilter {
  field: string;
  value: string;
}

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
  buckets: HistogramBucket[];
  truncated: boolean;
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
    return err instanceof Error ? err.message : "invalid regex";
  }
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

export function parseJsonFilter(input: string): JsonFilter | null {
  const eq = input.indexOf("=");
  if (eq <= 0) return null;
  const field = input.slice(0, eq).trim();
  const value = input.slice(eq + 1).trim();
  if (field === "") return null;
  return { field, value };
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

export function jsonLineMatches(line: string, filter: JsonFilter): boolean {
  const obj = parseJsonLine(line);
  if (obj === undefined) return false;
  const value = getJsonField(obj, filter.field);
  if (value === undefined) return false;
  if (filter.value === "*") return true;
  return stringifyField(value) === filter.value;
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

/**
 * Runs the pipeline and returns the indices of kept lines.
 * `deadline` (epoch ms) is checked periodically; FilterTimeout is thrown past it.
 */
export function applyFilters(
  lines: readonly string[],
  steps: readonly FilterStep[],
  json: JsonFilter | null = null,
  deadline = Number.POSITIVE_INFINITY,
): Uint32Array {
  const matchers: Matcher[] = [];
  for (const step of steps) {
    const m = compileStep(step);
    if (m) matchers.push(m);
  }
  const out = new Uint32Array(lines.length);
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if ((i & 2047) === 0 && Date.now() > deadline) throw new FilterTimeout("regex took too long");
    const line = lines[i] ?? "";
    let keep = true;
    for (const m of matchers) {
      if (!m(line)) {
        keep = false;
        break;
      }
    }
    if (keep && json && !jsonLineMatches(line, json)) keep = false;
    if (keep) out[n++] = i;
  }
  return out.slice(0, n);
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

/** Buckets lines by capture group 1 (e.g. a timestamp truncated to the minute), in first-seen order. */
export function histogram(
  lines: readonly string[],
  indices: ArrayLike<number> | null,
  pattern: string,
  deadline = Number.POSITIVE_INFINITY,
): HistogramResult {
  const re = new RegExp(pattern);
  const counts = new Map<string, number>();
  let truncated = false;
  let k = 0;
  for (const i of iterIndices(lines.length, indices)) {
    if ((k++ & 2047) === 0 && Date.now() > deadline) throw new FilterTimeout("regex took too long");
    const m = re.exec(lines[i] ?? "");
    if (!m) continue;
    const key = m[1] ?? m[0];
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
  return { buckets: [...counts.entries()].map(([key, count]) => ({ key, count })), truncated };
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

/** Parses epoch seconds/ms, ISO-8601, nginx `13/Nov/2026:00:00:00 +0000` or `YYYY-MM-DD HH:MM:SS[.fff] UTC`. Returns epoch ms. */
export function parseTimeInput(raw: string): number | null {
  const input = raw.trim().replace(/^\[|\]$/g, "").trim();
  if (input === "") return null;
  if (/^\d+(\.\d+)?$/.test(input)) {
    const n = Number(input);
    if (!Number.isFinite(n)) return null;
    // 13+ digit integers are milliseconds
    return input.split(".")[0]!.length >= 13 ? Math.round(n) : Math.round(n * 1000);
  }
  const nginx = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s*([+-])(\d{2}):?(\d{2}))?$/.exec(input);
  if (nginx) {
    const [, d, mon, y, hh, mm, ss, sign, oh, om] = nginx;
    const month = MONTHS[(mon ?? "").toLowerCase()];
    if (month === undefined) return null;
    const utc = Date.UTC(Number(y), month, Number(d), Number(hh), Number(mm), Number(ss));
    const offsetMin = sign ? (Number(oh) * 60 + Number(om)) * (sign === "-" ? -1 : 1) : 0;
    return utc - offsetMin * 60_000;
  }
  let iso = input;
  const pg = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(UTC|GMT|Z)?$/i.exec(input);
  if (pg) iso = `${pg[1]}T${pg[2]}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD HH:MM:SS` (plus `.mmm` when non-zero) in the given IANA zone. */
export function formatInZone(ms: number, timeZone: string): string {
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
      timeZoneName: "short",
    });
    formatters.set(timeZone, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  const frac = ((ms % 1000) + 1000) % 1000;
  const millis = frac === 0 ? "" : `.${String(frac).padStart(3, "0")}`;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}${millis} ${parts.timeZoneName ?? ""}`.trim();
}

/* ------------------------------------------------------------ deep links */

export interface ViewState {
  file: string | null;
  steps: FilterStep[];
  json: JsonFilter | null;
  cols: string[];
}

const KIND_CODE: Record<StepKind, string> = { contains: "c", not: "n", regex: "r" };

export function encodeState(state: ViewState): string {
  const p = new URLSearchParams();
  if (state.file) p.set("f", state.file);
  for (const s of state.steps) {
    if (s.text === "") continue;
    p.append("q", `${KIND_CODE[s.kind]}${s.ci ? "i" : ""}:${s.text}`);
  }
  if (state.json) p.set("jf", `${state.json.field}=${state.json.value}`);
  if (state.cols.length > 0) p.set("cols", state.cols.join(","));
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
  const jf = p.get("jf");
  const cols = (p.get("cols") ?? "").split(",").map((c) => c.trim()).filter((c) => c !== "");
  return { file: p.get("f"), steps, json: jf ? parseJsonFilter(jf) : null, cols };
}

export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
