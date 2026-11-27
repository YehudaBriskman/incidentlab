// The global nav (the app frame's start column): Home, Today's case, Cases, Leaderboard, My stats, Authoring and
// Admin, each an icon and a label, shown by role. A view can hang nested items under one of them (admin sections,
// a case's stages): `ViewResult.nav`, mounted by showSubNav().
// - above 1024px: --nav-size wide, collapsible to the --rail-size icon rail (kept in settings as navCollapsed);
// - 641–1024px: always the rail; the top bar's menu button opens the full nav in a start-edge Sheet;
// - 640px and below: no column; the same menu button opens the Sheet.
// The <nav> element itself moves into the Sheet and back (never cloned), so focus targets and listeners survive.
import { h, html, setChildren, type Child } from "../lib/dom";
import { openSheet, type DialogHandle } from "../lib/overlay";
import { cachedAccount, isAdmin, onAccountChange } from "../lib/session";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { TS } from "../i18n/strings-shell";
import { TC } from "../i18n/strings-classes";
import { ICONS, type IconName } from "./icons";
import { loadSettings, onSettingsChange, updateSettings } from "./settings";
import { cachedToday, onTodayChange } from "./today";
import type { NavKey, NavSection } from "./types";

const KEYS: readonly NavKey[] = ["home", "today", "cases", "leaderboard", "classes", "stats", "author", "admin"];
const ICON_OF: Record<NavKey, IconName> = {
  home: "home",
  today: "today",
  cases: "cases",
  leaderboard: "leaderboard",
  classes: "classes",
  stats: "stats",
  author: "author",
  admin: "admin",
};

/** The rail is forced up to this width (and the collapse button hides); the menu button opens the Sheet. */
const RAIL_MQ = "(max-width: 1024px)";

type Item = { li: HTMLLIElement; link: HTMLAnchorElement; label: HTMLSpanElement; sub: HTMLElement };

let navEl: HTMLElement | null = null;
let home: { parent: HTMLElement; next: Node | null } | null = null;
let items: Record<NavKey, Item> | null = null;
let collapseBtn: HTMLButtonElement | null = null;
let collapseLabel: HTMLSpanElement | null = null;
let subSpec: NavSection | null = null;
let drawer: DialogHandle<string> | null = null;
let clickedInDrawer = false;

const icon = (name: IconName, cls: string): HTMLElement => html("span", { class: cls, "aria-hidden": "true" }, ICONS[name]);

/** Hash route parts without the query: "#/case/x/toolbox?f=1" -> ["case", "x", "toolbox"]. */
export function routeParts(hash = window.location.hash): string[] {
  const path = hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  return path
    .split("/")
    .filter((p) => p.length > 0)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
}

/** Which top-level item the route belongs to. */
export function currentNavKey(parts: readonly string[] = routeParts()): NavKey | null {
  if (parts.length === 0) return "home";
  switch (parts[0]) {
    case "cases":
    case "case":
      return "cases";
    case "leaderboard":
      return "leaderboard";
    case "classes":
    case "class":
    case "join":
    case "classboard":
      return "classes";
    case "me":
      return "stats";
    case "author":
      return "author";
    case "admin":
      return "admin";
    default:
      return null;
  }
}

/** Rail mode: collapsed by the user on desktop, or any width up to 1024px (outside the drawer). */
function isRail(): boolean {
  return window.matchMedia(RAIL_MQ).matches || loadSettings().navCollapsed;
}

/** Labels, role visibility and aria-current. Built once and updated in place, so focus survives. */
function draw(): void {
  if (items === null || navEl === null) return;
  const account = cachedAccount();
  const todayId = cachedToday()?.caseId ?? null;
  const labels: Record<NavKey, string> = {
    home: TS().navHome,
    today: TS().navTodayCase,
    cases: TS().navCases,
    leaderboard: TG().leaderboard,
    classes: TC().navClasses,
    stats: TA().myStats,
    author: TS().navAuthor,
    admin: TG().adminLink,
  };
  const shown: Record<NavKey, boolean> = {
    home: true,
    cases: true,
    today: todayId !== null && !isAdmin(account),
    leaderboard: true,
    // classes (#182): any signed-in account; guests find the "create an account to join" note there
    classes: account !== null,
    // the forced password screen gates every view, so My stats waits for an approved, settled account
    stats: account !== null && !isAdmin(account) && account.status === "approved" && !account.mustChangePassword,
    // authors and the instructor manage cases (#66); approval and password state are enforced by the server
    author: account !== null && (account.role === "author" || isAdmin(account)),
    admin: isAdmin(account),
  };
  const current = currentNavKey();
  const rail = drawer === null && isRail();
  navEl.setAttribute("aria-label", TS().navMain);
  for (const key of KEYS) {
    const it = items[key];
    if (it.label.textContent !== labels[key]) it.label.textContent = labels[key];
    if (key === "today" && todayId !== null) it.link.href = `#/case/${encodeURIComponent(todayId)}`;
    const parentOfSub = subSpec !== null && subSpec.under === key;
    if (parentOfSub) it.link.setAttribute("aria-current", "true");
    else if (key === current) it.link.setAttribute("aria-current", "page");
    else it.link.removeAttribute("aria-current");
    it.li.classList.toggle("is-open", parentOfSub);
    it.li.hidden = !shown[key];
    // Rail tooltips: the label is visually hidden there, so the native title names the icon on hover.
    if (rail) it.link.title = labels[key];
    else it.link.removeAttribute("title");
  }
  for (const el of navEl.querySelectorAll<HTMLElement>("[data-nav-tip]")) {
    if (rail) el.title = el.dataset.navTip ?? "";
    else el.removeAttribute("title");
  }
  syncCollapse();
}

function syncCollapse(): void {
  if (collapseBtn === null || collapseLabel === null) return;
  const collapsed = loadSettings().navCollapsed;
  const label = collapsed ? TS().navExpand : TS().navCollapse;
  collapseBtn.setAttribute("aria-expanded", String(!collapsed));
  collapseBtn.setAttribute("aria-label", label);
  collapseBtn.title = label;
  collapseLabel.textContent = label;
}

/** Builds the nav inside the frame's <nav id="app-nav">. Call once. */
export function mountNav(el: HTMLElement): void {
  navEl = el;
  home = el.parentElement === null ? null : { parent: el.parentElement, next: el.nextSibling };
  const built = {} as Record<NavKey, Item>;
  const listItems = KEYS.map((key) => {
    const label = h("span", { class: "nav-label" });
    const link = h("a", { class: "nav-link", href: key === "home" ? "#/" : key === "cases" ? "#/cases" : key === "leaderboard" ? "#/leaderboard" : key === "classes" ? "#/classes" : key === "stats" ? "#/me" : key === "author" ? "#/author" : key === "admin" ? "#/admin" : "#/" }, icon(ICON_OF[key], "nav-icon"), label);
    const sub = h("div", { class: "nav-sub", hidden: true });
    const li = h("li", { class: `nav-item nav-item-${key}` }, link, sub);
    built[key] = { li, link, label, sub };
    return li;
  });
  items = built;

  collapseLabel = h("span", { class: "nav-label" });
  collapseBtn = h("button", { type: "button", class: "nav-collapse", "aria-controls": "app-nav" }, icon("panel", "nav-icon nav-collapse-icon"), collapseLabel);
  collapseBtn.addEventListener("click", () => {
    updateSettings({ navCollapsed: !loadSettings().navCollapsed });
    collapseBtn?.focus();
  });
  const a11y = h("a", { class: "nav-foot-link", href: "/accessibility.html" });
  const labelFoot = (): void => {
    a11y.textContent = TS().a11yStatement;
  };

  setChildren(
    el,
    h("div", { class: "nav-head" }, h("a", { class: "logo", href: "#/", "aria-label": TS().logoHome }, h("span", { class: "logo-mark", "aria-hidden": "true" }, "▲"), h("span", { class: "logo-word mono" }, "incident", h("span", { class: "accent" }, "lab")))),
    h("div", { class: "nav-scroll" }, h("ul", { class: "nav-list" }, listItems)),
    h("div", { class: "nav-foot" }, a11y, collapseBtn),
  );
  // A click on a link (or a [data-nav-close] control) inside the drawer closes it first, in the capture phase,
  // so a handler that moves focus (a stage button focuses its heading) keeps the last word.
  el.addEventListener(
    "click",
    (ev) => {
      if (drawer === null) return;
      const t = ev.target;
      if (t instanceof Element && t.closest("a[href], [data-nav-close], [data-sidebar-close]") !== null) {
        clickedInDrawer = true;
        window.setTimeout(() => (clickedInDrawer = false), 0);
        closeNavDrawer();
      }
    },
    true,
  );

  onAccountChange(draw);
  onTodayChange(draw);
  onSettingsChange(draw);
  window.addEventListener("hashchange", () => {
    labelFoot();
    draw();
  });
  window.addEventListener("popstate", draw);
  window.matchMedia(RAIL_MQ).addEventListener("change", draw);
  // Leaving the drawer widths with the drawer open: the nav belongs back in its column.
  window.matchMedia("(min-width: 1025px)").addEventListener("change", (ev) => {
    if (ev.matches) closeNavDrawer();
  });
  labelFoot();
  draw();
}

/** Puts a view's nested items under their top-level item, or removes them (null). */
export function showSubNav(spec: NavSection | null): void {
  if (items === null) return;
  if (subSpec !== null && subSpec !== spec) {
    const old = items[subSpec.under].sub;
    old.hidden = true;
    setChildren(old);
  }
  subSpec = spec;
  if (spec !== null) {
    const slot = items[spec.under].sub;
    const id = `nav-sub-${spec.under}`;
    if (!spec.content.hasAttribute("aria-label") && !spec.content.hasAttribute("aria-labelledby")) spec.content.setAttribute("aria-labelledby", id);
    setChildren(slot, h("p", { class: "nav-sub-title", id, dir: "auto" }, spec.label), spec.content);
    slot.hidden = false;
  }
  draw();
}

/** Re-applies labels, tooltips and aria-current (after a view redrew its nested items). */
export function refreshNav(): void {
  draw();
}

/** Opens the full nav in a start-edge Sheet (rail widths and phones). */
export function openNavDrawer(): void {
  const el = navEl;
  if (el === null || drawer !== null) return;
  const handle = openSheet({ side: "start", title: TS().navDrawer, body: el, className: "nav-sheet" });
  drawer = handle;
  draw();
  const back = (): void => restore(handle);
  handle.result.then(back, back);
  // Focus the current page's link (or the first one) instead of the close button: it is where the user is.
  const target = el.querySelector<HTMLElement>(".nav-sub [aria-current=page], .nav-sub [aria-current=step], .nav-link[aria-current=page]") ?? el.querySelector<HTMLElement>(".nav-link");
  target?.focus();
}

export function closeNavDrawer(): void {
  const open = drawer;
  if (open === null) return;
  open.close(null);
  restore(open);
}

/** True while the click that just closed the drawer is still being handled (views move focus on it). */
export function clickClosedDrawer(): boolean {
  return clickedInDrawer;
}

function restore(handle: DialogHandle<string>): void {
  if (drawer !== handle) return;
  drawer = null;
  if (navEl !== null && home !== null && navEl.parentElement !== home.parent) {
    home.parent.insertBefore(navEl, home.next !== null && home.next.parentNode === home.parent ? home.next : null);
  }
  draw();
}

/* ---------- nested item builders (views use these for ViewResult.nav) ---------- */

export interface NavSubOptions {
  label: string;
  /** An icon name from shell/icons.ts, raw trusted SVG markup, or a short text glyph (a stage number, ✓). */
  icon?: IconName | { svg: string } | { glyph: string; className?: string };
  /** A count or a node shown at the inline end (pending sign-ups); hidden when null. */
  badge?: HTMLElement | null;
  current?: "page" | "step" | "location" | null;
  className?: string;
}

function iconPart(spec: NavSubOptions["icon"]): HTMLElement {
  if (spec === undefined) return h("span", { class: "nav-sub-icon is-dot", "aria-hidden": "true" });
  if (typeof spec === "string") return icon(spec, "nav-sub-icon");
  if ("svg" in spec) return html("span", { class: "nav-sub-icon", "aria-hidden": "true" }, spec.svg);
  return h("span", { class: `nav-sub-icon is-glyph${spec.className ? ` ${spec.className}` : ""}`, "aria-hidden": "true" }, spec.glyph);
}

function subParts(opts: NavSubOptions): Child[] {
  return [iconPart(opts.icon), h("span", { class: "nav-label" }, opts.label), opts.badge ?? null];
}

/** A nested nav link: `<a class="nav-sub-link">` with icon, label and optional badge (wrap it in an <li>). */
export function navSubLink(href: string, opts: NavSubOptions): HTMLAnchorElement {
  return h("a", { class: `nav-sub-link${opts.className ? ` ${opts.className}` : ""}`, href, "aria-current": opts.current ?? null, "data-nav-tip": opts.label }, subParts(opts));
}

/** A nested nav button (a case stage): same anatomy as navSubLink. `data-nav-close` closes the drawer on use. */
export function navSubButton(opts: NavSubOptions & { onClick: () => void; closesDrawer?: boolean; attrs?: Record<string, string | null> }): HTMLButtonElement {
  const btn = h("button", { type: "button", class: `nav-sub-link${opts.className ? ` ${opts.className}` : ""}`, "aria-current": opts.current ?? null, "data-nav-tip": opts.label, "data-nav-close": opts.closesDrawer === false ? null : "" }, subParts(opts));
  for (const [k, v] of Object.entries(opts.attrs ?? {})) {
    if (v === null) btn.removeAttribute(k);
    else btn.setAttribute(k, v);
  }
  btn.addEventListener("click", opts.onClick);
  return btn;
}
