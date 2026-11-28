// What keeps a language switch lossless: the typed text, focus and the scroll position of the content area survive
// the re-render of the current route. The language radios live in the account menu and on #/settings/display.
import { getLang, setLang } from "../i18n/i18n";
import { TO } from "../i18n/strings-onboard";
import { restoreFields, snapshotFields, type FieldSnapshot } from "../lib/dom";
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
 * focus when it had it (it must survive the re-render; the radios in the account menu and on the settings page are
 * redrawn, so they pass null and refocus their own control).
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
