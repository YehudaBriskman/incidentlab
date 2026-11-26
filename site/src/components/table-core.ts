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
