import "./styles.css";
import { applyLang, getLang, isRelabel, noteRoute, setLang } from "./i18n/i18n";
import { T } from "./i18n/strings-player";
import { caseSummary, loadAllCases, loadCase } from "./content/load";
import { onConnectivity } from "./lib/api";
import { h, restoreFields, setChildren, snapshotFields, type FieldSnapshot } from "./lib/dom";
import { cachedAccount, isAdmin, loadAccount, onAccountChange, signOut } from "./lib/session";
import { cachedEvent, onEventChange, startEventPolling } from "./lib/event";
import { TA } from "./i18n/strings-account";
import { TG } from "./i18n/strings-game";
import { renderHome } from "./views/home";
import { eventDisplayPhase, eventLine, eventWhen, renderLeaderboard, stopLeaderboard } from "./views/leaderboard";

applyLang();

/* ---------- language toggle (header, every page) ---------- */

/**
 * A language switch re-renders the current route. What the user typed must survive it: snapshot the text
 * fields (in memory only), then refill the re-rendered fields as they appear (views may render async, e.g.
 * after the account loads). Focus stays on the toggle and the scroll position is kept.
 */
type PendingRestore = { hash: string; fields: FieldSnapshot; scrollY: number; focus: HTMLElement | null; until: number };
let pendingRestore: PendingRestore | null = null;
const RESTORE_WINDOW_MS = 5_000;

function applyPendingRestore(): void {
  const pending = pendingRestore;
  const app = document.getElementById("app");
  if (pending === null || app === null) return;
  if (pending.hash !== window.location.hash || Date.now() > pending.until) {
    pendingRestore = null;
    return;
  }
  restoreFields(app, pending.fields);
  if (pending.focus !== null && document.activeElement !== pending.focus && app.contains(document.activeElement)) {
    pending.focus.focus({ preventScroll: true }); // a view auto-focused its first field: give focus back
  }
  if (pending.scrollY > 0 && document.documentElement.scrollHeight >= pending.scrollY + window.innerHeight) {
    window.scrollTo(0, pending.scrollY);
    pending.scrollY = 0;
  }
  if (pending.fields.size === 0 && pending.scrollY === 0 && pending.focus === null) pendingRestore = null;
}

function switchLang(lang: "en" | "he", button: HTMLElement): void {
  if (lang === getLang()) return;
  const app = document.getElementById("app");
  pendingRestore = {
    hash: window.location.hash,
    fields: app === null ? new Map() : snapshotFields(app),
    scrollY: window.scrollY,
    focus: document.activeElement === button ? button : null,
    until: Date.now() + RESTORE_WINDOW_MS,
  };
  setLang(lang);
  applyPendingRestore();
}

function mountLangToggle(): void {
  const bar = document.querySelector(".topbar");
  if (!(bar instanceof HTMLElement)) return;
  const mk = (lang: "en" | "he", label: string): HTMLButtonElement => {
    const btn: HTMLButtonElement = h("button", { type: "button", class: "lang-btn", lang, "aria-pressed": String(getLang() === lang), onclick: () => switchLang(lang, btn) }, label);
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
  // The event name truncates; the countdown never does (it is the part that matters). Full text in `title`.
  const clockDot = h("span", { class: "dot", "aria-hidden": "true" });
  const clockName = h("span", { class: "event-clock-name", dir: "auto" });
  const clockTime = h("span", { class: "event-clock-time" });
  const clock = h("span", { class: "event-clock mono", hidden: true }, clockDot, clockName, clockTime);
  bar.querySelector(".account-menu")?.before(clock);
  const drawClock = (): void => {
    const line = eventLine();
    const event = cachedEvent();
    const phase = eventDisplayPhase();
    clock.hidden = line.length === 0;
    bar.classList.toggle("has-event", line.length > 0);
    if (line.length === 0 || event === null) return;
    clock.className = `event-clock mono is-${phase}`;
    clock.title = line;
    clockDot.hidden = phase !== "live";
    if (clockName.textContent !== event.name) clockName.textContent = event.name; // textContent only: admin-authored
    clockName.hidden = event.name.length === 0;
    clockTime.textContent = eventWhen();
    clockTime.hidden = clockTime.textContent.length === 0;
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
new MutationObserver(() => applyPendingRestore()).observe(appRoot, { childList: true, subtree: true });

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
        notFound(T().notOnRunbook);
        return;
      }
      if (caseSummary(id) === undefined) {
        notFound(T().caseMissing(id));
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
