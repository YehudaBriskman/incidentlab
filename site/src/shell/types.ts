// The contract between the router (main.ts) and the views it shows inside the app frame (shell/frame.ts).
import type { Child } from "../lib/dom";

/** The global nav's top-level items (shell/nav.ts), in their on-screen order. */
export type NavKey = "home" | "today" | "cases" | "leaderboard" | "classes" | "stats" | "author" | "admin";

/**
 * A view's nested items in the global nav: drawn under one top-level item (admin sections under Admin, a case's
 * stages under Cases). The view owns `content` and redraws inside it; the shell moves it between the nav column
 * and the phone drawer, so its state and listeners survive. Build the rows with `navSubLink()` /
 * `navSubButton()` (shell/nav.ts) so they get the icon, label, badge and rail tooltip parts.
 * Links and controls inside close the phone drawer when used (`a[href]`, `[data-nav-close]`).
 */
export interface NavSection {
  /** The top-level item the section hangs under. It is marked `aria-current="true"` (an ancestor of the page). */
  under: NavKey;
  /** Visible heading of the section and the accessible name of its list (a case title, "Sections"). */
  label: string;
  /** Usually a `<ul class="nav-sub-list">` or `<ol>`; any element works. */
  content: HTMLElement;
}

/**
 * A page panel beside the view's main content, inside the content area (the Explorer's file list, the toolbox
 * contents and filter). It scrolls on its own. Up to 1024px it folds away and a page-header button opens the
 * same element in a start-edge Sheet. Forms and filters belong here or in a `filterButton()`, never in the nav.
 */
export interface PageAside {
  /** Accessible name of the <aside> landmark and the drawer title on narrow screens. */
  label: string;
  /** Text of the page-header button that opens it on narrow screens (default: `label`). */
  trigger?: string;
  /** The panel content. The view keeps it and redraws inside; links and `[data-sidebar-close]` close the drawer. */
  content: HTMLElement;
}

/** @deprecated The pre-frame per-page sidebar. Read as `aside` (its `rail` is ignored); use `nav` or `aside`. */
export interface SidebarSpec extends PageAside {
  rail?: HTMLElement;
}

/** What a view hands to the frame. Everything but `main` is optional. */
export interface ViewResult {
  /** Mounted in #app. The view keeps the element and redraws inside it. */
  main: HTMLElement;
  /** Nested items in the global nav (admin sections, case stages). */
  nav?: NavSection;
  /** A page panel beside `main` (files, contents, filters). */
  aside?: PageAside;
  /** @deprecated Use `aside` (or `nav` for navigation). Kept so older views keep working. */
  sidebar?: SidebarSpec;
  /** Optional page-header content above #app (title row, page actions). Build it with `pageHeader()`. */
  header?: Child;
  /**
   * "scroll" (default): the content area scrolls as one reading column (case briefing, debrief, toolbox).
   * "fit": the page fills the content area and its panels scroll inside themselves (dashboards); `main` becomes
   * a flex column of full height. Phones always scroll.
   */
  layout?: "scroll" | "fit";
  /**
   * Runs right after the frame has mounted `main`, `nav`, `aside` and `header`: the place to start loading data
   * and to draw anything that needs to be in the document (focus, measuring, document.getElementById).
   */
  start?: () => void;
}

/** A view: builds its result synchronously; the router mounts it and then calls `start`. */
export type View = () => ViewResult;
