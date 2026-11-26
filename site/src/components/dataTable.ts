// DataTable: the one table for data pages (DESIGN.md "Data table"). Semantic <table> with column headers,
// optional row headers, sortable columns (aria-sort + a header button), numeric alignment, columns that hide on
// phones, a card layout on phones, and loading / empty / error states. Strings come from the caller.
//
// Opt-in extras for dashboards (the instructor's Accounts and Live tables):
// - keyed rows (`rowKey` + `rowSig`): unchanged rows keep their DOM nodes across updates, so focus survives polling;
// - expandable detail rows (`detail`), a column picker (`columnPicker`, hideable columns, remembered),
//   row selection with a select-all box (`selection`), CSV of the current view (`csv()` / `downloadCsv()`),
//   virtualization above `virtualize.threshold` rows, and caller-built cards below a media query (`cards`).
import { getLang } from "../i18n/i18n";
import { h, setChildren, type Attrs, type Child } from "../lib/dom";
import { popover } from "../lib/overlay";
import {
  nextSort,
  parseColumnChoice,
  pruneSelection,
  selectionState,
  sortRows,
  sortRowsWith,
  syncKeyed,
  toCsv,
  virtualWindow,
  visibleColumnIds,
  type CsvColumn,
  type KeyedContainer,
  type KeyedEntry,
  type SortDir,
  type SortKey,
  type SortState,
} from "./table-core";

export type Column<R> = {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: R) => Child;
  /** right-aligned (end-aligned in RTL), tabular figures, no wrapping */
  readonly numeric?: boolean;
  /** render the cell as <th scope="row"> (the row's name) */
  readonly rowHeader?: boolean;
  /** hidden below 640px unless the table stacks into cards */
  readonly optional?: boolean;
  /** extra class on the column's th and td */
  readonly className?: string;
  /** makes the column sortable */
  readonly sortValue?: (row: R) => SortKey;
  /** makes the column sortable with a comparator in ascending sense (multi-key sorts); wins over sortValue */
  readonly sortCompare?: (a: R, b: R) => number;
  /** first direction when this column is chosen (numbers usually start high) */
  readonly sortFirst?: SortDir;
  /** the column's value in a CSV export (columns without it are left out of the export) */
  readonly csv?: (row: R) => string | number | null;
  /** the column picker can hide it */
  readonly hideable?: boolean;
  /** hideable and off until chosen */
  readonly defaultHidden?: boolean;
  /** the header text is for screen readers only (an actions column) */
  readonly headerHidden?: boolean;
};

export type TableState =
  | { readonly kind: "ready" }
  | { readonly kind: "loading"; readonly label: string; readonly rows?: number }
  | { readonly kind: "error"; readonly message: string; readonly retry?: { readonly label: string; readonly run: () => void } };

export type DataTableOptions<R> = {
  readonly columns: readonly Column<R>[];
  readonly rows: readonly R[];
  /** attributes for each <tr> (class, data-*) */
  readonly rowAttrs?: (row: R) => Attrs;
  /** visible caption is up to the page: this one is for screen readers */
  readonly caption?: string;
  readonly labelledBy?: string;
  /** extra classes on the <table> (it always has "stats-table data-table") */
  readonly className?: string;
  /** extra classes on the scroll wrapper */
  readonly wrapClass?: string;
  /** names the scroll region so keyboard users can scroll a wide table (adds role=region + tabindex) */
  readonly regionLabel?: string;
  /** shown instead of the table when there are no rows and no extra rows */
  readonly empty?: Child;
  /** rows appended after the data rows (e.g. "you, not ranked yet"), not sorted */
  readonly extraRows?: Child;
  readonly initialSort?: SortState;
  /** each row becomes a card with labelled values below 640px */
  readonly stackOnPhone?: boolean;
  readonly state?: TableState;
  /** a stable id per row: rows are kept across updates (needed for selection) */
  readonly rowKey?: (row: R) => string;
  /** with rowKey: a row is rebuilt only when this changes (include everything the row shows) */
  readonly rowSig?: (row: R) => string;
  /** an expanded detail row under the row (null = collapsed) */
  readonly detail?: (row: R) => { readonly attrs?: Attrs; readonly content: Child } | null;
  /** a leading checkbox column and a select-all box in the header (needs rowKey) */
  readonly selection?: {
    readonly rowLabel: (row: R) => string;
    readonly allLabel: string;
    readonly disabled?: (row: R) => boolean;
    readonly onChange?: (keys: ReadonlySet<string>) => void;
  };
  /** a "Columns" button (see `pickerButton`) for the hideable columns, remembered under storageKey */
  readonly columnPicker?: {
    readonly label: string;
    readonly legend: string;
    readonly resetLabel: string;
    readonly storageKey?: string;
    /** the count next to the label, e.g. "(5 of 11)" */
    readonly countLabel?: (shown: number, total: number) => string;
  };
  /** render only the rows in view (fixed row height estimate) once there are more than `threshold` (200) */
  readonly virtualize?: { readonly rowHeight: number; readonly threshold?: number };
  /** below the media query the rows render as caller-built cards in a list (phones and tablets) */
  readonly cards?: { readonly query: string; readonly build: (row: R) => HTMLElement; readonly className?: string; readonly labelledBy?: string };
  readonly onSortChange?: (sort: SortState | null) => void;
  readonly onColumnsChange?: (visible: readonly string[]) => void;
};

export type DataTable<R> = {
  readonly element: HTMLElement;
  /** the column picker's button (with its popover panel), when `columnPicker` is set; place it in a toolbar */
  readonly pickerButton: HTMLElement | null;
  /** swap rows (and optionally extra rows) keeping the current sort */
  update(rows: readonly R[], extraRows?: Child): void;
  setState(state: TableState): void;
  setSort(sort: SortState | null): void;
  getSort(): SortState | null;
  /** the rows in display order */
  viewRows(): readonly R[];
  /** the row (or card) element for a key, when rendered */
  rowElement(key: string): HTMLElement | null;
  selected(): ReadonlySet<string>;
  clearSelection(): void;
  /** the current view (sorted rows, every column with a csv value) as a CSV document */
  csv(): string;
  downloadCsv(filename: string): void;
  /** rebuild every row (after a change the row signatures don't cover, e.g. the language) */
  refresh(): void;
  /** removes the media-query listener */
  destroy(): void;
};

const DEFAULT_VIRTUAL_THRESHOLD = 200;
let tableSeq = 0;

const cellClass = <R>(column: Column<R>): string | undefined =>
  [column.numeric ? "num" : "", column.optional ? "dt-opt" : "", column.className ?? ""].filter((c) => c !== "").join(" ") || undefined;

const isSortable = <R>(column: Column<R>): boolean => column.sortValue !== undefined || column.sortCompare !== undefined;

function readStored(key: string | undefined): string | null {
  if (key === undefined) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: defaults apply
  }
}
function writeStored(key: string | undefined, value: string | null): void {
  if (key === undefined) return;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

const domContainer = (el: Element): KeyedContainer<Element> => ({
  childAt: (i) => el.children[i] ?? null,
  insertBefore: (n, ref) => void el.insertBefore(n, ref),
  remove: (n) => n.remove(),
});

export function dataTable<R>(options: DataTableOptions<R>): DataTable<R> {
  const uid = `dt${++tableSeq}`;
  let rows = options.rows;
  let extraRows = options.extraRows;
  let sort: SortState | null = options.initialSort ?? null;
  let state: TableState = options.state ?? { kind: "ready" };
  const selected = new Set<string>();
  const keyed = options.rowKey !== undefined;
  const keyOf = (row: R, index: number): string => options.rowKey?.(row) ?? `#${index}`;

  const wrap = h("div", {
    class: ["table-wrap", "dt-wrap", options.wrapClass ?? ""].filter((c) => c !== "").join(" "),
    ...(options.regionLabel ? { role: "region", "aria-label": options.regionLabel, tabindex: "0" } : {}),
  });

  // ---- columns and the picker ----
  const hideable = options.columns.filter((c) => c.hideable === true);
  let chosen: Set<string> | null = options.columnPicker ? parseColumnChoice(readStored(options.columnPicker.storageKey)) : null;
  const visibleColumns = (): Column<R>[] => {
    const ids = new Set(visibleColumnIds(options.columns, chosen));
    return options.columns.filter((c) => ids.has(c.id));
  };
  let pickerButton: HTMLElement | null = null;
  if (options.columnPicker && hideable.length > 0) {
    const picker = options.columnPicker;
    const count = h("span", { class: "muted dt-picker-count" });
    const button = h("button", { type: "button", class: "btn btn-ghost btn-sm dt-picker-btn" }, picker.label, " ", count);
    const boxes = new Map<string, HTMLInputElement>();
    const syncPicker = (): void => {
      const shown = new Set(visibleColumns().map((c) => c.id));
      for (const [id, box] of boxes) box.checked = shown.has(id);
      count.textContent = picker.countLabel ? picker.countLabel(hideable.filter((c) => shown.has(c.id)).length, hideable.length) : "";
    };
    const applyChoice = (next: Set<string> | null): void => {
      chosen = next;
      writeStored(picker.storageKey, next === null ? null : JSON.stringify([...next]));
      syncPicker();
      options.onColumnsChange?.(visibleColumns().map((c) => c.id));
      rebuild();
    };
    const panel = h(
      "div",
      { class: "dt-picker", role: "dialog", "aria-label": picker.legend },
      h(
        "fieldset",
        { class: "dt-picker-set" },
        h("legend", { class: "dt-picker-legend" }, picker.legend),
        hideable.map((c) => {
          const box = h("input", { type: "checkbox", id: `${uid}-col-${c.id}`, "data-col": c.id });
          boxes.set(c.id, box);
          box.addEventListener("change", () => {
            const next = new Set(visibleColumns().filter((v) => v.hideable === true).map((v) => v.id));
            if (box.checked) next.add(c.id);
            else next.delete(c.id);
            applyChoice(next);
          });
          return h("label", { class: "dt-check", for: box.id }, box, h("span", {}, c.header));
        }),
      ),
      h("button", { type: "button", class: "btn btn-ghost btn-sm dt-picker-reset", onclick: () => applyChoice(null) }, picker.resetLabel),
    );
    popover(button, panel, { align: "end", onOpen: () => panel.querySelector<HTMLInputElement>("input")?.focus() });
    pickerButton = h("span", { class: "dt-picker-wrap" }, button, panel);
    syncPicker();
  }

  // ---- cards below a media query ----
  const cardsMq = options.cards ? window.matchMedia(options.cards.query) : null;
  const onCardsChange = (): void => rebuild();
  cardsMq?.addEventListener("change", onCardsChange);
  const cardMode = (): boolean => cardsMq?.matches === true;

  // ---- sorting ----
  const sortedRows = (): readonly R[] => {
    if (sort === null) return rows;
    const active = sort;
    const column = options.columns.find((c) => c.id === active.id);
    if (column?.sortCompare) return sortRowsWith(rows, column.sortCompare, active.dir);
    return column?.sortValue ? sortRows(rows, column.sortValue, active.dir, getLang() === "he" ? "he" : "en") : rows;
  };
  let view: readonly R[] = rows;

  // ---- selection ----
  const selBoxes = new Map<string, HTMLInputElement>();
  let allBox: HTMLInputElement | null = null;
  const selectableKeys = (): string[] =>
    view.flatMap((row, i) => (options.selection?.disabled?.(row) === true ? [] : [keyOf(row, i)]));
  const syncSelection = (): void => {
    if (!options.selection) return;
    for (const [key, box] of selBoxes) {
      if (!box.isConnected) {
        selBoxes.delete(key);
        continue;
      }
      box.checked = selected.has(key);
      box.closest("tr, li")?.classList.toggle("is-selected", box.checked);
    }
    if (allBox) {
      const st = selectionState(selected, selectableKeys());
      allBox.checked = st === "all";
      allBox.indeterminate = st === "some";
      allBox.disabled = selectableKeys().length === 0;
    }
  };
  const changed = (): void => {
    syncSelection();
    options.selection?.onChange?.(new Set(selected));
  };
  const selectBox = (row: R, key: string): HTMLInputElement => {
    const sel = options.selection;
    const box = h("input", {
      type: "checkbox",
      class: "dt-select-box",
      "aria-label": sel?.rowLabel(row) ?? key,
      disabled: sel?.disabled?.(row) === true,
      "data-key": key,
    });
    box.checked = selected.has(key);
    box.addEventListener("change", () => {
      if (box.checked) selected.add(key);
      else selected.delete(key);
      changed();
    });
    selBoxes.set(key, box);
    return box;
  };

  // ---- table structure (built once per column set; rows synced by key) ----
  let table: HTMLTableElement | null = null;
  let thead: HTMLTableSectionElement | null = null;
  let tbody: HTMLTableSectionElement | null = null;
  let cardList: HTMLUListElement | null = null;
  let headSig = "";
  let colSig = "";
  const rowCache = new Map<string, KeyedEntry<Element>>();
  const cardCache = new Map<string, KeyedEntry<Element>>();
  const spacerTop = h("tr", { class: "dt-spacer", "aria-hidden": "true" });
  const spacerBottom = h("tr", { class: "dt-spacer", "aria-hidden": "true" });
  let extraNodes: Node[] = [];
  let virtual = false;

  const headerCell = (column: Column<R>): HTMLElement => {
    const sortable = isSortable(column);
    const active = sort !== null && sort.id === column.id;
    const ariaSort = active && sort !== null ? (sort.dir === "asc" ? "ascending" : "descending") : sortable ? "none" : undefined;
    const label: Child = column.headerHidden ? h("span", { class: "visually-hidden" }, column.header) : column.header;
    const content: Child = sortable
      ? h(
          "button",
          {
            type: "button",
            class: "dt-sort",
            onclick: () => {
              sort = nextSort(sort, column.id, column.sortFirst ?? "asc");
              options.onSortChange?.(sort);
              render();
              wrap.querySelector<HTMLButtonElement>(`th[data-col="${CSS.escape(column.id)}"] .dt-sort`)?.focus();
            },
          },
          label,
          h("span", { class: "dt-sort-icon", "aria-hidden": "true" }, active && sort !== null ? (sort.dir === "asc" ? "▲" : "▼") : "↕"),
        )
      : label;
    return h("th", { scope: "col", class: cellClass(column), "data-col": column.id, "aria-sort": ariaSort }, content);
  };

  const renderHead = (cols: readonly Column<R>[]): void => {
    if (!thead) return;
    const sig = JSON.stringify([cols.map((c) => c.id), sort, getLang()]);
    if (sig === headSig) return;
    headSig = sig;
    allBox = options.selection ? makeAllBox(options.selection.allLabel) : null;
    const selectHead = allBox ? h("th", { scope: "col", class: "dt-select" }, allBox) : null;
    setChildren(thead, h("tr", {}, selectHead, cols.map(headerCell)));
  };

  /** The select-all box: in the header (table) or above the list (cards). */
  function makeAllBox(label: string): HTMLInputElement {
    const box = h("input", { type: "checkbox", class: "dt-select-box dt-select-all", "aria-label": label });
    box.addEventListener("change", () => {
      const keys = selectableKeys();
      if (box.checked) for (const k of keys) selected.add(k);
      else for (const k of keys) selected.delete(k);
      changed();
    });
    return box;
  }

  const buildRow = (row: R, key: string, cols: readonly Column<R>[]): Element[] => {
    const tr = h(
      "tr",
      { ...(options.rowAttrs?.(row) ?? {}), "data-key": keyed ? key : undefined },
      options.selection ? h("td", { class: "dt-select" }, selectBox(row, key)) : null,
      cols.map((column) =>
        column.rowHeader
          ? h("th", { scope: "row", class: cellClass(column) }, column.cell(row))
          : h("td", { class: cellClass(column), "data-label": column.header }, column.cell(row)),
      ),
    );
    const detail = options.detail?.(row) ?? null;
    if (detail === null) return [tr];
    const span = cols.length + (options.selection ? 1 : 0);
    const extra = detail.attrs ?? {};
    const detailRow = h(
      "tr",
      { ...extra, class: ["dt-detail", typeof extra.class === "string" ? extra.class : ""].filter((c) => c !== "").join(" ") },
      h("td", { colspan: span }, detail.content),
    );
    return [tr, detailRow];
  };

  const buildCard = (row: R, key: string): Element[] => {
    const card = options.cards?.build(row) ?? h("li", {});
    if (keyed) card.setAttribute("data-key", key);
    if (options.selection) card.prepend(h("span", { class: "dt-card-select" }, selectBox(row, key)));
    return [card];
  };

  const itemSig = (row: R, index: number): string => (keyed && options.rowSig ? `${colSig}|${options.rowSig(row)}` : `${colSig}|${Math.random()}#${index}`);

  const renderBody = (): void => {
    if (!table || !tbody) return;
    const cols = visibleColumns();
    const total = view.length;
    const threshold = options.virtualize?.threshold ?? DEFAULT_VIRTUAL_THRESHOLD;
    virtual = options.virtualize !== undefined && total > threshold;
    wrap.classList.toggle("dt-virtual", virtual);
    let start = 0;
    let end = total;
    if (virtual && options.virtualize) {
      const win = virtualWindow({ total, rowHeight: options.virtualize.rowHeight, scrollTop: wrap.scrollTop, viewport: wrap.clientHeight || 600 });
      start = win.start;
      end = win.end;
      const span = cols.length + (options.selection ? 1 : 0);
      setChildren(spacerTop, h("td", { colspan: span, style: `block-size:${win.padStart}px;padding:0;border:0` }));
      setChildren(spacerBottom, h("td", { colspan: span, style: `block-size:${win.padEnd}px;padding:0;border:0` }));
      if (tbody.firstElementChild !== spacerTop) tbody.prepend(spacerTop);
      table.setAttribute("aria-rowcount", String(total + 1));
    } else {
      spacerTop.remove();
      spacerBottom.remove();
      table.removeAttribute("aria-rowcount");
    }
    const slice = view.slice(start, end);
    syncKeyed(
      domContainer(tbody),
      rowCache,
      slice.map((row, i) => {
        const key = keyOf(row, start + i);
        return { key, sig: itemSig(row, start + i), build: () => buildRow(row, key, cols) };
      }),
      virtual ? 1 : 0,
    );
    if (virtual) {
      slice.forEach((row, i) => rowCache.get(keyOf(row, start + i))?.nodes[0]?.setAttribute("aria-rowindex", String(start + i + 2)));
      tbody.append(spacerBottom);
    }
    for (const n of extraNodes) n.parentNode?.removeChild(n);
    const holder = h("tbody", {}, extraRows);
    extraNodes = [...holder.childNodes];
    for (const n of extraNodes) tbody.append(n);
  };

  const renderCards = (): void => {
    const cards = options.cards;
    if (!cards) return;
    if (!cardList || cardList.parentNode !== wrap) {
      cardList = h("ul", { class: ["dt-cards", cards.className ?? ""].filter((c) => c !== "").join(" "), "aria-labelledby": cards.labelledBy ?? options.labelledBy });
      cardCache.clear();
      // Cards have no header row: the select-all box sits above the list, with a visible label.
      allBox = options.selection ? makeAllBox(options.selection.allLabel) : null;
      const allRow = allBox && options.selection ? h("label", { class: "dt-check dt-cards-all" }, allBox, h("span", { "aria-hidden": "true" }, options.selection.allLabel)) : null;
      setChildren(wrap, allRow, cardList);
    }
    syncKeyed(
      domContainer(cardList),
      cardCache,
      view.map((row, i) => {
        const key = keyOf(row, i);
        return { key, sig: itemSig(row, i), build: () => buildCard(row, key) };
      }),
    );
  };

  const ensureTable = (cols: readonly Column<R>[]): void => {
    const sig = JSON.stringify(cols.map((c) => c.id));
    if (table && table.parentNode === wrap && sig === colSig) return;
    colSig = sig;
    headSig = "";
    rowCache.clear();
    extraNodes = [];
    const tableClass = ["stats-table", "data-table", options.stackOnPhone ? "dt-stack" : "", options.className ?? ""].filter((c) => c !== "").join(" ");
    thead = h("thead", {});
    tbody = h("tbody", {});
    table = h("table", { class: tableClass, "aria-labelledby": options.labelledBy }, options.caption ? h("caption", { class: "visually-hidden" }, options.caption) : null, thead, tbody);
    setChildren(wrap, table);
  };

  function render(): void {
    if (state.kind === "error") {
      const retry = state.retry;
      table = null;
      cardList = null;
      setChildren(
        wrap,
        h("div", { class: "dt-message", role: "alert" }, h("p", {}, state.message), retry ? h("button", { type: "button", class: "btn btn-sm", onclick: retry.run }, retry.label) : null),
      );
      wrap.setAttribute("aria-busy", "false");
      return;
    }
    if (state.kind === "loading") {
      const count = state.rows ?? 5;
      table = null;
      cardList = null;
      setChildren(
        wrap,
        h("p", { class: "visually-hidden", role: "status" }, state.label),
        h(
          "table",
          { class: "stats-table data-table is-loading", "aria-hidden": "true" },
          h("tbody", {}, Array.from({ length: count }, () => h("tr", {}, visibleColumns().map((c) => h("td", { class: cellClass(c) }, h("span", { class: "dt-skeleton" })))))),
        ),
      );
      wrap.setAttribute("aria-busy", "true");
      return;
    }
    wrap.setAttribute("aria-busy", "false");
    view = sortedRows();
    if (keyed && options.selection && pruneSelection(selected, view.map((r, i) => keyOf(r, i)))) options.selection.onChange?.(new Set(selected));
    const hasExtra = extraRows !== undefined && extraRows !== null && extraRows !== false;
    if (rows.length === 0 && !hasExtra && options.empty !== undefined) {
      wrap.classList.add("is-empty");
      table = null;
      cardList = null;
      setChildren(wrap, h("div", { class: "dt-message" }, options.empty));
      return;
    }
    wrap.classList.remove("is-empty");
    if (cardMode()) {
      table = null;
      wrap.classList.add("dt-wrap-cards");
      wrap.classList.remove("dt-virtual");
      renderCards();
    } else {
      wrap.classList.remove("dt-wrap-cards");
      cardList = null;
      const cols = visibleColumns();
      ensureTable(cols);
      renderHead(cols);
      renderBody();
    }
    syncSelection();
  }

  function rebuild(): void {
    rowCache.clear();
    cardCache.clear();
    table = null;
    cardList = null;
    render();
  }

  // Virtualized: re-render the window as the wrapper scrolls (one frame at a time).
  let scrollFrame = 0;
  wrap.addEventListener("scroll", () => {
    if (!virtual || scrollFrame !== 0) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      renderBody();
      syncSelection();
    });
  });

  const csvColumns = (): CsvColumn<R>[] =>
    options.columns.flatMap((c) => (c.csv ? [{ header: c.header, value: c.csv }] : []));

  render();
  return {
    element: wrap,
    pickerButton,
    update(next, nextExtra) {
      rows = next;
      extraRows = nextExtra;
      render();
    },
    setState(next) {
      state = next;
      render();
    },
    setSort(next) {
      if (JSON.stringify(next) === JSON.stringify(sort)) return;
      sort = next;
      render();
    },
    getSort: () => sort,
    viewRows: () => view,
    rowElement(key) {
      const entry = (cardMode() ? cardCache : rowCache).get(key);
      const el = entry?.nodes[0];
      return el instanceof HTMLElement && el.isConnected ? el : null;
    },
    selected: () => selected,
    clearSelection() {
      if (selected.size === 0) return;
      selected.clear();
      changed();
    },
    csv: () => toCsv(csvColumns(), view),
    downloadCsv(filename) {
      const blob = new Blob(["﻿", toCsv(csvColumns(), view)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: filename, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
    refresh: rebuild,
    destroy() {
      cardsMq?.removeEventListener("change", onCardsChange);
    },
  };
}
