import "./styles.css";
import { applyLang, isRelabel, noteRoute } from "./i18n/i18n";
import { T } from "./i18n/strings-player";
import { caseSummary, catalogFailed, catalogLoading, catalogReady, loadAllCases, loadCase } from "./content/load";
import { h, setChildren } from "./lib/dom";
import type { View, ViewResult } from "./shell/types";
import { closeOverlays, toast } from "./lib/overlay";
import { TA } from "./i18n/strings-account";
import { TO } from "./i18n/strings-onboard";
import { homeView } from "./views/home";
import { renderLeaderboard, stopLeaderboard } from "./views/leaderboard";
import { applyPendingRestore, labelStatic } from "./shell/lang";
import { mountNav } from "./shell/nav";
import { mountTopbar } from "./shell/topbar";
import { initFrame, reserveAside, resetContentScroll, showPage } from "./shell/frame";
import { applySettings, loadSettings } from "./shell/settings";

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
  setChildren(appRoot, view.main);
  showPage(view);
  view.start?.();
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
        h("a", { class: "btn btn-primary", href: "#/" }, T().backToCases),
        h("a", { class: "btn btn-ghost", href: "#/leaderboard" }, TO().toLeaderboard),
      ),
    ),
  );
}

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
    })
    .catch((err: unknown) => {
      console.error(err);
      if (token === routeToken) notFound(T().pageFailed);
    });
}

let routeToken = 0;

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
  return section === "case" && id !== undefined && parts.length === 3 && (sub === "toolbox" || sub === "explorer");
}

function route(): void {
  routeToken++;
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
    // #/cases is the catalog entry of the nav; until home splits it out it shows the same dashboard.
    if (parts.length === 0 || (parts[0] === "cases" && parts.length === 1)) {
      mount(homeView());
      return;
    }
    if ((parts[0] === "login" || parts[0] === "signup") && parts.length === 1) {
      const signUp = parts[0] === "signup";
      document.title = `${signUp ? TA().signUpBtn : TA().signIn} · IncidentLab`;
      const code = query.get("code")?.trim();
      // Both routes run the account gate: signed out -> the form (a `?code=` class link prefills the class
      // code); signed in -> the pending / rejected / password screens, or home once approved. The
      // instructor's session goes to the admin panel instead of the "sign in as a player" card.
      lazyView(() =>
        loadAuthView().then((auth) =>
          legacy((root) =>
            auth.withApprovedAccount(root, "IncidentLab", () => void (window.location.hash = "#/"), {
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
      if (parts[2] === "manage") lazyView(() => Promise.all([loadClassManage(), loadAllCases()]).then(([m]): View => () => m.classManageView(id)));
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
    if (parts[0] === "author" && parts.length === 1) {
      lazyView(() => import("./views/author").then((m) => legacy(m.renderAuthor)));
      return;
    }
    if (parts[0] === "author" && parts[1] === "reviews" && parts.length === 2) {
      lazyView(() => import("./views/reviews").then((m) => legacy(m.renderReviews)));
      return;
    }
    if (parts[0] === "admin" && parts.length === 1) {
      // Admin shows titles and question names of every case: load them all (in parallel with its code).
      // Its sections are nested items in the global nav; the view re-attaches the same dashboard on #/admin?tab=… changes.
      lazyView(() => Promise.all([import("./views/admin"), loadAllCases()]).then(([m]): View => m.adminView));
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
        notFound(catalogFailed() ? T().pageFailed : T().caseMissing(id));
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
