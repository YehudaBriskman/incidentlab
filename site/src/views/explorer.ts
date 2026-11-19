import "../explorer.css";
import { h } from "../lib/dom";
import { WorkerClient } from "../explorer/client";
import {
  decodeState,
  encodeState,
  fmtBytes,
  fmtCount,
  formatInZone,
  getJsonField,
  isEpochSeconds,
  matchRanges,
  parseCsvLine,
  parseJsonFilter,
  parseJsonLine,
  parseTimeInput,
  regexError,
  stringifyField,
} from "../explorer/core";
import type { FilterStep, HistogramResult, JsonFilter, StepKind } from "../explorer/core";
import { EVIDENCE_FILES, FILTER_PRESETS, HISTOGRAM_PRESETS, UNIQUE_PRESETS, evidenceUrl } from "../explorer/files";
import type { EvidenceFile } from "../explorer/files";
import type { WorkerResponse } from "../explorer/protocol";

const ROUTE = "#/case/3am-outage/explorer";
const ROW_H = 20;
const DEBOUNCE_MS = 250;
const HARD_TIMEOUT_MS = 2500;
const ZONE = "Asia/Jerusalem";

let activeTeardown: (() => void) | null = null;

function ownsHash(hash: string): boolean {
  return hash === ROUTE || hash.startsWith(`${ROUTE}?`) || hash.startsWith(`${ROUTE}/`);
}

export function renderExplorer(root: HTMLElement): void {
  activeTeardown?.();
  activeTeardown = null;
  document.title = "Evidence explorer · IncidentLab";

  const initial = decodeState(window.location.hash.split("?")[1] ?? "");

  /* ---------------------------------------------------------------- state */
  let file: EvidenceFile | null = null;
  const inWorker = new Set<string>();
  const knownBytes = new Map<string, number>();
  let loadJob = 0;
  let filterJob = 0;
  let windowJob = 0;
  let headerJob = 0;
  let aggJob = 0;
  let copyJob = 0;
  let total = 0;
  let count = 0;
  let isJson = false;
  let csvHeader: string[] = [];
  let steps: FilterStep[] = initial.steps.length > 0 ? initial.steps : [{ kind: "contains", text: "", ci: true }];
  let json: JsonFilter | null = initial.json;
  let cols: string[] = initial.cols;
  let suspendRegex = false;
  let winStart = 0;
  let winRows: Array<[number, string]> = [];
  let pendingWindow = false;
  let flashRow = -1;
  let debounce: number | null = null;
  let raf = 0;

  /* ---------------------------------------------------------------- dom */
  const status = h("p", { class: "ex-status", role: "status", "aria-live": "polite" });
  const notice = h("div", { class: "ex-notice", hidden: true });
  const fileList = h("ul", { class: "ex-files" });
  const sidebar = h("aside", { class: "ex-sidebar" });
  const sideToggle = h("button", { class: "btn btn-sm ex-side-toggle", type: "button", "aria-expanded": "false" }, "Files & time");
  const progressBar = h("div", { class: "ex-progress-bar" });
  const progressText = h("span", { class: "ex-progress-text" });
  const cancelBtn = h("button", { class: "btn btn-sm btn-ghost", type: "button" }, "Cancel");
  const progress = h("div", { class: "ex-progress", hidden: true }, h("div", { class: "ex-progress-track" }, progressBar), progressText, cancelBtn);
  const title = h("h2", { class: "ex-title mono" }, "Pick a file");
  const countEl = h("span", { class: "ex-count mono" });
  const pipeline = h("div", { class: "ex-pipeline" });
  const presets = h("div", { class: "ex-chips" });
  const jsonInput = h("input", { class: "ex-input mono", placeholder: "field = value   (e.g. level = error, * = any)", spellcheck: "false" });
  const colsInput = h("input", { class: "ex-input mono", placeholder: "columns: ts, level, msg", spellcheck: "false" });
  const jsonBar = h("div", { class: "ex-jsonbar", hidden: true },
    h("label", {}, h("span", {}, "JSON field filter"), jsonInput),
    h("label", {}, h("span", {}, "Column view"), colsInput));
  const viewport = h("div", { class: "ex-viewport", tabindex: "0", "aria-label": "File lines" });
  const spacer = h("div", { class: "ex-spacer" });
  const rowsLayer = h("div", { class: "ex-rows" });
  const csvHead = h("div", { class: "ex-csvhead mono", hidden: true });
  viewport.append(spacer, rowsLayer);
  const firstBtn = h("button", { class: "btn btn-sm", type: "button" }, "First match");
  const lastBtn = h("button", { class: "btn btn-sm", type: "button" }, "Last match");
  const copyBtn = h("button", { class: "btn btn-sm", type: "button" }, "Copy lines");
  const shareBtn = h("button", { class: "btn btn-sm btn-ghost", type: "button" }, "Copy link");

  const uniqInput = h("input", { class: "ex-input mono", value: "cid=(\\S+)", spellcheck: "false", "aria-label": "Capture regex" });
  const uniqOut = h("div", { class: "ex-agg-out" });
  const histInput = h("input", { class: "ex-input mono", value: "", spellcheck: "false", "aria-label": "Timestamp regex", placeholder: "regex with one capture group, e.g. \\[(\\d+/\\w+/\\d+:\\d\\d:\\d\\d)" });
  const histOut = h("div", { class: "ex-agg-out" });

  const timeInput = h("input", { class: "ex-input mono", placeholder: "epoch / ISO / 13/Nov/2026:00:00:00 +0000", spellcheck: "false", "aria-label": "Time to convert" });
  const timeOut = h("dl", { class: "ex-time-out mono" });

  /* ---------------------------------------------------------------- worker */
  const client = new WorkerClient(onMessage, (reason) => {
    inWorker.clear();
    showNotice(reason);
    if (reason.startsWith("regex")) suspendRegex = true;
    if (file) startLoad(file);
  });

  function showNotice(text: string, tone: "warn" | "info" = "warn"): void {
    notice.hidden = false;
    notice.className = `ex-notice ex-notice-${tone}`;
    notice.textContent = text;
  }
  function clearNotice(): void {
    notice.hidden = true;
  }

  function onMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case "progress":
        if (msg.job !== loadJob) return;
        progress.hidden = false;
        progressBar.style.width = msg.total > 0 ? `${Math.min(100, (msg.loaded / msg.total) * 100).toFixed(1)}%` : "30%";
        progressText.textContent = `Loading ${fmtBytes(msg.loaded)}${msg.total > 0 ? ` of ${fmtBytes(msg.total)}` : ""}…`;
        return;
      case "loaded":
        if (msg.job !== loadJob || !file || msg.path !== file.path) return;
        progress.hidden = true;
        inWorker.add(msg.path);
        knownBytes.set(msg.path, msg.bytes);
        renderFileList();
        isJson = msg.isJson;
        total = msg.lineCount;
        if (file.mode === "csv") {
          headerJob = client.job();
          client.send({ type: "window", job: headerJob, path: file.path, start: 0, count: 1 });
        }
        runFilter();
        return;
      case "filtered":
        if (msg.job !== filterJob) return;
        total = msg.total;
        count = msg.count;
        updateCount();
        winRows = [];
        winStart = 0;
        spacer.style.height = `${count * ROW_H}px`;
        if (flashRow >= count) flashRow = -1;
        scheduleRender();
        return;
      case "window":
        if (msg.job === headerJob) {
          csvHeader = parseCsvLine(msg.rows[0]?.[1] ?? "");
          renderCsvHead();
          return;
        }
        if (msg.job !== windowJob) return;
        pendingWindow = false;
        winStart = msg.start;
        winRows = msg.rows;
        renderRows();
        return;
      case "unique":
        if (msg.job !== aggJob) return;
        renderUnique(msg.rows, msg.distinct, msg.matchedLines, msg.more);
        return;
      case "histogram":
        if (msg.job !== aggJob) return;
        renderHistogram(msg.result);
        return;
      case "copy":
        if (msg.job !== copyJob) return;
        void copyText(msg.text).then((ok) => {
          showNotice(ok ? `Copied ${fmtCount(msg.count)} lines${msg.capped ? " (capped at 5,000)" : ""}.` : "Clipboard is blocked by the browser.", ok ? "info" : "warn");
        });
        return;
      case "error":
        if (msg.notLoaded && file) {
          inWorker.delete(file.path);
          startLoad(file);
          return;
        }
        if (msg.job === loadJob) {
          progress.hidden = true;
          showNotice(msg.cancelled ? "Load cancelled." : `Could not load file: ${msg.message}. Try again.`);
          return;
        }
        if (msg.job === filterJob) {
          count = 0;
          updateCount();
        }
        showNotice(msg.message === "regex took too long" ? "regex took too long — simplify the pattern." : msg.message);
        if (msg.job === aggJob) {
          uniqOut.replaceChildren();
          histOut.replaceChildren();
        }
        return;
    }
  }

  /* ---------------------------------------------------------------- files */
  function renderFileList(): void {
    fileList.replaceChildren(
      ...EVIDENCE_FILES.map((f) => {
        const bytes = knownBytes.get(f.path);
        const btn = h(
          "button",
          { class: `ex-file${file?.path === f.path ? " is-active" : ""}`, type: "button", "aria-current": file?.path === f.path ? "true" : null },
          h("span", { class: "ex-file-name mono" }, f.path),
          h("span", { class: "ex-file-meta" }, bytes !== undefined ? fmtBytes(bytes) : f.size, inWorker.has(f.path) ? " · loaded" : ""),
          h("span", { class: "ex-file-desc" }, f.description),
        );
        btn.addEventListener("click", () => {
          selectFile(f);
          sidebar.classList.remove("is-open");
          sideToggle.setAttribute("aria-expanded", "false");
        });
        return h("li", {}, btn);
      }),
    );
  }

  function selectFile(f: EvidenceFile): void {
    if (file?.path === f.path) return;
    if (file && file.path !== f.path) client.send({ type: "cancelLoad", path: file.path });
    file = f;
    title.textContent = f.path;
    csvHeader = [];
    csvHead.hidden = f.mode !== "csv";
    jsonBar.hidden = f.mode !== "json";
    count = 0;
    total = 0;
    winRows = [];
    spacer.style.height = "0px";
    viewport.scrollTop = 0;
    rowsLayer.replaceChildren();
    clearNotice();
    renderFileList();
    syncHash();
    if (inWorker.has(f.path)) {
      loadJob = client.job();
      isJson = f.mode === "json";
      if (f.mode === "csv") {
        headerJob = client.job();
        client.send({ type: "window", job: headerJob, path: f.path, start: 0, count: 1 });
      }
      runFilter();
    } else startLoad(f);
  }

  function startLoad(f: EvidenceFile): void {
    loadJob = client.job();
    progress.hidden = false;
    progressBar.style.width = "0%";
    progressText.textContent = "Loading…";
    countEl.textContent = "";
    client.send({ type: "load", job: loadJob, path: f.path, url: evidenceUrl(f.path) });
  }

  /* ---------------------------------------------------------------- filters */
  function effectiveSteps(): FilterStep[] {
    return steps.filter((s) => !(suspendRegex && s.kind === "regex"));
  }

  function runFilter(): void {
    if (!file || !inWorker.has(file.path)) return;
    for (const s of steps) {
      if (s.kind === "regex" && s.text !== "") {
        const err = regexError(s.text);
        if (err) {
          showNotice(`Invalid regex: ${err}`);
          return;
        }
      }
    }
    filterJob = client.job();
    countEl.textContent = "filtering…";
    const hasRegex = effectiveSteps().some((s) => s.kind === "regex" && s.text !== "");
    client.send({ type: "filter", job: filterJob, path: file.path, steps: effectiveSteps(), json: file.mode === "json" ? json : null }, hasRegex ? HARD_TIMEOUT_MS : 0);
  }

  function scheduleFilter(): void {
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = null;
      suspendRegex = false;
      clearNotice();
      syncHash();
      runFilter();
    }, DEBOUNCE_MS);
  }

  function updateCount(): void {
    countEl.textContent = `${fmtCount(count)} of ${fmtCount(total)} lines`;
  }

  function renderPipeline(): void {
    pipeline.replaceChildren(
      ...steps.map((step, idx) => {
        const kind = h("select", { class: "ex-select", "aria-label": "Filter type" },
          h("option", { value: "contains" }, "contains"),
          h("option", { value: "not" }, "NOT contains"),
          h("option", { value: "regex" }, "regex"));
        kind.value = step.kind;
        kind.addEventListener("change", () => {
          step.kind = kind.value === "not" ? "not" : kind.value === "regex" ? "regex" : "contains";
          scheduleFilter();
        });
        const input = h("input", { class: "ex-input mono", placeholder: idx === 0 ? "type to filter…" : "and then…", spellcheck: "false", "aria-label": "Filter text" });
        input.value = step.text;
        input.addEventListener("input", () => {
          step.text = input.value;
          scheduleFilter();
        });
        const ci = h("input", { type: "checkbox" });
        ci.checked = step.ci;
        ci.addEventListener("change", () => {
          step.ci = ci.checked;
          scheduleFilter();
        });
        const remove = h("button", { class: "btn btn-sm btn-ghost", type: "button", "aria-label": "Remove filter" }, "×");
        remove.addEventListener("click", () => {
          steps.splice(idx, 1);
          if (steps.length === 0) steps.push({ kind: "contains", text: "", ci: true });
          renderPipeline();
          scheduleFilter();
        });
        return h("div", { class: "ex-step" }, idx > 0 ? h("span", { class: "ex-pipe mono" }, "|") : null, kind, input,
          h("label", { class: "ex-ci" }, ci, "ignore case"), remove);
      }),
      (() => {
        const add = h("button", { class: "btn btn-sm", type: "button" }, "+ add filter");
        add.addEventListener("click", () => addStep("contains", ""));
        return add;
      })(),
    );
  }

  function addStep(kind: StepKind, text: string): void {
    const last = steps[steps.length - 1];
    if (last && last.text === "") steps.pop();
    steps.push({ kind, text, ci: kind !== "regex" });
    renderPipeline();
    scheduleFilter();
  }

  /* ---------------------------------------------------------------- virtual list */
  function scheduleRender(): void {
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      renderRows();
    });
  }

  function renderRows(): void {
    if (!file) return;
    const first = Math.floor(viewport.scrollTop / ROW_H);
    const visible = Math.ceil(viewport.clientHeight / ROW_H) + 2;
    const last = Math.min(count, first + visible);
    const haveAll = first >= winStart && last <= winStart + winRows.length;
    if (!haveAll && count > 0 && !pendingWindow) {
      pendingWindow = true;
      windowJob = client.job();
      client.send({ type: "window", job: windowJob, path: file.path, start: Math.max(0, first - 60), count: visible + 120 });
    } else if (!haveAll && pendingWindow) {
      // a request is in flight; re-check once it lands
      windowJob = client.job();
      client.send({ type: "window", job: windowJob, path: file.path, start: Math.max(0, first - 60), count: visible + 120 });
    }
    rowsLayer.style.transform = `translateY(${first * ROW_H}px)`;
    const frag = document.createDocumentFragment();
    const active = effectiveSteps();
    for (let r = first; r < last; r++) {
      const entry = winRows[r - winStart];
      frag.appendChild(renderRow(r, entry, active));
    }
    rowsLayer.replaceChildren(frag);
    if (count === 0 && total > 0) rowsLayer.replaceChildren(h("div", { class: "ex-empty" }, "No lines match this pipeline."));
  }

  function renderRow(r: number, entry: [number, string] | undefined, active: FilterStep[]): HTMLElement {
    const row = h("div", { class: `ex-row${r === flashRow ? " is-flash" : ""}` });
    if (!entry) {
      row.appendChild(h("span", { class: "ex-ln" }, "…"));
      return row;
    }
    const [lineIdx, text] = entry;
    row.appendChild(h("span", { class: "ex-ln" }, String(lineIdx + 1)));
    if (file?.mode === "csv" && csvHeader.length > 0 && lineIdx > 0) {
      for (const cell of parseCsvLine(text)) {
        const c = h("span", { class: "ex-cell" }, cell);
        if (isEpochSeconds(cell)) {
          const ms = Number(cell) * 1000;
          c.title = `${formatInZone(ms, "UTC")}\n${formatInZone(ms, ZONE)}`;
          c.classList.add("is-epoch");
        }
        row.appendChild(c);
      }
      return row;
    }
    if (isJson && cols.length > 0) {
      const obj = parseJsonLine(text);
      if (obj !== undefined) {
        for (const col of cols) row.appendChild(h("span", { class: "ex-cell ex-cell-wide" }, stringifyField(getJsonField(obj, col))));
        return row;
      }
    }
    const body = h("span", { class: "ex-text" });
    const ranges = matchRanges(text, active);
    let pos = 0;
    for (const [a, b] of ranges) {
      if (a > pos) body.appendChild(document.createTextNode(text.slice(pos, a)));
      body.appendChild(h("mark", {}, text.slice(a, b)));
      pos = b;
    }
    if (pos < text.length) body.appendChild(document.createTextNode(text.slice(pos)));
    row.appendChild(body);
    return row;
  }

  function renderCsvHead(): void {
    csvHead.replaceChildren(h("span", { class: "ex-ln" }, "#"), ...csvHeader.map((c) => h("span", { class: "ex-cell" }, c)));
  }

  function jumpTo(row: number): void {
    if (count === 0) return;
    flashRow = Math.max(0, Math.min(count - 1, row));
    viewport.scrollTop = Math.max(0, flashRow * ROW_H - viewport.clientHeight / 3);
    scheduleRender();
  }

  /* ---------------------------------------------------------------- aggregations */
  function runUnique(): void {
    if (!file || !inWorker.has(file.path)) return;
    const pattern = uniqInput.value;
    const err = regexError(pattern);
    if (err || pattern === "") {
      uniqOut.replaceChildren(h("p", { class: "ex-err" }, err ? `Invalid regex: ${err}` : "Enter a regex with one capture group."));
      return;
    }
    aggJob = client.job();
    uniqOut.replaceChildren(h("p", { class: "ex-muted" }, "Counting…"));
    client.send({ type: "unique", job: aggJob, path: file.path, pattern, ci: false }, HARD_TIMEOUT_MS);
  }

  function renderUnique(rows: Array<[string, number]>, distinct: number, matched: number, more: number): void {
    let sortBy: "count" | "value" = "count";
    let asc = false;
    const tbody = h("tbody");
    const paint = (): void => {
      const sorted = [...rows].sort((a, b) => {
        const d = sortBy === "count" ? a[1] - b[1] : a[0].localeCompare(b[0], undefined, { numeric: true });
        return asc ? d : -d;
      });
      tbody.replaceChildren(
        ...sorted.map(([value, n]) => {
          const add = h("button", { class: "ex-linkish mono", type: "button", title: "Add as a contains filter" }, value === "" ? "(empty)" : value);
          add.addEventListener("click", () => addStep("contains", value));
          return h("tr", {}, h("td", {}, add), h("td", { class: "num mono" }, fmtCount(n)));
        }),
      );
    };
    const th = (label: string, key: "count" | "value"): HTMLElement => {
      const b = h("button", { class: "ex-th", type: "button" }, label);
      b.addEventListener("click", () => {
        if (sortBy === key) asc = !asc;
        else {
          sortBy = key;
          asc = key === "value";
        }
        paint();
      });
      return h("th", {}, b);
    };
    paint();
    uniqOut.replaceChildren(
      h("p", { class: "ex-big" }, h("strong", { class: "mono" }, fmtCount(distinct)), ` distinct values in ${fmtCount(matched)} matching lines`),
      h("div", { class: "ex-table-wrap" }, h("table", { class: "ex-table" }, h("thead", {}, h("tr", {}, th("value", "value"), th("count", "count"))), tbody)),
      ...(more > 0 ? [h("p", { class: "ex-muted" }, `${fmtCount(more)} more… (showing the top 500 by count)`)] : []),
    );
  }

  function runHistogram(): void {
    if (!file || !inWorker.has(file.path)) return;
    const pattern = histInput.value;
    const err = regexError(pattern);
    if (err || pattern === "") {
      histOut.replaceChildren(h("p", { class: "ex-err" }, err ? `Invalid regex: ${err}` : "Enter a regex capturing a timestamp prefix."));
      return;
    }
    aggJob = client.job();
    histOut.replaceChildren(h("p", { class: "ex-muted" }, "Bucketing…"));
    client.send({ type: "histogram", job: aggJob, path: file.path, pattern }, HARD_TIMEOUT_MS);
  }

  function renderHistogram(result: HistogramResult): void {
    const max = result.buckets.reduce((m, b) => Math.max(m, b.count), 0);
    if (result.buckets.length === 0) {
      histOut.replaceChildren(h("p", { class: "ex-muted" }, "No line matched the pattern."));
      return;
    }
    histOut.replaceChildren(
      h("p", { class: "ex-muted" }, `${fmtCount(result.buckets.length)} buckets${result.truncated ? " (capped)" : ""}, max ${fmtCount(max)}`),
      h("div", { class: "ex-hist" },
        ...result.buckets.map((b) => {
          const bar = h("span", { class: "ex-bar" });
          bar.style.width = `${max > 0 ? (b.count / max) * 100 : 0}%`;
          return h("div", { class: "ex-hist-row" }, h("span", { class: "ex-hist-key mono" }, b.key), h("span", { class: "ex-bar-track" }, bar), h("span", { class: "ex-hist-n mono" }, fmtCount(b.count)));
        })),
    );
  }

  /* ---------------------------------------------------------------- time */
  function renderTime(): void {
    const ms = parseTimeInput(timeInput.value);
    if (timeInput.value.trim() === "") {
      timeOut.replaceChildren();
      return;
    }
    if (ms === null) {
      timeOut.replaceChildren(h("dd", { class: "ex-err" }, "Unrecognised format"));
      return;
    }
    timeOut.replaceChildren(
      h("dt", {}, "UTC"), h("dd", {}, formatInZone(ms, "UTC")),
      h("dt", {}, "Jerusalem"), h("dd", {}, formatInZone(ms, ZONE)),
      h("dt", {}, "epoch"), h("dd", {}, String(ms / 1000)),
    );
  }

  /* ---------------------------------------------------------------- hash / copy */
  function stateQuery(): string {
    return encodeState({ file: file?.path ?? null, steps, json, cols });
  }
  function syncHash(): void {
    const q = stateQuery();
    history.replaceState(null, "", `${ROUTE}${q ? `?${q}` : ""}`);
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = h("textarea", { class: "ex-offscreen" });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  /* ---------------------------------------------------------------- wiring */
  for (const p of FILTER_PRESETS) {
    const chip = h("button", { class: "ex-chip", type: "button", title: `${p.kind}: ${p.text}` }, p.label);
    chip.addEventListener("click", () => addStep(p.kind, p.text));
    presets.appendChild(chip);
  }
  cancelBtn.addEventListener("click", () => {
    if (file) client.send({ type: "cancelLoad", path: file.path });
  });
  firstBtn.addEventListener("click", () => jumpTo(0));
  lastBtn.addEventListener("click", () => jumpTo(count - 1));
  copyBtn.addEventListener("click", () => {
    if (!file || !inWorker.has(file.path)) return;
    copyJob = client.job();
    client.send({ type: "copy", job: copyJob, path: file.path });
  });
  shareBtn.addEventListener("click", () => {
    syncHash();
    void copyText(window.location.href).then((ok) => showNotice(ok ? "Link to this view copied." : "Copy the address bar to share this view.", "info"));
  });
  viewport.addEventListener("scroll", scheduleRender, { passive: true });
  const ro = new ResizeObserver(scheduleRender);
  ro.observe(viewport);
  jsonInput.value = json ? `${json.field} = ${json.value}` : "";
  jsonInput.addEventListener("input", () => {
    json = parseJsonFilter(jsonInput.value);
    scheduleFilter();
  });
  colsInput.value = cols.join(", ");
  colsInput.addEventListener("input", () => {
    cols = colsInput.value.split(",").map((c) => c.trim()).filter((c) => c !== "");
    syncHash();
    scheduleRender();
  });
  timeInput.addEventListener("input", renderTime);
  sideToggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("is-open");
    sideToggle.setAttribute("aria-expanded", String(open));
  });

  const uniqBtn = h("button", { class: "btn btn-sm btn-primary", type: "button" }, "Count");
  uniqBtn.addEventListener("click", runUnique);
  uniqInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runUnique(); });
  const histBtn = h("button", { class: "btn btn-sm btn-primary", type: "button" }, "Plot");
  histBtn.addEventListener("click", runHistogram);
  histInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runHistogram(); });
  const presetChips = (values: ReadonlyArray<{ label: string; pattern: string }>, input: HTMLInputElement): HTMLElement =>
    h("div", { class: "ex-chips" }, ...values.map((v) => {
      const c = h("button", { class: "ex-chip mono", type: "button" }, v.label);
      c.addEventListener("click", () => { input.value = v.pattern; });
      return c;
    }));

  sidebar.append(
    h("h3", { class: "ex-side-h" }, "Evidence files"),
    fileList,
    h("section", { class: "ex-time" }, h("h3", { class: "ex-side-h" }, "Time converter"), timeInput, timeOut),
  );

  const main = h("section", { class: "ex-main" },
    h("div", { class: "ex-head" }, title, countEl),
    progress,
    pipeline,
    h("div", { class: "ex-presets" }, h("span", { class: "ex-muted" }, "Examples:"), presets),
    jsonBar,
    notice,
    h("div", { class: "ex-actions" }, firstBtn, lastBtn, copyBtn, shareBtn),
    h("div", { class: "ex-view" }, csvHead, viewport),
    h("div", { class: "ex-aggs" },
      h("details", { class: "ex-agg", open: true },
        h("summary", {}, "Count unique values"),
        h("p", { class: "ex-muted" }, "Regex with one capture group, run over the filtered lines (like grep -o | sort | uniq -c)."),
        h("div", { class: "ex-row-form" }, uniqInput, uniqBtn),
        presetChips(UNIQUE_PRESETS.map((p) => ({ label: p, pattern: p })), uniqInput),
        uniqOut),
      h("details", { class: "ex-agg" },
        h("summary", {}, "Histogram by minute"),
        h("p", { class: "ex-muted" }, "Capture a timestamp prefix (down to the minute) to bucket the filtered lines."),
        h("div", { class: "ex-row-form" }, histInput, histBtn),
        presetChips(HISTOGRAM_PRESETS, histInput),
        histOut)),
  );

  root.replaceChildren(
    h("div", { class: "explorer" },
      h("div", { class: "ex-topbar" }, h("a", { class: "btn btn-sm btn-ghost", href: "#/case/3am-outage" }, "← Back to case"), h("strong", {}, "Evidence explorer"), status, sideToggle),
      h("div", { class: "ex-layout" }, sidebar, main)),
  );
  status.textContent = "grep, uniq and friends — in your browser";
  renderPipeline();
  renderFileList();

  const startFile = EVIDENCE_FILES.find((f) => f.path === initial.file);
  if (startFile) selectFile(startFile);

  /* ---------------------------------------------------------------- teardown */
  function teardown(): void {
    window.removeEventListener("hashchange", onHashChange);
    if (debounce !== null) window.clearTimeout(debounce);
    if (raf) window.cancelAnimationFrame(raf);
    ro.disconnect();
    client.dispose();
    if (activeTeardown === teardown) activeTeardown = null;
  }
  function onHashChange(): void {
    if (!ownsHash(window.location.hash)) teardown();
  }
  window.addEventListener("hashchange", onHashChange);
  activeTeardown = teardown;
}
