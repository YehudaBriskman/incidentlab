// The EN | עב language toggle and what keeps a language switch lossless: the typed text, focus and the scroll
// position of the content area survive the re-render of the current route.
import { getLang, setLang } from "../i18n/i18n";
import { T } from "../i18n/strings-player";
import { TO } from "../i18n/strings-onboard";
import { h, restoreFields, snapshotFields, type FieldSnapshot } from "../lib/dom";
import { contentScroller } from "./scroll";

/** The skip link is static HTML: relabel it in the current language. */
export function labelStatic(): void {
  const link = document.querySelector(".skip-link");
  if (link !== null) link.textContent = TO().skipToContent;
}

/**
 * A language switch re-renders the current route. What the user typed must survive it: snapshot the text
 * fields (in memory only), then refill the re-rendered fields as they appear (views may render async, e.g.
 * after the account loads). Focus stays on the toggle and the scroll position is kept.
 */
type PendingRestore = { hash: string; fields: FieldSnapshot; scrollY: number; focus: HTMLElement | null; until: number };
let pendingRestore: PendingRestore | null = null;
const RESTORE_WINDOW_MS = 5_000;

/** Called by main.ts whenever #app changes (a MutationObserver), and right after a language switch. */
export function applyPendingRestore(): void {
  const pending = pendingRestore;
  const app = document.getElementById("app");
  if (pending === null || app === null) return;
  if (pending.hash !== window.location.hash || Date.now() > pending.until) {
    pendingRestore = null;
    return;
  }
  restoreFields(app, pending.fields);
  if (pending.focus !== null && document.activeElement !== pending.focus && app.contains(document.activeElement)) {
    pending.focus.focus({ preventScroll: true }); // a view auto-focused its first field: give focus back
  }
  const scroller = contentScroller();
  if (pending.scrollY > 0 && scroller.scrollHeight >= pending.scrollY + scroller.clientHeight) {
    scroller.scrollTop = pending.scrollY;
    pending.scrollY = 0;
  }
  if (pending.fields.size === 0 && pending.scrollY === 0 && pending.focus === null) pendingRestore = null;
}

/**
 * Switches the language and re-renders the route, keeping typed text and the scroll position. `button` keeps
 * focus when it had it (it must survive the re-render: the top-bar toggle does; a control inside #app does not,
 * so the settings page passes null and refocuses its own control).
 */
export function switchLang(lang: "en" | "he", button: HTMLElement | null): void {
  if (lang === getLang()) return;
  const app = document.getElementById("app");
  pendingRestore = {
    hash: window.location.hash,
    fields: app === null ? new Map() : snapshotFields(app),
    scrollY: contentScroller().scrollTop,
    focus: button !== null && document.activeElement === button ? button : null,
    until: Date.now() + RESTORE_WINDOW_MS,
  };
  setLang(lang);
  labelStatic();
  applyPendingRestore();
}

/** One EN | עב group. The frame mounts two (top bar on wide screens, nav foot on phones); CSS shows one. */
export function createLangToggle(): HTMLElement {
  const mk = (lang: "en" | "he", label: string): HTMLButtonElement => {
    const btn: HTMLButtonElement = h("button", { type: "button", class: "lang-btn", lang, "aria-pressed": String(getLang() === lang), onclick: () => switchLang(lang, btn) }, label);
    return btn;
  };
  const en = mk("en", "EN");
  const he = mk("he", "עב");
  const wrap = h("div", { class: "lang-toggle", role: "group", "aria-label": T().langToggle }, en, he);
  window.addEventListener("hashchange", () => {
    en.setAttribute("aria-pressed", String(getLang() === "en"));
    he.setAttribute("aria-pressed", String(getLang() === "he"));
    wrap.setAttribute("aria-label", T().langToggle);
  });
  return wrap;
}
