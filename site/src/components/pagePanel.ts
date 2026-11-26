// Page building blocks for the app frame's content area (DESIGN.md, Frame): a page header (title, meta line and
// page actions) and a panel whose body can scroll inside itself. A dashboard returns `layout: "fit"` from its
// view and puts its lists in `panel({ scroll: true })`, so the page fits the viewport and only panels scroll.
import { h, type Child } from "../lib/dom";

export interface PageHeaderOptions {
  title: Child;
  /** One quiet line under the title (counts, freshness). */
  meta?: Child;
  /** Page-level actions at the inline end: at most one primary button. */
  actions?: Child;
  /** id for the <h1>, e.g. to label the page's main region. */
  id?: string;
}

/** `<header class="pg-head">` with an h1, an optional meta line and an actions cluster. */
export function pageHeader(opts: PageHeaderOptions): HTMLElement {
  return h(
    "header",
    { class: "pg-head" },
    h("div", { class: "pg-title" }, h("h1", { id: opts.id ?? null, tabindex: "-1" }, opts.title), opts.meta ? h("p", { class: "pg-meta" }, opts.meta) : null),
    opts.actions ? h("div", { class: "pg-actions" }, opts.actions) : null,
  );
}

export interface PanelOptions {
  title?: Child;
  /** id of the panel heading (generated when omitted); labels the section and its scroll region. */
  titleId?: string;
  actions?: Child;
  body: Child;
  /** Grow to the free height and scroll the body inside (a focusable, labelled region for keyboard scrolling). */
  scroll?: boolean;
  className?: string;
}

let seq = 0;

/** `<section class="pnl">` with an optional head (h2 + actions) and a body that may scroll on its own. */
export function panel(opts: PanelOptions): HTMLElement {
  const id = opts.titleId ?? `pnl-${++seq}`;
  const hasTitle = opts.title !== undefined && opts.title !== null && opts.title !== false;
  return h(
    "section",
    { class: `pnl${opts.scroll ? " is-scroll" : ""}${opts.className ? ` ${opts.className}` : ""}`, "aria-labelledby": hasTitle ? id : null },
    hasTitle || opts.actions ? h("div", { class: "pnl-head" }, hasTitle ? h("h2", { id }, opts.title) : null, opts.actions ? h("div", { class: "pg-actions" }, opts.actions) : null) : null,
    h("div", { class: "pnl-body", tabindex: opts.scroll ? "0" : null, role: opts.scroll && hasTitle ? "region" : null, "aria-labelledby": opts.scroll && hasTitle ? id : null }, opts.body),
  );
}
