// The platform owner console (#/admin, #185). All API data (usernames above all) is rendered via textContent /
// attributes only — never innerHTML.
// Sections: Users (search, filters and paging on the server; ban, roles, class limits, resets, trash)
// · Classes (every class, member limits, archive) · Live (one case, polled) · Stats (per case) · Global daily case
// (the site schedule) · Site announcement (the site-wide clock, freeze and banner) · Audit log, plus a Reviews link
// (the owner's review queue) with its count.
// Budget (docs/DATA.md): only Live and the site announcement poll (every 5 s, visible tabs). Users, Classes, Stats
// and Audit read a lot on the server, so they load on demand: opening the section, a search or filter, a page, an
// action, or Refresh.
// Auth: the `admin` session cookie (signed in on #/login with the ADMIN_KEY) or an admin key typed into the gate.
// The panels a class dashboard reuses (members, live, event, schedule, stats, projector board) live in views/manage/*:
// this file mounts them with the /api/admin/* calls and keeps the shell (gate, sections, URL, poll, banner), the
// trash and the audit log (classes replaced the site invite code, #204).
import "../admin.css";
import "../owner.css";
import { T } from "../i18n/strings-tools";
import { getLang } from "../i18n/i18n";
import {
  AUDIT_ADMIN_ACTOR,
  TRASH_RETENTION_DAYS,
  type AuditEntry,
  type LiveEvent,
  type Schedule,
  type AdminUsersResponse,
  type TodayResponse,
  type TrashEntry,
  type UserStats,
} from "../../shared/contract";
import { cachedCase } from "../content/load";
import { cachedEvent, serverNow as publicServerNow } from "../lib/event";
import { dataTable } from "../components/dataTable";
import { h, setChildren, type Child } from "../lib/dom";
import { loadErrorText } from "../lib/errors";
import { TE } from "../i18n/strings-errors";
import { T as TP } from "../i18n/strings-player";
import { TS } from "../i18n/strings-shell";
import { clickClosedDrawer, navSubLink, refreshNav, showSubNav } from "../shell/nav";
import { setPageCrumb } from "../shell/topbar";
import { scrollerOf } from "../shell/scroll";
import type { NavSection, ViewResult } from "../shell/types";
import { banner, closeMenu, toast, tooltip } from "../lib/overlay";
import {
  AdminApiError,
  approveAll,
  clearAdminKey,
  deleteAccount,
  fetchAdminClasses,
  fetchAudit,
  fetchCaseStats,
  fetchEvent,
  fetchExportCsv,
  fetchMe,
  fetchOverview,
  fetchAuthorRequestCount,
  renameAccount,
  setAccountHidden,
  fetchProgress,
  fetchPublicLeaderboard,
  fetchReviewCount,
  fetchSchedule,
  fetchSettings,
  fetchToday,
  fetchTrash,
  fetchUsers,
  getAdminKey,
  logoutSession,
  resetAccountPassword,
  fetchResetRequests,
  approveResetRequest,
  rejectResetRequest,
  resetProgress,
  restartPlayerCase,
  restoreTrash,
  saveEvent,
  saveSchedule,
  setAccountClassLimit,
  setAccountRole,
  setAccountStatus,
  setAccountsStatus,
  setAdminKey,
  setClassArchived,
  setClassMemberLimit,
  type AdminAuditResult,
  type AdminProgressResult,
  type AdminStatsResult,
} from "../lib/admin-api";
import { caseTitle } from "./manage/caseInfo";
import {
  errMessage,
  fmtInt,
  formatDateTime,
  formatDateTimeSec,
  formatDateTimeSecZone,
  formatDateTimeZone,
  ms,
  relativeAgo,
  relativeIn,
} from "./manage/format";
import { headWithHint, tipped } from "./manage/ui";
import { createMembersPanel } from "./manage/members";
import { createLivePanel } from "./manage/live";
import { createSchedulePanel } from "./manage/schedule";
import { createEventPanel } from "./manage/event";
import { createBoardPanel } from "./manage/board";
import { createStatsPanel } from "./manage/stats";
import { createOwnerClassesPanel } from "./manage/ownerClasses";
import { createResetRequestsPanel } from "./manage/resetRequests";
import { createOverviewPanel } from "./manage/overview";
import { TOw } from "../i18n/strings-owner";
import type { MembersQuery } from "./manage/members";
import { NARROW_QUERY, createManageHost } from "./manage/host";

const POLL_MS = 5000;
/** The dashboard poll refetches /api/today at most this often (see load()). */
const TODAY_REFRESH_MS = 60_000;
const MAX_BACKOFF_MS = 60000;
const TAB_STORAGE = "il.adminTab";

type TabId = "overview" | "accounts" | "classes" | "live" | "event" | "schedule" | "stats" | "audit";
const TABS: readonly TabId[] = ["overview", "accounts", "classes", "live", "stats", "schedule", "event", "audit"];
/** The section #/admin opens on (#235): what waits on the owner and the budget. */
const DEFAULT_TAB: TabId = "overview";
/** The sections whose data changes by the second: only these poll. The rest load on demand (#185). */
const POLLED_TABS: ReadonlySet<TabId> = new Set<TabId>(["live", "event"]);
/** How a load was asked for: the poll's tick, opening a section, or a refresh (the button, an action). */
type LoadMode = "tick" | "enter" | "manual";
const LOAD_RANK: Readonly<Record<LoadMode, number>> = { tick: 0, enter: 1, manual: 2 };
const isTabId = (v: string | null): v is TabId => TABS.some((t) => t === v);

/** Rail icons (decorative: the link carries the name). 24px grid, stroke drawn in currentColor. */
const svgIcon = (paths: string): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${paths}</svg>`;
const SECTION_ICONS: Readonly<Record<TabId, string>> = {
  overview: svgIcon('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  accounts: svgIcon('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>'),
  classes: svgIcon('<path d="M3 9l9-5 9 5-9 5z"/><path d="M7 11.5V16c0 1.5 2.5 3 5 3s5-1.5 5-3v-4.5"/><path d="M21 9v5"/>'),
  live: svgIcon('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  stats: svgIcon('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M21 20H3"/>'),
  event: svgIcon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/>'),
  schedule: svgIcon('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>'),
  audit: svgIcon('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 12h7"/><path d="M9 16h7"/>'),
};
const AUDIT_LIMIT = 100;

type AuthMode = "key" | "session";
/** How long a "saved" note stays in the save bar before the bar hides again. */
const SAVED_NOTE_MS = 4000;

// ---- URL state: #/admin?tab=live&case=<id> (deep links; Back moves between tabs) ----

function readUrlState(): { tab: TabId | null; caseId: string | null } {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const tab = params.get("tab");
  const caseId = params.get("case");
  return { tab: isTabId(tab) ? tab : null, caseId: caseId !== null && cachedCase(caseId) !== undefined ? caseId : null };
}

function adminHash(tab: TabId, caseId: string | null): string {
  const params = new URLSearchParams({ tab });
  if (tab === "live" && caseId !== null) params.set("case", caseId);
  return `#/admin?${params.toString()}`;
}

const isAdminHash = (hash: string): boolean => /^#\/?admin(\?|$)/.test(hash);

/** Where the console's review queue lives (#221; #/author/reviews redirects here). */
export const REVIEWS_HREF = "#/admin/reviews";

function sectionLabelOf(tab: TabId): string {
  switch (tab) {
    case "overview":
      return TOw().tabOverview;
    case "accounts":
      return T().admTabAccounts;
    case "classes":
      return T().admTabClasses;
    case "live":
      return T().admTabLive;
    case "event":
      return T().admTabEvent;
    case "schedule":
      return T().admTabSchedule;
    case "stats":
      return T().admTabStats;
    case "audit":
      return T().admTabAudit;
  }
}

/** "Users · Platform console · IncidentLab": every console page names its section first (#222). */
const consoleTitle = (section: string): string => `${section} · ${TS().navConsole} · IncidentLab`;

const REVIEWS_ICON = svgIcon('<path d="M4 4h16v12H8l-4 4z"/><path d="M9 10l2 2 4-4"/>');

/**
 * The console's sections as nested nav items for a page of the console that is not the dashboard itself (the review
 * queue): plain links back into #/admin?tab=…, with `current` marked.
 */
export function consoleNav(current: "reviews"): NavSection {
  const list = h("ul", { class: "nav-sub-list", "aria-label": T().admTabsLabel });
  setChildren(
    list,
    TABS.map((tab) => h("li", {}, navSubLink(adminHash(tab, null), { label: sectionLabelOf(tab), icon: { svg: SECTION_ICONS[tab] }, className: "admin-side-link" }))),
    h("li", {}, navSubLink(REVIEWS_HREF, { label: T().admReviewsLink, icon: { svg: REVIEWS_ICON }, current: current === "reviews" ? "page" : null, className: "admin-side-link admin-reviews-link" })),
  );
  return { under: "admin", label: TS().adminSections, content: list };
}

/**
 * The console's one page header (#285): the Platform console h1 under the owner eyebrow, on every section and on
 * the review queue (#/admin/reviews), with the page's quick actions beside it.
 */
export function consoleHeader(actions: readonly Child[] = []): HTMLElement {
  return h(
    "header",
    { class: "admin-head" },
    h("div", { class: "admin-head-title" }, h("p", { class: "eyebrow" }, T().admInstructorLive), h("h1", { class: "admin-title" }, T().admClassDashboard)),
    actions.length === 0 ? null : h("div", { class: "admin-head-actions" }, actions),
  );
}

/** Unsaved drafts carried over when the view re-renders in place (the language toggle re-runs the route). */
let carried: { schedule: Schedule | null; event: LiveEvent | null } | null = null;



// ---- schedule ---------------------------------------------------------------------



function readStoredTab(): TabId {
  try {
    const v = sessionStorage.getItem(TAB_STORAGE);
    return isTabId(v) ? v : DEFAULT_TAB;
  } catch {
    return DEFAULT_TAB;
  }
}

function storeTab(tab: TabId): void {
  try {
    sessionStorage.setItem(TAB_STORAGE, tab);
  } catch {
    // storage blocked: the tab just won't be remembered
  }
}

// ---- view ---------------------------------------------------------------------------

let activeCleanup: (() => void) | null = null;

/**
 * The live dashboard. The router re-runs on every hash change (it runs before any listener registered here), so a
 * Back/Forward between tabs (#/admin?tab=…) calls renderAdmin again: we re-attach the same instance instead of
 * rebuilding it, which keeps drafts, focus and data. Only a language switch rebuilds (with the drafts carried over).
 */
type AdminInstance = {
  container: HTMLElement;
  side: AdminSide;
  lang: string;
  alive: () => boolean;
  reattach: () => void;
  dirtyDrafts: () => { schedule: Schedule | null; event: LiveEvent | null };
};
let activeInstance: AdminInstance | null = null;

/** The nav section of one dashboard instance: it lives as long as it does (reused when the router re-attaches it). */
type AdminSide = { content: HTMLElement };

/** The live instance the router will re-attach on this URL, if any (same language, still inside #/admin). */
function reusableInstance(): AdminInstance | null {
  const prev = activeInstance;
  return prev !== null && prev.alive() && isAdminHash(location.hash) && prev.lang === getLang() ? prev : null;
}

/**
 * The dashboard as a shell view (#60): the sections are sidebar navigation (People, Live, Event, Audit) under the
 * quick actions; the active section is in main. The sign-in gate releases the sidebar while it is on screen.
 */
export function adminView(): ViewResult {
  const main = h("div", { class: "view" });
  const side: AdminSide = reusableInstance()?.side ?? { content: h("ul", { class: "nav-sub-list admin-nav" }) };
  const nav: NavSection = { under: "admin", label: TS().adminSections, content: side.content };
  return { main, nav, layout: "fit", start: () => renderAdmin(main, side) };
}

function renderAdmin(root: HTMLElement, side: AdminSide): void {
  const prev = activeInstance;
  if (prev && prev.alive()) {
    if (prev === reusableInstance()) {
      root.replaceChildren(prev.container);
      prev.reattach();
      return;
    }
    carried = prev.dirtyDrafts();
  }
  // A re-render of the same route must not leak the previous instance's timers.
  if (activeCleanup) activeCleanup();

  const container = h("div", { class: "admin" });
  root.replaceChildren(container);
  const carry = carried;
  carried = null;
  const urlState = readUrlState();

  let pollId: number | null = null;
  let todayFetchedAt = 0;
  let tickId: number | null = null;
  let disposed = false;

  const state = {
    auth: null as AuthMode | null,
    tab: urlState.tab ?? readStoredTab(),
    /** the dashboard passed the sign-in check and is built */
    ready: false,
    /** the users page on screen (fetched on demand, #185) */
    users: null as AdminUsersResponse | null,
    /** bumped by every users request: an older response never replaces a newer one */
    usersSeq: 0,
    /** the overall top 10 on the Stats section */
    topUsers: [] as UserStats[],
    /** cases waiting for the owner's review (the Reviews link's badge); null until known */
    reviews: null as number | null,
    /** vouched password reset requests and author access requests waiting (#285); null until known */
    resets: null as number | null,
    authorRequests: null as number | null,
    /** pending sign-ups, from the users list (the Users badge) */
    pendingSignups: 0,
    today: null as TodayResponse | null,
    progress: null as AdminProgressResult | null,
    stats: null as AdminStatsResult | null,
    liveCaseId: urlState.caseId,
    lastUpdated: 0,
    paused: false,
    loading: false,
    queued: null as LoadMode | null,
    banner: null as string | null,
    failures: 0,
    // recently deleted (Accounts tab)
    trash: {
      entries: null as TrashEntry[] | null,
      error: null as string | null,
      unavailable: false,
      busy: new Set<string>(),
      msg: null as { text: string; ok: boolean } | null,
    },
    /** phone/tablet layout (cards instead of grids, compact chrome) */
    narrow: window.matchMedia(NARROW_QUERY).matches,
    audit: null as AdminAuditResult | null,
  };

  // The services every manage panel gets (views/manage/host.ts): the root, the poll, errors, confirms and menus.
  const host = createManageHost({
    container,
    disposed: () => disposed,
    narrow: () => state.narrow,
    refresh: () => void load("manual"),
    handleAuthError: (err) => handleAuthError(err),
    setBanner: (text) => {
      state.banner = text;
      renderBanner();
    },
    syncSaveBar: () => syncSaveBarClass(),
  });
  const { askConfirm, withFocusKept } = host;

  const stopTimers = (): void => {
    if (pollId !== null) window.clearTimeout(pollId);
    if (tickId !== null) window.clearInterval(tickId);
    pollId = null;
    tickId = null;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopTimers();
    if (savedNoteTimer !== null) window.clearTimeout(savedNoteTimer);
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("beforeunload", onBeforeUnload);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("click", onDocClick, { capture: true });
    document.documentElement.classList.remove("admin-savebar-open");
    board.close();
    narrowMq.removeEventListener("change", onNarrowChange);
    if (activeCleanup === dispose) activeCleanup = null;
    if (activeInstance?.container === container) activeInstance = null;
  };
  activeCleanup = dispose;

  /** The URL this view last showed (to put back when the instructor stays). */
  let shownUrl = location.href;
  /** Set when a link click was already confirmed, so the hash change doesn't ask twice. */
  let leaveConfirmed = false;
  /** Last focused control in the dashboard (restored when the router re-attaches the view). */
  let lastFocused: HTMLElement | null = null;

  function setUrl(hash: string, mode: "push" | "replace"): void {
    if (mode === "push") history.pushState(history.state, "", hash);
    else history.replaceState(history.state, "", hash);
    shownUrl = location.href;
  }

  /** Names the editors with unsaved changes ("schedule", "event"), or "" when nothing is dirty. */
  function dirtySections(): string {
    const parts: string[] = [];
    if (schedule.dirty()) parts.push(T().admSecSchedule);
    if (eventForm.dirty()) parts.push(T().admSecEvent);
    return parts.join(" + ");
  }

  /** Leaves #/admin for `href` once the instructor agreed to drop the unsaved edits. */
  function leaveTo(href: string): void {
    leaveConfirmed = true;
    window.setTimeout(() => (leaveConfirmed = false), 1000); // the target may not change the hash after all
    location.href = href;
  }

  /**
   * Runs after the router (which registered first). Leaving #/admin with unsaved edits (Back, a typed URL)
   * asks; staying puts the old URL back and re-runs the route, which re-attaches this same instance (drafts
   * intact). The URL is put back only after the answer, so the other page's late renders cannot land on top.
   */
  function onHashChange(): void {
    if (disposed || isAdminHash(location.hash)) return; // inside #/admin: renderAdmin re-attaches us
    const dirty = dirtySections();
    if (dirty !== "" && !leaveConfirmed) {
      void confirmLeave(dirty).then((ok) => {
        if (disposed) return;
        if (ok) return dispose();
        history.replaceState(history.state, "", shownUrl);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      return;
    }
    leaveConfirmed = false;
    dispose();
  }

  /** Link clicks are caught before the hash changes, so staying doesn't even leave the page. */
  function onDocClick(e: MouseEvent): void {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
    const href = link?.getAttribute("href") ?? "";
    if (!href.startsWith("#") || isAdminHash(href) || link?.hasAttribute("download")) return;
    const dirty = dirtySections();
    if (dirty === "" || leaveConfirmed) return;
    e.preventDefault();
    void confirmLeave(dirty).then((ok) => {
      if (ok) leaveTo(href);
    });
  }

  /** The URL changed inside #/admin (Back/Forward between tabs, or a pasted link): follow it. */
  function applyUrlState(): void {
    const next = readUrlState();
    const tab = next.tab ?? DEFAULT_TAB;
    if (tab !== state.tab && !selectTab(tab, { fromUrl: true })) {
      history.replaceState(history.state, "", shownUrl);
      return;
    }
    if (next.caseId !== null && next.caseId !== state.liveCaseId && tab === "live") selectLiveCase(next.caseId, false);
    shownUrl = location.href;
  }

  activeInstance = {
    container,
    side,
    lang: getLang(),
    alive: () => !disposed,
    reattach: () => {
      syncShellSidebar();
      if (state.ready) applyUrlState();
      else {
        // Still signing in: the section in the new URL is the one to open once the console is built.
        const wanted = readUrlState();
        if (wanted.tab !== null) state.tab = wanted.tab;
        if (wanted.caseId !== null) state.liveCaseId = wanted.caseId;
      }
      setPageCrumb(tabLabel(state.tab));
      if (lastFocused && lastFocused.isConnected) lastFocused.focus({ preventScroll: true });
    },
    dirtyDrafts: () => ({ schedule: schedule.dirty() ? schedule.draft() : null, event: eventForm.dirty() ? eventForm.draft() : null }),
  };
  function onVisibility(): void {
    if (document.visibilityState === "hidden") {
      if (pollId !== null) window.clearTimeout(pollId);
      pollId = null;
    } else if (state.ready && !state.paused && POLLED_TABS.has(state.tab)) {
      void load();
    }
  }
  function onBeforeUnload(e: BeforeUnloadEvent): void {
    if (schedule.dirty() || eventForm.dirty()) e.preventDefault();
  }
  /** A focused field must never sit under the sticky save bar (WCAG 2.4.11). */
  function onFocusIn(e: FocusEvent): void {
    const target = e.target;
    if (!(target instanceof HTMLElement) || !container.contains(target)) return;
    lastFocused = target;
    // After the browser's own focus scrolling (which already honours scroll-padding-bottom).
    window.requestAnimationFrame(() => {
      const bar = container.querySelector<HTMLElement>(".admin-tabpanel:not([hidden]) .sched-actions:not([hidden])");
      if (!bar || bar.contains(target) || document.activeElement !== target) return;
      const overlap = target.getBoundingClientRect().bottom - bar.getBoundingClientRect().top + 12;
      if (overlap > 0) scrollerOf(target).scrollBy({ top: overlap });
    });
  }
  /** Crossing the phone/tablet breakpoint swaps grids for cards (and back) without losing state. */
  const narrowMq = window.matchMedia(NARROW_QUERY);
  function onNarrowChange(): void {
    state.narrow = narrowMq.matches;
    closeMenu();
    if (state.ready) renderActiveTab();
  }
  narrowMq.addEventListener("change", onNarrowChange);
  window.addEventListener("hashchange", onHashChange);
  document.addEventListener("click", onDocClick, { capture: true });
  window.addEventListener("beforeunload", onBeforeUnload);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("focusin", onFocusIn);

  // ---- login ---------------------------------------------------------------------

  function showLogin(error: string | null): void {
    stopTimers();
    state.ready = false;
    state.auth = null;
    gateShown = true;
    syncShellSidebar();
    const input = h("input", {
      type: "password",
      id: "admin-key",
      class: "admin-input",
      autocomplete: "current-password",
      placeholder: "ADMIN_KEY",
      required: true,
    });
    const errorEl = h("p", { class: "admin-error", role: "alert" });
    if (error) errorEl.textContent = error;
    else errorEl.hidden = true;
    const submit = h("button", { type: "submit", class: "btn btn-primary" }, T().admOpenDashboard);
    const form = h(
      "form",
      { class: "admin-login-form" },
      h("label", { for: "admin-key", class: "admin-label" }, T().admAdminKey),
      input,
      errorEl,
      submit,
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const key = input.value.trim();
      if (!key) return;
      setAdminKey(key);
      submit.disabled = true;
      submit.textContent = T().admChecking;
      state.auth = "key";
      void start();
    });
    setChildren(
      container,
      h(
        "section",
        { class: "admin-login panel" },
        h("p", { class: "eyebrow" }, T().admInstructor),
        h("h1", { class: "admin-title" }, T().admLoginTitle),
        h("p", { class: "muted" }, T().admLoginIntro),
        form,
        h(
          "p",
          { class: "muted small admin-login-alt" },
          T().admOrSignInBefore,
          h("code", {}, "admin"),
          T().admOrSignInAfter,
          h("a", { href: "#/login" }, T().admSignInPage),
          ".",
        ),
      ),
    );
    input.focus();
  }

  /** The console could not load (offline, 5xx): a scoped error with Try again, keeping the session. */
  function showLoadError(err: unknown, retry: () => void): void {
    stopTimers();
    state.ready = false;
    gateShown = true;
    syncShellSidebar();
    const again = h("button", { type: "button", class: "btn btn-primary", onclick: () => retry() }, TP().tryAgain);
    setChildren(
      container,
      h(
        "section",
        { class: "center-card load-failed", role: "alert" },
        h("h1", {}, TE().adminLoadFailedTitle),
        h("p", { class: "muted" }, loadErrorText(err)),
        h("div", { class: "row-center" }, again),
      ),
    );
  }

  /** 401 / 503 send the instructor back to the key gate. Returns true when handled. */
  function handleAuthError(err: unknown): boolean {
    if (!(err instanceof AdminApiError)) return false;
    if (err.status === 401) {
      const wasSession = state.auth === "session";
      clearAdminKey();
      if (wasSession) {
        // The owner's session ended: back to the one sign-in page, never the key form (#221).
        stopTimers();
        toast({ tone: "info", text: T().admSessionExpired });
        window.location.replace("#/login");
        return true;
      }
      showLogin(T().admKeyRejected);
      return true;
    }
    if (err.status === 503) {
      clearAdminKey();
      showLogin(T().admDisabled);
      return true;
    }
    return false;
  }

  // ---- shell: header, tabs, banner (built once; tab regions re-rendered) ------------------

  // Focusable so keyboard users can open the full-time tooltip; renderUpdated() adds the time as hidden text.
  const updatedEl = h("span", { class: "admin-updated admin-tipped", "aria-live": "off", tabindex: "0" });
  tooltip(updatedEl, () => updatedEl.dataset.full ?? "");
  const pauseBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admPause);
  const refreshBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admRefresh);
  // Tinted, not amber: each view keeps the accent fill for its one primary action (DESIGN.md accent budget).
  const boardBtn = h("button", { type: "button", class: "btn btn-sm admin-quick-board", "data-sidebar-close": "" }, TS().adminProjector);
  const logoutBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admSignOut);
  // Connection problems and failed actions: one dismissible banner under the tabs (lib/overlay.ts).
  const statusBanner = banner({ tone: "warning", text: "", dismissible: true, className: "admin-banner", onDismiss: () => void (state.banner = null) });
  statusBanner.hide();

  pauseBtn.addEventListener("click", () => {
    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? T().admResume : T().admPause;
    pauseBtn.setAttribute("aria-pressed", String(state.paused));
    renderUpdated();
    if (state.paused) {
      if (pollId !== null) window.clearTimeout(pollId);
      pollId = null;
    } else {
      void load();
    }
  });
  refreshBtn.addEventListener("click", () => void load("manual"));
  boardBtn.addEventListener("click", () => board.open());
  logoutBtn.addEventListener("click", () => {
    const wasSession = state.auth === "session";
    clearAdminKey();
    if (!wasSession) {
      showLogin(null);
      return;
    }
    logoutBtn.disabled = true;
    logoutSession()
      .catch(() => {
        // the cookie may already be gone; either way the gate comes back
      })
      .finally(() => {
        logoutBtn.disabled = false;
        showLogin(null);
      });
  });

  const tabLabel = sectionLabelOf;

  // ---- the sections: sidebar navigation (#60) ----------------------------------------------
  // Links, not a tablist: each section has its own URL (#/admin?tab=…), so the browser's Back, "open in a new
  // tab" and copy-link work, and aria-current marks the one on screen. A plain click is handled here (pushState,
  // so the router doesn't rebuild the page) and goes through selectTab's unsaved-edits guard.
  const pendingTabBadge = h("span", { class: "tab-badge nav-sub-badge" });
  pendingTabBadge.hidden = true;
  // The review queue (#184) lives on its own page; the console links it with the number waiting.
  const reviewsBadge = h("span", { class: "tab-badge nav-sub-badge" });
  reviewsBadge.hidden = true;
  const reviewsLink = navSubLink(REVIEWS_HREF, {
    label: T().admReviewsLink,
    icon: { svg: REVIEWS_ICON },
    badge: reviewsBadge,
    className: "admin-side-link admin-reviews-link",
  });
  function renderReviewsBadge(): void {
    const n = state.reviews ?? 0;
    reviewsBadge.textContent = fmtInt(n);
    reviewsBadge.hidden = n === 0;
    reviewsBadge.setAttribute("aria-label", T().admReviewsBadge(n));
    reviewsLink.dataset.navTip = n === 0 ? T().admReviewsLink : `${T().admReviewsLink}, ${T().admReviewsBadge(n)}`;
    refreshNav();
  }
  const sectionLinks = new Map<TabId, HTMLAnchorElement[]>();
  const tabPanels = new Map<TabId, HTMLElement>();
  const navSpec: NavSection = { under: "admin", label: TS().adminSections, content: side.content };
  /** The sign-in gate is on screen: the nav section is removed until the dashboard is back. */
  let gateShown = false;

  function onSectionClick(tab: TabId, e: MouseEvent): void {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    // From the drawer (it has already closed): focus follows to the section. The column and the rail keep it.
    const focusPanel = clickClosedDrawer();
    if (selectTab(tab) && focusPanel) tabPanels.get(tab)?.focus({ preventScroll: true });
  }

  function sectionLink(tab: TabId): HTMLAnchorElement {
    const label = tabLabel(tab);
    const link = navSubLink(adminHash(tab, null), { label, icon: { svg: SECTION_ICONS[tab] }, badge: tab === "accounts" ? pendingTabBadge : null, className: "admin-side-link" });
    link.addEventListener("click", (e) => onSectionClick(tab, e));
    const list = sectionLinks.get(tab) ?? [];
    list.push(link);
    sectionLinks.set(tab, list);
    return link;
  }

  for (const tab of TABS) {
    // tabindex 0: the visible panel scrolls inside the fit layout, so keyboard users must be able to reach and
    // scroll it (WCAG 2.1.1, axe scrollable-region-focusable); hidden panels are out of the tab order anyway.
    tabPanels.set(tab, h("section", { id: `admin-panel-${tab}`, class: "admin-tabpanel", "aria-label": tabLabel(tab), tabindex: "0" }));
  }

  const sectionGroups: ReadonlyArray<{ id: string; label: string; tabs: readonly TabId[] }> = [
    { id: "overview", label: TOw().tabOverview, tabs: ["overview"] },
    { id: "people", label: TS().adminGroupPeople, tabs: ["accounts", "classes"] },
    { id: "live", label: TS().adminGroupLive, tabs: ["live", "stats"] },
    { id: "event", label: TS().adminGroupEvent, tabs: ["schedule", "event"] },
    { id: "audit", label: TS().adminGroupAudit, tabs: ["audit"] },
  ];

  /** Fills the nav section once per instance: the sections in their groups' order. */
  function buildSidebar(): void {
    sectionLinks.clear();
    side.content.setAttribute("aria-label", T().admTabsLabel);
    setChildren(side.content, sectionGroups.flatMap((g) => g.tabs).map((tab) => h("li", {}, sectionLink(tab))), h("li", {}, reviewsLink));
    renderReviewsBadge();
  }

  /** Shows (or, at the sign-in gate, removes) this dashboard's nav section, when it is the page on screen. */
  function syncShellSidebar(): void {
    if (disposed || !container.isConnected) return;
    showSubNav(gateShown ? null : navSpec);
    setPageCrumb(gateShown ? null : tabLabel(state.tab));
  }

  function syncTabs(): void {
    setPageCrumb(tabLabel(state.tab));
    document.title = consoleTitle(tabLabel(state.tab));
    for (const tab of TABS) {
      const selected = tab === state.tab;
      for (const link of sectionLinks.get(tab) ?? []) {
        if (selected) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
      const panel = tabPanels.get(tab);
      if (panel) panel.hidden = !selected;
    }
  }

  /**
   * Leaving the Schedule or Event tab with unsaved edits asks first; confirming discards the draft.
   * Returns false when the instructor chose to stay.
   */
  function selectTab(tab: TabId, opts: { fromUrl?: boolean } = {}): boolean {
    if (tab === state.tab) return true;
    const leaving = state.tab;
    const dirty = leaving === "schedule" ? schedule.dirty() : leaving === "event" ? eventForm.dirty() : false;
    if (dirty) {
      // Ask first; the tab stays until the draft is discarded, then the switch runs again (now clean).
      void confirmLeave(leaving === "schedule" ? T().admSecSchedule : T().admSecEvent).then((ok) => {
        if (!ok || disposed || state.tab !== leaving) return;
        if (leaving === "schedule") schedule.discard();
        else eventForm.discard();
        if (selectTab(tab)) tabPanels.get(tab)?.focus({ preventScroll: true });
      });
      return false;
    }
    state.tab = tab;
    storeTab(tab);
    if (!opts.fromUrl) setUrl(adminHash(tab, state.liveCaseId), "push");
    syncTabs();
    syncSaveBarClass();
    renderActiveTab();
    if (tab === "schedule" && !schedule.draft()) void schedule.load();
    if (tab === "event" && !eventForm.draft()) void eventForm.load();
    void load("enter");
    return true;
  }

  /** The sticky save bar is visible on the active tab: leave room for it when the browser scrolls focus into view. */
  function syncSaveBarClass(): void {
    const open =
      (state.tab === "schedule" && schedule.barVisible()) || (state.tab === "event" && eventForm.barVisible());
    document.documentElement.classList.toggle("admin-savebar-open", open);
  }

  function buildDashboard(): void {
    setChildren(
      container,
      // The page's quick actions: freshness, pause/refresh, the projector board (and Sign out for a typed key: a
      // session admin signs out from the account menu in the top bar).
      consoleHeader([updatedEl, pauseBtn, refreshBtn, boardBtn, state.auth === "key" ? logoutBtn : null]),
      // What waits on the owner, on every section (#285), above the KPIs and the tables.
      needsStrip,
      statusBanner.el,
      [...tabPanels.values()],
    );
    buildSidebar();
    gateShown = false;
    syncShellSidebar();
    overview.mount(tabPanels.get("overview") ?? container);
    buildAccountsPanel();
    ownerClasses.mount(tabPanels.get("classes") ?? container);
    live.mount(tabPanels.get("live") ?? container);
    statsPanel.mount(tabPanels.get("stats") ?? container);
    buildAuditPanel();
    pauseBtn.textContent = state.paused ? T().admResume : T().admPause;
    syncTabs();
  }

  function renderUpdated(): void {
    if (!state.lastUpdated) {
      updatedEl.textContent = T().admLoading;
      return;
    }
    const sec = Math.max(0, Math.round((Date.now() - state.lastUpdated) / 1000));
    const full = formatDateTime(new Date(state.lastUpdated).toISOString());
    setChildren(updatedEl, T().admUpdated(state.paused, relativeAgo(new Date(state.lastUpdated).toISOString(), Date.now())), h("span", { class: "visually-hidden" }, `, ${full}`));
    updatedEl.dataset.full = full;
    updatedEl.classList.toggle("is-stale", sec > 20);
  }

  function renderBanner(): void {
    if (state.banner === null) {
      statusBanner.hide();
      return;
    }
    statusBanner.update({ text: state.banner });
    statusBanner.show();
  }

  /** Unsaved schedule or event edits: ask before they are dropped. Resolves true to discard and go on. */
  function confirmLeave(what: string): Promise<boolean> {
    return askConfirm({
      title: T().admLeaveTitle,
      body: T().admLeaveConfirm(what),
      confirmLabel: T().admLeaveDiscard,
      cancelLabel: T().admLeaveStay,
      tone: "danger",
    });
  }

  // =====================================================================================
  // Accounts tab: the members panel (views/manage/members.ts) on the admin API, then the trash
  // =====================================================================================

  // Teacher-vouched password resets (#254): vouched requests, approved or rejected here.
  const resetRequests = createResetRequestsPanel({
    host,
    api: { list: fetchResetRequests, approve: approveResetRequest, reject: rejectResetRequest },
    onCount: (n) => {
      if (n === state.resets) return;
      state.resets = n;
      renderUsersBadge();
      renderNeeds();
    },
  });

  /** The Users link's badge (#285): pending sign-ups plus vouched password resets, both worked on that section. */
  function renderUsersBadge(): void {
    const pending = state.pendingSignups;
    const resets = state.resets ?? 0;
    const n = pending + resets;
    pendingTabBadge.textContent = fmtInt(n);
    pendingTabBadge.hidden = n === 0;
    const label = resets === 0 ? T().admPendingBadge(pending) : TOw().usersBadge(pending, resets);
    pendingTabBadge.setAttribute("aria-label", label);
    const railLabel = n === 0 ? tabLabel("accounts") : `${tabLabel("accounts")}, ${label}`;
    for (const link of sectionLinks.get("accounts") ?? []) link.dataset.navTip = railLabel;
    refreshNav();
  }

  // "Needs you" (#285): the queues that wait on the owner, as links to where each is worked. Counts come with the
  // console's first load and every Refresh (one small call per queue), never on the timer.
  const needsStrip = h("nav", { class: "needs-strip", "aria-label": TOw().needsLabel, "data-testid": "needs-strip" });
  function renderNeeds(): void {
    const items: Array<{ id: string; text: string; href: string; tab: TabId | null }> = [];
    const add = (id: string, n: number | null, text: (n: number) => string, href: string, tab: TabId | null): void => {
      if (n !== null && n > 0) items.push({ id, text: text(n), href, tab });
    };
    add("resets", state.resets, TOw().needsResets, adminHash("accounts", null), "accounts");
    add("reviews", state.reviews, TOw().needsReviews, REVIEWS_HREF, null);
    add("authors", state.authorRequests, TOw().needsAuthors, REVIEWS_HREF, null);
    add("signups", state.pendingSignups, TOw().needsSignups, adminHash("accounts", null), "accounts");
    setChildren(
      needsStrip,
      h("span", { class: "needs-label" }, TOw().needsLabel),
      items.length === 0
        ? h("span", { class: "muted small" }, TOw().needsNone)
        : h(
            "ul",
            { class: "needs-list" },
            items.map((it) => {
              const link = h("a", { class: "needs-item", href: it.href, "data-needs": it.id }, h("span", { class: "needs-dot", "aria-hidden": "true" }), it.text);
              const tab = it.tab;
              if (tab !== null) {
                link.addEventListener("click", (e) => {
                  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  if (selectTab(tab)) tabPanels.get(tab)?.focus({ preventScroll: true });
                });
              }
              return h("li", {}, link);
            }),
          ),
    );
  }

  /** The queue counts behind "Needs you" (#285): reviews, vouched resets and author requests. Never throws. */
  async function loadNeeds(): Promise<void> {
    const [reviews, resets, authors] = await Promise.all([
      fetchReviewCount().catch(() => null),
      fetchResetRequests().then((r) => r.length).catch(() => null),
      fetchAuthorRequestCount().catch(() => null),
    ]);
    if (disposed) return;
    if (reviews !== null) state.reviews = reviews;
    if (resets !== null) state.resets = resets;
    if (authors !== null) state.authorRequests = authors;
    renderReviewsBadge();
    renderUsersBadge();
    renderNeeds();
  }

  const members = createMembersPanel({
    host,
    page: { get: () => state.users, set: (page) => void (state.users = page) },
    fetch: (query) => void loadUsers(query),
    api: {
      setClassLimit: setAccountClassLimit,
      setStatus: setAccountStatus,
      rename: renameAccount,
      setHidden: setAccountHidden,
      setRole: setAccountRole,
      setStatuses: setAccountsStatus,
      approveAll,
      resetPassword: resetAccountPassword,
      deleteAccount,
      exportCsv: fetchExportCsv,
    },
    onDeleted: async (a) => {
      const entry = await newestTrash((e) => e.kind === "account" && e.label === `account ${a.username}`);
      undoToast(T().admDeletedToast(a.username, TRASH_RETENTION_DAYS), entry);
    },
    // The pending count is on the Accounts link in the sidebar too (badge and rail tooltip).
    onPendingCount: (n) => {
      state.pendingSignups = n;
      renderUsersBadge();
      renderNeeds();
    },
    rerender: () => renderAccounts(),
  });

  /**
   * The trash entry a soft delete just created (newest first from the server), for the Undo in its toast.
   * Matched by the server's label; null when it can't be found (the toast then has no Undo).
   */
  /**
   * Fetches one page of the users list (#185) and shows it. On demand only: a search, filter, sort or page change
   * calls this directly; opening the section and Refresh go through load(). Older responses are dropped.
   */
  async function loadUsers(query: MembersQuery): Promise<void> {
    const seq = ++state.usersSeq;
    try {
      const page = await fetchUsers(query);
      if (disposed || seq !== state.usersSeq) return;
      state.users = page;
      state.lastUpdated = Date.now();
      renderUpdated();
      if (state.tab === "accounts") renderAccounts();
      else members.renderPending();
    } catch (err: unknown) {
      if (disposed || handleAuthError(err)) return;
      state.banner = T().admActionFailed(errMessage(err));
      renderBanner();
    }
  }

  async function newestTrash(match: (e: TrashEntry) => boolean): Promise<TrashEntry | null> {
    try {
      const entries = await fetchTrash();
      state.trash.entries = entries;
      trashSig = "";
      return entries.find(match) ?? null;
    } catch {
      return null;
    }
  }

  /** "Deleted …" with Undo, which restores the trash entry right away. */
  function undoToast(text: string, entry: TrashEntry | null): void {
    toast({ tone: "success", text, ...(entry ? { action: { label: T().admUndo, run: () => void restoreEntry(entry) } } : {}) });
  }

  // ---- recently deleted (trash): deleted accounts and reset case progress, restorable for a few days ----
  const trashBodyEl = h("div", { class: "admin-table-wrap" });
  const trashMsgEl = h("p", { class: "small trash-msg", role: "status", hidden: true });
  let trashSig = "";
  let trashNow = Date.now();
  // Stacks into labelled cards on phones (dt-stack): the Hebrew labels never wrap one letter per line.
  const trashTable = dataTable<TrashEntry>({
    columns: [
      { id: "item", header: T().admColItem, rowHeader: true, className: "trash-label", cell: (e) => h("span", { dir: "auto" }, e.label), sortValue: (e) => e.label },
      { id: "deleted", header: T().admColDeletedAt, className: "col-seen", cell: (e) => tipped(h("span", {}, formatDateTime(e.deletedAt)), formatDateTimeZone(e.deletedAt)), sortValue: (e) => ms(e.deletedAt), sortFirst: "desc" },
      { id: "expires", header: T().admColExpires, className: "col-seen", cell: (e) => tipped(h("span", {}, relativeIn(e.expiresAt, trashNow)), formatDateTime(e.expiresAt)), sortValue: (e) => ms(e.expiresAt) },
      { id: "records", header: T().admColRecords, numeric: true, cell: (e) => fmtInt(e.records), sortValue: (e) => e.records, sortFirst: "desc" },
      {
        id: "actions",
        header: T().admColActions,
        headerHidden: true,
        className: "col-actions",
        cell: (e) => {
          const busy = state.trash.busy.has(e.id);
          return h(
            "button",
            { type: "button", class: "btn btn-ghost btn-sm", disabled: busy, "aria-label": T().admRestoreLabel(e.label), onclick: () => void restoreEntry(e) },
            busy ? T().admRestoring : T().admRestore,
          );
        },
      },
    ],
    rows: [],
    rowKey: (e) => e.id,
    rowSig: (e) => JSON.stringify([getLang(), e, state.trash.busy.has(e.id), relativeIn(e.expiresAt, trashNow)]),
    className: "admin-table trash-table",
    wrapClass: "admin-dt",
    labelledBy: "admin-trash-title",
    stackOnPhone: true,
  });

  async function restoreEntry(entry: TrashEntry): Promise<void> {
    const t = state.trash;
    if (t.busy.has(entry.id)) return;
    t.busy.add(entry.id);
    t.msg = null;
    renderTrash();
    try {
      const res = await restoreTrash(entry.id);
      if (disposed) return;
      t.msg = { text: T().admRestored(entry.label, res.restored, res.skipped), ok: true };
      t.entries = (t.entries ?? []).filter((e) => e.id !== entry.id);
      void load("manual");
    } catch (err: unknown) {
      if (disposed || handleAuthError(err)) return;
      const conflict = err instanceof AdminApiError && (err.status === 409 || err.code === "conflict");
      t.msg = { text: conflict ? T().admRestoreConflict(entry.label) : T().admActionFailed(errMessage(err)), ok: false };
    } finally {
      t.busy.delete(entry.id);
    }
    renderTrash();
    // The restored row is gone from the list: keep keyboard focus in the section.
    trashMsgEl.focus();
  }

  function renderTrash(): void {
    const t = state.trash;
    trashMsgEl.textContent = t.msg?.text ?? "";
    trashMsgEl.hidden = t.msg === null;
    trashMsgEl.classList.toggle("is-error", t.msg !== null && !t.msg.ok);
    trashMsgEl.tabIndex = -1;
    const now = Date.now();
    const sig = JSON.stringify([
      getLang(),
      t.unavailable,
      t.error,
      t.entries,
      [...t.busy],
      // "expires in" changes slowly: re-render when its text would change
      (t.entries ?? []).map((e) => relativeIn(e.expiresAt, now)),
    ]);
    if (sig === trashSig) return;
    trashSig = sig;
    if (t.unavailable) {
      setChildren(trashBodyEl, h("p", { class: "muted admin-empty-small" }, T().admTrashUnavailable));
      return;
    }
    if (t.entries === null) {
      setChildren(trashBodyEl, h("p", { class: t.error ? "admin-error" : "muted admin-empty-small" }, t.error ? T().admTrashFailed(t.error) : T().admLoading));
      return;
    }
    if (t.entries.length === 0) {
      setChildren(trashBodyEl, h("p", { class: "muted admin-empty-small" }, T().admTrashEmpty(TRASH_RETENTION_DAYS)));
      return;
    }
    trashNow = now;
    trashTable.update(t.entries);
    if (trashTable.element.parentNode !== trashBodyEl) setChildren(trashBodyEl, trashTable.element);
  }

  function buildAccountsPanel(): void {
    setChildren(
      tabPanels.get("accounts") ?? container,
      // Vouched resets first (#285): they wait on the owner, and the users table grows without bound.
      resetRequests.section(),
      members.sections(),
      h(
        "section",
        { class: "panel admin-panel trash-panel", "aria-labelledby": "admin-trash-title" },
        headWithHint(h("h2", { class: "admin-h2", id: "admin-trash-title" }, T().admTrashTitle), T().admTrashHelp(TRASH_RETENTION_DAYS)),
        h("p", { class: "muted small admin-hint is-touch-only" }, T().admTrashHelp(TRASH_RETENTION_DAYS)),
        trashMsgEl,
        trashBodyEl,
      ),
    );
  }

  function renderAccounts(): void {
    members.render();
    resetRequests.render();
    renderTrash();
  }

  // =====================================================================================
  // Live tab: the live panel (views/manage/live.ts) on the admin API
  // =====================================================================================

  const live = createLivePanel({
    host,
    caseId: () => state.liveCaseId,
    cases: () => ({ released: state.today?.releasedCaseIds ?? [], todayId: state.today?.caseId ?? null }),
    progress: () => state.progress,
    onSelectCase: (caseId) => selectLiveCase(caseId, true),
    api: { resetCase: (caseId) => resetProgress(caseId), restartPlayer: restartPlayerCase },
    onCaseReset: async (caseId, title) => {
      const entry = await newestTrash((e) => e.kind === "progress" && e.label.startsWith(`progress of ${caseId} (`));
      undoToast(T().admCaseReset(title), entry);
    },
    onRestarted: async (player) => {
      const entry = await newestTrash((e) => e.kind === "progress" && e.label === `progress of ${player.caseId} for one player`);
      undoToast(T().admRestartedToast(player.username), entry);
    },
  });

  /** Switches the Live tab to another case; the case goes into the URL (replacing the entry: not a new Back step). */
  function selectLiveCase(caseId: string, updateUrl: boolean): void {
    if (caseId === state.liveCaseId) return;
    state.liveCaseId = caseId;
    state.progress = null;
    if (updateUrl && state.tab === "live") setUrl(adminHash("live", caseId), "replace");
    if (state.ready) {
      live.render();
      void load("enter");
    }
  }

  // =====================================================================================
  // Schedule tab: the schedule editor (views/manage/schedule.ts) on the admin API
  // =====================================================================================

  const schedule = createSchedulePanel({
    host,
    panel: tabPanels.get("schedule") ?? container,
    api: { load: fetchSchedule, save: saveSchedule },
    today: () => state.today,
    isActive: () => state.tab === "schedule",
    carried: carry?.schedule ?? null,
    onSaved: () => clearSavedNoteLater(),
    afterSave: async () => {
      try {
        state.today = await fetchToday();
      } catch {
        // the next poll will pick it up
      }
      todayFetchedAt = 0; // refetch on the next tick too, in case the CDN purge was still on its way
    },
  });

  /** Hides a "saved" note after a moment (the bar goes away with it). */
  let savedNoteTimer: number | null = null;
  function clearSavedNoteLater(): void {
    if (savedNoteTimer !== null) window.clearTimeout(savedNoteTimer);
    savedNoteTimer = window.setTimeout(() => {
      savedNoteTimer = null;
      if (disposed) return;
      schedule.clearNote();
      eventForm.clearNote();
      if (state.tab === "schedule") withFocusKept(schedule.render);
      if (state.tab === "event") eventForm.renderControls();
    }, SAVED_NOTE_MS);
  }

  // =====================================================================================
  // Event tab: the event form (views/manage/event.ts) on the admin API
  // =====================================================================================

  const eventForm = createEventPanel({
    host,
    panel: tabPanels.get("event") ?? container,
    api: { load: fetchEvent, save: saveEvent },
    isActive: () => state.tab === "event",
    carried: carry?.event ?? null,
    onSaved: () => clearSavedNoteLater(),
  });

  // =====================================================================================
  // Audit log
  // =====================================================================================

  const auditBodyEl = h("div", { class: "admin-table-wrap" });
  const auditCountEl = h("span", { class: "muted small" });
  let auditSig = "";
  let auditNames: ReadonlyMap<string, string> = new Map();
  const AUDIT_KINDS = ["all", "account", "progress", "event", "schedule", "settings", "trash"] as const;
  const auditKindOf = (action: string): string => action.split(".")[0] ?? action;
  let auditQuery = "";
  let auditKind = "all";
  const auditSearch = h("input", {
    type: "search",
    class: "admin-input audit-search",
    enterkeyhint: "search",
    placeholder: T().admAuditSearch,
    "aria-label": T().admAuditSearch,
  });
  auditSearch.addEventListener("input", () => {
    auditQuery = auditSearch.value;
    auditSig = "";
    renderAudit();
  });
  const auditKindSelect = h(
    "select",
    { class: "admin-input", "aria-label": T().admAuditKindLabel },
    AUDIT_KINDS.map((k) => h("option", { value: k }, T().admAuditKind(k))),
  );
  auditKindSelect.addEventListener("change", () => {
    auditKind = auditKindSelect.value;
    auditSig = "";
    renderAudit();
  });
  const auditDetailText = (e: AuditEntry): string => {
    const isAccount = e.action.startsWith("account.") || e.action === "progress.restart";
    const name = e.target === null ? "" : (auditNames.get(e.target) ?? (isAccount ? T().admUnknownAccount : e.target));
    let detail = e.detail ?? "";
    if (e.detail !== null && (e.action === "progress.restart" || e.action === "progress.reset")) detail = e.detail === "all cases" ? T().admAllCases : caseTitle(e.detail);
    return [name, detail].filter((x) => x !== "").join(" · ");
  };
  const auditTable = dataTable<AuditEntry>({
    columns: [
      {
        id: "time",
        header: T().admColTime,
        className: "col-seen",
        // Seconds matter here: a class's approvals land within the same minute.
        cell: (e) => tipped(h("time", { datetime: e.at }, formatDateTimeSec(e.at)), formatDateTimeSecZone(e.at)),
        sortValue: (e) => ms(e.at),
        sortFirst: "desc",
        csv: (e) => e.at,
      },
      { id: "action", header: T().admColAction, cell: (e) => h("span", { title: e.action }, T().admAuditAction(e.action)), sortValue: (e) => T().admAuditAction(e.action), csv: (e) => e.action },
      { id: "actor", header: T().admColActor, className: "audit-actor", cell: (e) => auditActor(e, auditNames), sortValue: (e) => auditActorText(e), csv: (e) => (e.actor === null ? "" : `${auditActorText(e)} (${e.actor})`) },
      { id: "target", header: T().admColTarget, className: "audit-target", cell: (e) => auditTarget(e, auditNames), csv: auditDetailText },
      { id: "via", header: T().admColVia, cell: (e) => h("span", { class: `via-pill is-${e.via}` }, T().admVia(e.via, e.actor === null || e.actor === AUDIT_ADMIN_ACTOR)), sortValue: (e) => e.via, csv: (e) => e.via },
    ],
    rows: [],
    className: "admin-table audit-table",
    wrapClass: "admin-dt",
    labelledBy: "admin-audit-title",
    initialSort: { id: "time", dir: "desc" },
    stackOnPhone: true,
  });
  const auditExportBtn = h(
    "button",
    {
      type: "button",
      class: "btn btn-ghost btn-sm",
      title: T().admExportViewHint,
      onclick: () => auditTable.downloadCsv(`incidentlab-audit-${new Date().toISOString().slice(0, 10)}.csv`),
    },
    T().admExportView,
  );

  function buildAuditPanel(): void {
    setChildren(
      tabPanels.get("audit") ?? container,
      h(
        "section",
        { class: "panel admin-panel", "aria-labelledby": "admin-audit-title" },
        h(
          "div",
          { class: "admin-table-head" },
          headWithHint(h("h2", { class: "admin-h2", id: "admin-audit-title" }, T().admAuditTitle, " ", auditCountEl), T().admAuditHint),
          h("div", { class: "admin-controls" }, auditSearch, auditKindSelect, auditExportBtn),
        ),
        h("p", { class: "muted small admin-hint is-touch-only" }, T().admAuditHint),
        auditBodyEl,
      ),
    );
    auditSig = "";
  }

  /** Who did it, as text: the site owner, the account's username, or "deleted account" (search, sort, CSV). */
  function auditActorText(e: AuditEntry): string {
    if (e.actor === null) return "";
    if (e.actor === AUDIT_ADMIN_ACTOR) return T().admActorOwner;
    return auditNames.get(e.actor) ?? T().admActorGone;
  }

  /** The actor cell (#185): the owner pill, or the account's name with its id (the id survives a delete). */
  function auditActor(e: AuditEntry, names: ReadonlyMap<string, string>): Child[] {
    if (e.actor === null) return ["—"];
    if (e.actor === AUDIT_ADMIN_ACTOR) return [h("span", { class: "via-pill is-owner" }, T().admActorOwner)];
    const name = names.get(e.actor);
    return [
      name !== undefined ? h("span", { class: "player-name", dir: "auto" }, name) : h("span", { class: "muted" }, T().admActorGone),
      " ",
      h("code", { class: "muted small audit-actor-id", dir: "ltr" }, e.actor),
    ];
  }

  function auditTarget(e: AuditEntry, names: ReadonlyMap<string, string>): Child[] {
    const out: Child[] = [];
    if (e.target !== null) {
      const name = names.get(e.target);
      // Account targets that are gone say so; other targets (a case id, a trash entry) show as they are.
      const isAccount = e.action.startsWith("account.") || e.action === "progress.restart";
      out.push(
        name !== undefined
          ? h("span", { class: "player-name", dir: "auto" }, name)
          : isAccount
            ? h("span", { class: "muted", title: e.target }, T().admUnknownAccount)
            : h("code", { class: "muted", dir: "ltr" }, e.target),
      );
    }
    if (e.detail !== null) {
      let detail = e.detail;
      if (e.action === "progress.restart" || e.action === "progress.reset") {
        detail = e.detail === "all cases" ? T().admAllCases : caseTitle(e.detail);
      }
      if (out.length > 0) out.push(" · ");
      out.push(h("span", { class: "muted", dir: "auto" }, detail));
    }
    if (out.length === 0) out.push("—");
    return out;
  }

  function renderAudit(): void {
    const entries = state.audit?.entries ?? null;
    const names = new Map(Object.entries(state.audit?.names ?? {}));
    const sig = JSON.stringify([getLang(), entries, [...names]]);
    if (sig === auditSig) return;
    auditSig = sig;
    auditNames = names;
    auditCountEl.textContent = "";
    if (entries === null) {
      setChildren(auditBodyEl, h("p", { class: "muted admin-empty-small" }, T().admLoading));
      return;
    }
    if (entries.length === 0) {
      setChildren(auditBodyEl, h("p", { class: "muted admin-empty-small" }, T().admAuditEmpty));
      return;
    }
    const q = auditQuery.trim().toLowerCase();
    const shown = entries.filter(
      (e) =>
        (auditKind === "all" || auditKindOf(e.action) === auditKind) &&
        (q === "" || `${T().admAuditAction(e.action)} ${e.action} ${auditActorText(e)} ${e.actor ?? ""} ${auditDetailText(e)}`.toLowerCase().includes(q)),
    );
    auditCountEl.textContent = `(${shown.length === entries.length ? fmtInt(entries.length) : T().admAuditShown(fmtInt(shown.length), fmtInt(entries.length))})`;
    if (shown.length === 0) {
      setChildren(auditBodyEl, h("p", { class: "muted admin-empty-small" }, T().admAuditNoMatch));
      return;
    }
    auditTable.update(shown);
    if (auditTable.element.parentNode !== auditBodyEl) setChildren(auditBodyEl, auditTable.element);
  }

  // =====================================================================================
  // Stats tab: the stats panel (views/manage/stats.ts) on the admin API
  // =====================================================================================

  // =====================================================================================
  // Classes (#185): every class on the site, on demand (views/manage/ownerClasses.ts)
  // =====================================================================================

  // Overview (#235): the default section, on demand (opening it, Refresh), never on the timer.
  const overview = createOverviewPanel({
    host,
    api: { load: fetchOverview },
    links: { reviews: REVIEWS_HREF, accounts: adminHash("accounts", null) },
  });

  const ownerClasses = createOwnerClassesPanel({
    host,
    api: { list: fetchAdminClasses, setMemberLimit: setClassMemberLimit, setArchived: setClassArchived },
  });

  const statsPanel = createStatsPanel({
    api: { progress: fetchProgress },
    stats: () => state.stats,
    accounts: () => state.topUsers,
    todayId: () => state.today?.caseId ?? null,
  });

  // =====================================================================================
  // Projector board (views/manage/board.ts): the public board, with the admin's event clock when it has one
  // =====================================================================================

  const board = createBoardPanel({
    host,
    api: { load: fetchPublicLeaderboard },
    cases: () => state.today?.releasedCaseIds ?? [],
    // The event as the room sees it: the admin's copy once the Event section loaded it, else the public poll's.
    eventClock: () => {
      const saved = eventForm.server();
      return saved ? { event: saved, now: eventForm.serverNow() } : { event: cachedEvent(), now: publicServerNow() };
    },
  });

  // ---- render dispatch ------------------------------------------------------------------

  function renderActiveTab(): void {
    switch (state.tab) {
      case "overview":
        overview.render();
        break;
      case "accounts":
        renderAccounts();
        break;
      case "classes":
        ownerClasses.render();
        break;
      case "live":
        live.render();
        break;
      case "schedule":
        schedule.render();
        break;
      case "stats":
        statsPanel.render();
        break;
      case "event":
        eventForm.render();
        break;
      case "audit":
        renderAudit();
        break;
    }
  }

  function renderData(): void {
    // The pending count is visible on the tab from anywhere.
    if (state.tab !== "accounts") members.renderPending();
    // Keep the schedule and event editors (and focus) intact while polling.
    if (state.tab === "schedule") schedule.renderToday();
    else if (state.tab === "event") eventForm.renderStatus();
    else renderActiveTab();
    renderUpdated();
    renderBanner();
  }

  // ---- data loading ----------------------------------------------------------------------

  function ensureLiveCase(): void {
    if (state.liveCaseId || !state.today) return;
    state.liveCaseId = state.today.caseId ?? state.today.releasedCaseIds[0] ?? null;
  }

  function applyTrash(res: TrashEntry[] | Error): void {
    const t = state.trash;
    if (res instanceof Error) {
      // 404: this server has no trash endpoint yet.
      t.unavailable = res instanceof AdminApiError && res.status === 404;
      t.error = t.unavailable ? null : errMessage(res);
      return;
    }
    t.unavailable = false;
    t.error = null;
    t.entries = res;
  }

  /**
   * Loads what the section on screen needs. A tick (the poll) fetches only what changes by the second: the Live
   * case's progress and the site announcement. Opening a section ("enter") and a refresh ("manual") also fetch
   * the on-demand sections (users, classes, stats, audit, trash); a refresh updates the review count.
   */
  async function load(mode: LoadMode = "tick"): Promise<void> {
    if (disposed) return;
    if (state.loading) {
      if (state.queued === null || LOAD_RANK[mode] > LOAD_RANK[state.queued]) state.queued = mode;
      return;
    }
    if (state.auth === null) return showLogin(null);
    state.loading = true;
    state.queued = null;
    const tab = state.tab;
    const onDemand = mode !== "tick";
    const liveCase = state.liveCaseId;
    const eventRev = eventForm.rev();
    const usersSeq = tab === "accounts" && onDemand ? ++state.usersSeq : null;
    // The projector board refreshes with the dashboard (public endpoint; its errors stay on the board).
    board.refresh();
    // Recently deleted is optional: a server without it (404) or a failure must not break the dashboard.
    const trashReq: Promise<TrashEntry[] | AdminApiError | Error> | null =
      tab === "accounts" && onDemand ? fetchTrash().catch((err: unknown) => (err instanceof Error ? err : new Error(T().admUnknownError))) : null;
    try {
      // Today's case changes at most once a day (or on a schedule save, which reloads it itself): once a minute
      // is plenty, and it halves the dashboard's calls per tick.
      const todayDue = Date.now() - todayFetchedAt >= TODAY_REFRESH_MS;
      const [users, today, progress, stats, event, audit, top, reviews] = await Promise.all([
        usersSeq !== null ? fetchUsers(members.query()) : Promise.resolve(null),
        todayDue ? fetchToday() : Promise.resolve(null),
        tab === "live" && liveCase ? fetchProgress(liveCase) : Promise.resolve(null),
        tab === "stats" && onDemand ? fetchCaseStats() : Promise.resolve(null),
        tab === "event" && !eventForm.saving() ? fetchEvent() : Promise.resolve(null),
        tab === "audit" && onDemand ? fetchAudit(AUDIT_LIMIT) : Promise.resolve(null),
        tab === "stats" && onDemand ? fetchUsers({ sort: "rank", kind: "user", status: "approved", limit: 10 }) : Promise.resolve(null),
        mode === "manual" ? fetchReviewCount().catch(() => null) : Promise.resolve(null),
        mode === "manual" ? loadNeeds() : Promise.resolve(),
        // The class list reports its own errors in its section.
        tab === "classes" && onDemand ? ownerClasses.load() : Promise.resolve(),
        // And the overview (#235).
        tab === "overview" && onDemand ? overview.load() : Promise.resolve(),
        // So does the reset request queue (#254).
        tab === "accounts" && onDemand ? resetRequests.load() : Promise.resolve(),
      ]);
      if (disposed) return;
      if (users && usersSeq === state.usersSeq) state.users = users;
      if (top) state.topUsers = top.accounts;
      if (reviews !== null) {
        state.reviews = reviews;
        renderReviewsBadge();
      }
      if (today) {
        state.today = today;
        todayFetchedAt = Date.now();
      }
      if (progress && progress.caseId === state.liveCaseId) state.progress = progress;
      if (stats) {
        state.stats = stats;
        await statsPanel.loadProgress(stats);
        if (disposed) return;
      }
      if (trashReq) applyTrash(await trashReq);
      if (event && eventRev === eventForm.rev() && !eventForm.saving()) eventForm.applyPoll(event);
      if (audit) state.audit = audit;
      ensureLiveCase();
      state.lastUpdated = Date.now();
      state.banner = null;
      state.failures = 0;
      // The tab or the live case changed mid-flight: fetch again right away.
      if ((state.tab !== tab || state.liveCaseId !== liveCase) && state.queued === null) state.queued = "enter";
      renderData();
    } catch (err: unknown) {
      if (disposed) return;
      if (handleAuthError(err)) return;
      state.failures += 1;
      state.banner = T().admConnProblem(errMessage(err), Math.round(nextDelay() / 1000));
      renderBanner();
    } finally {
      state.loading = false;
      const queued = state.queued;
      if (queued !== null && !disposed && state.ready) {
        state.queued = null;
        void load(queued);
      } else {
        scheduleNext();
      }
    }
  }

  // 5s normally; exponential backoff on errors: 10s, 20s, 40s, capped at 60s.
  function nextDelay(): number {
    return state.failures === 0 ? POLL_MS : Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** state.failures);
  }

  function scheduleNext(): void {
    if (pollId !== null) window.clearTimeout(pollId);
    pollId = null;
    // Only the live sections poll; the others wait for the instructor (on-demand, #185).
    if (disposed || state.paused || !state.ready || !POLLED_TABS.has(state.tab) || document.visibilityState === "hidden") return;
    pollId = window.setTimeout(() => {
      pollId = null;
      if (!container.isConnected) return dispose();
      void load();
    }, nextDelay());
  }

  async function start(): Promise<void> {
    if (state.auth === null) return showLogin(null);
    try {
      // The settings call is the sign-in check (admin only, one record); the users list loads with its section.
      // Its value (the legacy site invite code, #204) is no longer shown: classes replaced it.
      const [today, , reviews] = await Promise.all([fetchToday(), fetchSettings(), fetchReviewCount().catch(() => null)]);
      if (disposed) return;
      state.ready = true;
      state.reviews = reviews;
      state.today = today;
      todayFetchedAt = Date.now();
      ensureLiveCase();
      state.lastUpdated = Date.now();
      state.banner = null;
    } catch (err: unknown) {
      if (disposed) return;
      if (handleAuthError(err)) return;
      // Signed in as the owner: a failed load is an outage, not a sign-in problem, so never the key form.
      if (state.auth === "session") return showLoadError(err, () => void start());
      showLogin(err instanceof Error ? err.message : T().admLoadFailed);
      return;
    }
    buildDashboard();
    renderNeeds();
    void loadNeeds();
    // Canonical deep link for the current view (no new history entry).
    if (isAdminHash(location.hash)) setUrl(adminHash(state.tab, state.liveCaseId), "replace");
    stopTimers();
    renderData();
    renderActiveTab();
    if (state.tab === "schedule") void schedule.load();
    if (state.tab === "event") void eventForm.load();
    // The section on screen loads its data (the on-demand ones once, the live ones then poll).
    void load("enter");
    tickId = window.setInterval(() => {
      if (!container.isConnected) return dispose();
      renderUpdated();
      if (state.tab === "event") eventForm.renderStatus();
      board.tick();
    }, 1000);
  }

  /** The admin session cookie wins (no key gate); otherwise a key typed earlier in this tab; otherwise the gate. */
  async function bootstrap(): Promise<void> {
    document.title = `${TS().navConsole} · IncidentLab`;
    setChildren(container, h("p", { class: "muted admin-loading" }, T().admLoadingDashboard));
    let sessionAdmin = false;
    let signedIn = false;
    let sessionError: unknown = null;
    try {
      const me = await fetchMe();
      sessionAdmin = me?.role === "admin";
      signedIn = me !== null;
    } catch (err: unknown) {
      // network trouble: fall back to the key (if any), whose own request reports the error
      sessionError = err;
    }
    if (disposed) return;
    if (sessionAdmin) {
      // A stale key would be sent as a header and rejected (a bad header is never ignored), so drop it.
      clearAdminKey();
      state.auth = "session";
      return start();
    }
    if (getAdminKey()) {
      state.auth = "key";
      return start();
    }
    // The session check itself failed: whoever this is (the owner, likely), the key form is not the answer.
    if (sessionError !== null) return showLoadError(sessionError, () => void bootstrap());
    // #221: the admin-key form is never shown to people. Signed out, the one sign-in page (the owner signs in there
    // as `admin`; tools keep the X-Admin-Key header); signed in as someone else, say whose console this is.
    if (signedIn) return showNotOwner();
    window.location.replace("#/login");
  }

  function showNotOwner(): void {
    stopTimers();
    state.ready = false;
    gateShown = true;
    syncShellSidebar();
    setChildren(
      container,
      h(
        "section",
        { class: "center-card" },
        h("h1", {}, TS().navConsole),
        h("p", { class: "muted" }, T().admOwnerOnly),
        h("div", { class: "row-center" }, h("a", { class: "btn btn-primary", href: "#/" }, TS().navHome)),
      ),
    );
  }

  void bootstrap();
}
