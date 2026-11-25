import { getLang } from "../i18n/i18n";
const he = (): boolean => getLang() === "he";
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

/**
 * Two-step inline confirmation: the first click swaps the button for
 * "Confirm / Cancel" so destructive actions never happen by accident.
 */
export function confirmButton(opts: {
  label: string;
  confirmLabel: string;
  className?: string;
  onConfirm: () => void;
}): HTMLElement {
  const wrap = h("span", { class: "confirm-wrap" });
  const showIdle = (): void => {
    wrap.replaceChildren(
      h("button", { type: "button", class: opts.className ?? "btn btn-ghost", onclick: showConfirm }, opts.label),
    );
  };
  const showConfirm = (): void => {
    const yes = h("button", { type: "button", class: "btn btn-danger", onclick: () => opts.onConfirm() }, opts.confirmLabel);
    const no = h("button", { type: "button", class: "btn btn-ghost", onclick: () => { showIdle(); focusFirst(); } }, he() ? "ביטול" : "Cancel");
    wrap.replaceChildren(h("span", { class: "confirm-prompt", role: "group", "aria-label": he() ? "אישור פעולה" : "Confirm action" }, yes, no));
    yes.focus();
  };
  const focusFirst = (): void => {
    const btn = wrap.querySelector("button");
    if (btn) btn.focus();
  };
  showIdle();
  return wrap;
}

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

export function copyButton(getText: () => string, label = he() ? "העתק" : "Copy"): HTMLButtonElement {
  const btn = h("button", { type: "button", class: "btn btn-copy", "aria-label": label }, label);
  btn.addEventListener("click", () => {
    void copyText(getText()).then((ok) => {
      btn.textContent = ok ? (he() ? "הועתק" : "Copied") : (he() ? "ההעתקה נכשלה" : "Copy failed");
      btn.classList.toggle("is-copied", ok);
      window.setTimeout(() => {
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
