// The per-page sidebar (#60). One <aside id="sidebar"> in the shell grid, filled by the view on screen:
// - above 1024px: 264px wide, collapsible to the 64px rail (the choice is kept in settings);
// - 641–1024px: always the 64px rail; its button opens the full content in a Sheet;
// - 640px and below: no column; a button in the page header opens the Sheet.
// The view's content element moves between the <aside> and the Sheet (never cloned), so its state survives.
// Routes that have a sidebar set html[data-sidebar-page] before the view loads (public/settings-boot.js on
// first paint, reserveSidebar() on navigation): the column is reserved and nothing shifts when it fills.
import { appendChildren, h, html, setChildren, type Child } from "../lib/dom";
import { openSheet, type DialogHandle } from "../lib/overlay";
import { TS } from "../i18n/strings-shell";
import { loadSettings, onSettingsChange, updateSettings } from "./settings";
import type { SidebarSpec } from "./types";

const PANEL_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M14 10l2 2-2 2"/></svg>';
const MENU_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" focusable="false" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';

/** Up to this width the column is the rail (or gone) and the full content opens in a Sheet. */
const NARROW = "(max-width: 1024px)";

type Drawer = { handle: DialogHandle<string>; content: HTMLElement };

let aside: HTMLElement | null = null;
let body: HTMLElement | null = null;
let rail: HTMLElement | null = null;
let pageHeader: HTMLElement | null = null;
let collapseBtn: HTMLButtonElement | null = null;
let openBtn: HTMLButtonElement | null = null;
let current: SidebarSpec | null = null;
let drawer: Drawer | null = null;

const icon = (svg: string, cls: string): HTMLElement => html("span", { class: cls, "aria-hidden": "true" }, svg);

/** Builds the sidebar chrome inside the shell's <aside> and wires the collapse state. Call once. */
export function initSidebar(el: HTMLElement, header: HTMLElement): void {
  aside = el;
  pageHeader = header;
  collapseBtn = h("button", { type: "button", class: "sidebar-btn sidebar-collapse", "aria-controls": "sidebar-body" });
  collapseBtn.append(icon(PANEL_ICON, "sidebar-icon"));
  collapseBtn.addEventListener("click", () => {
    updateSettings({ sidebarCollapsed: !loadSettings().sidebarCollapsed });
  });
  openBtn = h("button", { type: "button", class: "sidebar-btn sidebar-open", "aria-haspopup": "dialog" });
  openBtn.append(icon(PANEL_ICON, "sidebar-icon"));
  openBtn.addEventListener("click", openDrawer);
  body = h("div", { class: "sidebar-body", id: "sidebar-body" });
  rail = h("div", { class: "sidebar-rail" });
  setChildren(el, h("div", { class: "sidebar-head" }, collapseBtn, openBtn), body, rail);
  syncCollapse();
  onSettingsChange(syncCollapse);
  // Leaving the narrow layout with the drawer open: the content belongs back in the column.
  window.matchMedia(NARROW).addEventListener("change", (ev) => {
    if (!ev.matches) closeDrawer();
  });
}

function syncCollapse(): void {
  if (collapseBtn === null) return;
  const collapsed = loadSettings().sidebarCollapsed;
  const label = collapsed ? TS().sidebarExpand : TS().sidebarCollapse;
  collapseBtn.setAttribute("aria-expanded", String(!collapsed));
  collapseBtn.setAttribute("aria-label", label);
  collapseBtn.title = label;
}

/** Reserves (or releases) the sidebar column before the next view has loaded. */
export function reserveSidebar(on: boolean): void {
  if (on) document.documentElement.setAttribute("data-sidebar-page", "");
  else document.documentElement.removeAttribute("data-sidebar-page");
  if (on && current === null) aside?.setAttribute("aria-busy", "true");
}

/** Puts a view's sidebar (or none) and page-header content on screen. */
export function showSidebar(spec: SidebarSpec | null, header: Child = null): void {
  closeDrawer();
  current = spec;
  reserveSidebar(spec !== null);
  if (aside !== null && body !== null && rail !== null) {
    aside.removeAttribute("aria-busy");
    if (spec === null) aside.removeAttribute("aria-label");
    else aside.setAttribute("aria-label", spec.label);
    setChildren(body, spec?.content ?? null);
    setChildren(rail, spec?.rail ?? null);
  }
  if (openBtn !== null && spec !== null) {
    openBtn.setAttribute("aria-label", TS().sidebarOpen(spec.label));
    openBtn.title = spec.label;
  }
  syncCollapse();
  drawHeader(spec, header);
}

function drawHeader(spec: SidebarSpec | null, header: Child): void {
  if (pageHeader === null) return;
  const trigger =
    spec === null
      ? null
      : h("button", { type: "button", class: "btn btn-sm btn-ghost sidebar-trigger", "aria-haspopup": "dialog", onclick: openDrawer }, icon(MENU_ICON, "sidebar-icon"), spec.trigger ?? spec.label);
  setChildren(pageHeader);
  appendChildren(pageHeader, [trigger, header]);
  // Shown by CSS: always with view content (.has-header), on phones whenever the page has a sidebar.
  pageHeader.classList.toggle("has-header", header !== null && header !== undefined && header !== false);
}

/** Opens the current sidebar's content in a Sheet from the inline-start edge (tablet rail and phone). */
export function openDrawer(): void {
  const spec = current;
  if (spec === null || drawer !== null) return;
  const content = spec.content;
  const handle = openSheet({ side: "start", title: spec.label, body: content, className: "sidebar-sheet" });
  const opened: Drawer = { handle, content };
  drawer = opened;
  // Capture phase: the drawer closes (and focus goes back to its button) before the control's own handler
  // runs, so a handler that moves focus (a stage button focuses its heading) keeps the last word.
  handle.el.addEventListener(
    "click",
    (ev) => {
      const target = ev.target;
      if (target instanceof Element && content.contains(target) && target.closest("a[href], [data-sidebar-close]") !== null) closeDrawer();
    },
    true,
  );
  handle.result.then(
    () => restore(opened),
    () => restore(opened),
  );
}

/** Closes the drawer, if open, and puts its content back in the column. */
export function closeDrawer(): void {
  const open = drawer;
  if (open === null) return;
  open.handle.close(null);
  restore(open);
}

function restore(open: Drawer): void {
  if (drawer === open) drawer = null;
  // Only the content of the sidebar still on screen goes back; a newer view's content is already there.
  if (body !== null && current?.content === open.content && open.content.parentElement !== body) body.append(open.content);
}

