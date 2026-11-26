// filterButton(): the shared filter pattern. A "Filter (n)" button opens an anchored, non-modal popover
// (popover() in lib/overlay.ts) with checkbox and radio groups and a Clear all; the badge counts the active
// choices. Filters never live in the global nav: pages put this button in their header or toolbar.
//
//   const filters = filterButton({
//     groups: [
//       { id: "difficulty", legend: "Difficulty", type: "checkbox", options: [{ value: "easy", label: "Easy" }] },
//       { id: "status", legend: "Status", type: "radio", options: [...], defaultValue: "all" },
//     ],
//     onChange: (value) => render(value), // value: Record<groupId, string[]>
//   });
//   header.append(filters.el);
//
// Keyboard: the button opens the panel and focus goes to the first checked (or first) option; Tab moves through
// the groups and Clear all; Escape or Tab past the end closes it and focus returns to the button.
import { TS } from "../i18n/strings-shell";
import { h, html, setChildren } from "../lib/dom";
import { popover } from "../lib/overlay";
import { ICONS } from "../shell/icons";

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterGroup {
  id: string;
  legend: string;
  /** checkbox: any number; radio: exactly one (its `defaultValue` does not count as active). */
  type: "checkbox" | "radio";
  options: readonly FilterOption[];
  /** Radio only: the "no filter" choice ("all"). Defaults to the first option. */
  defaultValue?: string;
}

/** The chosen values per group id (a radio group holds one value). */
export type FilterValue = Record<string, string[]>;

export interface FilterButtonOptions {
  groups: readonly FilterGroup[];
  /** Initial choices; missing groups start empty (checkbox) or at their default (radio). */
  value?: FilterValue;
  /** Button text before the count (default: "Filter"). */
  label?: string;
  onChange: (value: FilterValue) => void;
}

export interface FilterButtonHandle {
  /** The button and its panel, in DOM order (the panel follows the button for Tab). */
  el: HTMLElement;
  value: () => FilterValue;
  /** Replaces the choices (does not call onChange). */
  set: (value: FilterValue) => void;
  /** Clears every group (calls onChange). */
  clear: () => void;
  /** Number of active choices: checked checkboxes plus radios away from their default. */
  count: () => number;
}

let seq = 0;

export function filterButton(opts: FilterButtonOptions): FilterButtonHandle {
  const id = `flt-${++seq}`;
  const defaultOf = (g: FilterGroup): string => g.defaultValue ?? g.options[0]?.value ?? "";
  const normalise = (v: FilterValue | undefined): FilterValue => {
    const out: FilterValue = {};
    for (const g of opts.groups) {
      const chosen = (v?.[g.id] ?? []).filter((x) => g.options.some((o) => o.value === x));
      out[g.id] = g.type === "radio" ? [chosen[0] ?? defaultOf(g)] : chosen;
    }
    return out;
  };
  let value = normalise(opts.value);

  const count = (): number =>
    opts.groups.reduce((n, g) => n + (g.type === "radio" ? ((value[g.id]?.[0] ?? defaultOf(g)) === defaultOf(g) ? 0 : 1) : (value[g.id]?.length ?? 0)), 0);

  const text = h("span", { class: "filter-btn-text" });
  const badge = h("span", { class: "filter-badge", "aria-hidden": "true" });
  const button = h("button", { type: "button", class: "btn btn-sm filter-btn" }, html("span", { class: "icon", "aria-hidden": "true" }, ICONS.filter), text, badge);
  const body = h("div", { class: "filter-groups" });
  const clearBtn = h("button", { type: "button", class: "btn btn-sm btn-ghost filter-clear" });
  const title = h("h2", { class: "filter-title", id: `${id}-title` });
  const panel = h("div", { class: "filter-panel", role: "dialog", "aria-labelledby": `${id}-title` }, h("div", { class: "filter-head" }, title, clearBtn), body);

  const syncButton = (): void => {
    const n = count();
    text.textContent = opts.label ?? TS().filterButton;
    badge.textContent = String(n);
    badge.hidden = n === 0;
    button.setAttribute("aria-label", n === 0 ? (opts.label ?? TS().filterButton) : TS().filterButtonCount(n));
    button.classList.toggle("is-active", n > 0);
    clearBtn.disabled = n === 0;
  };

  const draw = (): void => {
    title.textContent = TS().filterPanel;
    clearBtn.textContent = TS().filterClearAll;
    setChildren(
      body,
      opts.groups.map((g) =>
        h(
          "fieldset",
          { class: "filter-group" },
          h("legend", { class: "filter-legend" }, g.legend),
          h(
            "div",
            { class: "filter-options" },
            g.options.map((o) =>
              h(
                "label",
                { class: "filter-option" },
                h("input", {
                  type: g.type,
                  name: `${id}-${g.id}`,
                  value: o.value,
                  checked: (value[g.id] ?? []).includes(o.value),
                  onchange: (ev) => {
                    const input = ev.currentTarget;
                    if (!(input instanceof HTMLInputElement)) return;
                    const cur = value[g.id] ?? [];
                    value = { ...value, [g.id]: g.type === "radio" ? [o.value] : input.checked ? [...cur, o.value] : cur.filter((x) => x !== o.value) };
                    syncButton();
                    opts.onChange(value);
                  },
                }),
                h("span", { dir: "auto" }, o.label),
              ),
            ),
          ),
        ),
      ),
    );
    syncButton();
  };

  const ctl = popover(button, panel, {
    align: "start",
    onOpen: () => (panel.querySelector<HTMLInputElement>("input:checked") ?? panel.querySelector<HTMLInputElement>("input"))?.focus(),
  });
  clearBtn.addEventListener("click", () => {
    handle.clear();
    panel.querySelector<HTMLInputElement>("input")?.focus();
  });
  window.addEventListener("hashchange", () => {
    if (!ctl.isOpen()) draw(); // re-label on language change
  });

  const handle: FilterButtonHandle = {
    el: h("div", { class: "filter-wrap" }, button, panel),
    value: () => value,
    set: (v) => {
      value = normalise(v);
      draw();
    },
    clear: () => {
      value = normalise({});
      draw();
      opts.onChange(value);
    },
    count,
  };
  draw();
  return handle;
}
