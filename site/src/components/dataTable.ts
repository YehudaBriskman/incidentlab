// DataTable: the one table for data pages (DESIGN.md "Data table"). Semantic <table> with column headers,
// optional row headers, sortable columns (aria-sort + a header button), numeric alignment, columns that hide on
// phones, a card layout on phones, and loading / empty / error states. Strings come from the caller.
import { getLang } from "../i18n/i18n";
import { h, setChildren, type Attrs, type Child } from "../lib/dom";
import { nextSort, sortRows, type SortDir, type SortKey, type SortState } from "./table-core";

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
  /** first direction when this column is chosen (numbers usually start high) */
  readonly sortFirst?: SortDir;
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
};

export type DataTable<R> = {
  readonly element: HTMLElement;
  /** swap rows (and optionally extra rows) keeping the current sort */
  update(rows: readonly R[], extraRows?: Child): void;
  setState(state: TableState): void;
};

const cellClass = <R>(column: Column<R>): string | undefined =>
  [column.numeric ? "num" : "", column.optional ? "dt-opt" : "", column.className ?? ""].filter((c) => c !== "").join(" ") || undefined;

export function dataTable<R>(options: DataTableOptions<R>): DataTable<R> {
  let rows = options.rows;
  let extraRows = options.extraRows;
  let sort: SortState | null = options.initialSort ?? null;
  let state: TableState = options.state ?? { kind: "ready" };

  const wrap = h("div", {
    class: ["table-wrap", "dt-wrap", options.wrapClass ?? ""].filter((c) => c !== "").join(" "),
    ...(options.regionLabel ? { role: "region", "aria-label": options.regionLabel, tabindex: "0" } : {}),
  });

  const sortedRows = (): readonly R[] => {
    if (sort === null) return rows;
    const active = sort;
    const column = options.columns.find((c) => c.id === active.id);
    return column?.sortValue ? sortRows(rows, column.sortValue, active.dir, getLang() === "he" ? "he" : "en") : rows;
  };

  const headerCell = (column: Column<R>): HTMLElement => {
    const sortable = column.sortValue !== undefined;
    const active = sort !== null && sort.id === column.id;
    const ariaSort = active && sort !== null ? (sort.dir === "asc" ? "ascending" : "descending") : sortable ? "none" : undefined;
    const content: Child = sortable
      ? h(
          "button",
          {
            type: "button",
            class: "dt-sort",
            onclick: () => {
              sort = nextSort(sort, column.id, column.sortFirst ?? "asc");
              render();
              wrap.querySelector<HTMLButtonElement>(`th[data-col="${CSS.escape(column.id)}"] .dt-sort`)?.focus();
            },
          },
          column.header,
          h("span", { class: "dt-sort-icon", "aria-hidden": "true" }, active && sort !== null ? (sort.dir === "asc" ? "▲" : "▼") : "↕"),
        )
      : column.header;
    return h("th", { scope: "col", class: cellClass(column), "data-col": column.id, "aria-sort": ariaSort }, content);
  };

  const bodyRow = (row: R): HTMLElement =>
    h(
      "tr",
      options.rowAttrs?.(row) ?? {},
      options.columns.map((column) =>
        column.rowHeader
          ? h("th", { scope: "row", class: cellClass(column) }, column.cell(row))
          : h("td", { class: cellClass(column), "data-label": column.header }, column.cell(row)),
      ),
    );

  const render = (): void => {
    if (state.kind === "error") {
      const retry = state.retry;
      setChildren(
        wrap,
        h("div", { class: "dt-message", role: "alert" }, h("p", {}, state.message), retry ? h("button", { type: "button", class: "btn btn-sm", onclick: retry.run }, retry.label) : null),
      );
      wrap.setAttribute("aria-busy", "false");
      return;
    }
    if (state.kind === "loading") {
      const count = state.rows ?? 5;
      setChildren(
        wrap,
        h("p", { class: "visually-hidden", role: "status" }, state.label),
        h(
          "table",
          { class: "stats-table data-table is-loading", "aria-hidden": "true" },
          h("tbody", {}, Array.from({ length: count }, () => h("tr", {}, options.columns.map((c) => h("td", { class: cellClass(c) }, h("span", { class: "dt-skeleton" })))))),
        ),
      );
      wrap.setAttribute("aria-busy", "true");
      return;
    }
    wrap.setAttribute("aria-busy", "false");
    const hasExtra = extraRows !== undefined && extraRows !== null && extraRows !== false;
    if (rows.length === 0 && !hasExtra && options.empty !== undefined) {
      wrap.classList.add("is-empty");
      setChildren(wrap, h("div", { class: "dt-message" }, options.empty));
      return;
    }
    wrap.classList.remove("is-empty");
    const tableClass = ["stats-table", "data-table", options.stackOnPhone ? "dt-stack" : "", options.className ?? ""].filter((c) => c !== "").join(" ");
    setChildren(
      wrap,
      h(
        "table",
        { class: tableClass, "aria-labelledby": options.labelledBy },
        options.caption ? h("caption", { class: "visually-hidden" }, options.caption) : null,
        h("thead", {}, h("tr", {}, options.columns.map(headerCell))),
        h("tbody", {}, sortedRows().map(bodyRow), extraRows),
      ),
    );
  };

  render();
  return {
    element: wrap,
    update(next, nextExtra) {
      rows = next;
      extraRows = nextExtra;
      render();
    },
    setState(next) {
      state = next;
      render();
    },
  };
}
