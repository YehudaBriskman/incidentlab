// The slim top bar (one row): the menu button (rail widths and phones), the breadcrumb, a compact live status
// chip (the event clock, or today's case and the countdown to the next one), the connectivity chip and the one
// account menu (shell/accountMenu.ts: identity, language, theme, display options, sign out; #220).
import { T } from "../i18n/strings-player";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { TS } from "../i18n/strings-shell";
import { TL } from "../i18n/strings-landing";
import { TC } from "../i18n/strings-classes";
import { TSe, settingsSectionLabel } from "../i18n/strings-settings";
import { isSettingsSection, settingsHref } from "../lib/settings-route";
import { cachedClassName } from "../lib/class-api";
import { onConnectivity } from "../lib/api";
import { h, html, setChildren } from "../lib/dom";
import { cachedEvent, formatCountdown, onEventChange, serverNow, startEventPolling } from "../lib/event";
import { cachedAccount, isAdmin, loadAccount, onAccountChange } from "../lib/session";
import { caseSummary, onCatalogChange } from "../content/load";
import { eventDisplayPhase, eventLine, eventWhen } from "../views/leaderboard";
import { ICONS } from "./icons";
import { currentNavKey, openNavDrawer, routeParts } from "./nav";
import { createAccountMenu } from "./accountMenu";
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
  const homeCrumb: Crumb = { label: TS().navHome, href: "#/home" };
  const key = currentNavKey(parts);
  const [section, id, sub] = parts;
  if (section === "case" && id !== undefined) {
    const title = caseSummary(id)?.title ?? id;
    const out: Crumb[] = [homeCrumb, { label: TS().navCases, href: "#/cases" }, { label: title, href: `#/case/${encodeURIComponent(id)}`, bdi: true }];
    if (sub === "toolbox") out.push({ label: TS().sideToolbox });
    if (sub === "explorer") out.push({ label: TS().sideExplorer });
    return out;
  }
  if (section === "settings") {
    // #219: Home / Settings / the section on screen
    if (id === undefined || !isSettingsSection(id)) return [homeCrumb, { label: TSe().title }];
    return [homeCrumb, { label: TSe().title, href: settingsHref("account") }, { label: settingsSectionLabel(id) }];
  }
  if (key === "home") return [{ label: TS().navHome }];
  if (parts.length === 0) return [{ label: TL().crumb }]; // the landing (#279)
  if (key === "classes") {
    // #182: Classes > the class (its name once loaded) > Manage > the section on screen.
    const classesCrumb: Crumb = { label: TC().navClasses, href: "#/classes" };
    if (section === "classes") return [homeCrumb, { label: TC().navClasses }];
    if (section === "join") return [homeCrumb, classesCrumb, { label: TC().joinPageTitle }];
    if (section === "classboard") return [homeCrumb, classesCrumb, { label: TC().boardTitle }];
    if (section === "class" && id !== undefined) {
      const name: Crumb = { label: cachedClassName(id) ?? TC().classesTitle, href: `#/class/${encodeURIComponent(id)}`, bdi: true };
      if (sub !== "manage") return [homeCrumb, classesCrumb, name];
      const manage: Crumb = { label: TC().manageTitle, href: `#/class/${encodeURIComponent(id)}/manage` };
      return pageCrumb === null ? [homeCrumb, classesCrumb, name, manage] : [homeCrumb, classesCrumb, name, manage, { label: pageCrumb }];
    }
  }
  if (section === "about") return [homeCrumb, { label: TS().navAbout }];
  if (section === "privacy") return [homeCrumb, { label: TS().navPrivacy }];
  if (section === "login") return [homeCrumb, { label: TS().crumbSignIn }];
  if (section === "signup") return [homeCrumb, { label: TS().crumbSignUp }];
  // #221: the review queue sits inside the platform console
  if (section === "admin" && id === "reviews") return [homeCrumb, { label: TS().navConsole, href: "#/admin" }, { label: TS().crumbReviews }];
  const labels: Partial<Record<string, string>> = {
    cases: TS().navCases,
    leaderboard: TG().leaderboard,
    stats: TA().myStats,
    author: TS().navAuthor,
    admin: TS().navConsole,
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
        // A name someone else wrote (a case title, a class name) gets its own direction on the crumb element itself,
        // not a <bdi> inside it: the crumb is what clips, so its ellipsis then falls at the end of that text (an
        // English title in the Hebrew UI loses its tail, not its start).
        const dir = c.bdi === true ? "auto" : null;
        const inner =
          last || c.href === undefined
            ? h("span", { class: "crumb-current", dir, "aria-current": last ? "page" : null }, c.label)
            : h("a", { class: "crumb-link", dir, href: c.href }, c.label);
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
  // The chip's name is its visible text plus this hidden context, so it always contains what is on screen
  // (Label in Name, WCAG 2.5.3): speech users say what they see, screen readers still hear the full sentence.
  const context = h("span", { class: "visually-hidden" });
  const chip = h("a", { class: "status-chip", hidden: true }, dot, label, title, time, context);
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
      chip.removeAttribute("aria-label");
      context.textContent = "";
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
    chip.removeAttribute("aria-label");
    context.textContent = ` (${full})`;
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
    h("div", { class: "topbar-tools" }, createAccountMenu()),
  );
  refreshToday();
  loadAccount().catch(() => undefined);
  startEventPolling();
}
