// The navbar: logo, page navigation (aria-current), account menu, language toggle and the ⚙ settings menu.
// Below 640px the navigation, account and language collapse behind a menu button, so the signed-in header
// stays two short rows (this one and the live strip).
import { getLang, isRelabel, setLang } from "../i18n/i18n";
import { T } from "../i18n/strings-player";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { TO } from "../i18n/strings-onboard";
import { TS } from "../i18n/strings-shell";
import { h, restoreFields, setChildren, snapshotFields, type FieldSnapshot } from "../lib/dom";
import { cachedAccount, isAdmin, loadAccount, onAccountChange, signOut } from "../lib/session";
import { createSettingsMenu } from "./settingsMenu";
import { cachedToday, onTodayChange, refreshToday } from "./today";

/** The skip link and footer tagline are static HTML: relabel them in the current language. */
export function labelStatic(): void {
  const link = document.querySelector(".skip-link");
  if (link !== null) link.textContent = TO().skipToContent;
  const tagline = document.querySelector(".footer-tagline");
  if (tagline !== null) tagline.textContent = TO().footerTagline;
}

/* ---------- language toggle ---------- */

/**
 * A language switch re-renders the current route. What the user typed must survive it: snapshot the text
 * fields (in memory only), then refill the re-rendered fields as they appear (views may render async, e.g.
 * after the account loads). Focus stays on the toggle and the scroll position is kept.
 */
type PendingRestore = { hash: string; fields: FieldSnapshot; scrollY: number; focus: HTMLElement | null; until: number };
let pendingRestore: PendingRestore | null = null;
const RESTORE_WINDOW_MS = 5_000;

/** Called by main.ts whenever #app changes (a MutationObserver), and right after a language switch. */
export function applyPendingRestore(): void {
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
  labelStatic();
  applyPendingRestore();
}

function createLangToggle(): HTMLElement {
  const mk = (lang: "en" | "he", label: string): HTMLButtonElement => {
    const btn: HTMLButtonElement = h("button", { type: "button", class: "lang-btn", lang, "aria-pressed": String(getLang() === lang), onclick: () => switchLang(lang, btn) }, label);
    return btn;
  };
  const en = mk("en", "EN");
  const he = mk("he", "עב");
  const wrap = h("div", { class: "lang-toggle", role: "group", "aria-label": T().langToggle }, en, h("span", { class: "lang-sep", "aria-hidden": "true" }, "|"), he);
  window.addEventListener("hashchange", () => {
    en.setAttribute("aria-pressed", String(getLang() === "en"));
    he.setAttribute("aria-pressed", String(getLang() === "he"));
    wrap.setAttribute("aria-label", T().langToggle);
  });
  return wrap;
}

/* ---------- account menu ---------- */

function createAccountMenu(status: Element | null): HTMLElement {
  const wrap = h("nav", { class: "account-menu", "aria-label": TA().accountMenu });
  const draw = (): void => {
    const account = cachedAccount();
    // "on-call: you" only makes sense for someone signed in
    status?.classList.toggle("is-off", account === null);
    wrap.setAttribute("aria-label", TA().accountMenu);
    if (account === null) {
      setChildren(wrap, h("a", { class: "btn btn-sm", href: "#/login" }, TA().signIn));
      return;
    }
    setChildren(
      wrap,
      h("span", { class: "account-name", dir: "auto" }, account.username),
      // finally, not then: offline sign-out still clears the local account, so leave the signed-in page too
      h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => void signOut().catch(() => undefined).finally(() => (window.location.hash = "#/")) }, TA().signOut),
    );
  };
  onAccountChange(draw);
  window.addEventListener("hashchange", draw); // re-label on language change
  draw();
  return wrap;
}

/* ---------- page navigation ---------- */

type NavKey = "cases" | "today" | "leaderboard" | "stats" | "author" | "admin";
const NAV_KEYS: readonly NavKey[] = ["cases", "today", "leaderboard", "stats", "author", "admin"];

/** Which nav entry is the current page, from the hash. */
function currentNav(todayId: string | null): NavKey | null {
  const parts = window.location.hash.replace(/^#\/?/, "").split("?")[0]?.split("/").filter((p) => p.length > 0) ?? [];
  if (parts.length === 0) return "cases";
  if (parts[0] === "leaderboard") return "leaderboard";
  if (parts[0] === "me") return "stats";
  if (parts[0] === "admin") return "admin";
  if (parts[0] === "author") return "author";
  if (parts[0] === "case" && parts.length === 2 && todayId !== null && decodeURIComponent(parts[1] ?? "") === todayId) return "today";
  return null;
}

function createSiteNav(): HTMLElement {
  // Built once and updated in place, so focus on a link survives a navigation or a language switch.
  const links: Record<NavKey, HTMLAnchorElement> = {
    cases: h("a", { class: "nav-link", href: "#/" }),
    today: h("a", { class: "nav-link", href: "#/" }),
    leaderboard: h("a", { class: "nav-link", href: "#/leaderboard" }),
    stats: h("a", { class: "nav-link", href: "#/me" }),
    author: h("a", { class: "nav-link", href: "#/author" }),
    admin: h("a", { class: "nav-link", href: "#/admin" }),
  };
  const items = NAV_KEYS.map((key) => h("li", { class: "nav-item" }, links[key]));
  const list = h("ul", { class: "nav-list" }, items);
  const nav = h("nav", { class: "site-nav" }, list);
  const draw = (): void => {
    const account = cachedAccount();
    const todayId = cachedToday()?.caseId ?? null;
    const labels: Record<NavKey, string> = { cases: TS().navCases, today: TS().navToday, leaderboard: TG().leaderboard, stats: TA().myStats, author: TS().navAuthor, admin: TG().adminLink };
    const shown: Record<NavKey, boolean> = {
      cases: true,
      today: todayId !== null && !isAdmin(account),
      leaderboard: true,
      // the forced password screen gates every view, so My stats waits for an approved, settled account
      stats: account !== null && !isAdmin(account) && account.status === "approved" && !account.mustChangePassword,
      // authors and the instructor manage cases (#66); approval and password state are enforced by the server
      author: account !== null && (account.role === "author" || isAdmin(account)),
      admin: isAdmin(account),
    };
    const current = currentNav(todayId);
    nav.setAttribute("aria-label", TS().navMain);
    NAV_KEYS.forEach((key, i) => {
      const link = links[key];
      if (link.textContent !== labels[key]) link.textContent = labels[key];
      if (key === "today" && todayId !== null) link.href = `#/case/${encodeURIComponent(todayId)}`;
      if (key === current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
      const item = items[i];
      if (item !== undefined) item.hidden = !shown[key];
    });
  };
  onAccountChange(draw);
  onTodayChange(draw);
  window.addEventListener("hashchange", draw);
  draw();
  return nav;
}

/* ---------- mount ---------- */

/** Fills header.navbar: [logo] [menu button] [panel: nav · account · language] [⚙]. */
export function mountNavbar(header: HTMLElement): void {
  const row = header.querySelector(".navbar-row");
  if (!(row instanceof HTMLElement)) return;
  const status = header.querySelector(".topbar-status");

  const panel = h("div", { id: "nav-panel", class: "nav-panel" }, createSiteNav(), createAccountMenu(status), createLangToggle());
  const menuIcon = h("span", { class: "nav-toggle-icon", "aria-hidden": "true" }, "☰");
  const menuButton = h("button", { type: "button", class: "nav-toggle", "aria-controls": "nav-panel", "aria-expanded": "false" }, menuIcon);
  const setOpen = (open: boolean, returnFocus = false): void => {
    header.classList.toggle("is-open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    if (!open && returnFocus) menuButton.focus();
  };
  menuButton.addEventListener("click", () => setOpen(!header.classList.contains("is-open")));
  header.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && header.classList.contains("is-open")) {
      ev.preventDefault();
      setOpen(false, panel.contains(document.activeElement));
    }
  });
  document.addEventListener("click", (ev) => {
    if (ev.target instanceof Node && !panel.contains(ev.target) && !menuButton.contains(ev.target)) setOpen(false);
  });
  const label = (): void => {
    menuButton.setAttribute("aria-label", TS().navMenu);
    menuButton.title = TS().navMenu;
  };
  window.addEventListener("hashchange", () => {
    if (!isRelabel()) setOpen(false); // a navigation closes the menu; a language switch inside it does not
    label();
  });
  label();

  row.append(menuButton, panel, ...createSettingsMenu());
  refreshToday();
  loadAccount().catch(() => undefined);
}
