import "./styles.css";
import { applyLang, isRelabel, noteRoute } from "./i18n/i18n";
import { T } from "./i18n/strings-player";
import { caseSummary, catalogReady, loadAllCases, loadCase, onCatalogChange } from "./content/load";
import { h, setChildren } from "./lib/dom";
import { TA } from "./i18n/strings-account";
import { TO } from "./i18n/strings-onboard";
import { renderHome } from "./views/home";
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
new MutationObserver(() => applyPendingRestore()).observe(appRoot, { childList: true, subtree: true });

/* ---------- global safety net: never white-screen ---------- */
/*
 * Error toasts (the global safety net): one polite host, no per-toast role, so nothing is announced twice.
 * The same message is never stacked: a repeat bumps a "×n" counter. They stay until dismissed (WCAG 2.2.1,
 * errors never auto-dismiss); at most 3 on screen, the oldest goes first.
 */
const TOAST_MAX = 3;
const toastHost = h("div", { class: "toast-host", "aria-live": "polite" });
document.body.append(toastHost);
type ToastEntry = { el: HTMLElement; count: number; countEl: HTMLElement };
const toasts = new Map<string, ToastEntry>();

function removeToast(message: string): void {
  const entry = toasts.get(message);
  if (entry === undefined) return;
  const hadFocus = entry.el.contains(document.activeElement);
  entry.el.remove();
  toasts.delete(message);
  if (hadFocus) document.getElementById("app")?.focus({ preventScroll: true });
}

function toast(message: string): void {
  const existing = toasts.get(message);
  if (existing !== undefined) {
    existing.count++;
    existing.countEl.textContent = TO().toastCount(existing.count);
    existing.countEl.hidden = false;
    return;
  }
  const countEl = h("span", { class: "toast-count", hidden: true });
  const close = h("button", { type: "button", class: "toast-close", "aria-label": TO().toastDismiss, onclick: () => removeToast(message) }, "×");
  const el = h("div", { class: "toast toast-error" }, h("p", { class: "toast-text" }, message, " ", countEl), close);
  toasts.set(message, { el, count: 1, countEl });
  toastHost.append(el);
  while (toasts.size > TOAST_MAX) {
    const oldest = toasts.keys().next().value;
    if (oldest === undefined) break;
    removeToast(oldest);
  }
}
window.addEventListener("error", (ev) => {
  console.error(ev.error ?? ev.message);
  toast(T().toastError);
});
window.addEventListener("unhandledrejection", (ev) => {
  console.error(ev.reason);
  toast(T().toastRequestFailed);
});

function notFound(message: string): void {
  document.title = T().notFoundTitle;
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
function lazyView(load: () => Promise<(root: HTMLElement) => void>): void {
  if (!isRelabel() || appRoot.childElementCount === 0) loadingView();
  const token = routeToken;
  load()
    .then((render) => {
      if (token === routeToken) render(appRoot);
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
  if (!isRelabel()) window.scrollTo(0, 0);

  try {
    if (parts.length === 0) {
      renderHome(appRoot);
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
        loadAuthView().then((auth) => (root: HTMLElement) =>
          auth.withApprovedAccount(root, "IncidentLab", () => void (window.location.hash = "#/"), {
            onAdmin: () => void (window.location.hash = "#/admin"),
            signedOutMode: signUp ? "sign-up" : "sign-in",
            inviteCode: code !== undefined && code.length > 0 ? code.slice(0, 40) : undefined,
            titled: true,
          }),
        ),
      );
      return;
    }
    if (parts[0] === "leaderboard" && parts.length === 1) {
      renderLeaderboard(appRoot, query);
      return;
    }
    if (parts[0] === "me" && parts.length === 1) {
      lazyView(() => Promise.all([import("./views/stats"), loadAuthView()]).then(([m]) => m.renderStats));
      return;
    }
    if (parts[0] === "admin" && parts.length === 1) {
      // Admin shows titles and question names of every case: load them all (in parallel with its code).
      lazyView(() => Promise.all([import("./views/admin"), loadAllCases()]).then(([m]) => m.renderAdmin));
      return;
    }
    if (parts[0] === "case" && parts[1] !== undefined) {
      const id = parts[1];
      const sub = parts[2];
      if (sub !== undefined && sub !== "toolbox" && sub !== "explorer") {
        notFound(TO().notOnRunbook);
        return;
      }
      if (caseSummary(id) === undefined) {
        // It may be a DB-published case the catalog fetch hasn't merged yet: wait for it once, then decide.
        const token = routeToken;
        void catalogReady.then(() => {
          if (token !== routeToken) return;
          if (caseSummary(id) === undefined) notFound(T().caseMissing(id));
          else route();
        });
        return;
      }
      // The case's content is its own chunk (per language), fetched only now.
      const missing = (): void => notFound(T().caseMissing(id));
      if (sub === "explorer") {
        lazyView(() =>
          Promise.all([loadCase(id), import("./views/explorer")]).then(([c, m]) => (c === undefined ? missing : (root: HTMLElement) => m.renderExplorer(root, c))),
        );
      } else {
        lazyView(() =>
          Promise.all([loadCase(id), loadCaseViews()]).then(([c, views]) => {
            const render = sub === "toolbox" ? views.renderToolbox : views.renderCase;
            return c === undefined ? missing : (root: HTMLElement) => render(root, c);
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
