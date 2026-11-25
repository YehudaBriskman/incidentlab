import "./styles.css";
import { applyLang, getLang, setLang } from "./i18n/i18n";
import { T } from "./i18n/strings-player";
import { getCase } from "./content/load";
import { onConnectivity } from "./lib/api";
import { h, setChildren } from "./lib/dom";
import { cachedAccount, isAdmin, loadAccount, onAccountChange, signOut } from "./lib/session";
import { onEventChange, startEventPolling } from "./lib/event";
import { TA } from "./i18n/strings-account";
import { TG } from "./i18n/strings-game";
import { renderAuthForm, stopAuthTimers, withApprovedAccount } from "./views/auth";
import { renderStats } from "./views/stats";
import { renderCase, stopCaseTimers } from "./views/case";
import { renderHome } from "./views/home";
import { renderToolbox } from "./views/toolbox";
import { eventLine, renderLeaderboard, stopLeaderboard } from "./views/leaderboard";

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
    const board = h("a", { class: "btn btn-sm btn-ghost", href: "#/leaderboard" }, TG().leaderboard);
    if (account === null) {
      setChildren(wrap, board, h("a", { class: "btn btn-sm", href: "#/login" }, TA().signIn));
      return;
    }
    setChildren(
      wrap,
      board,
      h("span", { class: "account-name", dir: "auto" }, account.username),
      isAdmin(account)
        ? h("a", { class: "btn btn-sm btn-ghost", href: "#/admin" }, TG().adminLink)
        : account.status === "approved"
          ? h("a", { class: "btn btn-sm btn-ghost", href: "#/me" }, TA().myStats)
          : null,
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

/* ---------- live event: header countdown + announcement banner ---------- */
const DISMISSED_KEY = "il.announce.dismissed";
function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}
function writeDismissed(text: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, text);
  } catch {
    /* storage blocked: the banner just stays dismissed for this page load */
  }
}

function mountEvent(): void {
  const bar = document.querySelector(".topbar");
  if (!(bar instanceof HTMLElement)) return;
  const clock = h("span", { class: "event-clock mono", hidden: true });
  bar.querySelector(".account-menu")?.before(clock);
  const drawClock = (): void => {
    const line = eventLine();
    clock.textContent = line;
    clock.hidden = line.length === 0;
    bar.classList.toggle("has-event", line.length > 0);
  };

  let dismissedText = readDismissed();
  let currentText: string | null = null;
  const text = h("p", { class: "announce-text", dir: "auto" });
  const label = h("span", { class: "announce-label" });
  const close = h("button", { type: "button", class: "announce-close", "aria-label": TG().dismiss }, "×");
  const banner = h(
    "div",
    { class: "announce", role: "region", hidden: true },
    h("div", { class: "announce-inner", "aria-live": "polite" }, label, text),
    close,
  );
  close.addEventListener("click", () => {
    if (currentText !== null) {
      dismissedText = currentText;
      writeDismissed(currentText);
    }
    banner.hidden = true;
    document.getElementById("app")?.focus({ preventScroll: true });
  });
  bar.after(banner);

  onEventChange((event) => {
    drawClock();
    const a = event?.announcement ?? null;
    currentText = a?.text ?? null;
    if (a === null || a.text === dismissedText) {
      banner.hidden = true;
      return;
    }
    banner.className = `announce announce-${a.level}`;
    banner.setAttribute("aria-label", TG().announcement);
    label.textContent = a.level === "warning" ? "⚠ " : "📣 ";
    if (text.textContent !== a.text) text.textContent = a.text; // textContent only: admin-authored text
    close.setAttribute("aria-label", TG().dismiss);
    banner.hidden = false;
  });
  window.setInterval(drawClock, 1000);
  startEventPolling();
}
mountEvent();

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
  const [path, queryString] = window.location.hash.replace(/^#\/?/, "").split("?");
  const hash = path ?? "";
  const query = new URLSearchParams(queryString ?? "");
  const parts = hash.split("/").filter((part) => part.length > 0).map(decodeURIComponent);
  stopCaseTimers();
  stopAuthTimers();
  stopLeaderboard();
  window.scrollTo(0, 0);

  try {
    if (parts.length === 0) {
      renderHome(appRoot);
      return;
    }
    if (parts[0] === "login" && parts.length === 1) {
      document.title = `${TA().signIn} · IncidentLab`;
      // The instructor's session goes to the admin panel instead of the "sign in as a player" card.
      withApprovedAccount(appRoot, "IncidentLab", () => void (window.location.hash = "#/"), { onAdmin: () => void (window.location.hash = "#/admin") });
      return;
    }
    if (parts[0] === "signup" && parts.length === 1) {
      // After sign-up the account is pending: the gate shows the approval screen, then goes home.
      const goHome = (): void => void (window.location.hash = "#/");
      renderAuthForm(appRoot, { context: "IncidentLab", mode: "sign-up", onSignedIn: () => withApprovedAccount(appRoot, "IncidentLab", goHome) });
      return;
    }
    if (parts[0] === "leaderboard" && parts.length === 1) {
      renderLeaderboard(appRoot, query);
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
