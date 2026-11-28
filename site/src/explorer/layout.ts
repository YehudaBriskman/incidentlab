// DOM-free rules of the Explorer's layout (#280): the window splitter between the log and the analysis panel
// (APG window splitter), and the layout preferences remembered per device. views/explorer.ts wires them up.
//
// The splitter's value is the log's share of the split, in percent: the log is the primary pane (APG). The
// panel's width in px is what is stored, because a device keeps its width while the share moves with the window.

/** Panel width the split starts at (and a double-click resets to). */
export const DEFAULT_PANEL = 380;
/** The analysis panel never gets narrower than this. */
export const MIN_PANEL = 280;
/** The log never gets narrower than this. */
export const MIN_LOG = 320;
/** One arrow key press moves the splitter this far. */
export const KEY_STEP = 32;

export interface SplitBounds {
  /** Width shared by the log and the panel (the splitter itself excluded). */
  readonly total: number;
  readonly minLog: number;
  readonly minPanel: number;
}

export function bounds(total: number): SplitBounds {
  return { total: Math.max(0, total), minLog: MIN_LOG, minPanel: MIN_PANEL };
}

/** The largest panel the split allows: what is left once the log has its minimum (never below the panel's minimum). */
export function maxPanel(b: SplitBounds): number {
  return Math.max(b.minPanel, b.total - b.minLog);
}

export function clampPanel(px: number, b: SplitBounds): number {
  if (!Number.isFinite(px)) return Math.min(DEFAULT_PANEL, maxPanel(b));
  return Math.round(Math.min(maxPanel(b), Math.max(b.minPanel, px)));
}

/** The log's share of the split in whole percent (aria-valuenow). */
export function logShare(panel: number, b: SplitBounds): number {
  if (b.total <= 0) return 0;
  return Math.round(((b.total - clampPanel(panel, b)) / b.total) * 100);
}

/** aria-valuemin and aria-valuemax: the log's share with the panel at its largest and at its smallest. */
export function shareRange(b: SplitBounds): { min: number; max: number } {
  return { min: logShare(maxPanel(b), b), max: logShare(b.minPanel, b) };
}

/**
 * The panel width after a key press on the splitter, or null when the key is not the splitter's.
 * Arrows move the splitter the way they point: in LTR the panel is at the right, so ArrowLeft widens it; in RTL
 * it is at the left, so ArrowLeft narrows it. Home gives the log its minimum, End its maximum (APG).
 * Shift moves four steps.
 */
export function panelAfterKey(key: string, shift: boolean, panel: number, b: SplitBounds, rtl: boolean): number | null {
  const step = KEY_STEP * (shift ? 4 : 1);
  const towardStart = rtl ? -step : step; // ArrowLeft in LTR grows the end-side panel
  switch (key) {
    case "ArrowLeft":
      return clampPanel(panel + towardStart, b);
    case "ArrowRight":
      return clampPanel(panel - towardStart, b);
    case "Home":
      return maxPanel(b);
    case "End":
      return b.minPanel;
    default:
      return null;
  }
}

/**
 * The panel width while dragging: the distance from the pointer to the split's end edge (the start edge in RTL),
 * less half the splitter so the grab point stays under the pointer.
 */
export function panelFromPointer(clientX: number, splitLeft: number, splitRight: number, splitter: number, rtl: boolean, b: SplitBounds): number {
  const fromEdge = rtl ? clientX - splitLeft : splitRight - clientX;
  return clampPanel(fromEdge - splitter / 2, b);
}

/* ---------------------------------------------------------------- remembered per device */

export const PANEL_KEY = "il.explorer.panel";
export const FILES_KEY = "il.explorer.files";
export const TAB_KEY = "il.explorer.tab";

export type AnalyzeTab = "filters" | "unique" | "time";
export const ANALYZE_TABS: readonly AnalyzeTab[] = ["filters", "unique", "time"];

/** Storage that may be missing or throw (private windows, blocked site data). */
export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function read(store: PrefStore | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: PrefStore | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    /* storage blocked: the layout still works for this visit */
  }
}

export function readPanelWidth(store: PrefStore | null): number | null {
  const v = Number(read(store, PANEL_KEY));
  return read(store, PANEL_KEY) !== null && Number.isFinite(v) && v > 0 ? v : null;
}
export function savePanelWidth(store: PrefStore | null, px: number): void {
  write(store, PANEL_KEY, String(Math.round(px)));
}

/** The files pane is open unless the player closed it on this device. */
export function readFilesOpen(store: PrefStore | null): boolean {
  return read(store, FILES_KEY) !== "0";
}
export function saveFilesOpen(store: PrefStore | null, open: boolean): void {
  write(store, FILES_KEY, open ? "1" : "0");
}

export function readTab(store: PrefStore | null): AnalyzeTab {
  const v = read(store, TAB_KEY);
  return ANALYZE_TABS.find((t) => t === v) ?? "filters";
}
export function saveTab(store: PrefStore | null, tab: AnalyzeTab): void {
  write(store, TAB_KEY, tab);
}

/** window.localStorage, or null where reading the property itself throws. */
export function localStore(): PrefStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
