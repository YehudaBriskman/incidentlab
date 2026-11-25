import "./styles.css";
import { applyLang, getLang, setLang } from "./i18n/i18n";
import { T } from "./i18n/strings-player";
import { getCase } from "./content/load";
import { onConnectivity } from "./lib/api";
import { h, setChildren } from "./lib/dom";
import { cachedAccount, loadAccount, onAccountChange, signOut } from "./lib/session";
import { TA } from "./i18n/strings-account";
import { renderAuthForm, stopAuthTimers, withApprovedAccount } from "./views/auth";
import { renderStats } from "./views/stats";
import { renderCase, stopCaseTimers } from "./views/case";
import { renderHome } from "./views/home";
import { renderToolbox } from "./views/toolbox";

applyLang();

/* ---------- language toggle (header, every page) ---------- */
function mountLangToggle(): void {
  const bar = document.querySelector(".topbar");
  if (!(bar instanceof HTMLElement)) return;
  const mk = (lang: "en" | "he", label: string): HTMLButtonElement => {
    const btn = h("button", { type: "button", class: "lang-btn", lang, "aria-pressed": String(getLang() === lang), onclick: () => setLang(lang) }, label);
    return btn;
  };
  const en = mk("en", "EN");
  const he = mk("he", "עב");
  const wrap = h("div", { class: "lang-toggle", role: "group", "aria-label": T().langToggle }, en, h("span", { class: "lang-sep", "aria-hidden": "true" }, "|"), he);
  bar.append(wrap);
  window.addEventListener("hashchange", () => {
    en.setAttribute("aria-pressed", String(getLang() === "en"));
    he.setAttribute("aria-pressed", String(getLang() === "he"));
    wrap.setAttribute("aria-label", T().langToggle);
  });
}
mountLangToggle();

/* ---------- account menu (header, every page) ---------- */
function mountAccountMenu(): void {
  const bar = document.querySelector(".topbar");
  if (!(bar instanceof HTMLElement)) return;
  const wrap = h("nav", { class: "account-menu", "aria-label": TA().accountMenu });
  const draw = (): void => {
    const account = cachedAccount();
    if (account === null) {
      setChildren(wrap, h("a", { class: "btn btn-sm", href: "#/login" }, TA().signIn));
      return;
    }
    setChildren(
      wrap,
      h("span", { class: "account-name", dir: "auto" }, account.username),
      account.status === "approved" ? h("a", { class: "btn btn-sm btn-ghost", href: "#/me" }, TA().myStats) : null,
      h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => void signOut().then(() => (window.location.hash = "#/")) }, TA().signOut),
    );
  };
  bar.querySelector(".lang-toggle")?.before(wrap);
  onAccountChange(draw);
  window.addEventListener("hashchange", draw); // re-label on language change
  draw();
  loadAccount().catch(() => undefined);
}
mountAccountMenu();

const root = document.getElementById("app");
if (!(root instanceof HTMLElement)) throw new Error("#app root missing");
const appRoot: HTMLElement = root;

/* ---------- global safety net: never white-screen ---------- */
const toastHost = h("div", { class: "toast-host", "aria-live": "polite" });
document.body.append(toastHost);
function toast(message: string): void {
  const el = h("div", { class: "toast", role: "status" }, message);
  toastHost.append(el);
  window.setTimeout(() => el.remove(), 5000);
}
window.addEventListener("error", (ev) => {
  console.error(ev.error ?? ev.message);
  toast(T().toastError);
});
window.addEventListener("unhandledrejection", (ev) => {
  console.error(ev.reason);
  toast(T().toastRequestFailed);
});

const banner = h("div", { class: "net-banner", role: "status", hidden: true });
document.body.prepend(banner);
onConnectivity((state) => {
  banner.hidden = state === "ok";
  banner.textContent = state === "retrying" ? T().netRetrying : T().netDown;
});

function notFound(message: string): void {
  document.title = T().notFoundTitle;
  setChildren(
    appRoot,
    h("section", { class: "center-card" }, h("p", { class: "mono accent" }, "404"), h("h1", {}, message), h("a", { class: "btn btn-primary", href: "#/" }, T().backToCases)),
  );
}

function loadingView(): void {
  setChildren(appRoot, h("section", { class: "center-card" }, h("p", { class: "muted mono" }, T().loading)));
}

function lazyView(load: () => Promise<(root: HTMLElement) => void>): void {
  loadingView();
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

function route(): void {
  routeToken++;
  // Strip the "?query" part (Explorer deep links: #/case/<id>/explorer?f=...) before matching.
  const hash = (window.location.hash.replace(/^#\/?/, "").split("?")[0]) ?? "";
  const parts = hash.split("/").filter((part) => part.length > 0).map(decodeURIComponent);
  stopCaseTimers();
  stopAuthTimers();
  window.scrollTo(0, 0);

  try {
    if (parts.length === 0) {
      renderHome(appRoot);
      return;
    }
    if (parts[0] === "login" && parts.length === 1) {
      document.title = `${TA().signIn} · IncidentLab`;
      withApprovedAccount(appRoot, "IncidentLab", () => void (window.location.hash = "#/"));
      return;
    }
    if (parts[0] === "signup" && parts.length === 1) {
      // After sign-up the account is pending: the gate shows the approval screen, then goes home.
      const goHome = (): void => void (window.location.hash = "#/");
      renderAuthForm(appRoot, { context: "IncidentLab", mode: "sign-up", onSignedIn: () => withApprovedAccount(appRoot, "IncidentLab", goHome) });
      return;
    }
    if (parts[0] === "me" && parts.length === 1) {
      renderStats(appRoot);
      return;
    }
    if (parts[0] === "admin" && parts.length === 1) {
      lazyView(() => import("./views/admin").then((m) => m.renderAdmin));
      return;
    }
    if (parts[0] === "case" && parts[1] !== undefined) {
      const c = getCase(parts[1]);
      if (!c) {
        notFound(T().caseMissing(parts[1]));
        return;
      }
      const sub = parts[2];
      if (sub === undefined) renderCase(appRoot, c);
      else if (sub === "toolbox") renderToolbox(appRoot, c);
      else if (sub === "explorer") lazyView(() => import("./views/explorer").then((m) => (root: HTMLElement) => m.renderExplorer(root, c)));
      else notFound(T().notOnRunbook);
      return;
    }
    notFound(T().notOnRunbook);
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
