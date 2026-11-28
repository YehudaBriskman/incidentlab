// Focus after a route change (#246, WCAG 2.4.3): a new page moves focus to its h1, so the next Tab starts in the
// page and a screen reader reads where it landed. Without it focus stays on the link that was clicked (or drops
// to <body> when that link was redrawn), and the next Tab restarts at the skip link.
// - Not on the first load (the browser starts at the top, the skip link first) and not on a same-page redraw: a
//   language switch, a query change (`?tab=`, Explorer filters), an account change that re-runs the route.
// - Not when the view placed focus itself (a sign-in form's field, a case stage heading) or a dialog has it.
// - Views that draw later (data first) are waited for; the wait ends on the next route or after a few seconds.
// When no h1 can take focus (none drawn, or the view focused a field), the page title is announced through the
// shared polite region instead, so the change is never silent. A focused h1 reads itself: no second announcement.
import { announce } from "../lib/dom";

const WAIT_MS = 3000;
let lastPath: string | null = null;
let pending: (() => void) | null = null;

/** The route without its `?query`: query changes redraw the same page. */
function routePath(hash: string): string {
  return (hash.split("?")[0] ?? "").replace(/^#\/?/, "");
}

/** Focus is still where the route change left it: on <body>, gone with the old page, or in the frame's chrome. */
function focusIsFree(content: Element): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || !active.isConnected) return true;
  if (active.closest("dialog[open], [popover]:popover-open") !== null) return false;
  return !content.contains(active);
}

function visibleHeading(content: Element): HTMLElement | null {
  for (const el of content.querySelectorAll<HTMLElement>("h1")) {
    if (el.closest("[hidden], [inert], dialog") === null) return el;
  }
  return null;
}

/** Focus the h1 (it reads itself); when the view already placed focus (a field), announce the page title instead. */
function land(content: Element, heading: HTMLElement): void {
  if (!focusIsFree(content)) {
    announce(document.title);
    return;
  }
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

/**
 * Called by the router after each mount. `relabel` is true for a language switch (the same page, new words).
 * `content` is the frame's scroller (main.app-content): the page header and #app.
 */
export function focusRoute(content: Element, relabel: boolean): void {
  const path = routePath(window.location.hash);
  const first = lastPath === null;
  const samePage = path === lastPath;
  lastPath = path;
  if (first || samePage || relabel) return;
  pending?.();
  pending = null;

  const now = visibleHeading(content);
  if (now !== null) {
    land(content, now);
    return;
  }
  // The view draws its h1 after loading its data: wait for it, but never past the next route.
  const observer = new MutationObserver(() => {
    if (routePath(window.location.hash) !== path) return stop();
    const heading = visibleHeading(content);
    if (heading === null) return;
    stop();
    land(content, heading);
  });
  const timer = window.setTimeout(() => {
    stop();
    if (routePath(window.location.hash) === path) announce(document.title);
  }, WAIT_MS);
  const stop = (): void => {
    observer.disconnect();
    window.clearTimeout(timer);
    if (pending === stop) pending = null;
  };
  pending = stop;
  observer.observe(content, { childList: true, subtree: true });
}
