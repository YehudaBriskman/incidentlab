// Small DOM helpers shared by the manage panels: tooltipped values, headings with a help tooltip, KPI tiles
// and table header cells. Everything is built with h(); tooltips come from lib/overlay.ts.
import { h } from "../../lib/dom";
import { tooltip } from "../../lib/overlay";
import { statTile } from "../../components/statGrid";

/** Puts a secondary detail (a full timestamp) into the shared tooltip instead of on screen. The trigger takes
 * keyboard focus, which opens the tooltip too, and carries the detail as visually hidden text so screen readers
 * get the full value whether or not the tooltip is open (#114). */
export function tipped<E extends HTMLElement>(el: E, detail: string): E {
  el.tabIndex = 0;
  el.classList.add("admin-tipped");
  el.append(h("span", { class: "visually-hidden" }, `, ${detail}`));
  tooltip(el, detail);
  return el;
}

/** A section heading with its help text in a tooltip on an "i" button. The paragraph stays for touch screens,
 * where hover tooltips don't open (admin.css shows one or the other). */
export function headWithHint(heading: HTMLElement, hint: string): HTMLElement {
  const btn = h("button", { type: "button", class: "admin-info", "aria-label": hint }, "i");
  tooltip(btn, hint);
  return h("div", { class: "admin-h2-row" }, heading, btn);
}

/** A KPI tile (components/statGrid.ts): label, value, one context line. */
export function tile(label: string, value: string, sub?: string): HTMLElement {
  return statTile({ label, value, subs: [sub ?? null], className: "admin-tile" });
}

export function th(label: string, cls?: string): HTMLTableCellElement {
  return h("th", { scope: "col", class: cls }, label);
}
