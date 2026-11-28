// The app frame's content area: what a view brings besides `main` (shell/types.ts ViewResult).
// - `nav`: nested items under a global-nav item (shell/nav.ts showSubNav);
// - `aside`: a page panel beside #app with its own scroll above 1024px; up to 1024px a page-header button opens
//   the same element in a start-edge Sheet (moved, never cloned, so its state survives);
// - `header`: the page header row above #app;
// - `layout`: "fit" pins the page to the content area's height so its panels scroll inside themselves.
// The content area (main.app-content) is the only scroller besides the nav; the frame itself is 100dvh.
// It also owns the admin's announcement: a compact dismissible notice at the top of the content area, and the
// guest banner (#176): a quiet, persistent "create an account" line while the session is a guest.
import type { LiveEvent } from "../../shared/contract";
import { TG } from "../i18n/strings-game";
import { appendChildren, h, html, setChildren, type Child } from "../lib/dom";
import { cachedEvent, onEventChange } from "../lib/event";
import { cachedAccount, isGuest, onAccountChange } from "../lib/session";
import { TGu } from "../i18n/strings-guest";
import { banner, openDialog, openSheet, type DialogHandle } from "../lib/overlay";
import { ICONS } from "./icons";
import { showSubNav } from "./nav";
import { scrollContentTo } from "./scroll";
import type { PageAside, ViewResult } from "./types";

const NARROW = "(max-width: 1024px)";

type Parts = { content: HTMLElement; header: HTMLElement; aside: HTMLElement; notice: HTMLElement };
let parts: Parts | null = null;
let currentAside: PageAside | null = null;
let asideDrawer: { handle: DialogHandle<string>; content: HTMLElement } | null = null;

/** Wires the frame's content area. Call once. */
export function initFrame(p: Parts): void {
  parts = p;
  p.notice.append(createAnnouncement(), createGuestBanner());
  window.matchMedia(NARROW).addEventListener("change", (ev) => {
    if (!ev.matches) closeAsideDrawer();
  });
}

/** Puts a view's nav section, page panel, header and layout on screen (main is mounted by the router). */
export function showPage(view: Pick<ViewResult, "nav" | "aside" | "sidebar" | "header" | "layout"> | null): void {
  showSubNav(view?.nav ?? null);
  showAside(view?.aside ?? view?.sidebar ?? null);
  drawHeader(view?.header ?? null);
  if (parts !== null) {
    if (view?.layout === "fit") parts.content.setAttribute("data-layout", "fit");
    else parts.content.removeAttribute("data-layout");
  }
}

/** Reserves (or releases) the page-panel column before the next view has loaded, so nothing shifts. */
export function reserveAside(on: boolean): void {
  if (on) document.documentElement.setAttribute("data-aside-page", "");
  else document.documentElement.removeAttribute("data-aside-page");
}

/** Back to the top of the content area (a navigation, not a language switch). */
export function resetContentScroll(): void {
  scrollContentTo(0);
}

function showAside(spec: PageAside | null): void {
  closeAsideDrawer();
  currentAside = spec;
  reserveAside(spec !== null);
  if (parts === null) return;
  const el = parts.aside;
  if (spec === null) {
    el.removeAttribute("aria-label");
    setChildren(el);
    return;
  }
  el.setAttribute("aria-label", spec.label);
  setChildren(el, spec.content);
}

/** Retitles the narrow-screen button of the page panel whose content is `content` (when it is on screen). */
export function setAsideTrigger(content: HTMLElement, text: string): void {
  if (currentAside === null || currentAside.content !== content) return;
  currentAside.trigger = text;
  const label = parts?.header.querySelector(".aside-trigger-label");
  if (label) label.textContent = text;
}

function drawHeader(header: Child): void {
  if (parts === null) return;
  const el = parts.header;
  const spec = currentAside;
  const trigger =
    spec === null
      ? null
      : h(
          "button",
          // its visible label is its name (WCAG 2.5.3, #249): an aria-label of "Open <panel>" hid the words on it
          { type: "button", class: "btn btn-sm aside-trigger", "aria-haspopup": "dialog", onclick: openAsideDrawer },
          html("span", { class: "icon", "aria-hidden": "true" }, ICONS.panel),
          h("span", { class: "aside-trigger-label" }, spec.trigger ?? spec.label),
        );
  setChildren(el);
  appendChildren(el, [trigger, header]);
  el.classList.toggle("has-header", header !== null && header !== undefined && header !== false);
  el.classList.toggle("has-trigger", trigger !== null);
}

/** Opens the page panel in a Sheet from the inline-start edge (up to 1024px). */
export function openAsideDrawer(): void {
  const spec = currentAside;
  if (spec === null || asideDrawer !== null) return;
  const content = spec.content;
  const handle = openSheet({ side: "start", title: spec.label, body: content, className: "aside-sheet" });
  const opened = { handle, content };
  asideDrawer = opened;
  handle.el.addEventListener(
    "click",
    (ev) => {
      const t = ev.target;
      if (t instanceof Element && content.contains(t) && t.closest("a[href], [data-sidebar-close]") !== null) closeAsideDrawer();
    },
    true,
  );
  const back = (): void => restoreAside(opened);
  handle.result.then(back, back);
}

export function closeAsideDrawer(): void {
  const open = asideDrawer;
  if (open === null) return;
  open.handle.close(null);
  restoreAside(open);
}

function restoreAside(open: { handle: DialogHandle<string>; content: HTMLElement }): void {
  if (asideDrawer === open) asideDrawer = null;
  if (parts !== null && currentAside?.content === open.content && open.content.parentElement !== parts.aside) parts.aside.append(open.content);
}

/* ---------- the announcement ---------- */

const DISMISSED_KEY = "il.announce.dismissed";
function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}
function writeDismissed(text: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, text);
  } catch {
    /* storage blocked: the notice just stays dismissed for this page load */
  }
}

/** The admin's announcement: one compact dismissible banner (lib/overlay.ts); a dismissed text stays dismissed. */
function createAnnouncement(): HTMLElement {
  let dismissedText = readDismissed();
  let currentText: string | null = null;
  const notice = banner({
    tone: "info",
    text: "",
    dismissible: true,
    label: TG().announcement,
    className: "announce",
    onDismiss: () => {
      if (currentText === null) return;
      dismissedText = currentText;
      writeDismissed(currentText);
    },
  });
  notice.hide();
  const show = (event: LiveEvent | null): void => {
    const a = event?.announcement ?? null;
    currentText = a?.text ?? null;
    if (a === null || a.text === dismissedText) {
      notice.hide();
      return;
    }
    notice.el.setAttribute("aria-label", TG().announcement);
    notice.update({ tone: a.level === "warning" ? "warning" : "info", text: a.text });
    notice.show();
  };
  show(cachedEvent()); // a remembered event draws at first paint (no layout shift); polling then updates it
  onEventChange(show);
  return notice.el;
}

/* ---------- the guest banner (#176) ---------- */

/** Opens the upgrade form (loaded on demand: most visitors are never guests). */
export function openGuestUpgrade(): void {
  void import("../views/guest").then((m) => m.openUpgradeDialog());
}

/**
 * A guest who signs out can never get back in (#176), so every sign-out a guest can reach asks first (#206): the
 * account menu and "not you? switch" on a case. "Create an account first" opens the upgrade form instead.
 * Resolves true only when the guest chose to sign out and lose the progress.
 */
export async function confirmGuestSignOut(): Promise<boolean> {
  const choice = await openDialog<"cancel" | "upgrade" | "leave">({
    size: "sm",
    role: "alertdialog",
    className: "ov-confirm is-danger",
    title: TGu().signOutTitle,
    body: h("p", {}, TGu().signOutBody),
    actions: [
      { value: "cancel", label: TGu().cancel, tone: "ghost", autofocus: true },
      { value: "upgrade", label: TGu().createFirst, tone: "primary" },
      { value: "leave", label: TGu().signOutConfirm, tone: "danger" },
    ],
  });
  if (choice === "upgrade") openGuestUpgrade();
  return choice === "leave";
}

/** Shown on every page while the session is a guest; not dismissible, since the progress is at stake. */
function createGuestBanner(): HTMLElement {
  const notice = banner({
    tone: "info",
    text: TGu().bannerText,
    label: TGu().bannerLabel,
    className: "guest-banner",
    action: { label: () => TGu().createAccount, run: openGuestUpgrade },
  });
  const draw = (): void => {
    if (!isGuest(cachedAccount())) {
      notice.hide();
      return;
    }
    notice.el.setAttribute("aria-label", TGu().bannerLabel);
    notice.update({ text: TGu().bannerText });
    notice.show();
  };
  draw();
  onAccountChange(draw);
  window.addEventListener("hashchange", draw); // re-label on language change
  return notice.el;
}
