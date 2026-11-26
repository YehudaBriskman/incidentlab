// Shared overlay primitives (#61): dialogs, confirms, sheets, anchored popovers, menus, toasts and banners.
// Every view uses these instead of building its own <dialog>, popover or toast. Rules shared by all of them:
// - modals (dialog, confirm, sheet) use the native <dialog> with showModal(): the rest of the page is inert,
//   Tab is trapped explicitly (so it never escapes into the browser chrome), Escape closes, page scroll is
//   locked, and focus goes back to the element that opened them;
// - popovers and menus use the Popover API (top layer, light dismiss) and return focus to their anchor;
// - enter and exit transitions live in styles.css and are dropped for prefers-reduced-motion and
//   [data-motion=reduce]; placement is mirrored for RTL here, and the CSS uses logical properties;
// - layering: the top layer orders modals and popovers by open order; the --z-* tokens order everything
//   that stays in the page (sidebar, sheet fallback, popover fallback, toast host).
// The DOM-free rules (focus wrap, menu keys, typeahead, placement, modal stack, toast queue) are in overlay-logic.ts.
import { appendChildren, h, type Child } from "./dom";
import { TV } from "../i18n/strings-overlay";
import { menuKeyTarget, ModalStack, placeAnchored, ToastQueue, trapTarget, typeaheadMatch } from "./overlay-logic";

const supportsPopover = (): boolean => typeof HTMLElement.prototype.showPopover === "function";
const isRtl = (): boolean => document.documentElement.dir === "rtl";
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${++seq}`;

/* ---------- focus helpers ---------- */

const FOCUSABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';

/** Elements Tab can reach inside `root`, in DOM order (one radio per group, like the browser). */
export function tabbables(root: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = [];
  const radioGroups = new Set<string>();
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el.tabIndex < 0 || el.closest("[inert]") !== null || el.getClientRects().length === 0) continue;
    if ((el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) && el.disabled) continue;
    if (el instanceof HTMLInputElement && el.type === "radio" && el.name !== "") {
      const checked = root.querySelector<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`);
      if (checked !== null ? checked !== el : radioGroups.has(el.name)) continue;
      radioGroups.add(el.name);
    }
    out.push(el);
  }
  return out;
}

/** Keeps Tab and Shift+Tab inside `root`. Call from a keydown listener. */
function trapTab(root: HTMLElement, ev: KeyboardEvent): void {
  if (ev.key !== "Tab") return;
  const list = tabbables(root);
  const active = document.activeElement;
  const index = active instanceof HTMLElement ? list.indexOf(active) : -1;
  const target = trapTarget(index, list.length, ev.shiftKey);
  if (list.length === 0) {
    ev.preventDefault();
    root.focus();
    return;
  }
  if (target === null) return;
  ev.preventDefault();
  list[target]?.focus();
}

/** Focus `target` if it is still on the page, else the main region (never leave focus on <body>). */
function restoreFocus(target: HTMLElement | null): void {
  const el = target !== null && target.isConnected ? target : document.getElementById("app");
  el?.focus({ preventScroll: target === null || !target.isConnected });
}

/** Removes `el` once its exit transition has finished (at once when there is none, e.g. reduced motion). */
function removeAfterExit(el: HTMLElement): void {
  const done = (): void => el.remove();
  const anims = el.getAnimations({ subtree: true });
  if (anims.length === 0) return done();
  const timer = window.setTimeout(done, 1000);
  void Promise.allSettled(anims.map((a) => a.finished)).then(() => {
    window.clearTimeout(timer);
    done();
  });
}

/* ---------- modal stack and scroll lock ---------- */

type ModalEntry = { el: HTMLDialogElement; opener: HTMLElement | null; dismiss: () => void };
const modals = new ModalStack<ModalEntry>();

function syncScrollLock(): void {
  // A class, not inline styles: the CSS keeps the scrollbar gutter so the page does not shift sideways.
  document.documentElement.classList.toggle("has-modal", modals.size > 0);
}

/** Closes every open modal and menu (the router calls this on navigation). Toasts and banners stay. */
export function closeOverlays(): void {
  closeMenu();
  for (const entry of [...modals.all()].reverse()) entry.dismiss();
}

/* ---------- dialog ---------- */

export type DialogSize = "sm" | "md" | "lg" | "full";
export type ActionTone = "primary" | "danger" | "ghost";

export interface DialogAction<R extends string> {
  value: R;
  label: string;
  tone?: ActionTone;
  /** Gets focus when the dialog opens (the safe choice for a confirm). */
  autofocus?: boolean;
  disabled?: boolean;
  /**
   * Work to finish before the dialog closes with this value. While it runs every action is disabled, this
   * button shows `busyLabel`, and Escape does nothing. A rejection closes the dialog and rejects `result`.
   */
  run?: () => Promise<void>;
  busyLabel?: string;
}

export interface DialogOptions<R extends string> {
  size?: DialogSize;
  title: string;
  body: Child;
  actions?: ReadonlyArray<DialogAction<R>>;
  /** "alertdialog" for confirms (the body is their description). */
  role?: "dialog" | "alertdialog";
  /** false: the body brings its own heading; the title only names the dialog. */
  header?: boolean;
  /** Shows a × close button in the header (default: true when there are no actions). */
  closeButton?: boolean;
  className?: string;
  /** Element to focus first (default: the autofocus action, else the first focusable, else the dialog). */
  initialFocus?: () => HTMLElement | null;
  /** Where focus goes after closing when the opener is gone (re-rendered or removed meanwhile). Default: the main region. */
  returnFocus?: () => HTMLElement | null;
}

export interface DialogHandle<R extends string> {
  el: HTMLDialogElement;
  body: HTMLElement;
  /** The chosen action's value, or null when dismissed (Escape, ×, navigation). */
  result: Promise<R | null>;
  close: (value: R | null) => void;
  button: (value: R) => HTMLButtonElement | undefined;
}

type ModalKind = { kind: "dialog"; size: DialogSize } | { kind: "sheet"; side: SheetSide };

function toneClass(tone: ActionTone | undefined): string {
  if (tone === "primary") return "btn btn-primary";
  if (tone === "danger") return "btn btn-danger";
  return "btn btn-ghost";
}

function showModal<R extends string>(kind: ModalKind, opts: DialogOptions<R>): DialogHandle<R> {
  const id = nextId("ov");
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const withHeader = opts.header !== false;
  const actions = opts.actions ?? [];
  const variant = kind.kind === "dialog" ? `ov-dialog is-${kind.size}` : `ov-sheet is-${kind.side}`;
  const el = h("dialog", {
    class: `${variant}${opts.className ? ` ${opts.className}` : ""}`,
    id,
    role: opts.role === "alertdialog" ? "alertdialog" : null,
    "aria-labelledby": withHeader ? titleId : null,
    "aria-label": withHeader ? null : opts.title,
    "aria-describedby": opts.role === "alertdialog" ? descId : null,
    tabindex: -1,
  });
  const body = h("div", { class: "ov-body", id: descId }, opts.body);
  const buttons = new Map<R, HTMLButtonElement>();
  let busy = false;
  let settled = false;
  let resolveResult: (value: R | null) => void = () => undefined;
  let rejectResult: (err: unknown) => void = () => undefined;
  const result = new Promise<R | null>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const active = document.activeElement;
  // The opener gets focus back on close (<body> counts as none: e.g. a busy confirm disabled its focused button).
  const opener = active instanceof HTMLElement && active !== document.body ? active : null;
  const entry: ModalEntry = { el, opener, dismiss: () => close(null) };

  function finish(): void {
    busy = false;
    if (el.open) el.close();
    const wasTop = modals.remove(entry, (above, closing) => above === null || closing.el.contains(above));
    syncScrollLock();
    // Gone for assistive tech and input at once; only its exit transition is still painted.
    el.inert = true;
    el.setAttribute("aria-hidden", "true");
    removeAfterExit(el);
    if (wasTop) restoreFocus(entry.opener !== null && entry.opener.isConnected ? entry.opener : (opts.returnFocus?.() ?? null));
  }

  function close(value: R | null): void {
    if (settled) return;
    settled = true;
    finish();
    resolveResult(value);
  }

  function choose(action: DialogAction<R>): void {
    if (busy || settled) return;
    const run = action.run;
    if (run === undefined) return close(action.value);
    busy = true;
    for (const b of buttons.values()) b.disabled = true;
    closeBtn?.setAttribute("disabled", "");
    const btn = buttons.get(action.value);
    if (btn !== undefined && action.busyLabel !== undefined) btn.textContent = action.busyLabel;
    el.setAttribute("aria-busy", "true");
    run().then(
      () => close(action.value),
      (err: unknown) => {
        if (settled) return;
        settled = true;
        finish();
        rejectResult(err);
      },
    );
  }

  for (const action of actions) {
    const btn = h(
      "button",
      { type: "button", class: toneClass(action.tone), disabled: action.disabled === true, "data-action": action.value },
      action.label,
    );
    btn.addEventListener("click", () => choose(action));
    buttons.set(action.value, btn);
  }

  const showClose = opts.closeButton ?? actions.length === 0;
  const closeBtn = showClose
    ? h("button", { type: "button", class: "ov-close", "aria-label": TV().close, title: TV().close, onclick: () => close(null) }, h("span", { "aria-hidden": "true" }, "×"))
    : null;

  appendChildren(el, [
    withHeader ? h("header", { class: "ov-head" }, h("h2", { class: "ov-title", id: titleId }, opts.title), closeBtn) : closeBtn,
    body,
    actions.length > 0 ? h("footer", { class: "ov-actions" }, [...buttons.values()]) : null,
  ]);

  // Escape: the native cancel would close at once; route it through close() so focus and the promise follow.
  el.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    if (!busy) close(null);
  });
  // A close we did not ask for (the browser's close watcher after a repeated Escape) still settles.
  el.addEventListener("close", () => {
    if (!settled) close(null);
  });
  el.addEventListener("keydown", (ev) => {
    if (modals.top() === entry) trapTab(el, ev);
  });
  if (kind.kind === "sheet") {
    // Sheets close on a backdrop click: it lands on the <dialog> itself, outside its box.
    el.addEventListener("click", (ev) => {
      if (ev.target !== el || busy) return;
      const r = el.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) close(null);
    });
  }

  closeMenu();
  document.body.append(el);
  modals.push(entry);
  syncScrollLock();
  el.showModal();
  const first =
    opts.initialFocus?.() ??
    actions.reduce<HTMLButtonElement | null>((found, a) => found ?? (a.autofocus === true ? (buttons.get(a.value) ?? null) : null), null) ??
    tabbables(body)[0] ??
    null;
  (first ?? el).focus();

  return { el, body, result, close, button: (value) => buttons.get(value) };
}

/** A modal dialog. Most callers only need the result: use openDialog(). */
export function showDialog<R extends string>(opts: DialogOptions<R>): DialogHandle<R> {
  return showModal({ kind: "dialog", size: opts.size ?? "md" }, opts);
}

/** Opens a modal dialog and resolves with the chosen action's value (null when dismissed). */
export function openDialog<R extends string>(opts: DialogOptions<R>): Promise<R | null> {
  return showDialog(opts).result;
}

/* ---------- confirm ---------- */

export interface ConfirmOptions {
  title: string;
  /** States the full cost of the action before it is confirmed. */
  body: Child;
  confirmLabel: string;
  cancelLabel?: string;
  /** danger: red confirm button, for destructive actions. */
  tone?: "default" | "danger";
  /** The confirm button stays disabled until this exact text is typed (destructive, hard-to-undo actions). */
  typedName?: string;
  /** A secondary line under the body. */
  note?: string;
  /** Runs before the dialog closes (see DialogAction.run); a rejection rejects the returned promise. */
  run?: () => Promise<void>;
  busyLabel?: string;
  returnFocus?: () => HTMLElement | null;
}

/**
 * Asks before an action. Resolves true when confirmed (after `run`, if given), false when cancelled.
 * Focus starts on Cancel (the safe choice), or on the name field when `typedName` is set.
 */
export async function confirm(opts: ConfirmOptions): Promise<boolean> {
  const typed = opts.typedName;
  const inputId = nextId("ov-typed");
  const input =
    typed !== undefined
      ? h("input", {
          type: "text",
          id: inputId,
          class: "input ov-typed-input",
          autocomplete: "off",
          autocapitalize: "off",
          spellcheck: "false",
          dir: "auto",
          "aria-describedby": `${inputId}-hint`,
        })
      : null;
  const bodyEl = typeof opts.body === "string" ? h("p", {}, opts.body) : opts.body;
  const handle = showModal<"cancel" | "ok">(
    { kind: "dialog", size: "sm" },
    {
      title: opts.title,
      role: "alertdialog",
      className: `ov-confirm${opts.tone === "danger" ? " is-danger" : ""}`,
      body: [
        bodyEl,
        opts.note !== undefined ? h("p", { class: "muted small" }, opts.note) : null,
        input !== null && typed !== undefined
          ? h(
              "div",
              { class: "ov-typed" },
              h("label", { for: inputId, class: "ov-typed-label" }, TV().typeToConfirmBefore, h("code", { class: "ov-typed-name", dir: "auto" }, typed), TV().typeToConfirmAfter),
              input,
              h("p", { class: "muted small ov-typed-hint", id: `${inputId}-hint` }, TV().typedNameHint),
            )
          : null,
      ],
      actions: [
        { value: "cancel", label: opts.cancelLabel ?? TV().cancel, tone: "ghost", autofocus: typed === undefined },
        {
          value: "ok",
          label: opts.confirmLabel,
          tone: opts.tone === "danger" ? "danger" : "primary",
          disabled: typed !== undefined,
          run: opts.run,
          busyLabel: opts.busyLabel,
        },
      ],
      initialFocus: input !== null ? () => input : undefined,
      returnFocus: opts.returnFocus,
    },
  );
  if (input !== null && typed !== undefined) {
    const ok = handle.button("ok");
    input.addEventListener("input", () => {
      if (ok !== undefined && handle.el.getAttribute("aria-busy") !== "true") ok.disabled = input.value !== typed;
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && ok !== undefined && !ok.disabled) {
        ev.preventDefault();
        ok.click();
      }
    });
  }
  return (await handle.result) === "ok";
}

/* ---------- sheet ---------- */

export type SheetSide = "start" | "end" | "bottom";

export interface SheetOptions<R extends string = string> extends Omit<DialogOptions<R>, "size"> {
  side: SheetSide;
}

/** A modal panel anchored to the inline-start, inline-end or bottom edge (row detail, filters, mobile sidebar). */
export function openSheet<R extends string = string>(opts: SheetOptions<R>): DialogHandle<R> {
  return showModal({ kind: "sheet", side: opts.side }, { ...opts, closeButton: opts.closeButton ?? true });
}

/* ---------- anchored popover (non-modal) ---------- */

export interface AnchoredPanel {
  show: (anchor: HTMLElement) => void;
  hide: () => void;
  isOpen: () => boolean;
  anchor: () => HTMLElement | null;
  place: () => void;
}

interface AnchoredOptions {
  align?: "start" | "end";
  onOpen?: (anchor: HTMLElement) => void;
  onClose?: (anchor: HTMLElement | null) => void;
  /** Close when focus leaves the panel (non-modal panels must never keep focus behind them). */
  closeOnFocusOut?: boolean;
}

/**
 * Turns `panel` into a top-layer popover placed next to whichever anchor shows it. Light dismiss (outside
 * click, Escape) comes from popover="auto"; without the Popover API the panel falls back to `hidden` with
 * the same dismissal done by hand. Focus goes back to the anchor when the panel closes with focus inside.
 */
function anchoredPanel(panel: HTMLElement, opts: AnchoredOptions = {}): AnchoredPanel {
  const native = supportsPopover();
  let current: HTMLElement | null = null;
  if (native) panel.setAttribute("popover", "auto");
  else panel.hidden = true;
  panel.classList.add("ov-popover");

  const isOpen = (): boolean => (native ? panel.matches(":popover-open") : !panel.hidden);
  const place = (): void => {
    if (current === null) return;
    const a = current.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const root = document.documentElement;
    // Physical left/top on purpose: they are viewport coordinates from getBoundingClientRect, and
    // placeAnchored already mirrors the alignment for RTL.
    const pos = placeAnchored(a, p, { width: root.clientWidth, height: window.innerHeight }, { align: opts.align ?? "end", rtl: isRtl() });
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;
  };

  const opened = (): void => {
    if (current === null) return;
    current.setAttribute("aria-expanded", "true");
    place();
    opts.onOpen?.(current);
  };
  const closed = (): void => {
    const anchor = current;
    current = null;
    anchor?.setAttribute("aria-expanded", "false");
    opts.onClose?.(anchor);
    const active = document.activeElement;
    if (anchor !== null && (active === null || active === document.body || panel.contains(active))) restoreFocus(anchor);
  };

  const onDocPointer = (ev: PointerEvent): void => {
    const t = ev.target;
    if (t instanceof Node && !panel.contains(t) && current !== null && !current.contains(t)) hide();
  };
  const onDocKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") hide();
  };

  function show(anchor: HTMLElement): void {
    if (isOpen()) {
      if (current === anchor) return;
      hide();
    }
    current = anchor;
    if (native) {
      panel.showPopover();
    } else {
      panel.hidden = false;
      document.addEventListener("pointerdown", onDocPointer, true);
      document.addEventListener("keydown", onDocKey);
    }
    opened();
  }
  function hide(): void {
    if (!isOpen()) return;
    if (native) {
      panel.hidePopover();
    } else {
      panel.hidden = true;
      document.removeEventListener("pointerdown", onDocPointer, true);
      document.removeEventListener("keydown", onDocKey);
    }
    closed();
  }

  // show() and hide() update the state synchronously. The toggle event is async and coalesced, so it only
  // matters for the browser's own light dismiss (an outside click or Escape).
  if (native) {
    panel.addEventListener("toggle", (ev) => {
      if (ev instanceof ToggleEvent && ev.newState === "closed" && current !== null && !isOpen()) closed();
    });
  }
  if (opts.closeOnFocusOut !== false) {
    panel.addEventListener("focusout", (ev) => {
      const next = ev.relatedTarget;
      if (next instanceof Node && !panel.contains(next) && next !== current) hide();
    });
  }
  window.addEventListener("resize", () => {
    if (isOpen()) place();
  });
  return { show, hide, isOpen, anchor: () => current, place };
}

/**
 * Wires `anchor` to toggle a panel. A pointer press on the anchor of an open panel closes it: light dismiss
 * already ran on that press, so the click must not open it again.
 */
function bindAnchor(anchor: HTMLElement, panel: AnchoredPanel, open: () => void): void {
  let openAtPress = false;
  anchor.addEventListener("pointerdown", () => {
    openAtPress = panel.isOpen() && panel.anchor() === anchor;
  });
  anchor.addEventListener("click", () => {
    const wasOpen = openAtPress || (panel.isOpen() && panel.anchor() === anchor);
    openAtPress = false;
    if (wasOpen) panel.hide();
    else open();
  });
}

export interface PopoverControl {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  place: () => void;
}

/**
 * A non-modal panel (role=dialog) anchored to a button: the ⚙ display settings, filters, tooltips with
 * content. `onOpen` usually moves focus into the panel.
 */
export function popover(
  anchor: HTMLButtonElement,
  panel: HTMLElement,
  opts: { align?: "start" | "end"; onOpen?: () => void; onClose?: () => void } = {},
): PopoverControl {
  if (panel.id === "") panel.id = nextId("ov-pop");
  anchor.setAttribute("aria-controls", panel.id);
  anchor.setAttribute("aria-expanded", "false");
  const ctl = anchoredPanel(panel, { align: opts.align, onOpen: () => opts.onOpen?.(), onClose: () => opts.onClose?.() });
  bindAnchor(anchor, ctl, () => ctl.show(anchor));
  return { open: () => ctl.show(anchor), close: ctl.hide, isOpen: ctl.isOpen, place: ctl.place };
}

/* ---------- menu (APG menu button) ---------- */

export interface MenuItem {
  label: string;
  tone?: "danger";
  disabled?: boolean;
  run: () => void;
}

export type MenuItems = readonly MenuItem[] | (() => readonly MenuItem[]);

export interface MenuControl {
  open: (focus?: "first" | "last") => void;
  close: () => void;
}

const MENU_ID = "ov-menu";
let menuPanel: { el: HTMLElement; ctl: AnchoredPanel } | null = null;
let typeBuffer = "";
let typeTimer: number | null = null;

function menuItemsOf(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>("[role=menuitem]")];
}

/** One shared menu element in the top layer, so table scrollers never clip it. */
function sharedMenu(): { el: HTMLElement; ctl: AnchoredPanel } {
  if (menuPanel !== null && menuPanel.el.isConnected) return menuPanel;
  const el = h("div", { class: "ov-menu", role: "menu", id: MENU_ID, tabindex: -1 });
  const ctl = anchoredPanel(el, { align: "end", closeOnFocusOut: true });
  el.addEventListener("keydown", (ev) => {
    const items = menuItemsOf(el);
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
    if (ev.key === "Tab") {
      // APG: Tab closes the menu and moves on from the menu button. Focusing the anchor before the browser's
      // default Tab action makes that action continue from the anchor.
      const anchor = ctl.anchor();
      ctl.hide();
      anchor?.focus();
      return;
    }
    if (ev.key === "Escape" && !supportsPopover()) {
      ev.preventDefault();
      ctl.hide();
      return;
    }
    const target = menuKeyTarget(ev.key, index, items.length);
    if (target !== null) {
      ev.preventDefault();
      items[target]?.focus();
      return;
    }
    if (ev.key.length === 1 && ev.key !== " " && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      typeBuffer += ev.key;
      if (typeTimer !== null) window.clearTimeout(typeTimer);
      typeTimer = window.setTimeout(() => (typeBuffer = ""), 500);
      const match = typeaheadMatch(
        items.map((it) => it.textContent ?? ""),
        typeBuffer,
        index,
      );
      if (match >= 0) {
        ev.preventDefault();
        items[match]?.focus();
      }
    }
  });
  document.body.append(el);
  menuPanel = { el, ctl };
  return menuPanel;
}

/** Closes the shared menu if it is open (focus returns to its button). */
export function closeMenu(): void {
  if (menuPanel !== null && menuPanel.ctl.isOpen()) menuPanel.ctl.hide();
}

/**
 * Makes `anchor` an APG menu button for `items` (a function is read each time the menu opens). Click,
 * Enter or Space opens it on the first item, ArrowDown/ArrowUp on the first/last; inside, arrows, Home/End
 * and typeahead move, Enter/Space activate, Escape closes and returns focus to the button, Tab closes.
 * Choosing an item closes the menu and returns focus to the button before the item runs, so a dialog it
 * opens returns focus there too.
 */
export function menu(anchor: HTMLButtonElement, items: MenuItems, opts: { label?: string } = {}): MenuControl {
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "false");
  anchor.setAttribute("aria-controls", MENU_ID);

  const open = (focus: "first" | "last" = "first"): void => {
    const { el, ctl } = sharedMenu();
    if (ctl.isOpen()) ctl.hide();
    const list = typeof items === "function" ? items() : items;
    el.setAttribute("aria-label", opts.label ?? anchor.getAttribute("aria-label") ?? anchor.textContent ?? "");
    el.replaceChildren(
      ...list.map((item) => {
        const btn = h(
          "button",
          {
            type: "button",
            role: "menuitem",
            tabindex: -1,
            class: `ov-menu-item${item.tone === "danger" ? " is-danger" : ""}`,
            "aria-disabled": item.disabled === true ? "true" : null,
          },
          item.label,
        );
        btn.addEventListener("click", () => {
          if (item.disabled === true) return;
          ctl.hide();
          anchor.focus();
          item.run();
        });
        return btn;
      }),
    );
    ctl.show(anchor);
    const all = menuItemsOf(el);
    (focus === "last" ? all[all.length - 1] : all[0])?.focus();
  };

  const { ctl } = sharedMenu();
  bindAnchor(anchor, ctl, () => open("first"));
  anchor.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    open(ev.key === "ArrowUp" ? "last" : "first");
  });
  return { open, close: () => (ctl.anchor() === anchor ? ctl.hide() : undefined) };
}

/* ---------- toasts ---------- */

export type Tone = "success" | "info" | "warning" | "error";

export interface ToastOptions {
  tone: Tone;
  text: string;
  /** One button in the toast (e.g. Undo for a soft delete); choosing it dismisses the toast. */
  action?: { label: string; run: () => void };
  /**
   * Milliseconds before it dismisses itself; 0 keeps it until dismissed. Default: 6000 for success and info,
   * 0 for warning and error (errors never dismiss themselves, WCAG 2.2.1). The timer pauses while the toast is
   * hovered or focused.
   */
  timeout?: number;
}

export interface ToastHandle {
  dismiss: () => void;
}

const TOAST_MAX = 3;
const TOAST_DEFAULT_MS = 6000;
type ToastEntry = { el: HTMLElement; countEl: HTMLElement; timeout: number; timer: number | null; deadline: number; remaining: number };
const toastQueue = new ToastQueue<ToastEntry>(TOAST_MAX);
let toastHostEl: HTMLElement | null = null;

/**
 * The one polite live region for every toast. It exists before the first toast and individual toasts have no
 * role of their own, so nothing is announced twice. It sits in the page at --z-toast (a modal's top layer
 * and inert backdrop cover it, so a toast raised during a modal is read and usable once the modal closes).
 */
function toastHost(): HTMLElement {
  if (toastHostEl === null || !toastHostEl.isConnected) {
    toastHostEl = h("div", { class: "toast-host", "aria-live": "polite", "aria-relevant": "additions text" });
    const pause = (): void => {
      for (const key of toastQueue.keys()) {
        const e = toastQueue.get(key);
        if (e === undefined || e.timer === null) continue;
        window.clearTimeout(e.timer);
        e.timer = null;
        e.remaining = Math.max(1000, e.deadline - Date.now());
      }
    };
    const resume = (): void => {
      if (toastHostEl?.matches(":hover") === true || toastHostEl?.contains(document.activeElement) === true) return;
      for (const key of toastQueue.keys()) {
        const e = toastQueue.get(key);
        if (e !== undefined && e.timeout > 0 && e.timer === null) arm(key, e, e.remaining);
      }
    };
    toastHostEl.addEventListener("pointerenter", pause);
    toastHostEl.addEventListener("focusin", pause);
    toastHostEl.addEventListener("pointerleave", resume);
    toastHostEl.addEventListener("focusout", () => window.setTimeout(resume, 0));
    document.body.append(toastHostEl);
  }
  return toastHostEl;
}

function arm(key: string, entry: ToastEntry, ms: number): void {
  if (entry.timer !== null) window.clearTimeout(entry.timer);
  entry.deadline = Date.now() + ms;
  entry.remaining = ms;
  entry.timer = window.setTimeout(() => removeToast(key), ms);
}

function removeToast(key: string): void {
  const entry = toastQueue.get(key);
  if (entry === undefined) return;
  if (entry.timer !== null) window.clearTimeout(entry.timer);
  toastQueue.delete(key);
  const hadFocus = entry.el.contains(document.activeElement);
  entry.el.classList.add("is-leaving");
  entry.el.inert = true;
  removeAfterExit(entry.el);
  if (hadFocus) restoreFocus(null);
}

function toneLabel(tone: Tone): string {
  const t = TV();
  return { success: t.toneSuccess, info: t.toneInfo, warning: t.toneWarning, error: t.toneError }[tone];
}

const TONE_ICON: Record<Tone, string> = { success: "✓", info: "i", warning: "!", error: "✕" };

/**
 * Shows a toast. The same tone and text never stack: a repeat bumps a "×n" count (and restarts its timer).
 * At most 3 are on screen; the oldest goes first.
 */
export function toast(opts: ToastOptions): ToastHandle {
  const key = `${opts.tone}\u0000${opts.text}`;
  const timeout = opts.timeout ?? (opts.tone === "success" || opts.tone === "info" ? TOAST_DEFAULT_MS : 0);
  const host = toastHost();
  const added = toastQueue.add(key, () => {
    const countEl = h("span", { class: "toast-count", hidden: true });
    const action = opts.action;
    const el = h(
      "div",
      { class: `toast toast-${opts.tone}`, "data-tone": opts.tone },
      h("span", { class: "toast-icon", "aria-hidden": "true" }, TONE_ICON[opts.tone]),
      h("p", { class: "toast-text" }, h("span", { class: "visually-hidden" }, toneLabel(opts.tone), " "), opts.text, " ", countEl),
      action !== undefined
        ? h(
            "button",
            {
              type: "button",
              class: "btn btn-ghost btn-sm toast-action",
              onclick: () => {
                removeToast(key);
                action.run();
              },
            },
            action.label,
          )
        : null,
      h("button", { type: "button", class: "toast-close", "aria-label": TV().dismiss, title: TV().dismiss, onclick: () => removeToast(key) }, h("span", { "aria-hidden": "true" }, "×")),
    );
    return { el, countEl, timeout, timer: null, deadline: 0, remaining: timeout };
  });
  const entry = added.value;
  if (added.isNew) host.append(entry.el);
  else {
    entry.countEl.textContent = TV().toastCount(added.count);
    entry.countEl.hidden = false;
  }
  for (const gone of added.evicted) {
    if (gone.value.timer !== null) window.clearTimeout(gone.value.timer);
    const hadFocus = gone.value.el.contains(document.activeElement);
    gone.value.el.remove();
    if (hadFocus) restoreFocus(null);
  }
  if (entry.timeout > 0) arm(key, entry, entry.timeout);
  return { dismiss: () => removeToast(key) };
}

/* ---------- banner ---------- */

export interface BannerOptions {
  tone: Tone;
  text: string;
  dismissible?: boolean;
  onDismiss?: () => void;
  /** Names the banner as a region ("Announcement"); without it the banner is a plain status line. */
  label?: string;
  className?: string;
}

export interface BannerHandle {
  el: HTMLElement;
  /** Changes the tone or text in place (the live region stays, so the change is announced). */
  update: (next: { tone?: Tone; text?: string }) => void;
  show: () => void;
  hide: () => void;
}

/**
 * An inline message under the page header (announcements, freeze, offline, a failed action). The caller
 * places `el`; it starts visible. Dismissing hides it, calls `onDismiss`, and moves focus to the main region.
 */
export function banner(opts: BannerOptions): BannerHandle {
  let tone = opts.tone;
  const icon = h("span", { class: "banner-icon", "aria-hidden": "true" });
  const toneEl = h("span", { class: "visually-hidden" });
  const text = h("span", { class: "banner-text-body", dir: "auto" });
  const live = h("p", { class: "banner-text", "aria-live": "polite" }, toneEl, text);
  const close =
    opts.dismissible === true
      ? h("button", { type: "button", class: "banner-close", "aria-label": TV().dismiss, title: TV().dismiss }, h("span", { "aria-hidden": "true" }, "×"))
      : null;
  const el = h(
    "div",
    { class: `banner${opts.className ? ` ${opts.className}` : ""}`, role: opts.label !== undefined ? "region" : null, "aria-label": opts.label ?? null },
    icon,
    live,
    close,
  );
  const paint = (): void => {
    el.dataset.tone = tone;
    icon.textContent = TONE_ICON[tone];
    toneEl.textContent = `${toneLabel(tone)} `;
    close?.setAttribute("aria-label", TV().dismiss);
  };
  close?.addEventListener("click", () => {
    const hadFocus = el.contains(document.activeElement);
    el.hidden = true;
    opts.onDismiss?.();
    if (hadFocus) restoreFocus(null);
  });
  text.textContent = opts.text; // textContent only: banner text may be admin-authored
  paint();
  return {
    el,
    update: (next) => {
      if (next.tone !== undefined) tone = next.tone;
      if (next.text !== undefined && text.textContent !== next.text) text.textContent = next.text;
      paint();
    },
    show: () => void (el.hidden = false),
    hide: () => void (el.hidden = true),
  };
}
