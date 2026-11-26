import "../explorer.css";
import { h } from "../lib/dom";
import { openSheet } from "../lib/overlay";
import { getLang } from "../i18n/i18n";
import { WorkerClient } from "../explorer/client";
import type { RestartReason } from "../explorer/client";
import {
  decodeState,
  encodeState,
  epochLabel,
  epochTokens,
  flattenJson,
  fmtBucket,
  fmtBytes,
  fmtCount,
  formatInZone,
  getJsonField,
  groupByDir,
  isEpochSeconds,
  isYearless,
  isZoneless,
  kvPairs,
  matchesQuery,
  matchRanges,
  parseCsvLine,
  parseJsonLine,
  parseTimeInput,
  pluralCategory,
  regexError,
  stringifyField,
  timeSeries,
  wallClockToUtc,
  yearInText,
} from "../explorer/core";
import type { FilterStep, HistogramResult, JsonFilter, JsonOp, SortKey, StepKind, TimeRange, TimeSeries } from "../explorer/core";
import type { Case } from "../../shared/case";
import {
  ALL_ZONES,
  caseYearHint,
  caseZones,
  evidenceFilesFor,
  evidenceUrl,
  filterPresetsFor,
  histogramPresetsFor,
  uniquePresetsFor,
  zoneLabel,
} from "../explorer/files";
import type { EvidenceFile, PatternPreset } from "../explorer/files";
import type { SortSpec, WorkerErrorCode, WorkerResponse } from "../explorer/protocol";
import { T } from "../i18n/strings-tools";

/** A file path with line-break opportunities after "/", "_", "-" and ".", so names wrap at word joins, not mid-word. */
function breakablePath(path: string): Node[] {
  const parts = path.split(/(?<=[/_.-])/);
  return parts.flatMap((part, i) => (i < parts.length - 1 ? [document.createTextNode(part), document.createElement("wbr")] : [document.createTextNode(part)]));
}

const ROW_H = 20;
const DEBOUNCE_MS = 250;
const ANNOUNCE_MS = 900;
const HARD_TIMEOUT_MS = 2500;
const WRAP_KEY = "il.explorer.wrap";
const NARROW = "(max-width: 600px)";
const SVG_NS = "http://www.w3.org/2000/svg";
/** Scopes the worker's download cache to this page load (see explorer/cache.ts). */
const SESSION = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/* ---------------------------------------------------------------- text helpers */

type Values = Record<string, Node | string>;

/** Fills `{key}` tokens of a translated template with nodes (numbers wrapped in <bdi>) so bidi order stays right. */
function fill(template: string, values: Values): Node[] {
  const out: Node[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) out.push(document.createTextNode(template.slice(last, m.index)));
    const v = values[m[1] ?? ""];
    out.push(v === undefined ? document.createTextNode(m[0]) : typeof v === "string" ? document.createTextNode(v) : v);
    last = re.lastIndex;
  }
  if (last < template.length) out.push(document.createTextNode(template.slice(last)));
  return out;
}

/** Same as fill, as plain text (screen-reader announcements, aria-labels). */
function fillText(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
}

/** An LTR-isolated number, size, time or path inside translated text. */
const num = (s: string): HTMLElement => h("bdi", { dir: "ltr", class: "ex-num" }, s);
const plural = (n: number): string => pluralCategory(n, getLang());

function readWrapPref(): boolean | null {
  try {
    const v = localStorage.getItem(WRAP_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}
function saveWrapPref(on: boolean): void {
  try {
    localStorage.setItem(WRAP_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: the toggle still works for this visit */
  }
}

let activeTeardown: (() => void) | null = null;

/* ---------------------------------------------------------------- state types */

interface StepUi {
  /** regex syntax error, or null */
  error: string | null;
  /** the step blew the time budget and is NOT applied until the player edits it */
  slow: boolean;
}

type CountState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "notLoaded" }
  | { kind: "filtering" }
  | { kind: "invalid"; step: number }
  | { kind: "failed" }
  | { kind: "done" };

type AggState = "idle" | "running" | "done" | "stale" | "error";

interface Agg {
  kind: "unique" | "histogram";
  input: HTMLInputElement;
  err: HTMLElement;
  strip: HTMLElement;
  out: HTMLElement;
  chips: HTMLElement;
  job: number;
  /** filter generation the last run was computed against */
  gen: number;
  /** pattern kept fresh across filter changes, or null */
  wanted: string | null;
  state: AggState;
  /** announce the result: only when the player ran it, never for an automatic re-run */
  announce: boolean;
}

type Progress =
  | { kind: "hidden" }
  | { kind: "loading"; loaded: number; total: number }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export function renderExplorer(root: HTMLElement, c: Case): void {
  activeTeardown?.();
  activeTeardown = null;
  const ROUTE = `#/case/${c.id}/explorer`;
  const EVIDENCE_FILES = evidenceFilesFor(c);
  const CASE_ZONES = caseZones(c);
  const ZONES = ["UTC", ...CASE_ZONES, ...ALL_ZONES.filter((z) => z !== "UTC" && !CASE_ZONES.includes(z))];
  const ownsHash = (hash: string): boolean => hash === ROUTE || hash.startsWith(`${ROUTE}?`) || hash.startsWith(`${ROUTE}/`);
  document.title = T().exDocTitle;

  const initial = decodeState(window.location.hash.split("?")[1] ?? "");

  /* ---------------------------------------------------------------- state */
  let file: EvidenceFile | null = null;
  const inWorker = new Set<string>();
  const knownBytes = new Map<string, number>();
  let loading: string | null = null;
  let loadJob = 0;
  let filterJob = 0;
  let filterGen = 0;
  let windowJob = 0;
  let headerJob = 0;
  let copyJob = 0;
  let copyKind: "view" | "line" = "view";
  let locateJob = 0;
  let total = 0;
  let count = 0;
  let isJson = false;
  let csvHeader: string[] = [];
  let steps: FilterStep[] = initial.steps.length > 0 ? initial.steps : [{ kind: "contains", text: "", ci: true }];
  /** JSON conditions as edited (a half-typed one has an empty field and is not applied) */
  let conds: JsonFilter[] = initial.json.map((j) => ({ ...j }));
  let cols: string[] = initial.cols;
  let sort: { col: number; desc: boolean } | null = initial.sort ?? null;
  let timeRange: TimeRange | null = initial.time ?? null;
  const fieldsByPath = new Map<string, string[]>();
  const widthsByPath = new Map<string, number[]>();
  let detailOpen = false;
  let detailJob = 0;
  let detailTimer: number | null = null;
  let detailSay = false;
  let histRefocus = false;
  let sentSteps: FilterStep[] = [];
  let lastEdited: FilterStep | null = null;
  let countState: CountState = { kind: "none" };
  let winStart = 0;
  let winRows: Array<[number, string]> = [];
  let cursor = -1;
  let cursorLine = -1;
  let pendingLine: number | null = initial.line !== undefined && initial.line !== null ? initial.line - 1 : null;
  let locateIsDeepLink = false;
  let focusCursor = false;
  let headH = 0;
  let wrap = readWrapPref() ?? window.matchMedia(NARROW).matches;
  let avgH = ROW_H * 1.6;
  let yearFromEvidence: number | null = caseYearHint(c);
  let yearEdited = false;
  let debounce: number | null = null;
  let announceTimer: number | null = null;
  let raf = 0;
  const stepUi = new WeakMap<FilterStep, StepUi>();
  const stepEls = new Map<FilterStep, { row: HTMLElement; input: HTMLInputElement; err: HTMLElement }>();

  const ui = (s: FilterStep): StepUi => {
    let u = stepUi.get(s);
    if (!u) {
      u = { error: null, slow: false };
      stepUi.set(s, u);
    }
    return u;
  };

  /* ---------------------------------------------------------------- dom */
  const tagline = h("p", { class: "ex-status" }, T().exTagline);
  const announcer = h("p", { class: "ex-sr", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const notice = h("div", { class: "ex-notice", hidden: true });
  const fileList = h("ul", { class: "ex-files", id: "ex-files" });
  const fileSearch = h("input", { class: "ex-input ex-file-search", id: "ex-file-search", type: "search", placeholder: T().exFileSearchPh, spellcheck: "false", autocomplete: "off", "aria-controls": "ex-files" });
  const noFiles = h("p", { class: "ex-muted ex-no-files", role: "status", hidden: true }, T().exNoFiles);
  const fileCount = h("p", { class: "ex-muted ex-file-count", role: "status", hidden: true });
  const sidebar = h("aside", { class: "ex-sidebar", id: "ex-sidebar", "aria-label": T().exFilesTime });
  const sideToggle = h("button", { class: "btn btn-sm ex-side-toggle", type: "button", "aria-expanded": "false", "aria-controls": "ex-sidebar" }, T().exFilesTime);

  const progressBar = h("div", { class: "ex-progress-bar" });
  const progressText = h("p", { class: "ex-progress-text" });
  const cancelBtn = h("button", { class: "btn btn-sm", type: "button" }, T().exCancel);
  const retryBtn = h("button", { class: "btn btn-sm btn-primary", type: "button" }, T().exRetry);
  const progress = h("div", { class: "ex-progress", hidden: true },
    h("div", { class: "ex-progress-track", role: "progressbar", "aria-label": T().exLoading }, progressBar),
    h("div", { class: "ex-progress-body" }, progressText, h("div", { class: "ex-progress-actions" }, cancelBtn, retryBtn)));
  const progressTrack = progress.firstElementChild as HTMLElement;

  const title = h("h2", { class: "ex-title" }, T().exPickFile);
  const fileFormat = h("span", { class: "ex-format" });
  const countEl = h("p", { class: "ex-count" });
  const pipeline = h("div", { class: "ex-pipeline" });
  const presets = h("div", { class: "ex-chips" });
  const presetsRow = h("div", { class: "ex-presets" }, h("span", { class: "ex-muted" }, T().exExamples), presets);
  const fieldList = h("datalist", { id: "ex-json-fields" });
  const condList = h("div", { class: "ex-conds" });
  const addCondBtn = h("button", { class: "btn btn-sm", type: "button" }, T().exAddCond);
  const colsInput = h("input", { class: "ex-input mono", id: "ex-cols", placeholder: T().exColsPh, spellcheck: "false", autocomplete: "off" });
  const jsonBar = h("div", { class: "ex-jsonbar", hidden: true },
    h("div", { class: "ex-json-conds", role: "group", "aria-labelledby": "ex-json-h", "aria-describedby": "ex-json-help" },
      h("span", { class: "ex-json-h", id: "ex-json-h" }, T().exJsonConds),
      h("p", { class: "ex-muted ex-json-help", id: "ex-json-help" }, T().exJsonCondsHelp),
      condList, addCondBtn, fieldList),
    h("label", { for: "ex-cols", class: "ex-json-cols" }, h("span", {}, T().exColView), colsInput));
  const timeRow = h("div", { class: "ex-time-filter", hidden: true });
  const filtersBadge = h("span", { class: "ex-badge" });
  const controlsSet = h("fieldset", { class: "ex-fieldset" }, h("legend", { class: "ex-sr" }, T().exFilters), pipeline, timeRow, presetsRow, jsonBar);
  const controlsSum = h("summary", { class: "ex-controls-sum" }, T().exFilters, filtersBadge);
  const controls = h("details", { class: "ex-controls" }, controlsSum, controlsSet);
  // Phones: the filters open in a bottom sheet over the log instead of pushing it down the page. The same
  // fieldset moves into the sheet and back, so every input keeps its state and listeners; the log updates live
  // behind the sheet. Wider screens keep the inline panel.
  const PHONE_FILTERS = window.matchMedia("(max-width: 600px)");
  controlsSum.addEventListener("click", (ev) => {
    if (!PHONE_FILTERS.matches) return;
    ev.preventDefault();
    const sheet = openSheet<"done">({
      side: "bottom",
      title: T().exFilters,
      body: controlsSet,
      className: "ex-filter-sheet",
      actions: [{ value: "done", label: T().exFiltersDone, tone: "primary" }],
      returnFocus: () => controlsSum,
    });
    void sheet.result.then(() => controls.append(controlsSet));
  });

  const keysHelp = h("p", { class: "ex-sr", id: "ex-keys-help" }, T().exLineKeysHelp);
  const viewport = h("div", { class: "ex-viewport", dir: "ltr", tabindex: "0", role: "region", "aria-label": T().exFileLines, "aria-describedby": "ex-keys-help" });
  const headEl = h("div", { class: "ex-colhead mono", role: "group", "aria-label": T().exColumns, hidden: true });
  const spacer = h("div", { class: "ex-spacer" });
  const rowsLayer = h("div", { class: "ex-rows", role: "list", "aria-label": T().exFileLines });
  viewport.append(headEl, spacer, rowsLayer);
  const staleStrip = h("p", { class: "ex-stale-strip", hidden: true }, T().exStaleRows);
  const view = h("div", { class: "ex-view" }, staleStrip, viewport, progress);

  // Row detail drawer: a non-modal panel beside the log (a bottom sheet on narrow screens). It follows the
  // line cursor, so arrow keys in the log and Previous/Next here both update it. Self-contained, so the shared
  // Sheet primitive (#61) can replace the narrow-screen presentation without touching the content.
  const detailHeading = h("h3", { class: "ex-detail-h", id: "ex-detail-h", tabindex: "-1" }, T().exDetails);
  const detailPos = h("p", { class: "ex-detail-pos" });
  const detailClose = h("button", { class: "btn btn-sm btn-ghost ex-detail-close", type: "button", "aria-label": T().exDetailClose, "aria-keyshortcuts": "Escape" }, "×");
  const detailPrev = h("button", { class: "btn btn-sm", type: "button", "aria-keyshortcuts": "Shift+N" }, T().exPrevLine);
  const detailNext = h("button", { class: "btn btn-sm", type: "button", "aria-keyshortcuts": "N" }, T().exNextLine);
  const detailCopy = h("button", { class: "btn btn-sm", type: "button", "aria-keyshortcuts": "C" }, T().exCopyLine);
  const detailLink = h("button", { class: "btn btn-sm btn-ghost", type: "button", "aria-keyshortcuts": "L" }, T().exLinkLine);
  const detailBody = h("div", { class: "ex-detail-body" });
  const drawer = h("section", { class: "ex-drawer", id: "ex-drawer", role: "region", "aria-labelledby": "ex-detail-h", "aria-describedby": "ex-detail-keys", hidden: true },
    h("div", { class: "ex-drawer-head" }, h("div", { class: "ex-drawer-title" }, detailHeading, detailPos), detailClose),
    h("p", { class: "ex-sr", id: "ex-detail-keys" }, T().exDetailKeys),
    h("div", { class: "ex-drawer-tools", role: "group", "aria-label": T().exMatchNav }, detailPrev, detailNext, detailCopy, detailLink),
    detailBody);
  const detailBtn = h("button", { class: "btn btn-sm", type: "button", "aria-expanded": "false", "aria-controls": "ex-drawer", "aria-keyshortcuts": "Enter" }, T().exDetails);
  const work = h("div", { class: "ex-work" }, view, drawer);

  const firstBtn = h("button", { class: "btn btn-sm", type: "button" }, T().exFirst);
  const lastBtn = h("button", { class: "btn btn-sm", type: "button" }, T().exLast);
  const copyBtn = h("button", { class: "btn btn-sm", type: "button" }, T().exCopyLines);
  const shareBtn = h("button", { class: "btn btn-sm btn-ghost", type: "button" }, T().exCopyLink);
  const copyLineBtn = h("button", { class: "btn btn-sm", type: "button" }, T().exCopyLine);
  const linkLineBtn = h("button", { class: "btn btn-sm btn-ghost", type: "button" }, T().exLinkLine);
  const wrapCb = h("input", { type: "checkbox", id: "ex-wrap" });
  wrapCb.checked = wrap;
  const prevMatchBtn = h("button", { class: "btn btn-sm", type: "button", "aria-keyshortcuts": "Shift+N" }, T().exPrevMatch);
  const nextMatchBtn = h("button", { class: "btn btn-sm", type: "button", "aria-keyshortcuts": "N" }, T().exNextMatch);
  const matchPos = h("span", { class: "ex-match-pos", "aria-live": "polite", "aria-atomic": "true" });
  const matchNav = h("div", { class: "ex-match-nav", role: "group", "aria-label": T().exMatchNav, hidden: true }, prevMatchBtn, matchPos, nextMatchBtn);
  const actionButtons = [firstBtn, lastBtn, prevMatchBtn, nextMatchBtn, copyBtn, shareBtn, copyLineBtn, linkLineBtn, detailBtn];

  const makeAgg = (kind: Agg["kind"], label: string, placeholder: string): Agg => {
    const id = `ex-${kind}`;
    return {
      kind,
      input: h("input", { class: "ex-input mono", id, spellcheck: "false", autocomplete: "off", "aria-label": label, placeholder, "aria-describedby": `${id}-err` }),
      err: h("p", { class: "ex-err", id: `${id}-err`, role: "alert", hidden: true }),
      strip: h("p", { class: "ex-agg-strip", hidden: true }),
      out: h("div", { class: "ex-agg-out" }),
      chips: h("div", { class: "ex-chips" }),
      job: 0,
      gen: -1,
      wanted: null,
      state: "idle",
      announce: false,
    };
  };
  const uniq = makeAgg("unique", T().exCaptureRegex, T().exUniqPh);
  const hist = makeAgg("histogram", T().exTsRegex, T().exHistPh);
  const aggs: Agg[] = [uniq, hist];
  const histDetails = h("details", { class: "ex-agg" });

  const timeInput = h("input", { class: "ex-input mono", id: "ex-time", placeholder: "epoch / ISO / 13/Nov/2026:00:00:00 +0000 / Nov 18 07:00:07", spellcheck: "false", autocomplete: "off" });
  const yearInput = h("input", { class: "ex-input mono ex-year", id: "ex-year", type: "number", min: "1970", max: "2100", inputmode: "numeric" });
  const zoneSel = h("select", { class: "ex-select", id: "ex-zone" }, ...ZONES.map((z) => h("option", { value: z }, zoneLabel(z))));
  const timeNote = h("p", { class: "ex-muted ex-time-note" });
  const timeOut = h("dl", { class: "ex-time-out", dir: "ltr" });

  /* ---------------------------------------------------------------- worker */
  const client = new WorkerClient(onMessage, onRestart);

  function say(text: string, delay = 0): void {
    if (announceTimer !== null) window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => {
      announceTimer = null;
      announcer.textContent = text;
    }, delay);
  }

  function showNotice(text: string, tone: "warn" | "info" = "warn"): void {
    notice.hidden = false;
    notice.className = `ex-notice ex-notice-${tone}`;
    notice.textContent = text;
    say(text);
  }
  function clearNotice(): void {
    notice.hidden = true;
  }

  function errorText(code: WorkerErrorCode, status: number | undefined, detail: string | undefined): string {
    switch (code) {
      case "timeout":
        return T().exPatternTooSlow;
      case "http":
        return T().exLoadFailed(`HTTP ${status ?? "?"}`);
      case "cancelled":
        return T().exLoadCancelled;
      case "notLoaded":
        return T().exNotLoaded;
      case "unexpected":
        return T().exUnexpected(detail ?? "");
    }
  }

  function onRestart(reason: RestartReason): void {
    inWorker.clear();
    loading = null;
    if (reason.kind === "timeout") {
      if (reason.job === filterJob) suspendCulprits();
      const culprit = aggs.find((a) => a.job === reason.job && a.state === "running");
      if (culprit) aggFailed(culprit, T().exPatternTooSlow);
      showNotice(T().exWorkerRestarted, "info");
    } else {
      showNotice(T().exWorkerCrashed);
    }
    // Aggregations that were merely queued behind the killed job re-run once the file is back.
    for (const a of aggs) {
      if (a.state === "running" || a.state === "done") {
        a.gen = -1;
        markAggStale(a, T().exAggUpdating);
      }
    }
    renderFileList();
    if (file) startLoad(file);
  }

  function onMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case "progress":
        if (msg.job !== loadJob) return;
        paintProgress({ kind: "loading", loaded: msg.loaded, total: msg.total });
        return;
      case "loaded":
        if (msg.job !== loadJob || !file || msg.path !== file.path) return;
        loading = null;
        paintProgress({ kind: "hidden" });
        inWorker.add(msg.path);
        knownBytes.set(msg.path, msg.bytes);
        fieldsByPath.set(msg.path, msg.fields);
        widthsByPath.set(msg.path, msg.widths);
        renderFieldList();
        if (msg.year !== null && !yearEdited) {
          yearFromEvidence = msg.year;
          renderTime();
        }
        renderFileList();
        isJson = msg.isJson;
        total = msg.lineCount;
        requestCsvHeader();
        runFilter();
        return;
      case "filtered":
        if (msg.job !== filterJob) return;
        total = msg.total;
        count = msg.count;
        countState = { kind: "done" };
        setStale(false);
        paintCount(true);
        winRows = [];
        winStart = 0;
        cursor = -1;
        updateSpacer();
        scheduleRender();
        updateLineButtons();
        if (pendingLine !== null) {
          locateLine(pendingLine, true);
          pendingLine = null;
        } else if (cursorLine >= 0) {
          locateLine(cursorLine, false);
        } else if (detailOpen) {
          renderDetailGone();
        }
        for (const a of aggs) {
          if (a.wanted !== null && (a.state === "done" || a.state === "stale") && a.gen < filterGen) runAgg(a, a.wanted, false);
        }
        return;
      case "window":
        if (msg.job === headerJob) {
          csvHeader = parseCsvLine(msg.rows[0]?.[1] ?? "");
          paintHeader();
          scheduleRender();
          return;
        }
        if (msg.job !== windowJob) return;
        winStart = msg.start;
        winRows = msg.rows;
        renderRows();
        return;
      case "located":
        if (msg.job !== locateJob) return;
        if (msg.row >= 0) {
          cursorLine = msg.line;
          setCursor(msg.row, false, true);
        } else {
          cursorLine = -1;
          syncHash();
          updateLineButtons();
          if (detailOpen) renderDetailGone();
          if (locateIsDeepLink) showNotice(T().exLineHidden(fmtCount(msg.line + 1)), "info");
        }
        return;
      case "detail":
        if (msg.job !== detailJob) return;
        renderDetail(msg.row, msg.line, msg.text, msg.truncated);
        return;
      case "unique":
        if (msg.job !== uniq.job) return;
        uniq.state = "done";
        markAggStale(uniq, null);
        renderUnique(msg.rows, msg.distinct, msg.matchedLines, msg.more);
        return;
      case "histogram":
        if (msg.job !== hist.job) return;
        hist.state = "done";
        markAggStale(hist, null);
        renderHistogram(msg.result);
        return;
      case "copy":
        if (msg.job !== copyJob) return;
        void copyText(msg.text).then((ok) => {
          if (!ok) showNotice(T().exClipBlocked);
          else if (copyKind === "line") {
            flashButton(detailOpen && drawer.contains(document.activeElement) ? detailCopy : copyLineBtn);
            showNotice(T().exCopiedLine(fmtCount(cursorLine + 1)), "info");
          } else {
            flashButton(copyBtn);
            showNotice(fillText(T().exCopied(plural(msg.count), msg.capped), { n: fmtCount(msg.count) }), "info");
          }
        });
        return;
      case "error": {
        if (msg.code === "notLoaded") {
          if (file && loading !== file.path) {
            inWorker.delete(file.path);
            startLoad(file);
          }
          return;
        }
        if (msg.job === loadJob) {
          loading = null;
          paintProgress(msg.code === "cancelled" ? { kind: "cancelled" } : { kind: "failed", message: errorText(msg.code, msg.status, msg.detail) });
          countState = { kind: "notLoaded" };
          paintCount(false);
          return;
        }
        if (msg.job === filterJob) {
          if (msg.code === "timeout" && suspendCulprits()) {
            runFilter();
            return;
          }
          countState = { kind: "failed" };
          setStale(true);
          paintCount(false);
          showNotice(errorText(msg.code, msg.status, msg.detail));
          return;
        }
        const agg = aggs.find((a) => a.job === msg.job);
        if (agg) {
          aggFailed(agg, errorText(msg.code, msg.status, msg.detail));
          return;
        }
        showNotice(errorText(msg.code, msg.status, msg.detail));
        return;
      }
    }
  }

  /* ---------------------------------------------------------------- loading */
  function paintProgress(p: Progress): void {
    progress.hidden = p.kind === "hidden";
    cancelBtn.hidden = p.kind !== "loading";
    retryBtn.hidden = p.kind === "loading" || p.kind === "hidden";
    progressTrack.hidden = p.kind !== "loading";
    progress.classList.toggle("is-error", p.kind === "failed");
    if (p.kind === "loading") {
      // Only a known, consistent total gives a real bar; otherwise say so with an indeterminate one.
      const known = p.total > 0 && p.loaded <= p.total;
      progressTrack.classList.toggle("is-indeterminate", !known);
      progressBar.style.width = known ? `${((p.loaded / p.total) * 100).toFixed(1)}%` : "";
      if (known) {
        progressTrack.setAttribute("aria-valuemin", "0");
        progressTrack.setAttribute("aria-valuemax", "100");
        progressTrack.setAttribute("aria-valuenow", String(Math.round((p.loaded / p.total) * 100)));
      } else {
        progressTrack.removeAttribute("aria-valuenow");
      }
      const loaded = p.loaded > 0 ? fmtBytes(p.loaded) : "";
      progressText.replaceChildren(...(loaded === ""
        ? [document.createTextNode(T().exLoading)]
        : fill(T().exLoadingOf(known), { loaded: num(loaded), total: num(known ? fmtBytes(p.total) : "") })));
    } else if (p.kind === "cancelled") {
      progressText.textContent = T().exLoadCancelled;
    } else if (p.kind === "failed") {
      progressText.textContent = p.message;
    }
  }

  function startLoad(f: EvidenceFile): void {
    loadJob = client.job();
    loading = f.path;
    paintProgress({ kind: "loading", loaded: 0, total: 0 });
    countState = { kind: "loading" };
    paintCount(false);
    client.send({ type: "load", job: loadJob, path: f.path, url: evidenceUrl(c.id, f.path), mode: f.mode, session: SESSION });
  }

  function requestCsvHeader(): void {
    if (!file || file.mode !== "csv") return;
    headerJob = client.job();
    client.send({ type: "window", job: headerJob, path: file.path, start: 0, count: 1 });
  }

  /* ---------------------------------------------------------------- files */
  function renderFileList(): void {
    const q = fileSearch.value.trim();
    const shown = EVIDENCE_FILES.filter((f) => matchesQuery(q, [f.path, f.format, f.description]));
    noFiles.hidden = shown.length > 0;
    fileList.hidden = shown.length === 0;
    fileCount.hidden = q === "" || shown.length === 0;
    fileCount.textContent = fillText(T().exFilesShown, { n: fmtCount(shown.length), t: fmtCount(EVIDENCE_FILES.length) });
    const groups = groupByDir(shown, (f) => f.path);
    // One flat list when there is nothing to group (a single folder, or only top-level files).
    const flat = groups.length < 2;
    fileList.replaceChildren(...groups.flatMap((g, gi) => {
      const items = g.items.map(fileItem);
      if (flat) return items;
      const id = `ex-files-g${gi}`;
      return [h("li", { class: "ex-file-group" },
        h("h4", { class: "ex-file-group-h", id }, g.dir === "" ? T().exTopLevel : h("span", { class: "mono", dir: "ltr" }, `${g.dir}/`),
          h("span", { class: "ex-file-group-n" }, num(fmtCount(g.items.length)))),
        h("ul", { class: "ex-files-sub", "aria-labelledby": id }, ...items))];
    }));
  }

  function fileItem(f: EvidenceFile): HTMLElement {
    const bytes = knownBytes.get(f.path);
    const size = bytes !== undefined ? fmtBytes(bytes) : f.size;
    const active = file?.path === f.path;
    const btn = h(
      "button",
      { class: `ex-file${active ? " is-active" : ""}`, type: "button", "aria-current": active ? "true" : null },
      h("span", { class: "ex-file-name mono", dir: "ltr" }, breakablePath(f.path)),
      h("span", { class: "ex-file-meta" },
        f.format !== "" ? h("span", {}, f.format) : null,
        size !== "" ? [f.format !== "" ? " · " : "", num(size)] : null,
        inWorker.has(f.path) ? [h("span", { class: "ex-dot", "aria-hidden": "true" }), h("span", {}, T().exLoadedTag)] : null),
      h("span", { class: "ex-file-desc" }, f.description),
    );
    btn.addEventListener("click", () => {
      selectFile(f);
      sidebar.classList.remove("is-open");
      sideToggle.setAttribute("aria-expanded", "false");
    });
    return h("li", {}, btn);
  }

  function setEnabled(on: boolean): void {
    controlsSet.disabled = !on;
    aggSet.disabled = !on;
    for (const b of actionButtons) b.disabled = !on;
    wrapCb.disabled = !on;
    if (on) updateLineButtons();
  }

  function renderEmpty(): void {
    const readme = EVIDENCE_FILES.find((f) => f.path === "README_FIRST.txt");
    const open = readme ? h("button", { class: "btn btn-primary", type: "button" }, T().exOpenReadme) : null;
    open?.addEventListener("click", () => {
      if (readme) selectFile(readme);
    });
    rowsLayer.replaceChildren(h("div", { class: "ex-empty-card", role: "listitem" },
      h("p", { class: "ex-empty-title" }, T().exEmptyTitle),
      h("p", {}, T().exEmptyBody),
      readme ? h("p", {}, T().exEmptyReadme) : null,
      open));
  }

  function selectFile(f: EvidenceFile): void {
    if (file?.path === f.path) {
      // Re-picking the active file retries a cancelled or failed load (it used to do nothing).
      if (!inWorker.has(f.path) && loading !== f.path) startLoad(f);
      return;
    }
    if (file && loading === file.path) client.send({ type: "cancelLoad", path: file.path });
    loading = null;
    if (file !== null) {
      // A sort column and a time pattern belong to one file's layout; a deep link's first file keeps them.
      sort = null;
      timeRange = null;
      paintTimeRow();
      closeDetail(false);
    }
    file = f;
    title.textContent = f.path;
    title.setAttribute("dir", "ltr");
    fileFormat.textContent = f.format;
    csvHeader = [];
    jsonBar.hidden = f.mode !== "json";
    count = 0;
    total = 0;
    winRows = [];
    cursor = -1;
    if (pendingLine === null) cursorLine = -1;
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
    rowsLayer.replaceChildren();
    paintHeader();
    updateSpacer();
    clearNotice();
    setStale(false);
    setEnabled(true);
    renderPresets(f);
    renderFileList();
    syncHash();
    renderFieldList();
    renderConds();
    if (inWorker.has(f.path)) {
      paintProgress({ kind: "hidden" });
      loadJob = client.job();
      isJson = f.mode === "json";
      requestCsvHeader();
      runFilter();
    } else startLoad(f);
  }

  function renderPresets(f: EvidenceFile): void {
    const fp = filterPresetsFor(f.profile);
    presetsRow.hidden = fp.length === 0;
    presets.replaceChildren(...fp.map((p) => {
      const chip = h("button", { class: "ex-chip", type: "button", title: `${p.kind}: ${p.text}` }, p.label);
      chip.addEventListener("click", () => addStep(p.kind, p.text));
      return chip;
    }));
    resetAgg(uniq, uniquePresetsFor(f.profile));
    const hp = histogramPresetsFor(f.profile);
    resetAgg(hist, hp);
    histDetails.open = hp.length > 0 && f.profile !== "text";
  }

  /* ---------------------------------------------------------------- filters */
  function effectiveSteps(): FilterStep[] {
    return steps.filter((s) => !ui(s).slow);
  }

  function stepNo(s: FilterStep): number {
    return steps.indexOf(s) + 1;
  }

  /** Marks the regex step(s) that blew the time budget as not applied. Returns false when none could be blamed. */
  function suspendCulprits(): boolean {
    const regexes = sentSteps.filter((s) => s.kind === "regex" && s.text !== "" && steps.includes(s));
    if (regexes.length === 0) return false;
    // The pipeline ran fine before the last edit, so the edited step is the one to blame when it is a regex.
    const culprits = lastEdited !== null && regexes.includes(lastEdited) ? [lastEdited] : regexes;
    for (const s of culprits) ui(s).slow = true;
    paintSteps();
    return true;
  }

  function runFilter(): void {
    if (!file || !inWorker.has(file.path)) return;
    let firstBad: FilterStep | null = null;
    for (const s of steps) {
      const u = ui(s);
      u.error = s.kind === "regex" && s.text !== "" ? regexError(s.text) : null;
      if (u.error !== null && firstBad === null) firstBad = s;
    }
    paintSteps();
    if (firstBad !== null) {
      filterJob = client.job(); // any reply still in flight no longer matches the pipeline
      countState = { kind: "invalid", step: stepNo(firstBad) };
      setStale(true);
      paintCount(true);
      for (const a of aggs) if (a.state === "done") markAggStale(a, T().exAggPipelineInvalid);
      return;
    }
    filterGen++;
    filterJob = client.job();
    sentSteps = effectiveSteps();
    countState = { kind: "filtering" };
    paintCount(false);
    for (const a of aggs) if (a.state === "done") markAggStale(a, T().exAggUpdating);
    const hasRegex = sentSteps.some((s) => s.kind === "regex" && s.text !== "");
    client.send(
      {
        type: "filter",
        job: filterJob,
        path: file.path,
        steps: sentSteps.map((s) => ({ kind: s.kind, text: s.text, ci: s.ci })),
        json: file.mode === "json" ? appliedConds() : [],
        time: timeRange,
        sort: sortSpec(),
        skipHeader: file.mode === "csv",
      },
      hasRegex ? HARD_TIMEOUT_MS : 0,
    );
  }

  function scheduleFilter(): void {
    paintBadge();
    // Results computed for the old pipeline are marked at once, not only when the debounced filter runs.
    for (const a of aggs) if (a.state === "done") markAggStale(a, T().exAggUpdating);
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = null;
      clearNotice();
      syncHash();
      runFilter();
    }, DEBOUNCE_MS);
  }

  function setStale(on: boolean): void {
    view.classList.toggle("is-stale", on);
    staleStrip.hidden = !on;
  }

  function paintCount(announce: boolean): void {
    const t = T();
    countEl.className = "ex-count";
    switch (countState.kind) {
      case "none":
        countEl.replaceChildren();
        return;
      case "loading":
        countEl.textContent = t.exLoading;
        return;
      case "notLoaded":
        countEl.textContent = t.exNotLoaded;
        return;
      case "filtering":
        countEl.textContent = t.exFiltering;
        return;
      case "failed":
        countEl.classList.add("is-warn");
        countEl.textContent = t.exFilterFailed;
        return;
      case "invalid": {
        countEl.classList.add("is-warn");
        const n = String(countState.step);
        countEl.replaceChildren(...fill(t.exPipelineInvalid, { n: num(n) }));
        if (announce) say(fillText(t.exPipelineInvalid, { n }), ANNOUNCE_MS);
        return;
      }
      case "done": {
        const vals = { c: fmtCount(count), t: fmtCount(total) };
        const nodes = fill(t.exCountOf(plural(total)), { c: num(vals.c), t: num(vals.t) });
        let spoken = fillText(t.exCountOf(plural(total)), vals);
        const slow = steps.filter((s) => ui(s).slow).map(stepNo);
        if (slow.length > 0) {
          countEl.classList.add("is-warn");
          const list = slow.join(", ");
          nodes.push(document.createTextNode(" · "), ...fill(t.exStepsNotApplied(plural(slow.length)), { n: num(list) }));
          spoken += ` · ${fillText(t.exStepsNotApplied(plural(slow.length)), { n: list })}`;
        }
        countEl.replaceChildren(...nodes);
        // Polite, and only once the count has settled: typing a filter must not chatter.
        if (announce) say(spoken, ANNOUNCE_MS);
        return;
      }
    }
  }

  /** Conditions complete enough to apply: a field, and a value unless the test is "exists". */
  function appliedConds(): JsonFilter[] {
    return conds.filter((j) => j.field !== "" && (j.op === "exists" || j.value !== "")).map((j) => ({ ...j }));
  }

  function sortSpec(): SortSpec | null {
    if (!sort || !file) return null;
    let key: SortKey | null = null;
    if (file.mode === "csv") key = { kind: "csv", index: sort.col };
    else if (isJson && cols[sort.col] !== undefined) key = { kind: "json", path: cols[sort.col] ?? "" };
    return key ? { key, desc: sort.desc } : null;
  }

  function activeFilterCount(): number {
    return steps.filter((s) => s.text !== "").length + (file?.mode === "json" ? appliedConds().length : 0) + (timeRange ? 1 : 0);
  }

  function paintBadge(): void {
    const active = activeFilterCount();
    filtersBadge.textContent = active > 0 ? String(active) : "";
    filtersBadge.hidden = active === 0;
    paintMatchNav();
  }

  function paintSteps(): void {
    const t = T();
    for (const s of steps) {
      const els = stepEls.get(s);
      if (!els) continue;
      const u = ui(s);
      const msg = u.error !== null ? t.exInvalidRegex(u.error) : u.slow ? t.exStepTooSlow : "";
      els.input.setAttribute("aria-invalid", msg !== "" ? "true" : "false");
      els.row.classList.toggle("is-invalid", msg !== "");
      els.row.classList.toggle("is-slow", u.slow && u.error === null);
      els.err.hidden = msg === "";
      if (els.err.textContent !== msg) els.err.textContent = msg;
    }
  }

  function edited(step: FilterStep): void {
    lastEdited = step;
    ui(step).slow = false; // an edited step gets another chance
    scheduleFilter();
  }

  function renderPipeline(): void {
    const t = T();
    stepEls.clear();
    pipeline.replaceChildren(
      ...steps.map((step, idx) => {
        const n = String(idx + 1);
        const errId = `ex-step-${n}-err`;
        const kind = h("select", { class: "ex-select", "aria-label": fillText(t.exStepType, { n }) },
          h("option", { value: "contains" }, t.exContains),
          h("option", { value: "not" }, t.exNotContains),
          h("option", { value: "regex" }, "regex"));
        kind.value = step.kind;
        const input = h("input", {
          class: "ex-input mono",
          placeholder: idx === 0 ? t.exTypeToFilter : t.exAndThen,
          spellcheck: "false",
          autocomplete: "off",
          "aria-label": fillText(t.exStepText, { n }),
          "aria-describedby": errId,
          "aria-invalid": "false",
        });
        input.value = step.text;
        input.addEventListener("input", () => {
          step.text = input.value;
          edited(step);
        });
        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          if (debounce !== null) window.clearTimeout(debounce);
          debounce = null;
          clearNotice();
          syncHash();
          runFilter();
        });
        const ci = h("input", { type: "checkbox" });
        ci.checked = step.ci;
        kind.addEventListener("change", () => {
          step.kind = kind.value === "not" ? "not" : kind.value === "regex" ? "regex" : "contains";
          // Same default as a freshly added step, so both routes to a regex step mean the same thing.
          step.ci = step.kind !== "regex";
          ci.checked = step.ci;
          edited(step);
        });
        ci.addEventListener("change", () => {
          step.ci = ci.checked;
          edited(step);
        });
        const remove = h("button", { class: "btn btn-sm btn-ghost ex-remove", type: "button", "aria-label": fillText(t.exRemoveStep, { n }) }, "×");
        remove.addEventListener("click", () => {
          steps.splice(idx, 1);
          if (steps.length === 0) steps.push({ kind: "contains", text: "", ci: true });
          renderPipeline();
          scheduleFilter();
        });
        const err = h("p", { class: "ex-step-err", id: errId, role: "alert", hidden: true });
        const row = h("div", { class: "ex-step", role: "group", "aria-label": fillText(t.exStep, { n }) },
          h("div", { class: "ex-step-line" },
            idx > 0 ? h("span", { class: "ex-pipe mono", "aria-hidden": "true" }, "|") : null,
            kind, input, h("label", { class: "ex-ci" }, ci, t.exIgnoreCase), remove),
          err);
        stepEls.set(step, { row, input, err });
        return row;
      }),
      (() => {
        const add = h("button", { class: "btn btn-sm", type: "button" }, t.exAddFilter);
        add.addEventListener("click", () => addStep("contains", ""));
        return add;
      })(),
    );
    paintSteps();
    paintBadge();
  }

  function addStep(kind: StepKind, text: string): void {
    const last = steps[steps.length - 1];
    if (last && last.text === "") steps.pop();
    const step: FilterStep = { kind, text, ci: kind !== "regex" };
    steps.push(step);
    lastEdited = step;
    renderPipeline();
    scheduleFilter();
  }

  /* ---------------------------------------------------------------- json conditions */
  function renderFieldList(): void {
    const fields = file ? (fieldsByPath.get(file.path) ?? []) : [];
    fieldList.replaceChildren(...fields.map((f) => h("option", { value: f })));
  }

  const OPS: ReadonlyArray<[JsonOp, () => string]> = [
    ["eq", () => T().exOpEq],
    ["ne", () => T().exOpNe],
    ["has", () => T().exOpHas],
    ["exists", () => T().exOpExists],
  ];

  function renderConds(focusIdx: number | null = null): void {
    const t = T();
    if (conds.length === 0) conds.push({ field: "", op: "eq", value: "" });
    condList.replaceChildren(...conds.map((cond, idx) => {
      const n = String(idx + 1);
      const field = h("input", { class: "ex-input mono ex-cond-field", list: "ex-json-fields", placeholder: t.exFieldPh, spellcheck: "false", autocomplete: "off", "aria-label": fillText(t.exCondField, { n }) });
      field.value = cond.field;
      const op = h("select", { class: "ex-select", "aria-label": fillText(t.exCondOp, { n }) }, ...OPS.map(([v, label]) => h("option", { value: v }, label())));
      op.value = cond.op;
      const value = h("input", { class: "ex-input mono ex-cond-value", placeholder: t.exValuePh, spellcheck: "false", autocomplete: "off", "aria-label": fillText(t.exCondValue, { n }) });
      value.value = cond.value;
      value.hidden = cond.op === "exists";
      const remove = h("button", { class: "btn btn-sm btn-ghost ex-remove", type: "button", "aria-label": fillText(t.exRemoveCond, { n }) }, "×");
      field.addEventListener("input", () => {
        cond.field = field.value.trim();
        scheduleFilter();
      });
      op.addEventListener("change", () => {
        cond.op = OPS.find(([v]) => v === op.value)?.[0] ?? "eq";
        value.hidden = cond.op === "exists";
        scheduleFilter();
      });
      value.addEventListener("input", () => {
        cond.value = value.value;
        scheduleFilter();
      });
      remove.addEventListener("click", () => {
        conds.splice(idx, 1);
        renderConds(Math.max(0, idx - 1));
        scheduleFilter();
      });
      if (focusIdx === idx) queueMicrotask(() => field.focus());
      return h("div", { class: "ex-cond", role: "group", "aria-label": fillText(t.exCondition, { n }) }, field, op, value, remove);
    }));
  }

  /** Adds (or fills the empty last) JSON condition `field = value` and filters at once. */
  function addCond(field: string, op: JsonOp, value: string): void {
    const last = conds[conds.length - 1];
    if (last && last.field === "") conds.pop();
    conds.push({ field, op, value });
    renderConds();
    scheduleFilter();
  }

  /* ---------------------------------------------------------------- time filter */
  function paintTimeRow(): void {
    timeRow.hidden = timeRange === null;
    if (!timeRange) {
      timeRow.replaceChildren();
      return;
    }
    const remove = h("button", { class: "btn btn-sm btn-ghost ex-remove", type: "button", "aria-label": T().exRemoveTime }, "×");
    remove.addEventListener("click", () => {
      setTimeRange(null);
      pipeline.querySelector<HTMLInputElement>(".ex-input")?.focus();
    });
    timeRow.replaceChildren(
      h("span", { class: "ex-time-filter-k" }, T().exTimeFilter),
      h("span", { class: "chip pill-accent ex-time-chip" },
        ...fill(T().exTimeRange, { from: num(fmtBucket(timeRange.from)), to: num(fmtBucket(timeRange.to)) })),
      remove);
  }

  function setTimeRange(range: TimeRange | null): void {
    timeRange = range;
    paintTimeRow();
    paintBadge();
    if (range) say(fillText(T().exTimeFilterSet, { from: fmtBucket(range.from), to: fmtBucket(range.to) }));
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = null;
    for (const a of aggs) if (a.state === "done") markAggStale(a, T().exAggUpdating);
    clearNotice();
    syncHash();
    runFilter();
  }

  /** A histogram bucket becomes a time filter; with `extend`, the range grows to cover it as well. */
  function pickBucket(from: number, to: number, extend: boolean): void {
    const pattern = hist.wanted;
    if (pattern === null) return;
    // The chart re-renders for the narrower view; put keyboard focus back on it when it was there.
    histRefocus = hist.out.contains(document.activeElement);
    const year = currentYear().year;
    if (extend && timeRange && timeRange.pattern === pattern) {
      setTimeRange({ pattern, year, from: Math.min(from, timeRange.from), to: Math.max(to, timeRange.to) });
    } else {
      setTimeRange({ pattern, year, from, to });
    }
  }

  /* ---------------------------------------------------------------- virtual list */
  function headerCells(): string[] | null {
    if (!file) return null;
    if (file.mode === "csv" && csvHeader.length > 0) return csvHeader;
    if (isJson && cols.length > 0) return cols;
    return null;
  }

  /** The column header lives INSIDE the scroller (sticky top), so it scrolls sideways with its columns. */
  function paintHeader(): void {
    const cells = headerCells();
    headEl.hidden = cells === null;
    headH = cells === null ? 0 : ROW_H;
    // Columns not known yet (the CSV header is still loading) keep a deep-linked sort; a removed column drops it.
    if (sort && cells !== null && sort.col >= cells.length) sort = null;
    if (cells) {
      const t = T();
      headEl.replaceChildren(h("span", { class: "ex-ln", "aria-hidden": "true" }, "#"),
        ...cells.map((name, col) => {
          const state = sort?.col === col ? (sort.desc ? "desc" : "asc") : "none";
          const label = fillText(state === "asc" ? t.exSortedAsc : state === "desc" ? t.exSortedDesc : t.exSortBy, { c: name });
          const b = h("button", { class: `ex-cell ex-sort${state !== "none" ? ` is-${state}` : ""}`, type: "button", title: name, "aria-label": label, "data-col": String(col) },
            h("span", { class: "ex-sort-name" }, name),
            state !== "none" ? h("span", { class: "ex-sort-mark", "aria-hidden": "true" }, state === "asc" ? "▲" : "▼") : null);
          applyColWidth(b, col);
          b.addEventListener("click", () => cycleSort(col, name));
          return b;
        }));
    }
    updateSpacer();
  }

  /** Content-sized CSV columns (measured in the worker); JSON column view keeps a fixed wide cell. */
  function applyColWidth(el: HTMLElement, col: number): void {
    if (file?.mode === "csv") {
      const w = file ? widthsByPath.get(file.path)?.[col] : undefined;
      if (w !== undefined) el.style.width = `${w}ch`;
    } else el.classList.add("ex-cell-wide");
  }

  /** File order → ascending → descending → file order, like the shared data table. */
  function cycleSort(col: number, name: string): void {
    const t = T();
    if (sort?.col !== col) sort = { col, desc: false };
    else if (!sort.desc) sort = { col, desc: true };
    else sort = null;
    say(sort ? fillText(t.exSortSaid, { c: name, dir: sort.desc ? t.exDescending : t.exAscending }) : t.exSortOff);
    paintHeader();
    headEl.querySelector<HTMLElement>(`[data-col="${col}"]`)?.focus();
    syncHash();
    runFilter();
  }

  function updateSpacer(): void {
    spacer.style.height = wrap ? `${count * avgH + viewport.clientHeight * 0.5}px` : `${count * ROW_H}px`;
  }

  function scheduleRender(): void {
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      renderRows();
    });
  }

  function firstVisibleRow(): number {
    return Math.min(count - 1, Math.max(0, Math.floor(viewport.scrollTop / (wrap ? avgH : ROW_H))));
  }

  function renderRows(): void {
    if (!file) {
      renderEmpty();
      return;
    }
    if (count === 0) {
      rowsLayer.style.transform = `translateY(${headH}px)`;
      rowsLayer.replaceChildren(...(countState.kind === "done" && total > 0 ? [h("div", { class: "ex-empty", role: "listitem" }, T().exNoMatch)] : []));
      return;
    }
    const hadFocus = rowsLayer.contains(document.activeElement);
    const pos = viewport.scrollTop / (wrap ? avgH : ROW_H);
    const first = Math.min(count - 1, Math.floor(pos));
    const visible = Math.ceil((viewport.clientHeight - headH) / ROW_H) + 2;
    const last = Math.min(count, first + visible);
    const haveAll = first >= winStart && last <= winStart + winRows.length;
    if (!haveAll) {
      // one request in flight at a time; a newer position just re-targets it
      windowJob = client.job();
      client.send({ type: "window", job: windowJob, path: file.path, start: Math.max(0, first - 60), count: visible + 120 });
    }
    const frag = document.createDocumentFragment();
    const active = sentSteps.filter((s) => !ui(s).slow);
    for (let r = first; r < last; r++) frag.appendChild(renderRow(r, winRows[r - winStart], active));
    rowsLayer.replaceChildren(frag);
    if (wrap) {
      const firstEl = rowsLayer.firstElementChild;
      const h0 = firstEl instanceof HTMLElement ? firstEl.offsetHeight : ROW_H;
      rowsLayer.style.transform = `translateY(${headH + viewport.scrollTop - (pos - first) * h0}px)`;
      const rendered = rowsLayer.children.length;
      if (rendered >= 5 && haveAll) {
        const measured = rowsLayer.offsetHeight / rendered;
        if (Math.abs(measured - avgH) / avgH > 0.3) {
          const keep = viewport.scrollTop / avgH;
          avgH = Math.max(ROW_H, measured);
          updateSpacer();
          viewport.scrollTop = keep * avgH;
        }
      }
    } else {
      rowsLayer.style.transform = `translateY(${headH + first * ROW_H}px)`;
    }
    if (cursor >= first && cursor < last) {
      const el = rowsLayer.children[cursor - first];
      if (el instanceof HTMLElement && (hadFocus || focusCursor)) {
        el.focus({ preventScroll: true });
        focusCursor = false;
      }
    }
  }

  function renderRow(r: number, entry: [number, string] | undefined, active: FilterStep[]): HTMLElement {
    const isCursor = r === cursor;
    const row = h("div", {
      class: `ex-row${isCursor ? " is-cursor" : ""}`,
      role: "listitem",
      tabindex: "-1",
      "aria-posinset": String(r + 1),
      "aria-setsize": String(count),
      "data-row": String(r),
    });
    if (!entry) {
      row.appendChild(h("span", { class: "ex-ln" }, "…"));
      return row;
    }
    const [lineIdx, text] = entry;
    if (isCursor && cursorLine !== lineIdx) {
      cursorLine = lineIdx;
      syncHash();
      updateLineButtons();
    }
    row.appendChild(h("span", { class: "ex-ln" }, String(lineIdx + 1)));
    if (file?.mode === "csv" && csvHeader.length > 0) {
      parseCsvLine(text).forEach((cell, col) => {
        const el = h("span", { class: `ex-cell${cell === "" ? " is-blank" : ""}`, title: cell }, cell === "" ? "—" : cell);
        if (isEpochSeconds(cell)) {
          // The time is shown inline (not only on hover), muted so the raw value still reads first.
          const at = epochLabel(cell);
          el.title = `${cell}\n${at}`;
          el.append(h("span", { class: "ex-epoch" }, ` ${at}`));
        }
        applyColWidth(el, col);
        row.appendChild(el);
      });
      return row;
    }
    if (isJson && cols.length > 0) {
      const obj = parseJsonLine(text);
      if (obj !== undefined) {
        for (const col of cols) {
          const v = stringifyField(getJsonField(obj, col));
          row.appendChild(h("span", { class: "ex-cell ex-cell-wide", title: v }, v));
        }
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

  /** Moves the line cursor (keyboard focus) to view row `r` and scrolls it into view. */
  function setCursor(r: number, focus: boolean, center = false): void {
    if (count === 0) return;
    const next = Math.max(0, Math.min(count - 1, r));
    if (next !== cursor) cursorLine = -1;
    cursor = next;
    focusCursor = focus;
    const rowH = wrap ? avgH : ROW_H;
    const vh = viewport.clientHeight - headH;
    const top = cursor * rowH;
    if (center) viewport.scrollTop = Math.max(0, top - vh / 3);
    else if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + rowH > viewport.scrollTop + vh) viewport.scrollTop = top + rowH - vh;
    const known = winRows[cursor - winStart];
    if (known) cursorLine = known[0];
    syncHash();
    updateLineButtons();
    scheduleRender();
    queueDetail();
  }

  function locateLine(line: number, deepLink: boolean): void {
    if (!file || !inWorker.has(file.path)) return;
    locateJob = client.job();
    locateIsDeepLink = deepLink;
    client.send({ type: "locate", job: locateJob, path: file.path, line });
  }

  function updateLineButtons(): void {
    const on = file !== null && cursor >= 0 && cursorLine >= 0;
    copyLineBtn.disabled = !on;
    linkLineBtn.disabled = !on;
    const has = file !== null && count > 0;
    firstBtn.disabled = !has;
    lastBtn.disabled = !has;
    copyBtn.disabled = !has;
    detailBtn.disabled = !has;
    detailCopy.disabled = !on;
    detailLink.disabled = !on;
    paintMatchNav();
  }

  /** Previous/next match: only meaningful while filters narrow the view, where every row is a match. */
  function paintMatchNav(): void {
    const on = file !== null && activeFilterCount() > 0;
    matchNav.hidden = !on;
    const has = on && count > 0;
    prevMatchBtn.disabled = !has;
    nextMatchBtn.disabled = !has;
    matchPos.textContent = has && cursor >= 0 ? fillText(T().exMatchPos, { i: fmtCount(cursor + 1), n: fmtCount(count) }) : "";
  }

  /** Steps the line cursor through the filtered result, wrapping at both ends. */
  function stepMatch(dir: 1 | -1): void {
    if (!file || count === 0) return;
    const from = cursor >= 0 ? cursor : dir === 1 ? -1 : count;
    setCursor((((from + dir) % count) + count) % count, true);
  }

  function copyLine(): void {
    if (!file || cursor < 0 || !inWorker.has(file.path)) return;
    copyJob = client.job();
    copyKind = "line";
    client.send({ type: "copy", job: copyJob, path: file.path, row: cursor });
  }

  function copyLineLink(): void {
    if (cursorLine < 0) return;
    syncHash();
    void copyText(window.location.href).then((ok) => {
      if (ok) flashButton(detailOpen && drawer.contains(document.activeElement) ? detailLink : linkLineBtn);
      showNotice(ok ? T().exLineLinkCopied(fmtCount(cursorLine + 1)) : T().exCopyAddress, "info");
    });
  }

  /* ---------------------------------------------------------------- detail drawer */
  function openDetail(focus: boolean): void {
    if (!file || count === 0) return;
    if (cursor < 0) setCursor(firstVisibleRow(), false);
    detailOpen = true;
    drawer.hidden = false;
    work.classList.add("has-detail");
    detailBtn.setAttribute("aria-expanded", "true");
    detailBody.replaceChildren(h("p", { class: "ex-muted" }, T().exDetailLoading));
    queueDetail(0);
    if (focus) detailHeading.focus();
  }

  function closeDetail(returnFocus: boolean): void {
    if (!detailOpen) return;
    detailOpen = false;
    drawer.hidden = true;
    work.classList.remove("has-detail");
    detailBtn.setAttribute("aria-expanded", "false");
    if (detailTimer !== null) window.clearTimeout(detailTimer);
    detailTimer = null;
    if (returnFocus) {
      if (cursor >= 0) setCursor(cursor, true);
      else viewport.focus();
    }
  }

  /** Asks the worker for the cursor line; a short delay coalesces key repeat while the cursor moves. */
  function queueDetail(delay = 60): void {
    if (!detailOpen || !file || cursor < 0) return;
    if (detailTimer !== null) window.clearTimeout(detailTimer);
    const path = file.path;
    const row = cursor;
    detailTimer = window.setTimeout(() => {
      detailTimer = null;
      detailJob = client.job();
      client.send({ type: "detail", job: detailJob, path, row });
    }, delay);
  }

  function renderDetailGone(): void {
    detailHeading.textContent = T().exDetails;
    detailPos.textContent = "";
    detailBody.replaceChildren(h("p", { class: "ex-muted" }, T().exDetailGone));
  }

  function paintDetailNav(row: number): void {
    const t = T();
    const filtered = activeFilterCount() > 0;
    detailPrev.textContent = filtered ? t.exPrevMatch : t.exPrevLine;
    detailNext.textContent = filtered ? t.exNextMatch : t.exNextLine;
    detailPrev.disabled = count < 2;
    detailNext.disabled = count < 2;
    detailPos.replaceChildren(...fill(filtered ? t.exMatchPos : t.exLinePos, { i: num(fmtCount(row + 1)), n: num(fmtCount(count)) }));
  }

  function detailTable(rows: Array<[string, string]>, onFilter: (k: string, v: string) => void): HTMLElement {
    const t = T();
    return h("div", { class: "ex-table-wrap ex-detail-fields" }, h("table", { class: "ex-table" },
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", class: "ex-th-start" }, t.exDetailField),
        h("th", { scope: "col", class: "ex-th-start" }, t.exValue),
        h("th", { scope: "col" }, h("span", { class: "ex-sr" }, t.exDetailFilterAdd)))),
      h("tbody", {}, ...rows.map(([k, v]) => {
        const b = h("button", { class: "btn btn-sm btn-ghost", type: "button", "aria-label": fillText(t.exDetailFilterOn, { f: k, v: v === "" ? t.exEmpty : v }) }, t.exDetailFilterAdd);
        b.addEventListener("click", () => onFilter(k, v));
        return h("tr", {},
          h("th", { scope: "row", class: "mono ex-detail-k" }, h("bdi", { dir: "ltr" }, k)),
          h("td", { class: "mono ex-detail-v" }, v === "" ? h("span", { class: "ex-muted" }, "—") : h("bdi", { dir: "ltr" }, v)),
          h("td", { class: "ex-detail-act" }, b));
      }))));
  }

  function renderDetail(row: number, line: number, text: string, truncated: boolean): void {
    if (line < 0) {
      renderDetailGone();
      return;
    }
    const t = T();
    detailHeading.replaceChildren(...fill(t.exDetailTitle, { n: num(fmtCount(line + 1)) }));
    paintDetailNav(row);
    const parts: Node[] = [];
    let fields: Array<[string, string]> = [];
    let onFilter: (k: string, v: string) => void = (k, v) => addStep("contains", `${k}=${v}`);
    if (file?.mode === "csv" && csvHeader.length > 0) {
      const cells = parseCsvLine(text);
      fields = csvHeader.map((name, i) => [name, cells[i] ?? ""]);
      onFilter = (_k, v) => addStep("contains", v);
    } else {
      const obj = isJson ? parseJsonLine(text) : undefined;
      if (obj !== undefined) {
        fields = flattenJson(obj);
        onFilter = (k, v) => addCond(k, "eq", v);
      } else fields = kvPairs(text);
    }
    if (fields.length > 0) parts.push(h("h4", { class: "ex-detail-sub" }, t.exDetailFields), detailTable(fields, onFilter));
    const epochs = epochTokens(text);
    if (epochs.length > 0) {
      parts.push(h("h4", { class: "ex-detail-sub" }, t.exDetailTimes),
        h("dl", { class: "ex-detail-times", dir: "ltr" }, ...epochs.flatMap(([v, at]) => [h("dt", { class: "mono" }, v), h("dd", { class: "mono" }, at)])));
    }
    const raw = h("pre", { class: "ex-detail-raw", dir: "ltr", tabindex: "0", "aria-labelledby": "ex-detail-raw-h" });
    const ranges = matchRanges(text, sentSteps.filter((s) => !ui(s).slow));
    let pos = 0;
    for (const [a, b] of ranges) {
      if (a > pos) raw.append(text.slice(pos, a));
      raw.append(h("mark", {}, text.slice(a, b)));
      pos = b;
    }
    if (pos < text.length) raw.append(text.slice(pos));
    parts.push(h("h4", { class: "ex-detail-sub", id: "ex-detail-raw-h" }, t.exDetailRaw), raw);
    if (truncated) parts.push(h("p", { class: "ex-muted" }, t.exDetailTruncated));
    detailBody.replaceChildren(...parts);
    if (detailSay) {
      // Stepped from the drawer: focus did not move, so say where we are.
      detailSay = false;
      say(`${detailHeading.textContent ?? ""}. ${detailPos.textContent ?? ""}`);
    }
  }

  /** Moves the cursor one row (wrapping), from the drawer: the row is not focused so focus stays here. */
  function stepFromDrawer(dir: 1 | -1): void {
    if (!file || count === 0) return;
    detailSay = true;
    const from = cursor >= 0 ? cursor : dir === 1 ? -1 : count;
    setCursor((((from + dir) % count) + count) % count, false);
  }

  function onDrawerKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDetail(true);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      stepFromDrawer(e.key === "N" ? -1 : 1);
    } else if (e.key === "c") {
      e.preventDefault();
      copyLine();
    } else if (e.key === "l") {
      e.preventDefault();
      copyLineLink();
    }
  }

  function onViewportKey(e: KeyboardEvent): void {
    if (!file || count === 0 || e.altKey) return;
    const page = Math.max(1, Math.floor((viewport.clientHeight - headH) / ROW_H) - 1);
    const from = cursor >= 0 ? cursor : firstVisibleRow();
    let next: number | null = null;
    switch (e.key) {
      case "ArrowDown":
        next = cursor < 0 ? from : from + 1;
        break;
      case "ArrowUp":
        next = cursor < 0 ? from : from - 1;
        break;
      case "PageDown":
        next = from + page;
        break;
      case "PageUp":
        next = from - page;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
    }
    if (next !== null) {
      e.preventDefault();
      setCursor(next, true);
      return;
    }
    if ((e.key === "n" || e.key === "N") && !e.ctrlKey && !e.metaKey && activeFilterCount() > 0) {
      e.preventDefault();
      stepMatch(e.key === "N" ? -1 : 1);
      return;
    }
    if (e.key === "Escape" && detailOpen) {
      e.preventDefault();
      closeDetail(false);
      return;
    }
    const onRow = e.target instanceof HTMLElement && e.target.classList.contains("ex-row");
    if (e.key === "Enter" && onRow && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      openDetail(true);
      return;
    }
    if (cursor < 0 || !onRow) return;
    const noSelection = window.getSelection()?.isCollapsed ?? true;
    if ((e.key === "c" && !e.ctrlKey && !e.metaKey) || ((e.ctrlKey || e.metaKey) && e.key === "c" && noSelection)) {
      e.preventDefault();
      copyLine();
    } else if (e.key === "l" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      copyLineLink();
    }
  }

  function setWrap(on: boolean): void {
    const keep = firstVisibleRow();
    wrap = on;
    wrapCb.checked = on;
    viewport.classList.toggle("is-wrap", on);
    avgH = ROW_H * 1.6;
    updateSpacer();
    viewport.scrollTop = keep * (wrap ? avgH : ROW_H);
    scheduleRender();
  }

  /* ---------------------------------------------------------------- aggregations */
  function resetAgg(a: Agg, presetsList: PatternPreset[]): void {
    a.job = 0;
    a.gen = -1;
    a.wanted = null;
    a.state = "idle";
    a.input.value = presetsList[0]?.pattern ?? "";
    a.input.setAttribute("aria-invalid", "false");
    a.err.hidden = true;
    a.out.replaceChildren(h("p", { class: "ex-muted" }, presetsList.length > 0 ? T().exAggReady : T().exNoTimePreset));
    markAggStale(a, null);
    a.chips.replaceChildren(...presetsList.map((p) => {
      const chip = h("button", { class: "ex-chip", type: "button", title: p.pattern }, p.label);
      chip.addEventListener("click", () => {
        a.input.value = p.pattern;
        runAgg(a, p.pattern);
      });
      return chip;
    }));
  }

  function markAggStale(a: Agg, text: string | null): void {
    a.strip.hidden = text === null;
    a.strip.textContent = text ?? "";
    a.out.classList.toggle("is-stale", text !== null);
    if (text !== null && a.state === "done") a.state = "stale";
  }

  function aggFailed(a: Agg, message: string): void {
    a.state = "error";
    a.wanted = null;
    a.input.setAttribute("aria-invalid", "true");
    a.err.hidden = false;
    a.err.textContent = message;
    markAggStale(a, null);
    a.out.replaceChildren(h("p", { class: "ex-muted" }, T().exAggNotApplied));
  }

  function runAgg(a: Agg, pattern: string, announce = true): void {
    if (!file || !inWorker.has(file.path)) return;
    const err = pattern === "" ? (a.kind === "unique" ? T().exEnterCapture : T().exEnterTs) : regexError(pattern);
    if (err !== null) {
      a.state = "error";
      a.wanted = null;
      a.input.setAttribute("aria-invalid", "true");
      a.err.hidden = false;
      a.err.textContent = pattern === "" ? err : T().exInvalidRegex(err);
      markAggStale(a, null);
      a.out.replaceChildren();
      return;
    }
    if (countState.kind === "invalid") {
      a.wanted = pattern;
      a.state = "stale";
      markAggStale(a, T().exAggPipelineInvalid);
      return;
    }
    a.input.setAttribute("aria-invalid", "false");
    a.err.hidden = true;
    a.job = client.job();
    a.gen = filterGen;
    a.wanted = pattern;
    a.state = "running";
    a.announce = announce;
    markAggStale(a, null);
    a.out.replaceChildren(h("p", { class: "ex-muted" }, a.kind === "unique" ? T().exCounting : T().exBucketing));
    if (a.kind === "unique") client.send({ type: "unique", job: a.job, path: file.path, pattern, ci: false }, HARD_TIMEOUT_MS);
    else client.send({ type: "histogram", job: a.job, path: file.path, pattern, year: currentYear().year }, HARD_TIMEOUT_MS);
  }

  function renderUnique(rows: Array<[string, number]>, distinct: number, matched: number, more: number): void {
    let sortBy: "count" | "value" = "count";
    let asc = false;
    const tbody = h("tbody");
    const heads: Array<{ th: HTMLElement; key: "count" | "value" }> = [];
    const paint = (): void => {
      const sorted = [...rows].sort((a, b) => {
        const d = sortBy === "count" ? a[1] - b[1] : a[0].localeCompare(b[0], undefined, { numeric: true });
        return asc ? d : -d;
      });
      tbody.replaceChildren(
        ...sorted.map(([value, n]) => {
          const add = h("button", { class: "ex-linkish mono", type: "button", title: T().exAddAsContains, dir: "ltr" }, value === "" ? T().exEmpty : value);
          add.addEventListener("click", () => addStep("contains", value));
          return h("tr", {}, h("td", {}, add), h("td", { class: "num mono" }, fmtCount(n)));
        }),
      );
      for (const hd of heads) hd.th.setAttribute("aria-sort", hd.key === sortBy ? (asc ? "ascending" : "descending") : "none");
    };
    const th = (label: string, key: "count" | "value", cls: string): HTMLElement => {
      const b = h("button", { class: "ex-th", type: "button" }, label);
      const cell = h("th", { scope: "col", class: cls }, b);
      heads.push({ th: cell, key });
      b.addEventListener("click", () => {
        if (sortBy === key) asc = !asc;
        else {
          sortBy = key;
          asc = key === "value";
        }
        paint();
      });
      return cell;
    };
    const thead = h("thead", {}, h("tr", {}, th(T().exValue, "value", "ex-th-start"), th(T().exCountCol, "count", "num")));
    paint();
    const d = fmtCount(distinct);
    const m = fmtCount(matched);
    uniq.out.replaceChildren(
      h("p", { class: "ex-big" }, ...fill(T().exDistinctIn(plural(distinct), plural(matched)), { d: h("strong", { class: "ex-num" }, d), m: num(m) })),
      h("div", { class: "ex-table-wrap" }, h("table", { class: "ex-table" }, thead, tbody)),
      ...(more > 0 ? [h("p", { class: "ex-muted" }, ...fill(T().exMore, { n: num(fmtCount(more)) }))] : []),
    );
    if (uniq.announce) say(fillText(T().exDistinctIn(plural(distinct), plural(matched)), { d, m }));
  }

  function stepLabel(step: number): string {
    const t = T();
    if (step % 1440 === 0) return step === 1440 ? t.exPerDay : fillText(t.exPerDays, { n: String(step / 1440) });
    if (step % 60 === 0) return step === 60 ? t.exPerHour : fillText(t.exPerHours, { n: String(step / 60) });
    return step === 1 ? t.exPerMinute : fillText(t.exPerMinutes, { n: String(step) });
  }

  function renderHistogram(result: HistogramResult): void {
    const series = timeSeries(result.minutes);
    const parts: HTMLElement[] = [];
    if (series) parts.push(...renderChart(series));
    if (result.buckets.length > 0) {
      const max = result.buckets.reduce((acc, b) => Math.max(acc, b.count), 0);
      parts.push(h("p", { class: "ex-muted" }, series ? T().exHistSomeKeys : T().exHistNoTimes),
        h("div", { class: "ex-hist" },
          ...result.buckets.map((b) => {
            const bar = h("span", { class: "ex-bar" });
            bar.style.width = `${max > 0 ? (b.count / max) * 100 : 0}%`;
            return h("div", { class: "ex-hist-row" }, h("span", { class: "ex-hist-key mono", title: b.key }, b.key), h("span", { class: "ex-bar-track" }, bar), h("span", { class: "ex-hist-n mono" }, fmtCount(b.count)));
          })));
      if (result.truncated) parts.push(h("p", { class: "ex-muted" }, T().exHistCapped));
    }
    if (parts.length === 0) parts.push(h("p", { class: "ex-muted" }, T().exNoLineMatched));
    hist.out.replaceChildren(...parts);
    if (histRefocus) {
      histRefocus = false;
      const bar = hist.out.querySelector<SVGRectElement>("rect.is-picked") ?? hist.out.querySelector<SVGRectElement>('rect[tabindex="0"]');
      if (bar) {
        for (const r of hist.out.querySelectorAll("rect")) r.setAttribute("tabindex", "-1");
        bar.setAttribute("tabindex", "0");
        bar.focus();
      }
    }
  }

  function renderChart(s: TimeSeries): HTMLElement[] {
    const t = T();
    const n = s.counts.length;
    const max = Math.max(1, s.peak.count);
    const stepMs = s.step * 60_000;
    const per = stepLabel(s.step);
    const peakAt = fmtBucket(s.peak.at);
    const summary = fillText(t.exHistSummary(plural(s.total)), { per, total: fmtCount(s.total), n: fmtCount(n) });
    const peakText = fillText(t.exHistPeak, { n: fmtCount(s.peak.count), at: peakAt });
    const gapText = s.gap ? fillText(t.exHistGap(plural(s.gap.buckets)), { from: fmtBucket(s.gap.from), to: fmtBucket(s.gap.to), k: fmtCount(s.gap.buckets) }) : t.exHistNoGap;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${n} 100`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "ex-chart");
    // Bars are buttons (click = keep only that time) with a roving tab stop, like an APG toolbar: one Tab
    // stop for the chart, arrow keys between bars, Enter or Space to pick, Shift to widen to a range.
    svg.setAttribute("role", "toolbar");
    svg.setAttribute("aria-label", `${t.exChartBars}. ${summary}. ${peakText}. ${gapText}.`);
    svg.setAttribute("aria-describedby", "ex-hist-click-help");
    const bars: SVGRectElement[] = [];
    const selFrom = timeRange && timeRange.pattern === hist.wanted ? timeRange.from : null;
    const selTo = timeRange && timeRange.pattern === hist.wanted ? timeRange.to : null;
    for (let i = 0; i < n; i++) {
      const v = s.counts[i] ?? 0;
      if (v === 0) continue;
      const at = s.start + i * stepMs;
      const hgt = Math.max(1.5, (v / max) * 100);
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(i + 0.08));
      rect.setAttribute("width", "0.84");
      rect.setAttribute("y", String(100 - hgt));
      rect.setAttribute("height", String(hgt));
      rect.setAttribute("role", "button");
      rect.setAttribute("tabindex", "-1");
      rect.setAttribute("aria-label", fillText(t.exBarLabel, { at: fmtBucket(at), n: fmtCount(v) }));
      rect.dataset.from = String(at);
      if (selFrom !== null && selTo !== null && at >= selFrom && at < selTo) rect.classList.add("is-picked");
      const tip = document.createElementNS(SVG_NS, "title");
      tip.textContent = `${fmtBucket(at)} · ${fmtCount(v)}`;
      rect.appendChild(tip);
      svg.appendChild(rect);
      bars.push(rect);
    }
    // Inside a picked range every bar is picked; the mark only means something when some are not.
    if (bars.every((b) => b.classList.contains("is-picked"))) for (const b of bars) b.classList.remove("is-picked");
    const peakBar = bars.find((b) => Number(b.dataset.from) === s.peak.at) ?? bars[0];
    peakBar?.setAttribute("tabindex", "0");
    const pick = (rect: SVGRectElement, extend: boolean): void => {
      const from = Number(rect.dataset.from);
      pickBucket(from, from + stepMs, extend);
    };
    svg.addEventListener("click", (e) => {
      const rect = e.target instanceof SVGRectElement ? e.target : null;
      if (rect) pick(rect, e.shiftKey);
    });
    svg.addEventListener("keydown", (e) => {
      const at = bars.findIndex((b) => b === document.activeElement);
      if (at < 0) return;
      let next: number | null = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = Math.min(bars.length - 1, at + 1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = Math.max(0, at - 1);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = bars.length - 1;
      else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const rect = bars[at];
        if (rect) pick(rect, e.shiftKey);
        return;
      }
      if (next === null) return;
      e.preventDefault();
      for (const b of bars) b.setAttribute("tabindex", "-1");
      bars[next]?.setAttribute("tabindex", "0");
      bars[next]?.focus();
    });
    const end = s.start + (n - 1) * stepMs;
    const mid = s.start + Math.floor((n - 1) / 2) * stepMs;
    const rowsTable = s.counts.map((v, i) => {
      const at = s.start + i * stepMs;
      const label = fmtBucket(at);
      const cell = v === 0 ? label : (() => {
        const b = h("button", { class: "ex-linkish mono", type: "button", dir: "ltr", "aria-label": fillText(t.exFilterToTime, { at: label }) }, label);
        b.addEventListener("click", (e) => pickBucket(at, at + stepMs, e.shiftKey));
        return b;
      })();
      return h("tr", {}, h("td", { class: "mono" }, cell), h("td", { class: "num mono" }, fmtCount(v)));
    });
    return [
      h("p", { class: "ex-muted" }, ...fill(t.exHistSummary(plural(s.total)), { per, total: num(fmtCount(s.total)), n: num(fmtCount(n)) })),
      h("p", { class: "ex-muted ex-hist-help", id: "ex-hist-click-help" }, t.exHistClickHelp),
      h("div", { class: "ex-chart-wrap", dir: "ltr" },
        h("div", { class: "ex-yaxis mono", "aria-hidden": "true" }, h("span", {}, fmtCount(s.peak.count)), h("span", {}, "0")),
        h("div", { class: "ex-chart-box" }, svg,
          h("div", { class: "ex-xaxis mono", "aria-hidden": "true" }, h("span", {}, fmtBucket(s.start)), n > 2 ? h("span", {}, fmtBucket(mid)) : null, h("span", {}, fmtBucket(end))))),
      h("p", { class: "ex-hist-take" }, ...fill(t.exHistPeak, { n: num(fmtCount(s.peak.count)), at: num(peakAt) }), " · ",
        ...(s.gap ? fill(t.exHistGap(plural(s.gap.buckets)), { from: num(fmtBucket(s.gap.from)), to: num(fmtBucket(s.gap.to)), k: num(fmtCount(s.gap.buckets)) }) : [document.createTextNode(t.exHistNoGap)])),
      h("p", { class: "ex-muted" }, t.exHistWallClock),
      h("details", { class: "ex-hist-table" }, h("summary", {}, t.exHistAsTable),
        h("div", { class: "ex-table-wrap" }, h("table", { class: "ex-table" },
          h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "ex-th-start" }, t.exTimeCol), h("th", { scope: "col", class: "num" }, t.exCountCol))),
          h("tbody", {}, ...rowsTable)))),
    ];
  }

  /* ---------------------------------------------------------------- time */
  function currentYear(): { year: number; source: string } {
    const typed = Number(yearInput.value);
    if (yearEdited && Number.isInteger(typed) && typed >= 1970 && typed <= 2100) return { year: typed, source: T().exYearYours };
    if (yearFromEvidence !== null) return { year: yearFromEvidence, source: T().exYearEvidence };
    return { year: new Date().getUTCFullYear(), source: T().exYearToday };
  }

  function renderTime(): void {
    const y = currentYear();
    if (!yearEdited) yearInput.value = String(y.year);
    const raw = timeInput.value;
    timeNote.replaceChildren();
    if (raw.trim() === "") {
      timeOut.replaceChildren();
      return;
    }
    const yearless = isYearless(raw);
    let ms = parseTimeInput(raw, yearless ? y.year : null);
    if (ms === null) {
      timeOut.replaceChildren(h("dd", { class: "ex-err" }, T().exBadFormat));
      return;
    }
    const notes: Node[] = [];
    if (yearless) notes.push(...fill(T().exYearAssumed, { y: num(String(y.year)), src: y.source }));
    if (isZoneless(raw)) {
      const zone = zoneSel.value;
      if (zone !== "UTC") ms = wallClockToUtc(ms, zone);
      if (notes.length > 0) notes.push(document.createTextNode(" "));
      notes.push(...fill(T().exZoneAssumed, { z: num(zoneLabel(zone)) }));
    }
    timeNote.replaceChildren(...notes);
    const value = ms;
    timeOut.replaceChildren(
      ...ZONES.flatMap((z) => [
        h("dt", {}, zoneLabel(z), CASE_ZONES.includes(z) ? h("span", { class: "ex-zone-tag" }, ` · ${T().exCaseZone}`) : null),
        h("dd", {}, formatInZone(value, z)),
      ]),
      h("dt", {}, T().exEpochS), h("dd", {}, String(value / 1000)),
      h("dt", {}, T().exEpochMs), h("dd", {}, String(value)),
    );
  }

  /* ---------------------------------------------------------------- hash / copy */
  function stateQuery(): string {
    return encodeState({
      file: file?.path ?? null,
      steps,
      json: file?.mode === "json" ? appliedConds() : [],
      cols,
      line: cursorLine >= 0 ? cursorLine + 1 : null,
      sort,
      time: timeRange,
    });
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
      const ta = h("textarea", { class: "ex-offscreen", "aria-hidden": "true" });
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

  /** Inline "Copied" on the button itself for 2 s, at the same size. */
  function flashButton(btn: HTMLButtonElement): void {
    const label = btn.dataset.label ?? btn.textContent ?? "";
    btn.dataset.label = label;
    btn.textContent = T().exCopiedShort;
    btn.classList.add("is-copied");
    window.setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove("is-copied");
    }, 2000);
  }

  /* ---------------------------------------------------------------- wiring */
  cancelBtn.addEventListener("click", () => {
    if (file && loading === file.path) client.send({ type: "cancelLoad", path: file.path });
  });
  retryBtn.addEventListener("click", () => {
    if (file) startLoad(file);
  });
  firstBtn.addEventListener("click", () => setCursor(0, true));
  lastBtn.addEventListener("click", () => setCursor(count - 1, true));
  prevMatchBtn.addEventListener("click", () => stepMatch(-1));
  nextMatchBtn.addEventListener("click", () => stepMatch(1));
  fileSearch.addEventListener("input", renderFileList);
  copyBtn.addEventListener("click", () => {
    if (!file || !inWorker.has(file.path)) return;
    copyJob = client.job();
    copyKind = "view";
    client.send({ type: "copy", job: copyJob, path: file.path });
  });
  shareBtn.addEventListener("click", () => {
    syncHash();
    void copyText(window.location.href).then((ok) => {
      if (ok) flashButton(shareBtn);
      showNotice(ok ? T().exLinkCopied : T().exCopyAddress, "info");
    });
  });
  copyLineBtn.addEventListener("click", copyLine);
  linkLineBtn.addEventListener("click", copyLineLink);
  wrapCb.addEventListener("change", () => {
    saveWrapPref(wrapCb.checked);
    setWrap(wrapCb.checked);
  });
  viewport.addEventListener("scroll", scheduleRender, { passive: true });
  viewport.addEventListener("keydown", onViewportKey);
  rowsLayer.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target.closest("[data-row]") : null;
    if (!(target instanceof HTMLElement) || !(window.getSelection()?.isCollapsed ?? true)) return;
    setCursor(Number(target.dataset.row), true);
  });
  const ro = new ResizeObserver(() => {
    updateSpacer();
    scheduleRender();
  });
  ro.observe(viewport);
  addCondBtn.addEventListener("click", () => {
    conds.push({ field: "", op: "eq", value: "" });
    renderConds(conds.length - 1);
  });
  detailBtn.addEventListener("click", () => {
    if (detailOpen) closeDetail(true);
    else openDetail(true);
  });
  detailClose.addEventListener("click", () => closeDetail(true));
  detailPrev.addEventListener("click", () => stepFromDrawer(-1));
  detailNext.addEventListener("click", () => stepFromDrawer(1));
  detailCopy.addEventListener("click", copyLine);
  detailLink.addEventListener("click", copyLineLink);
  drawer.addEventListener("keydown", onDrawerKey);
  rowsLayer.addEventListener("dblclick", (e) => {
    const target = e.target instanceof Element ? e.target.closest("[data-row]") : null;
    if (target instanceof HTMLElement) openDetail(true);
  });
  colsInput.value = cols.join(", ");
  colsInput.addEventListener("input", () => {
    cols = colsInput.value.split(",").map((col) => col.trim()).filter((col) => col !== "");
    syncHash();
    paintHeader();
    scheduleRender();
  });
  timeInput.addEventListener("input", renderTime);
  yearInput.addEventListener("input", () => {
    yearEdited = yearInput.value.trim() !== "";
    renderTime();
  });
  zoneSel.addEventListener("change", renderTime);
  sideToggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("is-open");
    sideToggle.setAttribute("aria-expanded", String(open));
  });
  const narrow = window.matchMedia(NARROW);
  const onNarrow = (): void => {
    if (!narrow.matches) controls.open = true;
  };
  controls.open = !narrow.matches;
  narrow.addEventListener("change", onNarrow);

  const aggButton = (a: Agg, label: string): HTMLButtonElement => {
    const b = h("button", { class: "btn btn-sm btn-primary", type: "button" }, label);
    b.addEventListener("click", () => runAgg(a, a.input.value));
    a.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runAgg(a, a.input.value);
    });
    a.input.addEventListener("input", () => {
      if (a.state === "error") {
        a.state = "idle";
        a.input.setAttribute("aria-invalid", "false");
        a.err.hidden = true;
      }
    });
    return b;
  };
  const aggBody = (a: Agg, help: Node[], button: HTMLButtonElement): Node[] => [
    h("p", { class: "ex-muted" }, ...help),
    h("div", { class: "ex-row-form" }, a.input, button),
    a.err,
    a.chips,
    a.strip,
    a.out,
  ];

  sidebar.append(
    h("h3", { class: "ex-side-h" }, T().exEvidenceFiles),
    h("label", { class: "ex-sr", for: "ex-file-search" }, T().exFileSearch),
    fileSearch,
    fileCount,
    noFiles,
    fileList,
    h("section", { class: "ex-time", "aria-labelledby": "ex-time-h" },
      h("h3", { class: "ex-side-h", id: "ex-time-h" }, T().exTimeConverter),
      h("label", { class: "ex-field", for: "ex-time" }, T().exTimeToConvert),
      timeInput,
      h("div", { class: "ex-time-opts" },
        h("label", { class: "ex-field", for: "ex-year" }, T().exAssumeYear, yearInput),
        h("label", { class: "ex-field", for: "ex-zone" }, T().exAssumeZone, zoneSel)),
      timeNote,
      timeOut),
  );

  histDetails.append(
    h("summary", {}, T().exHistTitle),
    ...aggBody(hist, [document.createTextNode(T().exHistHelp)], aggButton(hist, T().exPlot)),
  );
  const aggSet = h("fieldset", { class: "ex-fieldset ex-aggs" },
    h("legend", { class: "ex-sr" }, T().exAggsLegend),
    h("details", { class: "ex-agg", open: true },
      h("summary", {}, T().exUniqueTitle),
      ...aggBody(uniq, fill(T().exUniqueHelp, { cmd: h("code", { dir: "ltr" }, "grep -o | sort | uniq -c") }), aggButton(uniq, T().exCountBtn))),
    histDetails);

  const main = h("section", { class: "ex-main", "aria-label": T().exTitle },
    h("div", { class: "ex-head" }, h("div", { class: "ex-head-title" }, title, fileFormat), countEl),
    controls,
    notice,
    h("div", { class: "ex-actions" }, firstBtn, lastBtn, matchNav, detailBtn, copyLineBtn, linkLineBtn, copyBtn, shareBtn,
      h("label", { class: "ex-toggle", for: "ex-wrap" }, wrapCb, T().exWrap)),
    keysHelp,
    work,
    aggSet,
  );

  root.replaceChildren(
    h("div", { class: "explorer" },
      h("div", { class: "ex-topbar" },
        h("a", { class: "btn btn-sm btn-ghost", href: `#/case/${c.id}` }, T().exBack),
        h("strong", {}, T().exTitle),
        h("span", { class: "ex-muted ex-case" }, c.title),
        tagline,
        sideToggle),
      announcer,
      h("div", { class: "ex-layout" }, sidebar, main)),
  );
  viewport.classList.toggle("is-wrap", wrap);
  renderConds();
  paintTimeRow();
  renderPipeline();
  renderFileList();
  renderTime();
  setEnabled(false);
  renderEmpty();

  // Year-less syslog needs the case's year. When the case text has none, the README (2 KB) usually does.
  if (yearFromEvidence === null && EVIDENCE_FILES.some((f) => f.path === "README_FIRST.txt")) {
    void fetch(evidenceUrl(c.id, "README_FIRST.txt"))
      .then((res) => (res.ok ? res.text() : ""))
      .then((text) => {
        const y = yearInText(text);
        if (y !== null && yearFromEvidence === null) {
          yearFromEvidence = y;
          renderTime();
        }
      })
      .catch(() => { /* offline: the converter says it assumed the current year */ });
  }

  const startFile = EVIDENCE_FILES.find((f) => f.path === initial.file);
  if (startFile) selectFile(startFile);

  /* ---------------------------------------------------------------- teardown */
  function teardown(): void {
    window.removeEventListener("hashchange", onHashChange);
    narrow.removeEventListener("change", onNarrow);
    if (debounce !== null) window.clearTimeout(debounce);
    if (announceTimer !== null) window.clearTimeout(announceTimer);
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
