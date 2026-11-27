// Instructor dashboard (#/admin). All API data (usernames above all) is rendered via textContent / attributes only — never innerHTML.
// Tabs: Accounts (approve sign-ups, per-user stats, invite code, CSV) · Live (one case, polled) · Event (window, freeze,
// announcement) · Schedule (incident of the day) · Stats (per case) · Audit log.
// Auth: the `admin` session cookie (signed in on #/login with the ADMIN_KEY) or an admin key typed into the gate.
import "../admin.css";
import { T } from "../i18n/strings-tools";
import { getLang } from "../i18n/i18n";
import {
  TRASH_RETENTION_DAYS,
  type AdminProgress,
  type AuditEntry,
  type CaseSummary,
  type LeaderboardResponse,
  type LiveEvent,
  type QuestionId,
  type Schedule,
  type Settings,
  type TodayResponse,
  type TrashEntry,
  type UserStats,
} from "../../shared/contract";
import { cachedCase } from "../content/load";
import { cachedEvent, eventPhase, formatCountdown, serverNow as publicServerNow } from "../lib/event";
import { dataTable } from "../components/dataTable";
import { formActions, formField } from "../components/formLayout";
import { copyButton, h, setChildren, type Child } from "../lib/dom";
import { TS } from "../i18n/strings-shell";
import { clickClosedDrawer, navSubLink, refreshNav, showSubNav } from "../shell/nav";
import { setPageCrumb } from "../shell/topbar";
import { scrollerOf } from "../shell/scroll";
import type { NavSection, ViewResult } from "../shell/types";
import { banner, closeMenu, showDialog, toast, tooltip, type DialogHandle } from "../lib/overlay";
import {
  AdminApiError,
  approveAll,
  clearAdminKey,
  deleteAccount,
  fetchAccounts,
  fetchAudit,
  fetchCaseStats,
  fetchEvent,
  fetchExportCsv,
  fetchMe,
  fetchProgress,
  fetchPublicLeaderboard,
  fetchSchedule,
  fetchSettings,
  fetchToday,
  fetchTrash,
  getAdminKey,
  logoutSession,
  resetAccountPassword,
  resetProgress,
  restartPlayerCase,
  restoreTrash,
  saveEvent,
  saveSchedule,
  saveSettings,
  setAccountRole,
  setAccountStatus,
  setAccountsStatus,
  setAdminKey,
  type AdminAccountsResult,
  type AdminEventResult,
  type AdminProgressResult,
  type AdminStatsResult,
} from "../lib/admin-api";
import { caseMaxScore, caseQuestionIds, caseTitle, questionTitle } from "./manage/caseInfo";
import {
  errMessage,
  fmtDec1,
  fmtInt,
  formatDateTime,
  formatDateTimeSec,
  formatDateTimeSecZone,
  formatDateTimeZone,
  formatDuration,
  formatFinish,
  formatPct,
  locale,
  median,
  ms,
  pad2,
  relativeAgo,
  relativeIn,
} from "./manage/format";
import { finishDurationMs } from "./manage/progressMetrics";
import { headWithHint, tipped } from "./manage/ui";
import { createMembersPanel } from "./manage/members";
import { createLivePanel } from "./manage/live";
import { createSchedulePanel } from "./manage/schedule";
import { NARROW_QUERY, createManageHost } from "./manage/host";

const POLL_MS = 5000;
/** The dashboard poll refetches /api/today at most this often (see load()). */
const TODAY_REFRESH_MS = 60_000;
/** Rows on the projector board; the rest are summed up as "+N more". */
const BOARD_ROWS = 10;
const MAX_BACKOFF_MS = 60000;
const TAB_STORAGE = "il.adminTab";

type TabId = "accounts" | "live" | "event" | "schedule" | "stats" | "audit";
const TABS: readonly TabId[] = ["accounts", "live", "event", "schedule", "stats", "audit"];
const isTabId = (v: string | null): v is TabId => TABS.some((t) => t === v);

/** Rail icons (decorative: the link carries the name). 24px grid, stroke drawn in currentColor. */
const svgIcon = (paths: string): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${paths}</svg>`;
const SECTION_ICONS: Readonly<Record<TabId, string>> = {
  accounts: svgIcon('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>'),
  live: svgIcon('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  stats: svgIcon('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M21 20H3"/>'),
  event: svgIcon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/>'),
  schedule: svgIcon('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>'),
  audit: svgIcon('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 12h7"/><path d="M9 16h7"/>'),
};
const AUDIT_LIMIT = 100;
const EVENT_QUICK_MINUTES = 60;
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L: easy to read aloud and type

type AuthMode = "key" | "session";
/** "Hardest question" needs at least this many players who reached it. */
const HARDEST_MIN_PLAYERS = 3;
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

/** Unsaved drafts carried over when the view re-renders in place (the language toggle re-runs the route). */
let carried: { schedule: Schedule | null; event: LiveEvent | null } | null = null;



/** Overall leaderboard: approved accounts that have played, by server rank. */
function topPlayers(accounts: readonly UserStats[], n: number): UserStats[] {
  return accounts
    .filter((a) => a.status === "approved" && a.rank !== null && a.casesStarted > 0)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.totalScore - a.totalScore || a.username.localeCompare(b.username))
    .slice(0, n);
}

// ---- stats ------------------------------------------------------------------------

type QuestionFunnel = { q: QuestionId; reached: number; solved: number; revealed: number; avgWrong: number; avgHints: number };

/**
 * Per question: how many players reached it (from the per-player progress when we have it; otherwise the
 * lower bound solved + gave up), and the server's solved / gave-up / averages.
 */
function questionFunnel(summary: CaseSummary, players: readonly AdminProgress[] | null): QuestionFunnel[] {
  return caseQuestionIds(summary.caseId).map((q) => {
    const s = summary.questions[q];
    const solved = s?.solved ?? 0;
    const revealed = s?.revealed ?? 0;
    const reached = players ? players.filter((p) => (p.stages[q]?.status ?? "locked") !== "locked").length : solved + revealed;
    return { q, reached: Math.max(reached, solved + revealed), solved, revealed, avgWrong: s?.avgWrong ?? 0, avgHints: s?.avgHints ?? 0 };
  });
}

/**
 * Hardest = the largest share of players who reached the question but haven't solved it (gave up or still
 * on it: the drop-off), then the most wrong attempts. Only questions at least HARDEST_MIN_PLAYERS reached count.
 */
function hardestQuestion(rows: readonly QuestionFunnel[]): { row: QuestionFunnel; rate: number } | null {
  let best: { row: QuestionFunnel; rate: number } | null = null;
  for (const row of rows) {
    if (row.reached < HARDEST_MIN_PLAYERS) continue;
    const rate = (row.reached - row.solved) / row.reached;
    if (rate === 0 && row.avgWrong === 0) continue;
    if (best === null || rate > best.rate || (rate === best.rate && row.avgWrong > best.row.avgWrong)) best = { row, rate };
  }
  return best;
}

// ---- schedule ---------------------------------------------------------------------



// ---- event (datetime-local <-> ISO UTC) -------------------------------------------------

/** ISO instant -> "YYYY-MM-DDTHH:mm" in this browser's local time (what <input type="datetime-local"> expects). */
function isoToLocalInput(iso: string | null): string {
  const t = ms(iso);
  if (t === null) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "YYYY-MM-DDTHH:mm" (local) -> ISO UTC, or null when empty/invalid. */
function localInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const d = new Date(value); // no offset in the string: parsed as local time
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function browserTimeZone(): { name: string; offset: string } {
  let name = "local";
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    // keep "local"
  }
  const mins = -new Date().getTimezoneOffset();
  const sign = mins >= 0 ? "+" : "−";
  const abs = Math.abs(mins);
  return { name, offset: `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}` };
}

const cloneEvent = (e: LiveEvent): LiveEvent => ({ ...e, announcement: e.announcement ? { ...e.announcement } : null });
const eventSig = (e: LiveEvent): string =>
  JSON.stringify([e.name.trim(), e.startsAt, e.endsAt, e.freezeAt, e.enforceWindow, e.announcement?.text.trim() ?? "", e.announcement?.level ?? null]);

/** Turns the form draft into what the server expects: trimmed name, empty announcement -> null. */
function normalizeEvent(e: LiveEvent): LiveEvent {
  const text = e.announcement?.text.trim() ?? "";
  return { ...e, name: e.name.trim(), announcement: text ? { text, level: e.announcement?.level ?? "info" } : null };
}

function randomInviteCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length] ?? "X");
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function readStoredTab(): TabId {
  try {
    const v = sessionStorage.getItem(TAB_STORAGE);
    return isTabId(v) ? v : "accounts";
  } catch {
    return "accounts";
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
    accounts: null as AdminAccountsResult | null,
    today: null as TodayResponse | null,
    progress: null as AdminProgressResult | null,
    stats: null as AdminStatsResult | null,
    /** per-case player progress for the Stats tab (how many reached each question) */
    statsProgress: new Map<string, readonly AdminProgress[]>(),
    liveCaseId: urlState.caseId,
    lastUpdated: 0,
    paused: false,
    loading: false,
    queued: false,
    banner: null as string | null,
    failures: 0,
    leaderboard: false,
    /** projector board: public leaderboard (honours the freeze); null scope = overall */
    board: {
      scope: null as string | null,
      data: null as LeaderboardResponse | null,
      error: null as string | null,
    },
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
    // class invite code (Accounts tab)
    settings: {
      server: null as Settings | null,
      input: "",
      saving: false,
      error: null as string | null,
      msg: null as string | null,
      /** bumped by every save: a poll that started earlier must not overwrite the saved value */
      rev: 0,
    },
    // event tab
    event: {
      server: null as LiveEvent | null,
      draft: null as LiveEvent | null,
      /** serverTime - Date.now() at the last response */
      offsetMs: 0,
      rev: 0,
      loading: false,
      saving: false,
      error: null as string | null,
      msg: null as string | null,
    },
    audit: null as AuditEntry[] | null,
  };

  // The services every manage panel gets (views/manage/host.ts): the root, the poll, errors, confirms and menus.
  const host = createManageHost({
    container,
    disposed: () => disposed,
    narrow: () => state.narrow,
    refresh: () => void load(),
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
    boardDialog?.close(null);
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
    if (eventDirty()) parts.push(T().admSecEvent);
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
    const tab = next.tab ?? "accounts";
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
      if (state.accounts) applyUrlState();
      setPageCrumb(tabLabel(state.tab));
      if (lastFocused && lastFocused.isConnected) lastFocused.focus({ preventScroll: true });
    },
    dirtyDrafts: () => ({ schedule: schedule.dirty() ? schedule.draft() : null, event: eventDirty() ? state.event.draft : null }),
  };
  function onVisibility(): void {
    if (document.visibilityState === "hidden") {
      if (pollId !== null) window.clearTimeout(pollId);
      pollId = null;
    } else if (state.accounts && !state.paused) {
      void load();
    }
  }
  function onBeforeUnload(e: BeforeUnloadEvent): void {
    if (schedule.dirty() || eventDirty()) e.preventDefault();
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
    if (state.accounts) renderActiveTab();
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
    state.accounts = null;
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

  /** 401 / 503 send the instructor back to the key gate. Returns true when handled. */
  function handleAuthError(err: unknown): boolean {
    if (!(err instanceof AdminApiError)) return false;
    if (err.status === 401) {
      const wasSession = state.auth === "session";
      clearAdminKey();
      showLogin(wasSession ? T().admSessionExpired : T().admKeyRejected);
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
  // The projector board: a full-screen modal dialog (lib/overlay.ts) whose content re-renders in place.
  const leaderboardEl = h("div", { class: "admin-board-content" });
  let boardDialog: DialogHandle<string> | null = null;

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
  refreshBtn.addEventListener("click", () => void load());
  boardBtn.addEventListener("click", () => {
    state.leaderboard = true;
    renderLeaderboard();
    void loadBoard();
  });
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

  const tabLabel = (tab: TabId): string => {
    switch (tab) {
      case "accounts":
        return T().admTabAccounts;
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
  };

  // ---- the sections: sidebar navigation (#60) ----------------------------------------------
  // Links, not a tablist: each section has its own URL (#/admin?tab=…), so the browser's Back, "open in a new
  // tab" and copy-link work, and aria-current marks the one on screen. A plain click is handled here (pushState,
  // so the router doesn't rebuild the page) and goes through selectTab's unsaved-edits guard.
  const pendingTabBadge = h("span", { class: "tab-badge nav-sub-badge" });
  pendingTabBadge.hidden = true;
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
    { id: "people", label: TS().adminGroupPeople, tabs: ["accounts"] },
    { id: "live", label: TS().adminGroupLive, tabs: ["live", "stats"] },
    { id: "event", label: TS().adminGroupEvent, tabs: ["event", "schedule"] },
    { id: "audit", label: TS().adminGroupAudit, tabs: ["audit"] },
  ];

  /** Fills the nav section once per instance: the sections in their groups' order. */
  function buildSidebar(): void {
    sectionLinks.clear();
    side.content.setAttribute("aria-label", T().admTabsLabel);
    setChildren(side.content, sectionGroups.flatMap((g) => g.tabs).map((tab) => h("li", {}, sectionLink(tab))));
  }

  /** Shows (or, at the sign-in gate, removes) this dashboard's nav section, when it is the page on screen. */
  function syncShellSidebar(): void {
    if (disposed || !container.isConnected) return;
    showSubNav(gateShown ? null : navSpec);
    setPageCrumb(gateShown ? null : tabLabel(state.tab));
  }

  function syncTabs(): void {
    setPageCrumb(tabLabel(state.tab));
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
    const dirty = leaving === "schedule" ? schedule.dirty() : leaving === "event" ? eventDirty() : false;
    if (dirty) {
      // Ask first; the tab stays until the draft is discarded, then the switch runs again (now clean).
      void confirmLeave(leaving === "schedule" ? T().admSecSchedule : T().admSecEvent).then((ok) => {
        if (!ok || disposed || state.tab !== leaving) return;
        if (leaving === "schedule") schedule.discard();
        else discardEvent();
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
    if (tab === "event" && !state.event.draft) void loadEvent();
    void load();
    return true;
  }

  /** The sticky save bar is visible on the active tab: leave room for it when the browser scrolls focus into view. */
  function syncSaveBarClass(): void {
    const open =
      (state.tab === "schedule" && schedule.barVisible()) || (state.tab === "event" && eventBarVisible());
    document.documentElement.classList.toggle("admin-savebar-open", open);
  }

  function buildDashboard(): void {
    setChildren(
      container,
      h(
        "header",
        { class: "admin-head" },
        h(
          "div",
          { class: "admin-head-title" },
          h("p", { class: "eyebrow" }, T().admInstructorLive),
          h("h1", { class: "admin-title" }, T().admClassDashboard),
        ),
        // The page's quick actions: freshness, pause/refresh, the projector board (and Sign out for a typed key).
        h(
          "div",
          { class: "admin-head-actions" },
          updatedEl,
          pauseBtn,
          refreshBtn,
          boardBtn,
          // A session admin signs out from the account menu in the top bar; a typed key has no account there.
          state.auth === "key" ? logoutBtn : null,
        ),
      ),
      statusBanner.el,
      [...tabPanels.values()],
    );
    buildSidebar();
    gateShown = false;
    syncShellSidebar();
    buildAccountsPanel();
    live.mount(tabPanels.get("live") ?? container);
    buildStatsPanel();
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
  // Accounts tab: the members panel (views/manage/members.ts) on the admin API, then the trash and invite code
  // =====================================================================================

  const members = createMembersPanel({
    host,
    accounts: {
      get: () => state.accounts?.accounts ?? null,
      set: (list) => {
        if (state.accounts && list) state.accounts = { ...state.accounts, accounts: [...list] };
      },
    },
    api: {
      setStatus: setAccountStatus,
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
      pendingTabBadge.textContent = fmtInt(n);
      pendingTabBadge.hidden = n === 0;
      pendingTabBadge.setAttribute("aria-label", T().admPendingBadge(n));
      const railLabel = n === 0 ? tabLabel("accounts") : `${tabLabel("accounts")}, ${T().admPendingBadge(n)}`;
      for (const link of sectionLinks.get("accounts") ?? []) link.dataset.navTip = railLabel;
      refreshNav();
    },
    rerender: () => renderAccounts(),
  });

  /**
   * The trash entry a soft delete just created (newest first from the server), for the Undo in its toast.
   * Matched by the server's label; null when it can't be found (the toast then has no Undo).
   */
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

  // ---- class invite code ----
  const inviteCurrentEl = h("div", { class: "invite-current" });
  const inviteInput = h("input", {
    type: "text",
    id: "admin-invite",
    class: "admin-input invite-input",
    placeholder: T().admInvitePh,
    autocomplete: "off",
    spellcheck: "false",
    maxlength: 40,
    dir: "ltr",
  });
  const inviteField = formField({ input: inviteInput, label: T().admInviteInputLabel });
  inviteInput.addEventListener("input", () => {
    state.settings.input = inviteInput.value;
    state.settings.msg = null;
    state.settings.error = null;
    renderInvite();
  });
  const inviteSetBtn = h("button", { type: "submit", class: "btn btn-outline btn-sm" }, T().admInviteSave);
  const inviteGenBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admInviteGenerate);
  const inviteClearBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admInviteClear);
  const inviteMsgEl = h("p", { class: "small invite-msg", role: "status" });
  const inviteForm = h("form", { class: "invite-form", novalidate: true }, inviteField.nodes, formActions(inviteSetBtn, inviteGenBtn, inviteClearBtn));
  inviteForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = state.settings.input.trim();
    if (code.length < 4 || code.length > 40) {
      state.settings.error = T().admInviteInvalid;
      renderInvite();
      inviteInput.focus();
      return;
    }
    void storeInvite(code);
  });
  inviteGenBtn.addEventListener("click", () => {
    inviteInput.value = randomInviteCode();
    state.settings.input = inviteInput.value;
    state.settings.msg = null;
    state.settings.error = null;
    renderInvite();
    inviteInput.focus();
    inviteInput.select();
  });
  // Turning the code off changes how every new sign-up is handled: ask, then offer Undo (puts the old code back).
  inviteClearBtn.addEventListener("click", () => {
    const previous = state.settings.server?.inviteCode ?? null;
    if (previous === null) return;
    void askConfirm({
      title: T().admInviteOffTitle,
      body: T().admInviteOffBody,
      confirmLabel: T().admInviteOffConfirm,
      tone: "primary",
      returnFocus: () => inviteInput,
    }).then(async (ok) => {
      if (!ok) return;
      await storeInvite(null);
      if (state.settings.error !== null) return;
      toast({ tone: "success", text: T().admInviteOffToast, action: { label: T().admUndo, run: () => void storeInvite(previous) } });
    });
  });

  async function storeInvite(code: string | null): Promise<void> {
    const st = state.settings;
    st.rev += 1;
    st.saving = true;
    st.error = null;
    st.msg = null;
    renderInvite();
    try {
      st.server = await saveSettings({ inviteCode: code });
      if (disposed) return;
      st.msg = code === null ? T().admInviteCleared : T().admInviteSaved;
      st.input = "";
      inviteInput.value = "";
    } catch (err: unknown) {
      if (disposed || handleAuthError(err)) return;
      st.error = T().admSaveFailed(errMessage(err));
    } finally {
      st.saving = false;
    }
    renderInvite();
  }

  let inviteCurrentSig = "";
  function renderInvite(): void {
    const st = state.settings;
    const code = st.server?.inviteCode ?? null;
    const sig = JSON.stringify([getLang(), st.server === null, code]);
    if (sig !== inviteCurrentSig) {
      inviteCurrentSig = sig;
      if (st.server === null) setChildren(inviteCurrentEl, h("p", { class: "muted small" }, T().admLoading));
      else if (code === null) setChildren(inviteCurrentEl, h("p", { class: "muted invite-off" }, T().admInviteOff));
      else {
        setChildren(
          inviteCurrentEl,
          h("span", { class: "admin-label" }, T().admInviteCurrent),
          h("code", { class: "admin-share-url invite-code" }, code),
          copyButton(() => code, T().admCopyCode),
        );
      }
    }
    if (inviteInput.value !== st.input) inviteInput.value = st.input;
    // Never a disabled submit: an empty or short code gets an inline error on submit instead.
    inviteSetBtn.disabled = st.saving;
    inviteGenBtn.disabled = st.saving;
    inviteClearBtn.disabled = st.saving || code === null;
    const fieldError = st.error !== null && st.error === T().admInviteInvalid;
    inviteField.setError(fieldError ? st.error : null);
    const msg = fieldError ? st.msg : (st.error ?? st.msg);
    inviteMsgEl.textContent = msg ?? "";
    inviteMsgEl.className = `small invite-msg${st.error && !fieldError ? " sched-invalid" : ""}`;
    inviteMsgEl.hidden = msg === null;
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
      void load();
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
      members.sections(),
      h(
        "section",
        { class: "panel admin-panel trash-panel", "aria-labelledby": "admin-trash-title" },
        headWithHint(h("h2", { class: "admin-h2", id: "admin-trash-title" }, T().admTrashTitle), T().admTrashHelp(TRASH_RETENTION_DAYS)),
        h("p", { class: "muted small admin-hint is-touch-only" }, T().admTrashHelp(TRASH_RETENTION_DAYS)),
        trashMsgEl,
        trashBodyEl,
      ),
      h(
        "section",
        { class: "panel admin-panel invite-panel" },
        headWithHint(h("h2", { class: "admin-h2" }, T().admInviteTitle), T().admInviteHelp),
        h("p", { class: "muted small admin-hint is-touch-only" }, T().admInviteHelp),
        inviteCurrentEl,
        inviteForm,
        inviteMsgEl,
      ),
    );
    renderInvite();
  }

  function renderAccounts(): void {
    members.render();
    renderInvite();
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
    if (state.accounts) {
      live.render();
      void load();
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
      state.event.msg = null;
      if (state.tab === "schedule") withFocusKept(schedule.render);
      if (state.tab === "event") renderEventControls();
    }, SAVED_NOTE_MS);
  }

  // =====================================================================================
  // Event tab (window, leaderboard freeze, announcement)
  // Form controls are built once and synced from the draft, so polling never steals focus.
  // =====================================================================================

  const serverNow = (): number => Date.now() + state.event.offsetMs;
  const isoAt = (t: number): string => new Date(Math.floor(t / 1000) * 1000).toISOString();

  function eventDirty(): boolean {
    const { server, draft } = state.event;
    return server !== null && draft !== null && eventSig(server) !== eventSig(draft);
  }

  function eventBarVisible(): boolean {
    const ev = state.event;
    return ev.draft !== null && (eventDirty() || ev.error !== null || ev.msg !== null || ev.saving);
  }

  function discardEvent(): void {
    const ev = state.event;
    if (!ev.server) return;
    ev.draft = cloneEvent(ev.server);
    ev.msg = null;
    ev.error = null;
    if (eventBuilt) syncEventForm();
  }

  /** Field-level problems the server would reject, shown next to the field (not only in the save bar). */
  function eventFieldErrors(d: LiveEvent): { end: string | null; freeze: string | null } {
    const start = ms(d.startsAt);
    const end = ms(d.endsAt);
    const freeze = ms(d.freezeAt);
    return {
      end: start !== null && end !== null && end <= start ? T().admErrEndBeforeStart : null,
      freeze: freeze !== null && end !== null && freeze > end ? T().admErrFreezeAfterEnd : null,
    };
  }

  const evStatusEl = h("p", { class: "adm-ev-status", "aria-live": "off" });
  const evClockEl = h("p", { class: "muted small adm-ev-clock" });
  const evBodyEl = h("div", { class: "admin-tabpanel adm-ev-body" });

  const evName = h("input", { type: "text", id: "ev-name", class: "admin-input", maxlength: 80, placeholder: T().admEventNamePh, autocomplete: "off", dir: "auto" });
  const timeInput = (id: string): HTMLInputElement =>
    h("input", { type: "datetime-local", id, class: "admin-input ev-time", step: 60, dir: "ltr", "aria-describedby": `${id}-preview ev-tz` });
  /** The picker shows the browser's own format (often US): this line repeats the value in the app locale, with the zone. */
  const timePreview = (id: string): HTMLParagraphElement => h("p", { class: "muted small ev-time-preview", id: `${id}-preview` });
  const evStart = timeInput("ev-start");
  const evEnd = timeInput("ev-end");
  const evFreeze = timeInput("ev-freeze");
  const evStartPreview = timePreview("ev-start");
  const evEndPreview = timePreview("ev-end");
  const evFreezePreview = timePreview("ev-freeze");
  const evAnnText = h("textarea", { id: "ev-ann", class: "admin-input ev-ann", maxlength: 280, rows: 3, dir: "auto", "aria-describedby": "ev-ann-help ev-ann-count" });
  const evAnnCount = h("span", { class: "muted small", id: "ev-ann-count" });
  const evAnnLevel = h(
    "select",
    { id: "ev-ann-level", class: "admin-input" },
    h("option", { value: "info" }, T().admLevel("info")),
    h("option", { value: "warning" }, T().admLevel("warning")),
  );
  const evAnnClear = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admAnnClear);
  const evStartNow = h("button", { type: "button", class: "btn btn-sm" }, T().admStartNow);
  const evEndNow = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admEndNow);
  const evFreezeBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admFreezeNow);
  const evSave = h("button", { type: "button", class: "btn btn-primary", id: "ev-save" }, T().admSaveEvent);
  const evDiscard = h("button", { type: "button", class: "btn btn-ghost", id: "ev-discard" }, T().admDiscard);
  const evStateEl = h("span", { class: "small", role: "status" });
  const evErrorEl = h("p", { class: "admin-error", role: "alert" });
  const evBar = h("div", { class: "sched-actions panel admin-panel" }, evSave, evDiscard, evStateEl, evErrorEl);

  function clearTimeBtn(input: HTMLInputElement, label: string, apply: (d: LiveEvent) => void): HTMLButtonElement {
    return h(
      "button",
      {
        type: "button",
        class: "btn btn-ghost btn-sm",
        "aria-label": T().admClearTimeLabel(label),
        onclick: () => {
          input.value = "";
          editEvent(apply);
        },
      },
      T().admClearTime,
    );
  }

  // The form's fields (components/formLayout.ts): label, inline error, control; the time fields add the locale
  // preview and a Clear button, and stay described by the preview and the time-zone note.
  const evNameField = formField({ input: evName, label: T().admEventName });
  // A note (the freeze explanation) goes under the control, so the three time inputs line up across columns.
  const timeField = (input: HTMLInputElement, label: string, preview: HTMLElement, apply: (d: LiveEvent) => void, note?: string) => {
    const noteId = `${input.id}-note`;
    return formField({
      input,
      label,
      describedBy: [preview.id, ...(note ? [noteId] : []), "ev-tz"],
      extra: h(
        "div",
        { class: "ev-time-extra" },
        preview,
        clearTimeBtn(input, label, apply),
        note ? h("p", { class: "muted small ev-time-note", id: noteId }, note) : null,
      ),
    });
  };
  const evStartField = timeField(evStart, T().admStartsAt, evStartPreview, (d) => (d.startsAt = null));
  const evEndField = timeField(evEnd, T().admEndsAt, evEndPreview, (d) => (d.endsAt = null));
  const evFreezeField = timeField(evFreeze, T().admFreezeAt, evFreezePreview, (d) => (d.freezeAt = null), T().admFreezeHelp);

  /** Mutates the draft from a control and refreshes the derived bits (no form rebuild). */
  function editEvent(mutate: (d: LiveEvent) => void): void {
    const ev = state.event;
    if (!ev.draft) return;
    mutate(ev.draft);
    ev.msg = null;
    ev.error = null;
    renderEventControls();
  }

  evName.addEventListener("input", () => editEvent((d) => (d.name = evName.value)));
  evStart.addEventListener("change", () => editEvent((d) => (d.startsAt = localInputToIso(evStart.value))));
  evEnd.addEventListener("change", () => editEvent((d) => (d.endsAt = localInputToIso(evEnd.value))));
  evFreeze.addEventListener("change", () => editEvent((d) => (d.freezeAt = localInputToIso(evFreeze.value))));
  const levelOf = (v: string): "info" | "warning" => (v === "warning" ? "warning" : "info");
  evAnnText.addEventListener("input", () => editEvent((d) => (d.announcement = { text: evAnnText.value, level: levelOf(evAnnLevel.value) })));
  evAnnLevel.addEventListener("change", () => editEvent((d) => (d.announcement = { text: evAnnText.value, level: levelOf(evAnnLevel.value) })));
  evAnnClear.addEventListener("click", () => {
    evAnnText.value = "";
    editEvent((d) => (d.announcement = null));
    evAnnText.focus();
  });
  evSave.addEventListener("click", () => {
    const d = state.event.draft;
    if (!d) return;
    const errs = eventFieldErrors(d);
    const first = errs.end ? evEnd : errs.freeze ? evFreeze : null;
    if (first) {
      state.event.msg = null;
      renderEventControls();
      evStateEl.textContent = T().admFixFields;
      first.focus();
      return;
    }
    void onSaveEvent();
  });
  evDiscard.addEventListener("click", () => discardEvent());

  /**
   * Quick actions change only the timing of the SAVED event (server clock) and save just that; half-edited
   * fields in the form are neither saved nor lost: they are re-applied on top of the result.
   */
  async function quickEvent(mutate: (d: LiveEvent, now: number) => void): Promise<boolean> {
    const ev = state.event;
    if (!ev.server || ev.saving) return false;
    const base = cloneEvent(ev.server);
    const draftBefore = ev.draft ? cloneEvent(ev.draft) : null;
    const next = cloneEvent(base);
    mutate(next, serverNow());
    ev.rev += 1;
    ev.saving = true;
    ev.error = null;
    ev.msg = null;
    renderEventControls();
    try {
      const res = await saveEvent(normalizeEvent(next));
      if (disposed) return false;
      applyEventResult(res, false);
      const merged = cloneEvent(res.event);
      if (draftBefore) {
        // Keep each field the instructor had edited (it differs from the old saved value) and the action didn't touch.
        const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
        if (!same(draftBefore.name, base.name)) merged.name = draftBefore.name;
        if (!same(draftBefore.startsAt, base.startsAt) && same(next.startsAt, base.startsAt)) merged.startsAt = draftBefore.startsAt;
        if (!same(draftBefore.endsAt, base.endsAt) && same(next.endsAt, base.endsAt)) merged.endsAt = draftBefore.endsAt;
        if (!same(draftBefore.freezeAt, base.freezeAt) && same(next.freezeAt, base.freezeAt)) merged.freezeAt = draftBefore.freezeAt;
        if (!same(draftBefore.announcement, base.announcement)) merged.announcement = draftBefore.announcement ? { ...draftBefore.announcement } : null;
      }
      ev.draft = merged;
      ev.msg = T().admEventSaved;
      clearSavedNoteLater();
      syncEventForm();
    } catch (err: unknown) {
      if (disposed || handleAuthError(err)) return false;
      ev.error = errMessage(err);
    } finally {
      ev.saving = false;
    }
    if (state.tab === "event") renderEventControls();
    return ev.error === null;
  }

  /** The "(other edits stay unsaved)" note, only when there are other edits. */
  const draftNote = (): string | undefined => (eventDirty() ? T().admDraftStays : undefined);

  evStartNow.addEventListener("click", () =>
    void quickEvent((d, now) => {
      d.startsAt = isoAt(now);
      d.endsAt = isoAt(now + EVENT_QUICK_MINUTES * 60_000);
      // A freeze from an earlier run (or past the new end) would freeze the new event at the wrong moment.
      const f = ms(d.freezeAt);
      if (f !== null && (f < now || f > now + EVENT_QUICK_MINUTES * 60_000)) d.freezeAt = null;
    }),
  );
  evEndNow.addEventListener("click", () => {
    const saved = state.event.server;
    if (!saved) return;
    const name = saved.name.trim() || T().admTheEvent;
    void askConfirm({
      title: T().admEndTitle(name),
      body: T().admEndBodyOpen,
      note: draftNote(),
      confirmLabel: T().admEndNow,
      tone: "danger",
      returnFocus: () => evEndNow,
    }).then((ok) => {
      if (!ok) return;
      void quickEvent((d, now) => {
        d.endsAt = isoAt(now);
        const s = ms(d.startsAt);
        if (s !== null && s >= now) d.startsAt = isoAt(now - 60_000);
        const f = ms(d.freezeAt);
        if (f !== null && f > now) d.freezeAt = null; // never reached: the standings at the end are final anyway
      });
    });
  });
  evFreezeBtn.addEventListener("click", () => {
    const unfreeze = isFrozen();
    void askConfirm({
      title: unfreeze ? T().admUnfreezeTitle : T().admFreezeTitle,
      body: unfreeze ? T().admUnfreezeBody : T().admFreezeBody,
      note: draftNote(),
      confirmLabel: unfreeze ? T().admUnfreeze : T().admFreezeNow,
      tone: unfreeze ? "primary" : "danger",
      returnFocus: () => evFreezeBtn,
    }).then(async (ok) => {
      if (!ok) return;
      const previous = state.event.server?.freezeAt ?? null;
      const saved = await quickEvent((d, now) => {
        if (unfreeze) {
          d.freezeAt = null;
          return;
        }
        const end = ms(d.endsAt);
        d.freezeAt = end !== null && end < now ? isoAt(end) : isoAt(now);
      });
      if (!saved) return;
      toast({
        tone: "success",
        text: unfreeze ? T().admUnfrozenToast : T().admFrozenToast,
        action: { label: T().admUndo, run: () => void quickEvent((d) => void (d.freezeAt = previous)) },
      });
    });
  });

  function isFrozen(): boolean {
    const f = ms(state.event.server?.freezeAt ?? null);
    return f !== null && f <= serverNow();
  }

  function applyEventResult(res: AdminEventResult, fromPoll: boolean): void {
    const ev = state.event;
    ev.offsetMs = (ms(res.serverTime) ?? Date.now()) - Date.now();
    const changed = ev.server === null || eventSig(ev.server) !== eventSig(res.event);
    const keepDraft = fromPoll && ev.draft !== null && eventDirty();
    ev.server = cloneEvent(res.event);
    if (!keepDraft && (changed || ev.draft === null)) {
      ev.draft = cloneEvent(res.event);
      if (state.tab === "event") syncEventForm();
    } else if (state.tab === "event") {
      renderEventControls();
    }
  }

  async function loadEvent(): Promise<void> {
    const ev = state.event;
    ev.loading = true;
    ev.error = null;
    renderEvent();
    try {
      const rev = ev.rev;
      const res = await fetchEvent();
      if (disposed) return;
      if (rev === ev.rev) applyEventResult(res, false);
      // A draft carried over from the previous render (language switch) wins over the fresh copy.
      if (carry?.event) {
        ev.draft = cloneEvent(carry.event);
        carry.event = null;
      }
    } catch (err: unknown) {
      if (disposed || handleAuthError(err)) return;
      ev.error = errMessage(err);
    } finally {
      ev.loading = false;
    }
    if (state.tab === "event") renderEvent();
  }

  async function onSaveEvent(): Promise<void> {
    const ev = state.event;
    if (!ev.draft || ev.saving) return;
    ev.rev += 1;
    ev.saving = true;
    ev.error = null;
    ev.msg = null;
    renderEventControls();
    try {
      const res = await saveEvent(normalizeEvent(ev.draft));
      if (disposed) return;
      applyEventResult(res, false);
      ev.draft = cloneEvent(res.event);
      ev.msg = T().admEventSaved;
      clearSavedNoteLater();
      syncEventForm();
    } catch (err: unknown) {
      if (disposed || handleAuthError(err)) return;
      ev.error = errMessage(err);
    } finally {
      ev.saving = false;
    }
    if (state.tab === "event") renderEventControls();
  }

  /** Copies the draft into the controls (after a load, save, discard or quick action). */
  function syncEventForm(): void {
    const d = state.event.draft;
    if (!d) return;
    evName.value = d.name;
    evStart.value = isoToLocalInput(d.startsAt);
    evEnd.value = isoToLocalInput(d.endsAt);
    evFreeze.value = isoToLocalInput(d.freezeAt);
    evAnnText.value = d.announcement?.text ?? "";
    evAnnLevel.value = d.announcement?.level ?? "info";
    renderEventControls();
  }

  function renderEventControls(): void {
    const ev = state.event;
    const dirty = eventDirty();
    const busy = ev.saving || ev.draft === null;
    evSave.disabled = busy || !dirty;
    evSave.textContent = ev.saving ? T().admSaving : T().admSaveEvent;
    evDiscard.disabled = busy || !dirty;
    for (const b of [evStartNow, evEndNow, evFreezeBtn]) b.disabled = busy;
    evAnnClear.disabled = busy || evAnnText.value === "";
    evAnnCount.textContent = T().admCharsLeft(280 - evAnnText.value.length);
    evStateEl.textContent = dirty ? T().admUnsaved : ev.msg ?? "";
    evStateEl.className = `small ${dirty ? "sched-dirty" : "muted"}`;
    evErrorEl.textContent = ev.error ? T().admSaveFailed(ev.error) : "";
    evErrorEl.hidden = ev.error === null;
    const errs = ev.draft ? eventFieldErrors(ev.draft) : { end: null, freeze: null };
    evEndField.setError(errs.end);
    evFreezeField.setError(errs.freeze);
    if (ev.draft) {
      const preview = (el: HTMLElement, iso: string | null): void => {
        el.textContent = iso === null ? T().admTimeNotSet : formatDateTimeZone(iso);
      };
      preview(evStartPreview, ev.draft.startsAt);
      preview(evEndPreview, ev.draft.endsAt);
      preview(evFreezePreview, ev.draft.freezeAt);
    }
    evBar.hidden = !eventBarVisible();
    syncSaveBarClass();
    renderEventStatus();
  }

  /** Status line + countdown from the saved event and the server clock (ticks every second). */
  function renderEventStatus(): void {
    const e = state.event.server;
    evFreezeBtn.textContent = isFrozen() ? T().admUnfreeze : T().admFreezeNow;
    if (!e) {
      evStatusEl.textContent = "";
      evClockEl.textContent = "";
      return;
    }
    const now = serverNow();
    const start = ms(e.startsAt);
    const end = ms(e.endsAt);
    let phase: string;
    let tone: "live" | "idle" | "soon" | "over";
    if (start === null && end === null) {
      phase = T().admStatusNoWindow;
      tone = "idle";
    } else if (start !== null && now < start) {
      phase = T().admStatusStartsIn(formatDuration(start - now));
      tone = "soon";
    } else if (end !== null && now >= end) {
      phase = T().admStatusEnded(formatDuration(now - end));
      tone = "over";
    } else if (end === null) {
      phase = T().admStatusLiveOpen;
      tone = "live";
    } else {
      phase = start === null ? T().admStatusEndsIn(formatDuration(end - now)) : T().admStatusLive(formatDuration(end - now));
      tone = "live";
    }
    const parts = [phase];
    const f = ms(e.freezeAt);
    if (f !== null) parts.push(f <= now ? T().admStatusFrozen(formatDateTime(e.freezeAt)) : T().admStatusFreezesIn(formatDuration(f - now)));
    const label = e.name.trim();
    // Each part carries its separator at its own end, so a wrapped line never starts with a stray "·" (#129).
    const segs: Array<{ text: string; strong: boolean }> = [
      ...(label ? [{ text: label, strong: true }] : []),
      ...parts.map((text) => ({ text, strong: false })),
    ];
    setChildren(
      evStatusEl,
      h("span", { class: `adm-ev-dot is-${tone}`, "aria-hidden": "true" }),
      segs.map((s, i) =>
        h("span", { class: "adm-ev-part" }, s.strong ? h("strong", {}, s.text) : s.text, i < segs.length - 1 ? " ·" : ""),
      ),
    );
    evClockEl.textContent = T().admServerClock(new Intl.DateTimeFormat(locale(), { timeStyle: "medium" }).format(now));
  }

  function buildEventPanel(): void {
    const tz = browserTimeZone();
    setChildren(
      evBodyEl,
      h("section", { class: "panel admin-panel" }, h("h2", { class: "admin-h2" }, T().admEventTitle), evStatusEl, evClockEl),
      h(
        "section",
        { class: "panel admin-panel" },
        headWithHint(h("h2", { class: "admin-h2" }, T().admQuickActions), T().admQuickHelp),
        h("p", { class: "muted small admin-hint is-touch-only" }, T().admQuickHelp),
        h("div", { class: "adm-ev-quick" }, evStartNow, evEndNow, evFreezeBtn),
      ),
      h(
        "section",
        { class: "panel admin-panel" },
        h("h2", { class: "admin-h2" }, T().admScheduleSettings),
        h(
          "div",
          { class: "sched-form adm-ev-form" },
          evNameField.nodes,
          evStartField.nodes,
          evEndField.nodes,
          evFreezeField.nodes,
          h("p", { class: "muted small ev-tz", id: "ev-tz" }, T().admTzNote(tz.name, tz.offset)),
        ),
      ),
      h(
        "section",
        { class: "panel admin-panel" },
        h("h2", { class: "admin-h2" }, T().admAnnouncement),
        h("p", { class: "muted small admin-hint", id: "ev-ann-help" }, T().admAnnouncementHelp),
        h(
          "div",
          { class: "adm-ev-ann" },
          h("label", { class: "visually-hidden", for: "ev-ann" }, T().admAnnouncement),
          evAnnText,
          h(
            "div",
            { class: "adm-ev-ann-row" },
            h("label", { class: "admin-label", for: "ev-ann-level" }, T().admAnnLevel),
            evAnnLevel,
            evAnnClear,
            evAnnCount,
          ),
        ),
      ),
      evBar,
    );
  }

  let eventBuilt = false;
  function renderEvent(): void {
    const panel = tabPanels.get("event");
    if (!panel) return;
    const ev = state.event;
    if (!ev.draft) {
      eventBuilt = false;
      setChildren(
        panel,
        ev.error
          ? h(
              "section",
              { class: "panel admin-panel" },
              h("p", { class: "admin-error", role: "alert" }, T().admLoadSectionFailed(ev.error)),
              h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => void loadEvent() }, T().admRetry),
            )
          : h("p", { class: "muted admin-loading" }, T().admLoading),
      );
      return;
    }
    if (!eventBuilt) {
      eventBuilt = true;
      buildEventPanel();
      setChildren(panel, evBodyEl);
      syncEventForm();
      return;
    }
    renderEventControls();
  }

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
    dir: "auto",
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
    const name = e.target === null ? "" : (auditNames.get(e.target) ?? T().admUnknownAccount);
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
      { id: "target", header: T().admColTarget, className: "audit-target", cell: (e) => auditTarget(e, auditNames), csv: auditDetailText },
      { id: "via", header: T().admColVia, cell: (e) => h("span", { class: `via-pill is-${e.via}` }, T().admVia(e.via)), sortValue: (e) => e.via, csv: (e) => e.via },
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

  function auditTarget(e: AuditEntry, names: ReadonlyMap<string, string>): Child[] {
    const out: Child[] = [];
    if (e.target !== null) {
      const name = names.get(e.target);
      out.push(
        name !== undefined
          ? h("span", { class: "player-name", dir: "auto" }, name)
          : h("span", { class: "muted", title: e.target }, T().admUnknownAccount),
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
    const entries = state.audit;
    const names = new Map((state.accounts?.accounts ?? []).map((a) => [a.accountId, a.username] as const));
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
        (q === "" || `${T().admAuditAction(e.action)} ${e.action} ${auditDetailText(e)}`.toLowerCase().includes(q)),
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
  // Stats tab
  // =====================================================================================

  const statsBoardEl = h("div", { class: "admin-table-wrap" });
  const statsCasesEl = h("div", { class: "stats-cases" });

  function buildStatsPanel(): void {
    setChildren(
      tabPanels.get("stats") ?? container,
      // How each case went comes first; the overall top 10 follows.
      statsCasesEl,
      h("section", { class: "panel admin-panel", "aria-labelledby": "admin-top10-title" }, h("h2", { class: "admin-h2", id: "admin-top10-title" }, T().admTop10), statsBoardEl),
    );
  }

  const statsBoardTable = dataTable<UserStats>({
    columns: [
      { id: "rank", header: T().admColRank, numeric: true, cell: (a) => (a.rank === null ? "—" : fmtInt(a.rank)) },
      { id: "user", header: T().admColUser, rowHeader: true, className: "col-name", cell: (a) => h("span", { class: "player-name", dir: "auto" }, a.username) },
      { id: "score", header: T().admColScore, numeric: true, className: "col-score", cell: (a) => fmtInt(a.totalScore) },
      { id: "completed", header: T().admColCompleted, numeric: true, cell: (a) => fmtInt(a.casesCompleted) },
      { id: "accuracy", header: T().admColAccuracy, numeric: true, cell: (a) => formatPct(a.accuracy) },
      { id: "hints", header: T().admColHints, numeric: true, optional: true, cell: (a) => fmtInt(a.hintsUsed) },
    ],
    rows: [],
    rowKey: (a) => a.accountId,
    rowSig: (a) => JSON.stringify([getLang(), a.rank, a.username, a.totalScore, a.casesCompleted, a.accuracy, a.hintsUsed]),
    rowAttrs: (a) => ({ class: a.rank === 1 ? "is-first" : "" }),
    className: "admin-table",
    wrapClass: "admin-dt",
    labelledBy: "admin-top10-title",
  });

  function renderStatsBoard(): void {
    const top = topPlayers(state.accounts?.accounts ?? [], 10);
    if (top.length === 0) {
      setChildren(statsBoardEl, h("p", { class: "muted admin-empty-small" }, T().admNoPlayersBoard));
      return;
    }
    statsBoardTable.update(top);
    if (statsBoardTable.element.parentNode !== statsBoardEl) setChildren(statsBoardEl, statsBoardTable.element);
  }

  /** Cases whose "Show as a table" is open: the panels re-render on every poll and must not snap shut. */
  const statsTableOpen = new Set<string>();

  /**
   * One case: a headline row that answers "how did it go?" (completion, median time, hardest stage with its numbers),
   * then per-question solved / gave up / still on it as bars, with the full numbers one disclosure away.
   */
  function caseSummaryPanel(s: CaseSummary): HTMLElement {
    const maxScore = s.maxScore > 0 ? s.maxScore : caseMaxScore(s.caseId);
    const title = cachedCase(s.caseId)?.title ?? s.title;
    const progress = state.statsProgress.get(s.caseId) ?? null;
    const funnel = questionFunnel(s, progress);
    const hardest = hardestQuestion(funnel);
    const isToday = state.today?.caseId === s.caseId;
    // Median from the per-player progress when we have it; otherwise the server's mean, labelled as such.
    const finishTimes = progress ? progress.map(finishDurationMs).filter((v): v is number => v !== null) : [];
    const med = median(finishTimes);
    const timeValue = med !== null ? formatFinish(med) : s.avgDurationSeconds !== null ? formatFinish(s.avgDurationSeconds * 1000) : "—";
    const timeLabel = med !== null || s.avgDurationSeconds === null ? T().admMedianTime : T().admAvgTime;
    const timeSample = med !== null ? finishTimes.length : s.completed;
    const head = h(
      "div",
      { class: "stats-case-head" },
      h("h2", { class: "admin-h2" }, title),
      isToday ? h("span", { class: "today-tag" }, T().admTodayTag) : null,
      h("code", { class: "muted small" }, s.caseId),
    );
    if (s.players === 0) {
      return h("section", { class: "panel admin-panel stats-case" }, head, h("p", { class: "muted admin-empty-small" }, T().admNobodyPlayed));
    }
    const hardestLabel = hardest ? `${hardest.row.q.toUpperCase()} ${questionTitle(s.caseId, hardest.row.q)}`.trim() : null;
    const headline = h(
      "div",
      { class: "stats-headline" },
      h(
        "div",
        { class: "stats-kpi is-lead" },
        h("div", { class: "admin-tile-label" }, T().admCompletion),
        h("div", { class: "stats-kpi-value" }, formatPct(s.completed / s.players)),
        h("div", { class: "admin-tile-sub" }, T().admCompletionSub(fmtInt(s.completed), s.players, fmtInt(s.players))),
      ),
      h(
        "div",
        { class: "stats-kpi" },
        h("div", { class: "admin-tile-label" }, timeLabel),
        h("div", { class: "stats-kpi-value" }, timeValue),
        h("div", { class: "admin-tile-sub" }, T().admFinishedSample(timeSample, fmtInt(timeSample))),
      ),
      h(
        "div",
        { class: "stats-kpi is-hardest", title: T().admHardestTip },
        h("div", { class: "admin-tile-label" }, T().admHardestStage),
        hardest && hardestLabel
          ? [
              h("div", { class: "stats-kpi-value stats-kpi-text", title: hardestLabel }, hardestLabel),
              h(
                "div",
                { class: "admin-tile-sub" },
                T().admHardestNumbers(formatPct(hardest.rate), fmtInt(hardest.row.reached), fmtDec1(hardest.row.avgWrong)),
              ),
            ]
          : h("div", { class: "admin-tile-sub" }, T().admHardestNotEnough(HARDEST_MIN_PLAYERS)),
      ),
    );
    const secondary = h(
      "p",
      { class: "muted small stats-secondary" },
      `${T().admAvgScoreFinishers}: ${s.avgScore === null ? "—" : fmtInt(Math.round(s.avgScore))}`,
      maxScore ? ` (${T().admPar(fmtInt(maxScore))})` : "",
      ` · ${T().admFinishedSample(s.completed, fmtInt(s.completed))}`,
    );
    // Per question: a bar of everyone who reached it, split into solved / gave up / still on it (text says the same).
    const bars = h(
      "ol",
      { class: "q-bars", "aria-label": T().admQBarsLabel },
      funnel.map((row) => {
        const stillOn = Math.max(0, row.reached - row.solved - row.revealed);
        const pct = (n: number): string => (row.reached > 0 ? `${(n / row.reached) * 100}%` : "0%");
        const isHardest = hardest?.row.q === row.q;
        const qTitle = questionTitle(s.caseId, row.q);
        return h(
          "li",
          { class: `q-bar-row${isHardest ? " is-hardest" : ""}` },
          h(
            "span",
            { class: "q-bar-label", title: qTitle },
            h("span", { class: "q-id" }, row.q.toUpperCase()),
            " ",
            qTitle,
            isHardest ? h("span", { class: "hardest-badge" }, "⚑ ", T().admHardest) : null,
          ),
          h(
            "span",
            { class: "q-bar-track", "aria-hidden": "true" },
            h("span", { class: "q-bar-seg is-solved", style: `width:${pct(row.solved)}` }),
            h("span", { class: "q-bar-seg is-revealed", style: `width:${pct(row.revealed)}` }),
            h("span", { class: "q-bar-seg is-open", style: `width:${pct(stillOn)}` }),
          ),
          h(
            "span",
            { class: "q-bar-nums" },
            row.reached > 0
              ? T().admQBarNums(fmtInt(row.solved), fmtInt(row.revealed), fmtInt(stillOn), fmtInt(row.reached))
              : T().admQBarNobody,
          ),
        );
      }),
    );
    const qTable = dataTable<QuestionFunnel>({
      columns: [
        { id: "q", header: T().admColQuestion, rowHeader: true, cell: (row) => [h("span", { class: "q-id" }, row.q.toUpperCase()), " ", questionTitle(s.caseId, row.q)] },
        { id: "reached", header: T().admColReached, numeric: true, cell: (row) => fmtInt(row.reached), sortValue: (row) => row.reached, sortFirst: "desc" },
        { id: "solved", header: T().admColSolved, numeric: true, cell: (row) => { const qs = s.questions[row.q]; return qs ? fmtInt(qs.solved) : "—"; }, sortValue: (row) => s.questions[row.q]?.solved ?? null, sortFirst: "desc" },
        { id: "revealed", header: T().admColRevealed, numeric: true, cell: (row) => { const qs = s.questions[row.q]; return qs ? fmtInt(qs.revealed) : "—"; }, sortValue: (row) => s.questions[row.q]?.revealed ?? null, sortFirst: "desc" },
        {
          id: "notSolved",
          header: T().admColNotSolved,
          numeric: true,
          cell: (row) => (row.reached > 0 ? `${fmtInt(row.reached - row.solved)} · ${formatPct((row.reached - row.solved) / row.reached)}` : "—"),
          sortValue: (row) => (row.reached > 0 ? (row.reached - row.solved) / row.reached : null),
          sortFirst: "desc",
        },
        { id: "avgWrong", header: T().admColAvgWrong, numeric: true, cell: (row) => { const qs = s.questions[row.q]; return qs ? fmtDec1(qs.avgWrong) : "—"; }, sortValue: (row) => s.questions[row.q]?.avgWrong ?? null, sortFirst: "desc" },
        { id: "avgHints", header: T().admColAvgHints, numeric: true, cell: (row) => { const qs = s.questions[row.q]; return qs ? fmtDec1(qs.avgHints) : "—"; }, sortValue: (row) => s.questions[row.q]?.avgHints ?? null, sortFirst: "desc" },
      ],
      rows: funnel,
      rowAttrs: (row) => ({ class: hardest?.row.q === row.q ? "is-hardest" : "" }),
      className: "admin-table stats-q-table",
      wrapClass: "admin-dt",
      caption: `${title} · ${T().admQBarsTitle}`,
    });
    const table = h(
      "details",
      { class: "stats-table-view", open: statsTableOpen.has(s.caseId) },
      h("summary", { class: "link-btn" }, T().admTableView),
      qTable.element,
    );
    table.addEventListener("toggle", () => {
      if (table.open) statsTableOpen.add(s.caseId);
      else statsTableOpen.delete(s.caseId);
    });
    return h(
      "section",
      { class: "panel admin-panel stats-case" },
      head,
      headline,
      secondary,
      h("h3", { class: "admin-label stats-q-title" }, T().admQBarsTitle),
      h(
        "p",
        { class: "muted small funnel-key" },
        h("span", { class: "key-done" }), `${T().admColSolved} `,
        h("span", { class: "key-revealed" }), `${T().admColRevealed} `,
        h("span", { class: "key-open" }), T().admStillOn,
      ),
      bars,
      table,
    );
  }

  function renderStats(): void {
    renderStatsBoard();
    const stats = state.stats;
    if (!stats) {
      setChildren(statsCasesEl, h("p", { class: "muted admin-loading" }, T().admLoading));
      return;
    }
    if (stats.cases.length === 0) {
      setChildren(statsCasesEl, h("section", { class: "panel admin-panel" }, h("p", { class: "muted admin-empty-small" }, T().admNoReleased)));
      return;
    }
    const todayId = state.today?.caseId;
    // Rebuild only when the numbers changed: a poll must not move focus out of a sorted per-question table.
    const sig = JSON.stringify([getLang(), stats, [...state.statsProgress], todayId]);
    if (sig === statsSig) return;
    statsSig = sig;
    const ordered = [...stats.cases].sort((a, b) => Number(b.caseId === todayId) - Number(a.caseId === todayId) || b.players - a.players);
    setChildren(statsCasesEl, ordered.map(caseSummaryPanel));
  }
  let statsSig = "";

  // =====================================================================================
  // Projector leaderboard: the PUBLIC board (GET /api/leaderboard), so a freeze hides the live standings
  // from the room exactly as it does for players. Never ranked from the admin's live account data.
  // =====================================================================================

  let boardSeq = 0;
  async function loadBoard(): Promise<void> {
    const b = state.board;
    const scope = b.scope;
    const seq = ++boardSeq;
    try {
      const data = await fetchPublicLeaderboard(scope);
      if (disposed || seq !== boardSeq) return;
      b.data = data;
      b.error = null;
    } catch (err: unknown) {
      if (disposed || seq !== boardSeq) return;
      b.error = errMessage(err);
    }
    if (state.leaderboard) renderLeaderboard();
  }

  const boardScopeSelect = h("select", { class: "admin-input admin-board-scope", id: "admin-board-scope" });
  boardScopeSelect.addEventListener("change", () => {
    const v = boardScopeSelect.value;
    const scope = v === "" ? null : v;
    if (scope === state.board.scope) return;
    state.board.scope = scope;
    state.board.data = null;
    state.board.error = null;
    renderLeaderboard();
    void loadBoard();
  });

  // Event line and freeze state in the board header: kept across re-renders and ticked once a second.
  const boardEventEl = h("p", { class: "admin-board-event", "aria-live": "off" });
  const boardStateEl = h("p", { class: "admin-board-state" });

  /** The event as the room sees it: the admin's copy once the Event section loaded it, else the public poll's. */
  function boardEvent(): { event: LiveEvent | null; now: number } {
    return state.event.server ? { event: state.event.server, now: serverNow() } : { event: cachedEvent(), now: publicServerNow() };
  }

  function renderBoardClock(): void {
    const { event, now } = boardEvent();
    const name = event?.name.trim() ?? "";
    const phase = eventPhase(event, now);
    const when =
      phase.kind === "before"
        ? T().admBoardStartsIn(formatCountdown(phase.msLeft))
        : phase.kind === "running"
          ? phase.msLeft === null
            ? ""
            : T().admBoardEndsIn(formatCountdown(phase.msLeft))
          : phase.kind === "over"
            ? T().admBoardEventOver
            : "";
    setChildren(boardEventEl, name ? h("strong", { dir: "auto" }, name) : null, name && when ? " · " : "", when ? h("span", { class: "board-clock" }, when) : null);
    boardEventEl.hidden = !name && !when;

    const data = state.board.data && state.board.data.caseId === state.board.scope ? state.board.data : null;
    if (!data) {
      boardStateEl.hidden = true;
      return;
    }
    boardStateEl.hidden = false;
    const freezeAt = ms(event?.freezeAt ?? null);
    const detail = data.frozen
      ? data.frozenAt
        ? T().admBoardFrozenAt(formatDateTime(data.frozenAt))
        : ""
      : freezeAt !== null && freezeAt > now
        ? T().admBoardFreezesIn(formatCountdown(freezeAt - now))
        : "";
    boardStateEl.classList.toggle("is-frozen", data.frozen);
    setChildren(
      boardStateEl,
      data.frozen ? h("span", { class: "board-frozen-chip" }, "❄ ", T().admBoardFrozen) : h("span", { class: "board-live-chip" }, T().admBoardLive),
      detail ? h("span", { class: "board-frozen-at" }, detail) : null,
    );
  }

  function renderLeaderboard(): void {
    if (!state.leaderboard) {
      boardDialog?.close(null); // focus goes back to the button (or the "More" menu) that opened it
      return;
    }
    const opening = boardDialog === null;
    if (opening) {
      const handle = showDialog<string>({ size: "full", title: T().admLeaderboard, header: false, closeButton: false, body: leaderboardEl, className: "admin-board" });
      boardDialog = handle;
      void handle.result.then(() => {
        if (boardDialog === handle) boardDialog = null;
        state.leaderboard = false;
        leaderboardEl.replaceChildren();
      });
    }
    const b = state.board;
    // Scope options: overall + released cases (rebuilt each time; keeps the selection).
    const released = state.today?.releasedCaseIds ?? [];
    setChildren(
      boardScopeSelect,
      h("option", { value: "", selected: b.scope === null }, T().admBoardOverall),
      released.map((id) => h("option", { value: id, selected: id === b.scope }, caseTitle(id))),
    );
    const data = b.data && b.data.caseId === b.scope ? b.data : null;
    const top = data ? data.entries.slice(0, BOARD_ROWS) : [];
    const close = h(
      "button",
      {
        type: "button",
        class: "btn btn-ghost admin-board-close",
        onclick: () => boardDialog?.close(null),
      },
      T().admClose,
    );
    renderBoardClock();
    const more = data ? Math.max(0, data.entries.length - BOARD_ROWS) : 0;
    let body: HTMLElement;
    if (b.error && !data) body = h("p", { class: "admin-error admin-board-empty", role: "alert" }, T().admBoardFailed(b.error));
    else if (!data) body = h("p", { class: "muted admin-board-empty" }, T().admLoading);
    else if (top.length === 0) body = h("p", { class: "muted admin-board-empty" }, T().admNoPlayersBoard);
    else {
      const overall = data.caseId === null;
      body = h(
        "ol",
        { class: "admin-board-list" },
        top.map((e) =>
          h(
            "li",
            { class: `admin-board-row rank-${e.rank}` },
            h("span", { class: "board-rank" }, fmtInt(e.rank)),
            h("span", { class: "board-name", dir: "auto" }, e.username),
            h("span", { class: "board-time muted" }, overall ? T().admCasesDone(e.casesCompleted) : T().admStagesSolved(e.stagesSolved)),
            h("span", { class: "board-score" }, fmtInt(e.score)),
          ),
        ),
      );
    }
    const focusedScope = document.activeElement === boardScopeSelect;
    const focusInside = opening || leaderboardEl.contains(document.activeElement);
    setChildren(
      leaderboardEl,
      h(
        "div",
        { class: "admin-board-inner" },
        // The header answers what the room asks: which event, how long is left, and are the standings frozen.
        h(
          "div",
          { class: "admin-board-head" },
          h("h2", { class: "admin-board-title" }, T().admLeaderboard),
          h(
            "div",
            { class: "admin-board-tools" },
            h("label", { class: "admin-label", for: "admin-board-scope" }, T().admBoardScope),
            boardScopeSelect,
            close,
          ),
          h("div", { class: "admin-board-meta" }, boardEventEl, boardStateEl),
        ),
        body,
        more > 0 ? h("p", { class: "admin-board-more" }, T().admBoardMore(more, fmtInt(more))) : null,
      ),
    );
    // Re-appending moves focus out of the dialog: put it back (Close on first open).
    if (focusedScope) boardScopeSelect.focus();
    else if (focusInside || document.activeElement === boardDialog?.el) close.focus();
  }

  // ---- render dispatch ------------------------------------------------------------------

  function renderActiveTab(): void {
    switch (state.tab) {
      case "accounts":
        renderAccounts();
        break;
      case "live":
        live.render();
        break;
      case "schedule":
        schedule.render();
        break;
      case "stats":
        renderStats();
        break;
      case "event":
        renderEvent();
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
    else if (state.tab === "event") renderEventStatus();
    else renderActiveTab();
    renderUpdated();
    renderBanner();
  }

  // ---- data loading ----------------------------------------------------------------------

  function ensureLiveCase(): void {
    if (state.liveCaseId || !state.today) return;
    state.liveCaseId = state.today.caseId ?? state.today.releasedCaseIds[0] ?? null;
  }

  /** Stats needs who reached each question (drop-off): one progress request per case that has players. */
  async function loadStatsProgress(stats: AdminStatsResult): Promise<void> {
    const ids = stats.cases.filter((c) => c.players > 0).map((c) => c.caseId);
    const results = await Promise.all(ids.map((id) => fetchProgress(id).catch(() => null)));
    const next = new Map<string, readonly AdminProgress[]>();
    for (const r of results) if (r) next.set(r.caseId, r.players);
    state.statsProgress = next;
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

  async function load(): Promise<void> {
    if (disposed) return;
    if (state.loading) {
      state.queued = true;
      return;
    }
    if (state.auth === null) return showLogin(null);
    state.loading = true;
    state.queued = false;
    const tab = state.tab;
    const liveCase = state.liveCaseId;
    const settingsRev = state.settings.rev;
    const eventRev = state.event.rev;
    // The projector board refreshes with the dashboard (public endpoint; its errors stay on the board).
    if (state.leaderboard) void loadBoard();
    // Recently deleted is optional: a server without it (404) or a failure must not break the poll.
    const trashReq: Promise<TrashEntry[] | AdminApiError | Error> | null =
      tab === "accounts" ? fetchTrash().catch((err: unknown) => (err instanceof Error ? err : new Error(T().admUnknownError))) : null;
    try {
      // Today's case changes at most once a day (or on a schedule save, which reloads it itself): once a minute
      // is plenty, and it halves the dashboard's calls per tick.
      const todayDue = Date.now() - todayFetchedAt >= TODAY_REFRESH_MS;
      const [accounts, today, progress, stats, settings, event, audit] = await Promise.all([
        fetchAccounts(),
        todayDue ? fetchToday() : Promise.resolve(null),
        tab === "live" && liveCase ? fetchProgress(liveCase) : Promise.resolve(null),
        tab === "stats" ? fetchCaseStats() : Promise.resolve(null),
        tab === "accounts" ? fetchSettings() : Promise.resolve(null),
        tab === "event" && !state.event.saving ? fetchEvent() : Promise.resolve(null),
        tab === "audit" ? fetchAudit(AUDIT_LIMIT) : Promise.resolve(null),
      ]);
      if (disposed) return;
      state.accounts = accounts;
      if (today) {
        state.today = today;
        todayFetchedAt = Date.now();
      }
      if (progress && progress.caseId === state.liveCaseId) state.progress = progress;
      if (stats) {
        state.stats = stats;
        await loadStatsProgress(stats);
        if (disposed) return;
      }
      if (trashReq) applyTrash(await trashReq);
      if (settings && settingsRev === state.settings.rev && !state.settings.saving) state.settings.server = settings;
      if (event && eventRev === state.event.rev && !state.event.saving) applyEventResult(event, true);
      if (audit) state.audit = audit;
      ensureLiveCase();
      state.lastUpdated = Date.now();
      state.banner = null;
      state.failures = 0;
      // The tab or the live case changed mid-flight: fetch again right away.
      if (state.tab !== tab || state.liveCaseId !== liveCase) state.queued = true;
      renderData();
    } catch (err: unknown) {
      if (disposed) return;
      if (handleAuthError(err)) return;
      state.failures += 1;
      state.banner = T().admConnProblem(errMessage(err), Math.round(nextDelay() / 1000));
      renderBanner();
    } finally {
      state.loading = false;
      if (state.queued && !disposed && state.accounts) {
        state.queued = false;
        void load();
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
    if (disposed || state.paused || !state.accounts || document.visibilityState === "hidden") return;
    pollId = window.setTimeout(() => {
      pollId = null;
      if (!container.isConnected) return dispose();
      void load();
    }, nextDelay());
  }

  async function start(): Promise<void> {
    if (state.auth === null) return showLogin(null);
    try {
      const [accounts, today, settings] = await Promise.all([fetchAccounts(), fetchToday(), fetchSettings()]);
      if (disposed) return;
      state.accounts = accounts;
      state.today = today;
      todayFetchedAt = Date.now();
      state.settings.server = settings;
      ensureLiveCase();
      state.lastUpdated = Date.now();
      state.banner = null;
    } catch (err: unknown) {
      if (disposed) return;
      if (handleAuthError(err)) return;
      showLogin(err instanceof Error ? err.message : T().admLoadFailed);
      return;
    }
    buildDashboard();
    // Canonical deep link for the current view (no new history entry).
    if (isAdminHash(location.hash)) setUrl(adminHash(state.tab, state.liveCaseId), "replace");
    stopTimers();
    renderData();
    renderActiveTab();
    if (state.tab === "schedule") void schedule.load();
    if (state.tab === "event") void loadEvent();
    // Live, Stats, Audit and Recently deleted (Accounts) need a second request before they have data.
    if (state.tab === "live" || state.tab === "stats" || state.tab === "audit" || state.tab === "accounts") void load();
    else scheduleNext();
    tickId = window.setInterval(() => {
      if (!container.isConnected) return dispose();
      renderUpdated();
      if (state.tab === "event") renderEventStatus();
      if (state.leaderboard && boardDialog !== null) renderBoardClock();
    }, 1000);
  }

  /** The admin session cookie wins (no key gate); otherwise a key typed earlier in this tab; otherwise the gate. */
  async function bootstrap(): Promise<void> {
    setChildren(container, h("p", { class: "muted admin-loading" }, T().admLoadingDashboard));
    let sessionAdmin = false;
    try {
      const me = await fetchMe();
      sessionAdmin = me?.role === "admin";
    } catch {
      // network trouble: fall back to the key (if any), whose own request reports the error
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
    showLogin(null);
  }

  void bootstrap();
}
