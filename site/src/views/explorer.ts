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
import type { Case } from "../content/schema";
import { FILTER_PRESETS, HISTOGRAM_PRESETS, UNIQUE_PRESETS, evidenceFilesFor, evidenceUrl } from "../explorer/files";
import type { EvidenceFile } from "../explorer/files";
import type { WorkerResponse } from "../explorer/protocol";
import { T } from "../i18n/strings-tools";

const ROW_H = 20;
const DEBOUNCE_MS = 250;
const HARD_TIMEOUT_MS = 2500;
const ZONE = "Asia/Jerusalem";

let activeTeardown: (() => void) | null = null;

export function renderExplorer(root: HTMLElement, c: Case): void {
  activeTeardown?.();
  activeTeardown = null;
  const ROUTE = `#/case/${c.id}/explorer`;
  const EVIDENCE_FILES = evidenceFilesFor(c);
  const ownsHash = (hash: string): boolean => hash === ROUTE || hash.startsWith(`${ROUTE}?`) || hash.startsWith(`${ROUTE}/`);
  document.title = T().exDocTitle;

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
  const sideToggle = h("button", { class: "btn btn-sm ex-side-toggle", type: "button", "aria-expanded": "false" }, T().exFilesTime);
  const progressBar = h("div", { class: "ex-progress-bar" });
  const progressText = h("span", { class: "ex-progress-text" });
  const cancelBtn = h("button", { class: "btn btn-sm btn-ghost", type: "button" }, T().exCancel);
  const progress = h("div", { class: "ex-progress", hidden: true }, h("div", { class: "ex-progress-track" }, progressBar), progressText, cancelBtn);
  const title = h("h2", { class: "ex-title mono" }, T().exPickFile);
  const countEl = h("span", { class: "ex-count mono" });
  const pipeline = h("div", { class: "ex-pipeline" });
  const presets = h("div", { class: "ex-chips" });
  const jsonInput = h("input", { class: "ex-input mono", placeholder: T().exJsonPh, spellcheck: "false" });
  const colsInput = h("input", { class: "ex-input mono", placeholder: T().exColsPh, spellcheck: "false" });
  const jsonBar = h("div", { class: "ex-jsonbar", hidden: true },
    h("label", {}, h("span", {}, T().exJsonFilter), jsonInput),
    h("label", {}, h("span", {}, T().exColView), colsInput));
  const viewport = h("div", { class: "ex-viewport", dir: "ltr", tabindex: "0", "aria-label": T().exFileLines });
  const spacer = h("div", { class: "ex-spacer" });
  const rowsLayer = h("div", { class: "ex-rows" });
  const csvHead = h("div", { class: "ex-csvhead mono", dir: "ltr", hidden: true });
  viewport.append(spacer, rowsLayer);
  const firstBtn = h("button", { class: "btn btn-sm", type: "button" }, T().exFirst);
  const lastBtn = h("button", { class: "btn btn-sm", type: "button" }, T().exLast);
  const copyBtn = h("button", { class: "btn btn-sm", type: "button" }, T().exCopyLines);
  const shareBtn = h("button", { class: "btn btn-sm btn-ghost", type: "button" }, T().exCopyLink);

  const uniqInput = h("input", { class: "ex-input mono", value: "cid=(\\S+)", spellcheck: "false", "aria-label": T().exCaptureRegex });
  const uniqOut = h("div", { class: "ex-agg-out" });
  const histInput = h("input", { class: "ex-input mono", value: "", spellcheck: "false", "aria-label": T().exTsRegex, placeholder: T().exHistPh });
  const histOut = h("div", { class: "ex-agg-out" });

  const timeInput = h("input", { class: "ex-input mono", placeholder: "epoch / ISO / 13/Nov/2026:00:00:00 +0000", spellcheck: "false", "aria-label": T().exTimeToConvert });
  const timeOut = h("dl", { class: "ex-time-out mono", dir: "ltr" });

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
        progressText.textContent = T().exLoadingOf(fmtBytes(msg.loaded), msg.total > 0 ? fmtBytes(msg.total) : "");
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
          showNotice(ok ? T().exCopied(fmtCount(msg.count), msg.capped) : T().exClipBlocked, ok ? "info" : "warn");
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
          showNotice(msg.cancelled ? T().exLoadCancelled : T().exLoadFailed(msg.message));
          return;
        }
        if (msg.job === filterJob) {
          count = 0;
          updateCount();
        }
        showNotice(msg.message === "regex took too long" ? T().exRegexSlow : msg.message);
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
          h("span", { class: "ex-file-meta" }, bytes !== undefined ? fmtBytes(bytes) : f.size, inWorker.has(f.path) ? T().exLoadedTag : ""),
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
    progressText.textContent = T().exLoading;
    countEl.textContent = "";
    client.send({ type: "load", job: loadJob, path: f.path, url: evidenceUrl(c.id, f.path) });
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
          showNotice(T().exInvalidRegex(err));
          return;
        }
      }
    }
    filterJob = client.job();
    countEl.textContent = T().exFiltering;
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
    countEl.textContent = T().exCountOf(fmtCount(count), fmtCount(total));
  }

  function renderPipeline(): void {
    pipeline.replaceChildren(
      ...steps.map((step, idx) => {
        const kind = h("select", { class: "ex-select", "aria-label": T().exFilterType },
          h("option", { value: "contains" }, T().exContains),
          h("option", { value: "not" }, T().exNotContains),
          h("option", { value: "regex" }, "regex"));
        kind.value = step.kind;
        kind.addEventListener("change", () => {
          step.kind = kind.value === "not" ? "not" : kind.value === "regex" ? "regex" : "contains";
          scheduleFilter();
        });
        const input = h("input", { class: "ex-input mono", placeholder: idx === 0 ? T().exTypeToFilter : T().exAndThen, spellcheck: "false", "aria-label": T().exFilterText });
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
        const remove = h("button", { class: "btn btn-sm btn-ghost", type: "button", "aria-label": T().exRemoveFilter }, "×");
        remove.addEventListener("click", () => {
          steps.splice(idx, 1);
          if (steps.length === 0) steps.push({ kind: "contains", text: "", ci: true });
          renderPipeline();
          scheduleFilter();
        });
        return h("div", { class: "ex-step" }, idx > 0 ? h("span", { class: "ex-pipe mono" }, "|") : null, kind, input,
          h("label", { class: "ex-ci" }, ci, T().exIgnoreCase), remove);
      }),
      (() => {
        const add = h("button", { class: "btn btn-sm", type: "button" }, T().exAddFilter);
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
    if (count === 0 && total > 0) rowsLayer.replaceChildren(h("div", { class: "ex-empty" }, T().exNoMatch));
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
      uniqOut.replaceChildren(h("p", { class: "ex-err" }, err ? T().exInvalidRegex(err) : T().exEnterCapture));
      return;
    }
    aggJob = client.job();
    uniqOut.replaceChildren(h("p", { class: "ex-muted" }, T().exCounting));
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
          const add = h("button", { class: "ex-linkish mono", type: "button", title: T().exAddAsContains }, value === "" ? T().exEmpty : value);
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
      h("p", { class: "ex-big" }, h("strong", { class: "mono" }, fmtCount(distinct)), T().exDistinctIn(fmtCount(matched))),
      h("div", { class: "ex-table-wrap" }, h("table", { class: "ex-table" }, h("thead", {}, h("tr", {}, th(T().exValue, "value"), th(T().exCountCol, "count"))), tbody)),
      ...(more > 0 ? [h("p", { class: "ex-muted" }, T().exMore(fmtCount(more)))] : []),
    );
  }

  function runHistogram(): void {
    if (!file || !inWorker.has(file.path)) return;
    const pattern = histInput.value;
    const err = regexError(pattern);
    if (err || pattern === "") {
      histOut.replaceChildren(h("p", { class: "ex-err" }, err ? T().exInvalidRegex(err) : T().exEnterTs));
      return;
    }
    aggJob = client.job();
    histOut.replaceChildren(h("p", { class: "ex-muted" }, T().exBucketing));
    client.send({ type: "histogram", job: aggJob, path: file.path, pattern }, HARD_TIMEOUT_MS);
  }

  function renderHistogram(result: HistogramResult): void {
    const max = result.buckets.reduce((m, b) => Math.max(m, b.count), 0);
    if (result.buckets.length === 0) {
      histOut.replaceChildren(h("p", { class: "ex-muted" }, T().exNoLineMatched));
      return;
    }
    histOut.replaceChildren(
      h("p", { class: "ex-muted" }, T().exBuckets(fmtCount(result.buckets.length), result.truncated, fmtCount(max))),
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
      timeOut.replaceChildren(h("dd", { class: "ex-err" }, T().exBadFormat));
      return;
    }
    timeOut.replaceChildren(
      h("dt", {}, "UTC"), h("dd", {}, formatInZone(ms, "UTC")),
      h("dt", {}, T().exJerusalem), h("dd", {}, formatInZone(ms, ZONE)),
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
    void copyText(window.location.href).then((ok) => showNotice(ok ? T().exLinkCopied : T().exCopyAddress, "info"));
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

  const uniqBtn = h("button", { class: "btn btn-sm btn-primary", type: "button" }, T().exCountBtn);
  uniqBtn.addEventListener("click", runUnique);
  uniqInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runUnique(); });
  const histBtn = h("button", { class: "btn btn-sm btn-primary", type: "button" }, T().exPlot);
  histBtn.addEventListener("click", runHistogram);
  histInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runHistogram(); });
  const presetChips = (values: ReadonlyArray<{ label: string; pattern: string }>, input: HTMLInputElement): HTMLElement =>
    h("div", { class: "ex-chips" }, ...values.map((v) => {
      const c = h("button", { class: "ex-chip mono", type: "button" }, v.label);
      c.addEventListener("click", () => { input.value = v.pattern; });
      return c;
    }));

  sidebar.append(
    h("h3", { class: "ex-side-h" }, T().exEvidenceFiles),
    fileList,
    h("section", { class: "ex-time" }, h("h3", { class: "ex-side-h" }, T().exTimeConverter), timeInput, timeOut),
  );

  const main = h("section", { class: "ex-main" },
    h("div", { class: "ex-head" }, title, countEl),
    progress,
    pipeline,
    h("div", { class: "ex-presets" }, h("span", { class: "ex-muted" }, T().exExamples), presets),
    jsonBar,
    notice,
    h("div", { class: "ex-actions" }, firstBtn, lastBtn, copyBtn, shareBtn),
    h("div", { class: "ex-view" }, csvHead, viewport),
    h("div", { class: "ex-aggs" },
      h("details", { class: "ex-agg", open: true },
        h("summary", {}, T().exUniqueTitle),
        h("p", { class: "ex-muted" }, T().exUniqueHelp),
        h("div", { class: "ex-row-form" }, uniqInput, uniqBtn),
        presetChips(UNIQUE_PRESETS.map((p) => ({ label: p, pattern: p })), uniqInput),
        uniqOut),
      h("details", { class: "ex-agg" },
        h("summary", {}, T().exHistTitle),
        h("p", { class: "ex-muted" }, T().exHistHelp),
        h("div", { class: "ex-row-form" }, histInput, histBtn),
        presetChips(HISTOGRAM_PRESETS, histInput),
        histOut)),
  );

  root.replaceChildren(
    h("div", { class: "explorer" },
      h("div", { class: "ex-topbar" }, h("a", { class: "btn btn-sm btn-ghost", href: `#/case/${c.id}` }, T().exBack), h("strong", {}, T().exTitle), h("span", { class: "ex-muted" }, c.title), status, sideToggle),
      h("div", { class: "ex-layout" }, sidebar, main)),
  );
  status.textContent = T().exTagline;
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
