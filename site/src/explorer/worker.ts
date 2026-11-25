// Heavy lifting for the explorer. File contents live ONLY here; the UI asks for
// windows of rows and aggregate results.
import { applyFilters, countUnique, FilterTimeout, histogram, looksLikeJsonLines } from "./core";
import { MAX_COPY_LINES, MAX_FILES_IN_WORKER, MAX_UNIQUE_ROWS } from "./protocol";
import type { WorkerRequest, WorkerResponse } from "./protocol";

const TIME_BUDGET_MS = 1500;

interface LoadedFile {
  lines: string[];
  view: Uint32Array | null; // null = all lines
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

async function load(job: number, path: string, url: string): Promise<void> {
  loads.get(path)?.abort();
  const ac = new AbortController();
  loads.set(path, ac);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} while fetching ${path}`);
    const total = Number(res.headers.get("content-length") ?? "0");
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
    store(path, { lines, view: null });
    post({ type: "loaded", job, path, lineCount: lines.length, bytes: loaded, isJson: looksLikeJsonLines(lines) });
  } catch (err) {
    const cancelled = ac.signal.aborted;
    post({ type: "error", job, message: cancelled ? "Load cancelled." : errMsg(err), cancelled });
  } finally {
    if (loads.get(path) === ac) loads.delete(path);
  }
}

function errMsg(err: unknown): string {
  if (err instanceof FilterTimeout) return "regex took too long";
  if (err instanceof Error) return err.message;
  return "unexpected error";
}

function need(job: number, path: string): LoadedFile | null {
  const f = touch(path);
  if (!f) post({ type: "error", job, message: "File is not loaded.", notLoaded: true });
  return f ?? null;
}

function handle(msg: WorkerRequest): void {
  switch (msg.type) {
    case "load":
      void load(msg.job, msg.path, msg.url);
      return;
    case "cancelLoad":
      loads.get(msg.path)?.abort();
      return;
    case "filter": {
      const f = need(msg.job, msg.path);
      if (!f) return;
      const active = msg.steps.some((s) => s.text !== "") || msg.json !== null;
      f.view = active ? applyFilters(f.lines, msg.steps, msg.json, Date.now() + TIME_BUDGET_MS) : null;
      post({ type: "filtered", job: msg.job, path: msg.path, total: f.lines.length, count: viewLength(f) });
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
      post({ type: "histogram", job: msg.job, result: histogram(f.lines, f.view, msg.pattern, Date.now() + TIME_BUDGET_MS) });
      return;
    }
    case "copy": {
      const f = need(msg.job, msg.path);
      if (!f) return;
      const n = Math.min(viewLength(f), MAX_COPY_LINES);
      const out: string[] = [];
      for (let r = 0; r < n; r++) out.push(f.lines[lineAt(f, r)] ?? "");
      post({ type: "copy", job: msg.job, text: out.join("\n"), count: n, capped: viewLength(f) > n });
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
    post({ type: "error", job, message: errMsg(err) });
  }
};
