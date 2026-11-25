import { TP } from "../i18n/strings-play";
type Listener = (event: Event) => void;
export type AttrValue = string | number | boolean | null | undefined | Listener;
export type Attrs = Record<string, AttrValue>;
export type Child = Node | string | number | null | undefined | false | readonly Child[];

/** Tiny hyperscript helper: h("div", { class: "x", onclick: fn }, "text", otherNode) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") {
      el.addEventListener(key.replace(/^on/, ""), value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

/** Element whose innerHTML is pre-rendered (trusted, build-time) markdown. */
export function html<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs,
  innerHtml: string,
): HTMLElementTagNameMap[K] {
  const el = h(tag, attrs);
  el.innerHTML = innerHtml;
  return el;
}

/* ---------- screen-reader announcements ---------- */

let announcer: HTMLElement | null = null;

/**
 * Create the shared polite live region (idempotent). It lives on <body>, outside the routed views, so it
 * exists before any message is put in it and survives every re-render. Views call this when they mount.
 */
export function ensureAnnouncer(): HTMLElement {
  if (announcer === null || !announcer.isConnected) {
    announcer = h("p", { class: "visually-hidden", role: "status", "aria-live": "polite", "aria-atomic": "true" });
    document.body.append(announcer);
  }
  return announcer;
}

/** Say `message` once through the polite region (cleared first, so a repeated message is re-read). */
export function announce(message: string): void {
  const el = ensureAnnouncer();
  el.textContent = "";
  window.setTimeout(() => (el.textContent = message), 60);
}

/* ---------- two-step inline confirm ---------- */

export type ConfirmTone = "accent" | "neutral" | "danger";

/**
 * Two-step inline confirmation: the first click swaps the trigger for a short prompt with
 * "Cancel / confirm". The safe choice (Cancel) gets focus, Escape cancels, and focus returns to the
 * trigger. Both confirm buttons reuse `sizeClass`, so the row keeps its height when it switches.
 * `prompt` states the full cost of the action before it is confirmed.
 */
export function confirmButton(opts: {
  label: string;
  confirmLabel: string;
  cancelLabel?: string;
  prompt?: string;
  className?: string;
  sizeClass?: string;
  tone?: ConfirmTone;
  onConfirm: () => void;
}): HTMLElement {
  const wrap = h("span", { class: "confirm-wrap" });
  const size = opts.sizeClass ?? "";
  const toneClass = { accent: "btn-primary", neutral: "", danger: "btn-danger" }[opts.tone ?? "accent"];
  const showIdle = (focus: boolean): void => {
    const trigger = h("button", { type: "button", class: opts.className ?? "btn btn-ghost", onclick: showConfirm }, opts.label);
    wrap.replaceChildren(trigger);
    if (focus) trigger.focus();
  };
  const cancel = (): void => showIdle(true);
  const showConfirm = (): void => {
    const promptId = `confirm-${++confirmSeq}`;
    const yes = h("button", { type: "button", class: `btn ${toneClass} ${size}`.trim(), onclick: () => opts.onConfirm() }, opts.confirmLabel);
    const no = h("button", { type: "button", class: `btn btn-ghost ${size}`.trim(), onclick: cancel }, opts.cancelLabel ?? TP().cancel);
    const group = h(
      "span",
      { class: "confirm-prompt", role: "group", "aria-labelledby": opts.prompt ? promptId : null, "aria-label": opts.prompt ? null : opts.label },
      opts.prompt ? h("span", { class: "confirm-text", id: promptId }, opts.prompt) : null,
      h("span", { class: "confirm-actions" }, no, yes),
    );
    group.addEventListener("keydown", (ev) => {
      if (ev instanceof KeyboardEvent && ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        cancel();
      }
    });
    wrap.replaceChildren(group);
    no.focus();
  };
  showIdle(false);
  return wrap;
}
let confirmSeq = 0;

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { "aria-hidden": "true", style: "position:fixed;opacity:0;left:-9999px" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Copy button: its visible text is its name, so "Copied" is what a screen reader hears too (and it is announced). */
export function copyButton(getText: () => string, label = TP().copy): HTMLButtonElement {
  const btn = h("button", { type: "button", class: "btn btn-copy" }, label);
  let timer: number | null = null;
  btn.addEventListener("click", () => {
    void copyText(getText()).then((ok) => {
      btn.textContent = ok ? TP().copied : TP().copyFailed;
      btn.classList.toggle("is-copied", ok);
      announce(ok ? TP().copiedAnnounce : TP().copyFailed);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("is-copied");
      }, 1600);
    });
  });
  return btn;
}

/** replaceChildren that accepts the same loose children as h() (null/false are skipped). */
export function setChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  appendChildren(parent, children);
}

/* ---------- form drafts that survive a re-render (language switch) ---------- */

/** Typed values by element id. Lives only in memory: password values are never written to storage. */
export type FieldSnapshot = Map<string, string>;

const TEXT_TYPES = new Set(["text", "password", "email", "search", "tel", "url", "number", ""]);

function draftFields(root: ParentNode): Array<HTMLInputElement | HTMLTextAreaElement> {
  const out: Array<HTMLInputElement | HTMLTextAreaElement> = [];
  for (const el of root.querySelectorAll("input[id], textarea[id]")) {
    if (el instanceof HTMLTextAreaElement) out.push(el);
    else if (el instanceof HTMLInputElement && TEXT_TYPES.has(el.getAttribute("type") ?? "")) out.push(el);
  }
  return out;
}

/** Snapshot every non-empty text field under `root`, keyed by id. */
export function snapshotFields(root: ParentNode): FieldSnapshot {
  const snap: FieldSnapshot = new Map();
  for (const el of draftFields(root)) if (el.value.length > 0) snap.set(el.id, el.value);
  return snap;
}

/**
 * Put snapshotted values back into freshly rendered fields with the same id. Restored ids are
 * removed from `snap` (each value is restored once). Fires "input" so views that track drafts stay in sync.
 */
export function restoreFields(root: ParentNode, snap: FieldSnapshot): void {
  for (const el of draftFields(root)) {
    const value = snap.get(el.id);
    if (value === undefined) continue;
    snap.delete(el.id);
    if (el.value === value) continue;
    el.value = value; // the user's text wins over anything the view prefilled (e.g. a ?code= class code)
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
