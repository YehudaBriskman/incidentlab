// The contract between the router (main.ts) and the views it shows inside the app shell.
import type { Child } from "../lib/dom";

/** A page's sidebar (shell/sidebar.ts): 264px on desktop, a 64px icon rail at 641–1024px, a Sheet at ≤640px. */
export interface SidebarSpec {
  /** Accessible name of the <aside> landmark, and the title of the drawer on narrow screens. */
  label: string;
  /** Text of the button in the page header that opens the drawer on phones (default: `label`). */
  trigger?: string;
  /**
   * The full content. The view keeps this element and redraws inside it; the shell moves the element
   * itself between the <aside> and the drawer, so its state and listeners survive. Links and controls
   * marked `data-sidebar-close` close the drawer when used.
   */
  content: HTMLElement;
  /** Icon-only shortcuts shown in the 64px rail (tablet, or the collapsed desktop sidebar). Optional. */
  rail?: HTMLElement;
}

/** What a view hands to the shell. A view without `sidebar` keeps the full-width layout. */
export interface ViewResult {
  /** Mounted in #app. The view keeps the element and redraws inside it. */
  main: HTMLElement;
  sidebar?: SidebarSpec;
  /** Optional page-header content (above #app, next to the phone sidebar button). */
  header?: Child;
  /**
   * Runs right after the shell has mounted `main`, `sidebar` and `header`: the place to start loading data
   * and to draw anything that needs to be in the document (focus, measuring, document.getElementById).
   */
  start?: () => void;
}

/** A view: builds its result synchronously; the router mounts it and then calls `start`. */
export type View = () => ViewResult;
