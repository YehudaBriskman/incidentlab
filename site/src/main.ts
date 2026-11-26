import "./styles.css";
import { applyLang, isRelabel, noteRoute } from "./i18n/i18n";
import { T } from "./i18n/strings-player";
import { caseSummary, catalogReady, loadAllCases, loadCase, onCatalogChange } from "./content/load";
import { h, setChildren } from "./lib/dom";
import type { View, ViewResult } from "./shell/types";
import { initSidebar, reserveSidebar, showSidebar } from "./shell/sidebar";
import { closeOverlays, toast } from "./lib/overlay";
import { TA } from "./i18n/strings-account";
import { TO } from "./i18n/strings-onboard";
import { homeView } from "./views/home";
import { renderLeaderboard, stopLeaderboard } from "./views/leaderboard";
import { applyPendingRestore, labelStatic, mountNavbar } from "./shell/navbar";
import { mountLiveStrip } from "./shell/liveStrip";
import { applySettings, loadSettings } from "./shell/settings";

applySettings(loadSettings()); // settings-boot.js already did this before first paint; resync in case it failed
applyLang();
labelStatic();

/* ---------- app shell: navbar, live strip, announcement (src/shell/) ---------- */
const header = document.querySelector("header.navbar");
if (header instanceof HTMLElement) {
  mountNavbar(header);
  mountLiveStrip(header);
}

const root = document.getElementById("app");
if (!(root instanceof HTMLElement)) throw new Error("#app root missing");
const appRoot: HTMLElement = root;

/* ---------- per-page sidebar (src/shell/sidebar.ts) ---------- */
const sidebarEl = document.getElementById("sidebar");
const pageHeaderEl = document.querySelector(".page-header");
if (sidebarEl instanceof HTMLElement && pageHeaderEl instanceof HTMLElement) initSidebar(sidebarEl, pageHeaderEl);
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

/** Puts a view on screen: its main content in #app, its sidebar and page header in the shell, then starts it. */
function mount(view: ViewResult): void {
  // A language switch re-renders the route: the new view starts from the old page's nodes, as views did
  // when they drew into #app itself, so they can carry over what was typed (auth's draft, field restore).
  if (isRelabel() && view.main.childNodes.length === 0) {
    const only = appRoot.childElementCount === 1 ? appRoot.firstElementChild : null;
    const old = only instanceof HTMLElement && only.classList.contains("view") ? only : appRoot;
    view.main.append(...old.childNodes);
  }
  setChildren(appRoot, view.main);
  showSidebar(view.sidebar ?? null, view.header ?? null);
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
  showSidebar(null);
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
const loadAuthView = (): Promise<AuthView> => import("./views/auth").then((m) => (authView = m));
const loadCaseViews = (): Promise<CaseViews> =>
  Promise.all([import("./views/case"), import("./views/toolbox"), loadAuthView()]).then(([caseView, toolbox]) => (caseViews = { ...caseView, ...toolbox }));

/**
 * Does `id` name a case this site can show (bundled, or DB-published and already merged into the catalog)?
 * The router asks before loading any case chunk. Kept as its own function so the catalog check has one home.
 */
function isKnownCase(id: string): boolean {
  return caseSummary(id) !== undefined;
}

/**
 * Routes whose view has a sidebar: home, a case, its toolbox and its Explorer, and admin. Their column is reserved
 * while the view loads (a DB case may not be in the catalog yet; an unknown id releases it on the 404).
 * public/settings-boot.js runs the same test before first paint; keep them in step.
 */
function sidebarRoute(parts: readonly string[]): boolean {
  if (parts.length === 0) return false; // home: a dashboard without a sidebar
  // Admin: its sign-in gate releases the column again (views/admin.ts); the signed-in dashboard doesn't shift.
  if (parts.length === 1 && parts[0] === "admin") return true;
  const [section, id, sub] = parts;
  return section === "case" && id !== undefined && parts.length <= 3 && (sub === undefined || sub === "toolbox" || sub === "explorer");
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
  if (!isRelabel()) {
    closeOverlays(); // a dialog or menu belongs to the page it was opened on
    window.scrollTo(0, 0);
    // The next page's column is there (or gone) before its code loads, so it never shifts in.
    if (sidebarRoute(parts)) reserveSidebar(true);
    else showSidebar(null);
  }

  try {
    if (parts.length === 0) {
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
      mount(legacy((root) => renderLeaderboard(root, query))());
      return;
    }
    if (parts[0] === "me" && parts.length === 1) {
      lazyView(() => Promise.all([import("./views/stats"), loadAuthView()]).then(([m]) => legacy(m.renderStats)));
      return;
    }
    if (parts[0] === "author" && parts.length === 1) {
      lazyView(() => import("./views/author").then((m) => legacy(m.renderAuthor)));
      return;
    }
    if (parts[0] === "admin" && parts.length === 1) {
      // Admin shows titles and question names of every case: load them all (in parallel with its code).
      // Its sections are sidebar navigation (#60); the view re-attaches the same dashboard on #/admin?tab=… changes.
      lazyView(() => Promise.all([import("./views/admin"), loadAllCases()]).then(([m]): View => m.adminView));
      return;
    }
    if (parts[0] === "case" && parts[1] !== undefined) {
      const id = parts[1];
      const sub = parts[2];
      if (sub !== undefined && sub !== "toolbox" && sub !== "explorer") {
        notFound(TO().notOnRunbook);
        return;
      }
      if (!isKnownCase(id)) {
        // It may be a DB-published case the catalog fetch hasn't merged yet: wait for it once, then decide.
        const token = routeToken;
        void catalogReady.then(() => {
          if (token !== routeToken) return;
          if (!isKnownCase(id)) notFound(T().caseMissing(id));
          else route();
        });
        return;
      }
      // The case's content is its own chunk (per language), fetched only now.
      const missing: View = () => ({ main: h("div", { class: "view" }), start: () => notFound(T().caseMissing(id)) });
      if (sub === "explorer") {
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
// DB-published cases that add to (or retitle) the bundled catalog: redraw the current page once with them.
onCatalogChange(route);
route();
