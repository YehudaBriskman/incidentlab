import "./styles.css";
import { applyLang, isRelabel, noteRoute } from "./i18n/i18n";
import { T } from "./i18n/strings-player";
import { caseSummary, catalogFailed, catalogLoading, catalogReady, loadAllCases, loadCase, reloadCatalog } from "./content/load";
import { h, setChildren } from "./lib/dom";
import type { View, ViewResult } from "./shell/types";
import { closeOverlays, toast } from "./lib/overlay";
import { TA } from "./i18n/strings-account";
import { TO } from "./i18n/strings-onboard";
import { TE } from "./i18n/strings-errors";
import { claimReload, classifyLoadError, clearReloadGuard, isChunkLoadError } from "./lib/load-recovery";
import { homeView } from "./views/home";
import { landingView } from "./views/landing";
import { playNow } from "./lib/playNow";
import { renderLeaderboard, stopLeaderboard } from "./views/leaderboard";
import { applyPendingRestore, labelStatic } from "./shell/lang";
import { mountNav } from "./shell/nav";
import { mountTopbar } from "./shell/topbar";
import { initFrame, reserveAside, resetContentScroll, showPage } from "./shell/frame";
import { applySettings, loadSettings } from "./shell/settings";
import { focusRoute } from "./shell/routeFocus";
import { parseSettingsRoute } from "./lib/settings-route";

applySettings(loadSettings()); // settings-boot.js already did this before first paint; resync in case it failed
applyLang();
labelStatic();

const root = document.getElementById("app");
if (!(root instanceof HTMLElement)) throw new Error("#app root missing");
const appRoot: HTMLElement = root;

/* ---------- app frame: global nav, top bar, content area (src/shell/) ---------- */
const navEl = document.getElementById("app-nav");
if (navEl instanceof HTMLElement) mountNav(navEl);
const topbarEl = document.querySelector("header.topbar");
if (topbarEl instanceof HTMLElement) mountTopbar(topbarEl);
const contentEl = document.querySelector("main.app-content");
const pageHeaderEl = document.querySelector(".page-header");
const asideEl = document.querySelector("aside.page-aside");
const noticeEl = document.querySelector(".app-notice");
if (contentEl instanceof HTMLElement && pageHeaderEl instanceof HTMLElement && asideEl instanceof HTMLElement && noticeEl instanceof HTMLElement) {
  initFrame({ content: contentEl, header: pageHeaderEl, aside: asideEl, notice: noticeEl });
}
new MutationObserver(() => applyPendingRestore()).observe(appRoot, { childList: true, subtree: true });

/* ---------- global safety net: never white-screen ---------- */
// Uncaught errors become error toasts (lib/overlay.ts): they stay until dismissed and repeats count up.
window.addEventListener("error", (ev) => {
  console.error(ev.error ?? ev.message);
  toast({ tone: "error", text: T().toastError });
});
window.addEventListener("unhandledrejection", (ev) => {
  console.error(ev.reason);
  toast({ tone: "error", text: T().toastRequestFailed });
});

/** Puts a view on screen: its main content in #app, its nav section, page panel and header in the frame, then starts it. */
function mount(view: ViewResult): void {
  // A language switch re-renders the route: the new view starts from the old page's nodes, as views did
  // when they drew into #app itself, so they can carry over what was typed (auth's draft, field restore).
  if (isRelabel() && view.main.childNodes.length === 0) {
    const only = appRoot.childElementCount === 1 ? appRoot.firstElementChild : null;
    const old = only instanceof HTMLElement && only.classList.contains("view") ? only : appRoot;
    view.main.append(...old.childNodes);
  }
  const relabel = isRelabel();
  setChildren(appRoot, view.main);
  showPage(view);
  view.start?.();
  // A new page takes focus on its h1 (#246); a language switch or same-page redraw keeps focus where it is.
  focusRoute(appRoot.closest("main") ?? appRoot, relabel);
}

/** Adapter for the views still written as `render(root)`: they draw into a layout-neutral wrapper, full width. */
function legacy(render: (root: HTMLElement) => void): View {
  return () => {
    const main = h("div", { class: "view" });
    return { main, start: () => render(main) };
  };
}

function notFound(message: string): void {
  document.title = T().notFoundTitle;
  showPage(null);
  setChildren(
    appRoot,
    h(
      "section",
      { class: "center-card not-found" },
      h("p", { class: "not-found-code mono" }, "404"),
      h("h1", {}, message),
      message === TO().notOnRunbook ? h("p", { class: "muted" }, TO().notFoundHint) : null,
      h(
        "div",
        { class: "row-center" },
        h("a", { class: "btn btn-primary", href: "#/cases" }, T().backToCases),
        h("a", { class: "btn btn-ghost", href: "#/leaderboard" }, TO().toLeaderboard),
      ),
    ),
  );
}

/* ---------- load failures (#208, #209): "couldn't load" is not "not found" ---------- */

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Set while the "couldn't load" card is on screen: what Try again (and coming back online) runs. */
let failedRetry: (() => void) | null = null;
let reloading = false;

/** Try again: fetch the catalog again if it was the part that failed, then run the route from the start. */
function retryRoute(): void {
  if (catalogFailed()) void reloadCatalog();
  route();
}

/**
 * A route's code is gone (a deploy replaced its chunk): reload once, with a note. False when the one reload
 * was already spent (sessionStorage guard) or storage is blocked; the caller then shows the "couldn't load" card.
 */
function reloadForUpdate(): boolean {
  if (reloading) return true;
  if (!claimReload(sessionStore(), Date.now())) return false;
  reloading = true;
  failedRetry = null;
  showPage(null);
  setChildren(appRoot, h("section", { class: "center-card", role: "status" }, h("p", { class: "muted" }, TE().updatedReloading)));
  window.setTimeout(() => window.location.reload(), 300);
  return true;
}

/** The "couldn't load" card: offline, a server error, or failed content, catalog or code. Never a 404. */
function loadFailed(err: unknown): void {
  const kind = classifyLoadError(err, navigator.onLine);
  // A failed module import stays failed in this document: only a reload fetches it again.
  const needsReload = kind !== "offline" && isChunkLoadError(err);
  const retry = needsReload ? (): void => window.location.reload() : retryRoute;
  failedRetry = retry;
  document.title = TE().loadFailedPageTitle;
  showPage(null);
  const body =
    kind === "offline" ? TE().loadFailedOffline : needsReload ? TE().loadFailedCode : kind === "server" ? TE().loadFailedServer : TE().loadFailedOther;
  setChildren(
    appRoot,
    h(
      "section",
      { class: "center-card load-failed", role: "alert" },
      h("h1", {}, TE().loadFailedTitle),
      h("p", { class: "muted" }, body),
      h(
        "div",
        { class: "row-center" },
        h("button", { type: "button", class: "btn btn-primary", onclick: retry }, needsReload ? TE().reloadPage : T().tryAgain),
        h("a", { class: "btn btn-ghost", href: "#/cases" }, T().backToCases),
      ),
    ),
  );
}

// Back online with the card up: try again without waiting for a click.
window.addEventListener("online", () => failedRetry?.());

// Vite's preload helper fires this when a dynamic import, its dependencies or its CSS fail. Reloading here covers
// every dynamic import, not only the router's. No preventDefault: that would make the import resolve to
// undefined, and the caller would take a missing module for a loaded one. The import still rejects.
window.addEventListener("vite:preloadError", () => {
  if (navigator.onLine) reloadForUpdate();
});

function loadingView(): void {
  setChildren(appRoot, h("section", { class: "center-card" }, h("p", { class: "muted mono" }, T().loading)));
}

/**
 * Render a view whose code or content loads asynchronously. A language switch keeps the current page up
 * until the re-render is ready (no "Loading…" flash); a navigation shows the loading card at once.
 */
function lazyView(load: () => Promise<View>): void {
  if (!isRelabel() || appRoot.childElementCount === 0) loadingView();
  const token = routeToken;
  load()
    .then((view) => {
      if (token === routeToken) mount(view());
      clearReloadGuard(sessionStore()); // this route's code loaded and ran: a later deploy may reload once again
    })
    .catch((err: unknown) => {
      console.error(err);
      if (reloading || token !== routeToken) return;
      if (navigator.onLine && isChunkLoadError(err) && reloadForUpdate()) return;
      loadFailed(err);
    });
}

let routeToken = 0;
/** Case ids already re-checked against a fresh catalog (once per page load, so an unknown id can't loop). */
const recheckedCases = new Set<string>();

/*
 * The case, toolbox, stats and sign-in views (and the markdown renderer they pull in) are chunks of their
 * own. Every view that uses the account gate imports the auth view, so each of their loaders also loads it
 * here: whenever auth's timers could be running, `authView` is set and the router can stop them.
 */
type AuthView = typeof import("./views/auth");
type CaseViews = typeof import("./views/case") & typeof import("./views/toolbox");
let authView: AuthView | null = null;
let caseViews: CaseViews | null = null;
/** The class page and class management (#182): their timers stop on every route change once loaded. */
type ClassPage = typeof import("./views/classPage");
type ClassManage = typeof import("./views/classManage");
let classPage: ClassPage | null = null;
let classManage: ClassManage | null = null;
const loadClassPage = (): Promise<ClassPage> => Promise.all([import("./views/classPage"), loadAuthView()]).then(([m]) => (classPage = m));
const loadClassManage = (): Promise<ClassManage> => Promise.all([import("./views/classManage"), loadAuthView()]).then(([m]) => (classManage = m));
const loadAuthView = (): Promise<AuthView> => import("./views/auth").then((m) => (authView = m));
const loadCaseViews = (): Promise<CaseViews> =>
  Promise.all([import("./views/case"), import("./views/toolbox"), loadAuthView()]).then(([caseView, toolbox]) => (caseViews = { ...caseView, ...toolbox }));

/** Every case (the dashboards show all titles); a failed catalog rejects, so the route shows "couldn't load". */
const loadEveryCase = (): Promise<void> =>
  loadAllCases().then(() => {
    if (catalogFailed()) throw new Error("The case catalog could not be loaded.");
  });

/**
 * Does `id` name a case this site can show? The content API's catalog (GET /api/cases) is the only list of
 * cases; the router asks before loading any case content. Kept as its own function so the check has one home.
 */
function isKnownCase(id: string): boolean {
  return caseSummary(id) !== undefined;
}

/**
 * Routes whose view has a page panel: a case's toolbox and its Explorer. The column is reserved while the view
 * loads (a DB case may not be in the catalog yet; an unknown id releases it on the 404).
 * public/settings-boot.js runs the same test before first paint; keep them in step.
 */
function asideRoute(parts: readonly string[]): boolean {
  const [section, id, sub] = parts;
  if (parseSettingsRoute(parts)?.kind === "section") return true; // the settings sections list (#219)
  return section === "case" && id !== undefined && parts.length === 3 && (sub === "toolbox" || sub === "explorer");
}

function route(): void {
  routeToken++;
  failedRetry = null;
  if (reloading) return; // the page is about to reload for a new deploy
  // Strip the "?query" part (Explorer deep links: #/case/<id>/explorer?f=...) before matching.
  const [path, queryString] = window.location.hash.replace(/^#\/?/, "").split("?");
  const hash = path ?? "";
  const query = new URLSearchParams(queryString ?? "");
  const parts = hash.split("/").filter((part) => part.length > 0).map(decodeURIComponent);
  noteRoute();
  caseViews?.stopCaseTimers();
  authView?.stopAuthTimers();
  stopLeaderboard();
  classPage?.stopClassPage();
  classManage?.stopClassManage(window.location.hash);
  if (!isRelabel()) {
    closeOverlays(); // a dialog or menu belongs to the page it was opened on
    resetContentScroll();
    // The next page's panel column is there (or gone) before its code loads, so it never shifts in.
    if (asideRoute(parts)) reserveAside(true);
    else showPage(null);
  }

  try {
    // #279: #/ is the landing for everyone; Home (#/home) is the dashboard (continue, today, classes, streak, a few
    // recommended cases); Cases is the catalog (#221).
    if (parts.length === 0) {
      mount(landingView());
      return;
    }
    if (parts[0] === "home" && parts.length === 1) {
      mount(homeView("home"));
      return;
    }
    if (parts[0] === "cases" && parts.length === 1) {
      mount(homeView("cases"));
      return;
    }
    if ((parts[0] === "login" || parts[0] === "signup") && parts.length === 1) {
      const signUp = parts[0] === "signup";
      document.title = `${signUp ? TA().signUpBtn : TA().signIn} · IncidentLab`;
      const code = query.get("code")?.trim();
      // Both routes run the account gate: signed out -> the form (a `?code=` class link prefills the class
      // code); signed in -> the pending / rejected / password screens, or the dashboard (#/home) once approved. The
      // instructor's session goes to the admin panel instead of the "sign in as a player" card.
      lazyView(() =>
        loadAuthView().then((auth) =>
          legacy((root) =>
            auth.withApprovedAccount(root, "IncidentLab", () => void (window.location.hash = "#/home"), {
              onAdmin: () => void (window.location.hash = "#/admin"),
              signedOutMode: signUp ? "sign-up" : "sign-in",
              inviteCode: code !== undefined && code.length > 0 ? code.slice(0, 40) : undefined,
              titled: true,
            }),
          ),
        ),
      );
      return;
    }
    // #225: the static About and Privacy pages (no API calls).
    if ((parts[0] === "about" || parts[0] === "privacy") && parts.length === 1) {
      const which = parts[0];
      lazyView(() => import("./views/pages").then((m): View => (which === "about" ? m.aboutView : m.privacyView)));
      return;
    }
    // #223: "Play now" as an address (the static hero's link in index.html works before the app boots): a guest
    // session when signed out, then the start-here case. It replaces itself in the history, so Back skips it.
    if (parts[0] === "play" && parts.length === 1) {
      loadingView();
      const token = routeToken;
      void playNow({ replace: true }).then((ok) => {
        if (!ok && token === routeToken) window.location.replace("#/home");
      });
      return;
    }
    if (parts[0] === "leaderboard" && parts.length === 1) {
      // The case picker and titles come from the catalog: wait for it on a cold load (instant afterwards).
      if (catalogLoading()) lazyView(() => catalogReady.then(() => legacy((root) => renderLeaderboard(root, query))));
      else mount(legacy((root) => renderLeaderboard(root, query))());
      return;
    }
    // Classes (#182): my classes, the join link, a class page, its management and its board (a capability URL).
    if (parts[0] === "classes" && parts.length === 1) {
      lazyView(() => Promise.all([import("./views/classes"), loadAuthView()]).then(([m]): View => m.classesView));
      return;
    }
    if (parts[0] === "join" && parts[1] !== undefined && parts.length === 2) {
      const code = parts[1];
      lazyView(() => Promise.all([import("./views/classes"), loadAuthView()]).then(([m]): View => () => m.joinView(code)));
      return;
    }
    if (parts[0] === "class" && parts[1] !== undefined && (parts.length === 2 || (parts.length === 3 && parts[2] === "manage"))) {
      const id = parts[1];
      // Case titles come from the catalog; management also shows question names (live grid): load every case.
      if (parts[2] === "manage") lazyView(() => Promise.all([loadClassManage(), loadEveryCase()]).then(([m]): View => () => m.classManageView(id)));
      else lazyView(() => Promise.all([loadClassPage(), catalogReady]).then(([m]): View => () => m.classPageView(id)));
      return;
    }
    if (parts[0] === "classboard" && parts[1] !== undefined && parts.length === 2) {
      const board = parts[1];
      const show = legacy((root) => renderLeaderboard(root, query, { board }));
      if (catalogLoading()) lazyView(() => catalogReady.then(() => show));
      else mount(show());
      return;
    }
    if (parts[0] === "me" && parts.length === 1) {
      lazyView(() => Promise.all([import("./views/stats"), loadAuthView(), catalogReady]).then(([m]) => legacy(m.renderStats)));
      return;
    }
    // Settings (#219): #/settings goes to its first section; an unknown section is a 404.
    const settings = parseSettingsRoute(parts);
    if (settings?.kind === "redirect") {
      window.location.replace(settings.to);
      return;
    }
    if (settings?.kind === "section") {
      const section = settings.section;
      lazyView(() => Promise.all([import("./views/settings"), loadAuthView()]).then(([m]): View => () => m.settingsView(section)));
      return;
    }
    if (parts[0] === "author" && parts.length === 1) {
      lazyView(() => import("./views/author").then((m) => legacy(m.renderAuthor)));
      return;
    }
    // The review queue is part of the platform console (#221); its old address under Authoring still works.
    if (parts[0] === "author" && parts[1] === "reviews" && parts.length === 2) {
      window.location.replace("#/admin/reviews");
      return;
    }
    if (parts[0] === "admin" && parts[1] === "reviews" && parts.length === 2) {
      lazyView(() =>
        Promise.all([import("./views/reviews"), import("./views/admin")]).then(([reviews, admin]): View => () => {
          const main = h("div", { class: "view" });
          return { main, nav: admin.consoleNav("reviews"), start: () => reviews.renderReviews(main) };
        }),
      );
      return;
    }
    if (parts[0] === "admin" && parts.length === 1) {
      // Admin shows titles and question names of every case: load them all (in parallel with its code).
      // Its sections are nested items in the global nav; the view re-attaches the same dashboard on #/admin?tab=… changes.
      lazyView(() => Promise.all([import("./views/admin"), loadEveryCase()]).then(([m]): View => m.adminView));
      return;
    }
    if (parts[0] === "case" && parts[1] !== undefined) {
      const id = parts[1];
      const sub = parts[2];
      if (sub !== undefined && sub !== "toolbox" && sub !== "explorer" && sub !== "present") {
        notFound(TO().notOnRunbook);
        return;
      }
      if (catalogLoading()) {
        // Cold deep link: the catalog has not answered yet. Wait for it once, then decide.
        loadingView();
        const token = routeToken;
        void catalogReady.then(() => {
          if (token === routeToken) route();
        });
        return;
      }
      if (!isKnownCase(id)) {
        if (catalogFailed()) {
          loadFailed(undefined); // the catalog never answered: not knowing is not "does not exist"
          return;
        }
        if (!recheckedCases.has(id)) {
          // A case published after this page loaded is not in its catalog yet: ask again once before the 404.
          recheckedCases.add(id);
          void reloadCatalog();
          route();
          return;
        }
        notFound(T().caseMissing(id));
        return;
      }
      // The case's content comes from the content API (per language), fetched only now.
      const missing: View = () => ({ main: h("div", { class: "view" }), start: () => notFound(T().caseMissing(id)) });
      if (sub === "present") {
        lazyView(() => Promise.all([loadCase(id), import("./views/present")]).then(([c, m]): View => (c === undefined ? missing : () => m.presentView(c))));
      } else if (sub === "explorer") {
        lazyView(() => Promise.all([loadCase(id), import("./views/explorer")]).then(([c, m]): View => (c === undefined ? missing : () => m.explorerView(c))));
      } else {
        lazyView(() =>
          Promise.all([loadCase(id), loadCaseViews()]).then(([c, views]): View => {
            if (c === undefined) return missing;
            return sub === "toolbox" ? () => views.toolboxView(c) : () => views.caseView(c);
          }),
        );
      }
      return;
    }
    notFound(TO().notOnRunbook);
  } catch (err) {
    console.error(err);
    notFound(T().pageBroke);
  }
}

// The skip link must not touch the hash, or the router would treat it as a route.
document.querySelector(".skip-link")?.addEventListener("click", (ev) => {
  ev.preventDefault();
  appRoot.focus();
});

window.addEventListener("hashchange", route);
route();
