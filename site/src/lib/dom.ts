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
    const no = h("button", { type: "button", class: "btn btn-ghost", onclick: () => { showIdle(); focusFirst(); } }, "Cancel");
    wrap.replaceChildren(h("span", { class: "confirm-prompt", role: "group", "aria-label": "Confirm action" }, yes, no));
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

export function copyButton(getText: () => string, label = "Copy"): HTMLButtonElement {
  const btn = h("button", { type: "button", class: "btn btn-copy", "aria-label": label }, label);
  btn.addEventListener("click", () => {
    void copyText(getText()).then((ok) => {
      btn.textContent = ok ? "Copied" : "Copy failed";
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
