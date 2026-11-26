// Heavy lifting for the explorer. File contents live ONLY here; the UI asks for
// windows of rows and aggregate results.
import { cachedFetch } from "./cache";
import { applyFilters, countUnique, csvColumnWidths, FilterTimeout, histogram, jsonFieldPaths, looksLikeJsonLines, sortIndices, yearHint } from "./core";
import { MAX_COPY_LINES, MAX_DETAIL_CHARS, MAX_FILES_IN_WORKER, MAX_UNIQUE_ROWS } from "./protocol";
import type { WorkerErrorCode, WorkerRequest, WorkerResponse } from "./protocol";

const TIME_BUDGET_MS = 1500;

interface LoadedFile {
  lines: string[];
  view: Uint32Array | null; // null = all lines
  /** the view is in a column's order, not file order, so `locate` cannot binary-search it */
  sorted: boolean;
}

const files = new Map<string, LoadedFile>();
const loads = new Map<string, AbortController>();
interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

function post(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

function touch(path: string): LoadedFile | undefined {
  const f = files.get(path);
  if (f) {
    files.delete(path);
    files.set(path, f);
  }
  return f;
}

function store(path: string, file: LoadedFile): void {
  files.delete(path);
  files.set(path, file);
  while (files.size > MAX_FILES_IN_WORKER) {
    const oldest = files.keys().next().value;
    if (oldest === undefined) break;
    files.delete(oldest);
  }
}

function viewLength(f: LoadedFile): number {
  return f.view ? f.view.length : f.lines.length;
}

function lineAt(f: LoadedFile, row: number): number {
  return f.view ? (f.view[row] ?? 0) : row;
}

/** View row of file line `line`, or -1 when the filter hides it. The view is sorted, so binary search. */
function locate(f: LoadedFile, line: number): number {
  if (!f.view) return line >= 0 && line < f.lines.length ? line : -1;
  if (f.sorted) return f.view.indexOf(line);
  let lo = 0;
  let hi = f.view.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = f.view[mid] ?? 0;
    if (v === line) return mid;
    if (v < line) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

async function load(job: number, path: string, url: string, mode: "text" | "json" | "csv", session: string): Promise<void> {
  loads.get(path)?.abort();
  const ac = new AbortController();
  loads.set(path, ac);
  try {
    const { res, fromCache } = await cachedFetch(url, ac.signal, session);
    if (!res.ok || !res.body) throw new HttpError(res.status);
    // With gzip/br, content-length is the compressed size while `loaded` counts decoded bytes, so the
    // total is unknown and the UI shows an indeterminate bar instead of one that lies.
    const encoding = (res.headers.get("content-encoding") ?? "identity").toLowerCase();
    const total = encoding === "identity" ? Number(res.headers.get("content-length") ?? "0") : 0;
    const lines: string[] = [];
    let rest = "";
    let loaded = 0;
    let lastPost = 0;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      const chunk = rest + decoder.decode(value, { stream: true });
      const parts = chunk.split("\n");
      rest = parts.pop() ?? "";
      for (const p of parts) lines.push(p.endsWith("\r") ? p.slice(0, -1) : p);
      const now = Date.now();
      if (now - lastPost > 80) {
        lastPost = now;
        post({ type: "progress", job, path, loaded, total });
      }
    }
    rest += decoder.decode();
    if (rest !== "") lines.push(rest.endsWith("\r") ? rest.slice(0, -1) : rest);
    store(path, { lines, view: null, sorted: false });
    const isJson = looksLikeJsonLines(lines);
    post({
      type: "loaded",
      job,
      path,
      lineCount: lines.length,
      bytes: loaded,
      isJson,
      year: yearHint(lines),
      fields: isJson ? jsonFieldPaths(lines) : [],
      widths: mode === "csv" ? csvColumnWidths(lines) : [],
      fromCache,
    });
  } catch (err) {
    if (ac.signal.aborted) post({ type: "error", job, code: "cancelled" });
    else post(errorFor(job, err));
  } finally {
    if (loads.get(path) === ac) loads.delete(path);
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

function errorFor(job: number, err: unknown): WorkerResponse {
  const code: WorkerErrorCode = err instanceof FilterTimeout ? "timeout" : err instanceof HttpError ? "http" : "unexpected";
  return {
    type: "error",
    job,
    code,
    status: err instanceof HttpError ? err.status : undefined,
    detail: code === "unexpected" && err instanceof Error ? err.message : undefined,
  };
}

function need(job: number, path: string): LoadedFile | null {
  const f = touch(path);
  if (!f) post({ type: "error", job, code: "notLoaded" });
  return f ?? null;
}

function rangeView(from: number, to: number): Uint32Array {
  const out = new Uint32Array(Math.max(0, to - from));
  for (let i = 0; i < out.length; i++) out[i] = from + i;
  return out;
}

function handle(msg: WorkerRequest): void {
  switch (msg.type) {
    case "load":
      void load(msg.job, msg.path, msg.url, msg.mode, msg.session);
      return;
    case "cancelLoad":
      loads.get(msg.path)?.abort();
      return;
    case "filter": {
      const f = need(msg.job, msg.path);
      if (!f) return;
      const active = msg.steps.some((s) => s.text !== "") || msg.json.length > 0 || msg.time !== null;
      const skip = msg.skipHeader && f.lines.length > 0;
      const deadline = Date.now() + TIME_BUDGET_MS;
      if (active) f.view = applyFilters(f.lines, msg.steps, msg.json, deadline, skip, { time: msg.time });
      else f.view = skip ? rangeView(1, f.lines.length) : null;
      f.sorted = false;
      if (msg.sort) {
        f.view = sortIndices(f.lines, f.view ?? rangeView(0, f.lines.length), msg.sort.key, msg.sort.desc, deadline + TIME_BUDGET_MS);
        f.sorted = true;
      }
      post({ type: "filtered", job: msg.job, path: msg.path, total: f.lines.length - (skip ? 1 : 0), count: viewLength(f) });
      return;
    }
    case "window": {
      const f = need(msg.job, msg.path);
      if (!f) return;
      const end = Math.min(viewLength(f), msg.start + Math.min(msg.count, 1000));
      const rows: Array<[number, string]> = [];
      for (let r = Math.max(0, msg.start); r < end; r++) {
        const i = lineAt(f, r);
        const text = f.lines[i] ?? "";
        rows.push([i, text.length > 4000 ? `${text.slice(0, 4000)} …[truncated]` : text]);
      }
      post({ type: "window", job: msg.job, path: msg.path, start: msg.start, rows });
      return;
    }
    case "unique": {
      const f = need(msg.job, msg.path);
      if (!f) return;
      const r = countUnique(f.lines, f.view, msg.pattern, msg.ci, Date.now() + TIME_BUDGET_MS);
      post({
        type: "unique",
        job: msg.job,
        rows: r.rows.slice(0, MAX_UNIQUE_ROWS),
        distinct: r.distinct,
        matchedLines: r.matchedLines,
        more: Math.max(0, r.rows.length - MAX_UNIQUE_ROWS),
      });
      return;
    }
    case "histogram": {
      const f = need(msg.job, msg.path);
      if (!f) return;
      post({ type: "histogram", job: msg.job, result: histogram(f.lines, f.view, msg.pattern, Date.now() + TIME_BUDGET_MS, msg.year) });
      return;
    }
    case "copy": {
      const f = need(msg.job, msg.path);
      if (!f) return;
      if (msg.row !== undefined) {
        const ok = msg.row >= 0 && msg.row < viewLength(f);
        post({ type: "copy", job: msg.job, text: ok ? (f.lines[lineAt(f, msg.row)] ?? "") : "", count: ok ? 1 : 0, capped: false });
        return;
      }
      const n = Math.min(viewLength(f), MAX_COPY_LINES);
      const out: string[] = [];
      for (let r = 0; r < n; r++) out.push(f.lines[lineAt(f, r)] ?? "");
      post({ type: "copy", job: msg.job, text: out.join("\n"), count: n, capped: viewLength(f) > n });
      return;
    }
    case "locate": {
      const f = need(msg.job, msg.path);
      if (!f) return;
      post({ type: "located", job: msg.job, line: msg.line, row: locate(f, msg.line) });
      return;
    }
    case "detail": {
      const f = need(msg.job, msg.path);
      if (!f) return;
      if (msg.row < 0 || msg.row >= viewLength(f)) {
        post({ type: "detail", job: msg.job, row: msg.row, line: -1, text: "", truncated: false });
        return;
      }
      const line = lineAt(f, msg.row);
      const text = f.lines[line] ?? "";
      post({ type: "detail", job: msg.job, row: msg.row, line, text: text.slice(0, MAX_DETAIL_CHARS), truncated: text.length > MAX_DETAIL_CHARS });
      return;
    }
  }
}

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    handle(msg);
  } catch (err) {
    const job = "job" in msg ? msg.job : -1;
    post(errorFor(job, err));
  }
};
