// DOM-free logic behind the DataTable: sorting and CSV. Kept separate so node:test can cover it directly.

export type SortDir = "asc" | "desc";
export type SortKey = string | number | null;
export type SortState = { readonly id: string; readonly dir: SortDir };

/**
 * Stable sort by a key. Missing values (null, NaN) always sink to the bottom in both directions, because
 * "no data" is not the smallest number. Strings compare with the locale's collation and numeric awareness.
 */
export function sortRows<R>(rows: readonly R[], key: (row: R) => SortKey, dir: SortDir, locale: string): R[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const sign = dir === "asc" ? 1 : -1;
  const isMissing = (v: SortKey): v is null => v === null || (typeof v === "number" && Number.isNaN(v));
  return rows
    .map((row, index) => ({ row, index, value: key(row) }))
    .sort((a, b) => {
      const am = isMissing(a.value);
      const bm = isMissing(b.value);
      if (am || bm) return am === bm ? a.index - b.index : am ? 1 : -1;
      const av = a.value;
      const bv = b.value;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : collator.compare(String(av), String(bv));
      return cmp === 0 ? a.index - b.index : cmp * sign;
    })
    .map((entry) => entry.row);
}

/** Clicking a header: a new column starts at its preferred direction, the same column flips. */
export function nextSort(current: SortState | null, id: string, preferred: SortDir): SortState {
  if (current === null || current.id !== id) return { id, dir: preferred };
  return { id, dir: current.dir === "asc" ? "desc" : "asc" };
}

/** RFC 4180 field: quote when needed, double inner quotes; neutralise spreadsheet formulas (=, +, -, @). */
export function csvField(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export type CsvColumn<R> = { readonly header: string; readonly value: (row: R) => string | number | null };

/** A CSV document with a header row and CRLF line ends (what spreadsheet apps expect). */
export function toCsv<R>(columns: readonly CsvColumn<R>[], rows: readonly R[]): string {
  const lines = [columns.map((c) => csvField(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvField(c.value(row))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Stable sort with a comparator written in ascending sense; "desc" flips only the comparator, so ties keep the
 * input order in both directions (callers pre-order the input, e.g. by name, to get a tie-breaker).
 */
export function sortRowsWith<R>(rows: readonly R[], compare: (a: R, b: R) => number, dir: SortDir): R[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compare(a.row, b.row) * sign || a.index - b.index)
    .map((entry) => entry.row);
}

// ---- column picker ----

/**
 * The columns to show: fixed columns always, hideable ones when chosen. `chosen` null means "the defaults"
 * (every hideable column not marked hidden by default). Unknown ids in `chosen` are ignored.
 */
export function visibleColumnIds(
  columns: ReadonlyArray<{ readonly id: string; readonly hideable?: boolean; readonly defaultHidden?: boolean }>,
  chosen: ReadonlySet<string> | null,
): string[] {
  return columns.filter((c) => c.hideable !== true || (chosen === null ? c.defaultHidden !== true : chosen.has(c.id))).map((c) => c.id);
}

/** Parses a stored column choice (a JSON array of ids); anything else means "use the defaults" (null). */
export function parseColumnChoice(raw: string | null): Set<string> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : null;
  } catch {
    return null;
  }
}

// ---- selection ----

export type SelectionState = "none" | "some" | "all";

/** What the "select all" box shows for the selectable keys on screen. */
export function selectionState(selected: ReadonlySet<string>, keys: readonly string[]): SelectionState {
  const n = keys.filter((k) => selected.has(k)).length;
  return n === 0 ? "none" : n === keys.length ? "all" : "some";
}

/** Drops selected keys whose rows are gone (deleted, or no longer listed). Returns true when any were dropped. */
export function pruneSelection(selected: Set<string>, keys: Iterable<string>): boolean {
  const alive = new Set(keys);
  let changed = false;
  for (const k of [...selected]) {
    if (!alive.has(k)) {
      selected.delete(k);
      changed = true;
    }
  }
  return changed;
}

// ---- virtualization ----

export type VirtualWindow = { readonly start: number; readonly end: number; readonly padStart: number; readonly padEnd: number };

/**
 * Rows to render for a scroll position: [start, end) plus the spacer heights before and after, so the scrollbar
 * keeps the full list's size. `overscan` rows on each side keep fast scrolling from showing blanks.
 */
export function virtualWindow(opts: { total: number; rowHeight: number; scrollTop: number; viewport: number; overscan?: number }): VirtualWindow {
  const { total, rowHeight } = opts;
  const overscan = opts.overscan ?? 8;
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0, padStart: 0, padEnd: 0 };
  const first = Math.min(Math.floor(Math.max(0, opts.scrollTop) / rowHeight), total - 1);
  const visible = Math.ceil(Math.max(0, opts.viewport) / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + visible + overscan);
  return { start, end, padStart: start * rowHeight, padEnd: (total - end) * rowHeight };
}

// ---- keyed list sync ----

/** The few container operations the keyed sync needs (a DOM element fits; tests use a fake). */
export interface KeyedContainer<N> {
  childAt(index: number): N | null;
  insertBefore(node: N, ref: N | null): void;
  remove(node: N): void;
}
export type KeyedEntry<N> = { nodes: N[]; sig: string };
export type KeyedItem<N> = { readonly key: string; readonly sig: string; readonly build: () => N[] };

/**
 * Puts the items' nodes in order starting at child `from`, rebuilding only entries whose signature changed and
 * moving the rest. Unchanged rows keep their DOM nodes, so focus and scroll survive a 5 s poll.
 */
export function syncKeyed<N>(parent: KeyedContainer<N>, cache: Map<string, KeyedEntry<N>>, items: readonly KeyedItem<N>[], from = 0): void {
  const keep = new Set<string>();
  let i = from;
  for (const item of items) {
    keep.add(item.key);
    let entry = cache.get(item.key);
    if (!entry || entry.sig !== item.sig) {
      if (entry) for (const n of entry.nodes) parent.remove(n);
      entry = { nodes: item.build(), sig: item.sig };
      cache.set(item.key, entry);
    }
    for (const node of entry.nodes) {
      const at = parent.childAt(i);
      if (at !== node) parent.insertBefore(node, at);
      i += 1;
    }
  }
  for (const [key, entry] of cache) {
    if (keep.has(key)) continue;
    for (const n of entry.nodes) parent.remove(n);
    cache.delete(key);
  }
}
