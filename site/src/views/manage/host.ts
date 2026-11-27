// What a manage panel gets from the dashboard that mounts it (the admin dashboard today, a class dashboard
// later): the root element, the poll, error handling, confirms and row menus (lib/overlay.ts), and the KPI tiles
// that fold on phones. Panels never reach for module globals: everything scoped to one dashboard comes from here
// or from the panel's own options.
import { T } from "../../i18n/strings-tools";
import { h } from "../../lib/dom";
import { confirm, menu, type ConfirmOptions, type MenuItem } from "../../lib/overlay";
import type { SortState } from "../../components/table-core";
import { errMessage, readPref, writePref } from "./format";

/** Below this width the grids render as cards and the header chrome compacts (phones and tablets). */
export const NARROW_QUERY = "(max-width: 900px)";
const TILES_STORAGE = "il.adminTilesOpen";

/** A value the dashboard owns and a panel may read and replace (for example the account list after an edit). */
export type Slot<T> = { get(): T; set(value: T): void };

/** A confirm: the title names the target and the action, and only destructive actions are red. */
export type ConfirmRequest = Omit<ConfirmOptions, "tone"> & { tone: "danger" | "primary" };

/** KPI tiles wrapped in a fold toggle; the one-line summary shows while folded. */
export type FoldTiles = HTMLElement & { _summary?: HTMLElement };

export type ManageHost = {
  /** The dashboard root: row menus and toggles find their trigger again in it after a re-render. */
  readonly container: HTMLElement;
  /** True once the dashboard was torn down: late responses must not render. */
  disposed(): boolean;
  /** Phone/tablet layout (cards instead of grids). */
  narrow(): boolean;
  /** Fetch the dashboard's data again now. */
  refresh(): void;
  /** 401 / 503 send the user back to sign-in. Returns true when handled. */
  handleAuthError(err: unknown): boolean;
  /** A failed action: the dashboard's banner (or sign-in for an auth error). */
  showActionError(err: unknown): void;
  /** Sets (or, with null, hides) the dashboard's status banner. */
  setBanner(text: string | null): void;
  askConfirm(opts: ConfirmRequest): Promise<boolean>;
  /** The "⋯" button that opens a row's actions menu; `key` finds it again after a re-render (focus return). */
  menuButton(label: string, key: string, items: () => readonly MenuItem[], text?: string): HTMLButtonElement;
  menuTriggerEl(key: string): HTMLElement | null;
  /** KPI tiles that fold into a one-line summary on phones and tablets (remembered). */
  foldableTiles(tilesEl: HTMLElement): FoldTiles;
  /** Re-render while keeping keyboard focus on the same control (by id: selects are rebuilt). */
  withFocusKept(render: () => void): void;
  /** The sticky save bar of an editor opened or closed: leave room for it when focus scrolls into view. */
  syncSaveBar(): void;
};

export type ManageHostDeps = Pick<ManageHost, "container" | "disposed" | "narrow" | "refresh" | "handleAuthError" | "setBanner" | "syncSaveBar">;

export function createManageHost(deps: ManageHostDeps): ManageHost {
  const { container } = deps;
  /** The KPI tiles on phones/tablets: collapsed to a one-line summary unless opened (remembered). */
  let tilesOpen = readPref(TILES_STORAGE) === "1";

  function showActionError(err: unknown): void {
    if (deps.handleAuthError(err)) return;
    deps.setBanner(T().admActionFailed(errMessage(err)));
  }

  // The title names the target and the action, the button repeats it ("Delete dana_k"), focus starts on the
  // safe choice, and only destructive actions are red. An action that fails closes the dialog and shows the
  // banner.
  function askConfirm(opts: ConfirmRequest): Promise<boolean> {
    return confirm({ ...opts, tone: opts.tone === "danger" ? "danger" : "default", cancelLabel: opts.cancelLabel ?? T().admCancel }).catch(
      (err: unknown) => {
        showActionError(err);
        return false;
      },
    );
  }

  const menuTriggerEl = (key: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-menu="${CSS.escape(key)}"]`);

  function menuButton(label: string, key: string, items: () => readonly MenuItem[], text?: string): HTMLButtonElement {
    const btn = h(
      "button",
      {
        type: "button",
        class: `btn btn-ghost btn-sm row-menu-btn${text ? "" : " is-icon"}`,
        "aria-label": label,
        title: label,
        "data-menu": key,
      },
      text ? h("span", {}, text) : null,
      h("span", { class: "row-menu-dots", "aria-hidden": "true" }, "⋯"),
    );
    menu(btn, items, { label });
    return btn;
  }

  function foldableTiles(tilesEl: HTMLElement): FoldTiles {
    const summary = h("span", { class: "tiles-summary" });
    const toggle = h(
      "button",
      { type: "button", class: "tiles-toggle", "aria-expanded": String(tilesOpen), "aria-controls": tilesEl.id },
      h("span", { class: "acct-caret", "aria-hidden": "true" }, "▸"),
      summary,
    );
    const wrap: FoldTiles = h("div", { class: `tiles-fold${tilesOpen ? "" : " is-folded"}` }, toggle, tilesEl);
    wrap._summary = summary;
    toggle.addEventListener("click", () => {
      tilesOpen = !tilesOpen;
      writePref(TILES_STORAGE, tilesOpen ? "1" : "0");
      for (const w of container.querySelectorAll<HTMLElement>(".tiles-fold")) {
        w.classList.toggle("is-folded", !tilesOpen);
        w.querySelector(".tiles-toggle")?.setAttribute("aria-expanded", String(tilesOpen));
      }
    });
    return wrap;
  }

  function withFocusKept(render: () => void): void {
    const active = document.activeElement;
    const id = active instanceof HTMLElement && container.contains(active) ? active.id : "";
    render();
    if (id) document.getElementById(id)?.focus();
  }

  return { ...deps, showActionError, askConfirm, menuButton, menuTriggerEl, foldableTiles, withFocusKept };
}

export function setTilesSummary(wrap: FoldTiles, text: string): void {
  if (wrap._summary) wrap._summary.textContent = text;
}

/** Shows the select option that matches a header sort, or "by column" for any other column. */
export function syncSortSelect<K extends string>(select: HTMLSelectElement, sorts: Record<K, SortState>, s: SortState | null): void {
  const match = (Object.keys(sorts) as K[]).find((k) => s !== null && sorts[k].id === s.id && sorts[k].dir === s.dir);
  select.value = match ?? "custom";
}
