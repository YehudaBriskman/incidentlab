// The slim top bar (one row): the menu button (rail widths and phones), the breadcrumb, a compact live status
// chip (the event clock, or today's case and the countdown to the next one), the connectivity chip, EN | עב,
// the ⚙ display settings and the account menu. It replaces the old navbar and the live strip under it.
import { T } from "../i18n/strings-player";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { TS } from "../i18n/strings-shell";
import { onConnectivity } from "../lib/api";
import { h, html, setChildren } from "../lib/dom";
import { cachedEvent, formatCountdown, onEventChange, serverNow, startEventPolling } from "../lib/event";
import { popover } from "../lib/overlay";
import { cachedAccount, isAdmin, loadAccount, onAccountChange, signOut } from "../lib/session";
import { caseSummary, onCatalogChange } from "../content/load";
import { eventDisplayPhase, eventLine, eventWhen } from "../views/leaderboard";
import { ICONS } from "./icons";
import { createLangToggle } from "./lang";
import { currentNavKey, openNavDrawer, routeParts } from "./nav";
import { createSettingsMenu } from "./settingsMenu";
import { cachedToday, msUntilNextDay, onTodayChange, refreshToday } from "./today";

/* ---------- breadcrumb ---------- */

type Crumb = { label: string; href?: string; bdi?: boolean };
let pageCrumb: string | null = null;
let drawCrumbs: () => void = () => undefined;

/**
 * The last crumb for pages whose position is not in the route (an admin section switched by pushState).
 * Null drops it. Redraws at once.
 */
export function setPageCrumb(text: string | null): void {
  pageCrumb = text;
  drawCrumbs();
}

function crumbsFor(parts: readonly string[]): Crumb[] {
  const homeCrumb: Crumb = { label: TS().navHome, href: "#/" };
  const key = currentNavKey(parts);
  const [section, id, sub] = parts;
  if (section === "case" && id !== undefined) {
    const title = caseSummary(id)?.title ?? id;
    const out: Crumb[] = [homeCrumb, { label: TS().navCases, href: "#/cases" }, { label: title, href: `#/case/${encodeURIComponent(id)}`, bdi: true }];
    if (sub === "toolbox") out.push({ label: TS().sideToolbox });
    if (sub === "explorer") out.push({ label: TS().sideExplorer });
    return out;
  }
  if (key === "home") return [{ label: TS().navHome }];
  if (section === "login" || section === "signup") return [homeCrumb, { label: TS().crumbSignIn }];
  const labels: Partial<Record<string, string>> = {
    cases: TS().navCases,
    leaderboard: TG().leaderboard,
    stats: TA().myStats,
    author: TS().navAuthor,
    admin: TG().adminLink,
  };
  const label = key === null ? undefined : labels[key];
  if (label === undefined) return [homeCrumb];
  if (key === "admin" && pageCrumb !== null) return [homeCrumb, { label, href: "#/admin" }, { label: pageCrumb }];
  return [homeCrumb, { label }];
}

function createCrumbs(): HTMLElement {
  const list = h("ol", { class: "crumbs-list" });
  const nav = h("nav", { class: "crumbs" }, list);
  drawCrumbs = (): void => {
    nav.setAttribute("aria-label", TS().crumbs);
    const crumbs = crumbsFor(routeParts());
    setChildren(
      list,
      crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        const text = c.bdi === true ? h("bdi", {}, c.label) : c.label;
        const inner = last || c.href === undefined ? h("span", { class: "crumb-current", "aria-current": last ? "page" : null }, text) : h("a", { class: "crumb-link", href: c.href }, text);
        return h("li", { class: `crumb${last ? " is-last" : ""}` }, inner);
      }),
    );
  };
  window.addEventListener("hashchange", () => {
    pageCrumb = null; // a new route starts without the old page's crumb; the view sets its own again
    drawCrumbs();
  });
  window.addEventListener("popstate", () => drawCrumbs());
  onCatalogChange(() => drawCrumbs()); // case titles arrive with the catalog (GET /api/cases)
  drawCrumbs();
  return nav;
}

/* ---------- status chip: event clock or today's case ---------- */

function createStatusChip(): HTMLElement {
  const dot = h("span", { class: "status-dot", "aria-hidden": "true" });
  const label = h("span", { class: "status-label" });
  const title = h("bdi", { class: "status-title" });
  const time = h("span", { class: "status-time" });
  const chip = h("a", { class: "status-chip", hidden: true }, dot, label, title, time);
  let rolling = false;
  const tick = (): void => {
    const event = cachedEvent();
    const eventText = eventWhen();
    if (event !== null && eventLine().length > 0) {
      // The event clock wins: during an event night it is what everyone watches.
      const phase = eventDisplayPhase();
      chip.hidden = false;
      chip.className = `status-chip is-event is-${phase}`;
      chip.removeAttribute("href");
      label.textContent = "";
      label.hidden = true;
      if (title.textContent !== event.name) title.textContent = event.name; // textContent only: admin-authored
      title.hidden = event.name.length === 0;
      time.textContent = eventText;
      chip.title = [event.name, eventText].filter((p) => p.length > 0).join(" · ");
      chip.setAttribute("aria-label", chip.title);
      return;
    }
    const today = cachedToday();
    const summary = today?.caseId ? caseSummary(today.caseId) : undefined;
    if (today === null || summary === undefined || isAdmin(cachedAccount())) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chip.className = "status-chip is-today";
    chip.href = `#/case/${encodeURIComponent(summary.id)}`;
    label.hidden = false;
    label.textContent = TS().statusToday;
    title.hidden = false;
    if (title.textContent !== summary.title) title.textContent = summary.title;
    const ms = msUntilNextDay(today.timezone, serverNow());
    time.textContent = ms === null ? "" : formatCountdown(ms);
    time.hidden = ms === null;
    const full = TS().statusTodayTitle(summary.title, time.textContent);
    chip.title = full;
    chip.setAttribute("aria-label", full);
    // The day rolled over: ask the server for the new schedule (once per rollover).
    if (ms !== null && ms <= 1000 && !rolling) {
      rolling = true;
      window.setTimeout(() => {
        rolling = false;
        refreshToday(true);
      }, 2000);
    }
  };
  onTodayChange(tick);
  onEventChange(tick);
  onAccountChange(tick);
  onCatalogChange(tick);
  window.addEventListener("hashchange", tick); // re-label on language change
  window.setInterval(tick, 1000);
  tick();
  return chip;
}

/** Connectivity: a polite status region that stays in the DOM, so its text change is announced. */
function createNetChip(): HTMLElement {
  const text = h("span", { class: "net-text" });
  const chip = h("span", { class: "net-status", role: "status" }, html("span", { class: "net-icon", "aria-hidden": "true" }, ICONS.wifiOff), text);
  onConnectivity((state) => {
    chip.classList.toggle("is-down", state !== "ok");
    window.setTimeout(() => {
      // "your progress is saved" only means something while playing a case; elsewhere (sign-in, home) say less
      const playing = window.location.hash.startsWith("#/case/");
      text.textContent = state === "ok" ? "" : state === "retrying" ? T().netRetrying : playing ? T().netDownPlaying : T().netDown;
      chip.title = text.textContent;
    }, 100);
  });
  return chip;
}

/* ---------- account menu ---------- */

/** Up to two initials from a username ("ada_lovelace" -> "AL", "dana" -> "DA"). */
export function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter((w) => w.length > 0);
  const letters = words.length >= 2 ? [words[0], words[1]].map((w) => [...(w ?? "")][0] ?? "") : [...(words[0] ?? name)].slice(0, 2);
  return letters.join("").toUpperCase();
}

function createAccountMenu(): HTMLElement {
  const wrap = h("div", { class: "account" });
  const button = h("button", { type: "button", class: "account-btn" });
  const panel = h("div", { class: "account-panel", role: "dialog" });
  popover(button, panel, { align: "end", onOpen: () => panel.querySelector<HTMLElement>("a, button")?.focus() });
  const signInLink = h("a", { class: "btn btn-sm btn-primary account-signin", href: "#/login" });

  const draw = (): void => {
    const account = cachedAccount();
    if (account === null) {
      signInLink.textContent = TA().signIn;
      setChildren(wrap, signInLink, panel);
      return;
    }
    const name = account.username;
    button.textContent = "";
    button.append(h("span", { class: "avatar", "aria-hidden": "true" }, initials(name)));
    // Label in Name (WCAG 2.5.3): the visible initials start the name, so "click AL" works in speech control.
    button.setAttribute("aria-label", `${initials(name)}, ${TS().accountButton(name)}`);
    button.title = name;
    panel.setAttribute("aria-label", TS().accountPanel);
    const role = isAdmin(account) ? TS().roleAdmin : account.role === "author" ? TS().roleAuthor : TS().rolePlayer;
    const showStats = !isAdmin(account) && account.status === "approved" && !account.mustChangePassword;
    const out = h("button", { type: "button", class: "account-item is-signout" }, TA().signOut);
    // finally, not then: offline sign-out still clears the local account, so leave the signed-in page too
    out.addEventListener("click", () => void signOut().catch(() => undefined).finally(() => (window.location.hash = "#/")));
    setChildren(
      panel,
      h(
        "div",
        { class: "account-head" },
        h("span", { class: "avatar is-lg", "aria-hidden": "true" }, initials(name)),
        h("span", { class: "account-who" }, h("bdi", { class: "account-name" }, name), h("span", { class: "account-role" }, role)),
      ),
      h(
        "ul",
        { class: "account-items" },
        showStats ? h("li", {}, h("a", { class: "account-item", href: "#/me" }, TA().myStats)) : null,
        h("li", {}, out),
      ),
    );
    setChildren(wrap, button, panel);
  };
  // Choosing an item closes the panel (popover light dismiss does not run for a click inside it).
  panel.addEventListener("click", (ev) => {
    if (ev.target instanceof Element && ev.target.closest("a[href]") !== null && panel.matches(":popover-open")) panel.hidePopover();
  });
  onAccountChange(draw);
  window.addEventListener("hashchange", draw); // re-label on language change
  draw();
  return wrap;
}

/* ---------- mount ---------- */

/** Fills header.topbar. Call once. */
export function mountTopbar(bar: HTMLElement): void {
  const menuBtn = h("button", { type: "button", class: "icon-btn topbar-menu", "aria-haspopup": "dialog", "aria-controls": "app-nav" });
  menuBtn.append(html("span", { class: "icon", "aria-hidden": "true" }, ICONS.menu));
  menuBtn.addEventListener("click", openNavDrawer);
  const label = (): void => {
    menuBtn.setAttribute("aria-label", TS().navOpen);
    menuBtn.title = TS().navOpen;
  };
  window.addEventListener("hashchange", label);
  label();

  setChildren(
    bar,
    menuBtn,
    createCrumbs(),
    h("div", { class: "topbar-status" }, createStatusChip(), createNetChip()),
    h("div", { class: "topbar-tools" }, h("div", { class: "topbar-lang" }, createLangToggle()), ...createSettingsMenu(), createAccountMenu()),
  );
  refreshToday();
  loadAccount().catch(() => undefined);
  startEventPolling();
}
