// Stat tiles (DESIGN.md "Stat tile"): a label, one big value with an optional unit, then context lines that
// give the number meaning (vs median, vs par). A grid lays them out; a tile can also show a loading skeleton.
import { h, type Child } from "../lib/dom";

export type StatTile = {
  readonly label: string;
  readonly value: Child;
  readonly unit?: string | null;
  /** context lines; nulls are skipped so callers can pass conditionals inline */
  readonly subs?: ReadonlyArray<string | null>;
  /** "up" or "down" colours the first sub line as a change */
  readonly trend?: "up" | "down" | null;
  readonly className?: string;
};

export function statTile(tile: StatTile): HTMLElement {
  const subs = (tile.subs ?? []).filter((s): s is string => s !== null);
  return h(
    "div",
    { class: ["stat-tile", "kpi", tile.className ?? ""].filter((c) => c !== "").join(" ") },
    h("p", { class: "stat-label" }, tile.label),
    h("p", { class: "stat-value-row" }, h("span", { class: "stat-value" }, tile.value), tile.unit ? h("span", { class: "stat-unit" }, tile.unit) : null),
    subs.map((s, i) => h("p", { class: `stat-sub muted small${i === 0 && tile.trend ? ` is-${tile.trend}` : ""}` }, s)),
  );
}

/** A skeleton tile with the same footprint as a real one, so the grid doesn't jump when data arrives. */
export function statTileSkeleton(label: string): HTMLElement {
  return h(
    "div",
    { class: "stat-tile kpi is-loading", "aria-hidden": "true" },
    h("p", { class: "stat-label" }, label),
    h("p", { class: "stat-value-row" }, h("span", { class: "dt-skeleton stat-skeleton" })),
  );
}

export function statGrid(tiles: readonly HTMLElement[], className = "kpi-grid"): HTMLElement {
  return h("div", { class: className }, tiles);
}
