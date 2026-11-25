// Instructor dashboard (#/admin). All API data (usernames above all) is rendered via textContent / attributes only — never innerHTML.
// Tabs: Accounts (approve sign-ups, per-user stats) · Live (one case, polled) · Schedule (incident of the day) · Stats (per case).
import "../admin.css";
import { T } from "../i18n/strings-tools";
import { getLang } from "../i18n/i18n";
import {
  QUESTION_ORDER,
  type AccountStatus,
  type AdminProgress,
  type CaseStats,
  type CaseSummary,
  type QuestionId,
  type Schedule,
  type StageStatus,
  type TodayResponse,
  type UserStats,
} from "../../shared/contract";
import { cases, getCase } from "../content/load";
import { copyButton, h, setChildren, type Child } from "../lib/dom";
import {
  AdminApiError,
  clearAdminKey,
  deleteAccount,
  fetchAccounts,
  fetchCaseStats,
  fetchProgress,
  fetchSchedule,
  fetchToday,
  getAdminKey,
  resetProgress,
  restartPlayerCase,
  saveSchedule,
  setAccountStatus,
  setAdminKey,
  type AdminAccountsResult,
  type AdminProgressResult,
  type AdminStatsResult,
} from "../lib/admin-api";

const POLL_MS = 5000;
const MAX_BACKOFF_MS = 60000;
const STUCK_WARN_MIN = 8;
const STUCK_ALERT_MIN = 15;
const TAB_STORAGE = "il.adminTab";
const DEFAULT_TIMEZONE = "Asia/Jerusalem";

type TabId = "accounts" | "live" | "schedule" | "stats";
const TABS: readonly TabId[] = ["accounts", "live", "schedule", "stats"];
const isTabId = (v: string | null): v is TabId => v === "accounts" || v === "live" || v === "schedule" || v === "stats";

type StageKey = "setup" | QuestionId;
type LiveSortKey = "score" | "progress" | "name" | "stuck";
type AcctSortKey = "rank" | "newest" | "seen" | "name";
type AcctFilter = "all" | AccountStatus;
type ConfirmKind = "delete" | "restart";

// ---- content lookups (titles come from the bundled case content, ids from the server) ----

const QUESTION_IDS: ReadonlySet<string> = new Set<string>(QUESTION_ORDER);
const isQuestionId = (id: string): id is QuestionId => QUESTION_IDS.has(id);

function caseTitle(caseId: string): string {
  return getCase(caseId)?.title ?? caseId;
}

function caseQuestionIds(caseId: string): QuestionId[] {
  const c = getCase(caseId);
  const ids = c ? c.questions.map((q) => q.id).filter(isQuestionId) : [];
  return ids.length > 0 ? ids : [...QUESTION_ORDER];
}

function questionTitle(caseId: string, q: QuestionId): string {
  return getCase(caseId)?.questions.find((x) => x.id === q)?.title ?? "";
}

function caseMaxScore(caseId: string): number | null {
  const c = cases.get(caseId);
  return c ? c.questions.reduce((sum, q) => sum + q.points, 0) : null;
}

function caseStages(caseId: string): StageKey[] {
  return ["setup", ...caseQuestionIds(caseId)];
}

// ---- formatting ----------------------------------------------------------------

const locale = (): string => (getLang() === "he" ? "he-IL" : "en-GB");

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function formatDuration(totalMs: number): string {
  const totalSec = Math.max(0, Math.round(totalMs / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) return `${hrs}h ${String(mins).padStart(2, "0")}m`;
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function formatSeconds(sec: number | null): string {
  return sec === null ? "—" : formatDuration(sec * 1000);
}

function formatDateTime(iso: string | null): string {
  const t = ms(iso);
  if (t === null) return "—";
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(t);
}

function formatPct(ratio: number | null): string {
  return ratio === null ? "—" : `${Math.round(ratio * 100)}%`;
}

function relativeAgo(iso: string | null, now: number): string {
  const t = ms(iso);
  if (t === null) return "—";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 10) return T().admJustNow;
  if (sec < 60) return T().admAgo(`${sec}s`);
  const min = Math.floor(sec / 60);
  if (min < 60) return T().admAgo(`${min}m`);
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return T().admAgo(`${hrs}h`);
  return T().admAgo(`${Math.floor(hrs / 24)}d`);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return hi;
  const lo = sorted[mid - 1] ?? hi;
  return (lo + hi) / 2;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const isoDay = (y: number, m0: number, d: number): string => `${y}-${pad2(m0 + 1)}-${pad2(d)}`;

function isValidTimeZone(tz: string): boolean {
  if (tz.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function timeZoneList(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [DEFAULT_TIMEZONE, "UTC"];
  }
}

// ---- live (per case) player metrics ----------------------------------------------

function stageLabel(stage: StageKey): string {
  return stage === "setup" ? T().admSetup : stage.toUpperCase();
}

function stageLongLabel(caseId: string, stage: AdminProgress["currentStage"]): string {
  if (stage === "done") return T().admFinished;
  if (stage === "setup") return T().admSetup;
  const title = questionTitle(caseId, stage);
  return title ? `${stage.toUpperCase()} · ${title}` : stage.toUpperCase();
}

function stageStatus(p: AdminProgress, stage: StageKey): StageStatus {
  if (stage === "setup") return p.setupDoneAt ? "solved" : p.startedAt ? "active" : "locked";
  return p.stages[stage]?.status ?? "locked";
}

const isFinishedStatus = (s: StageStatus): boolean => s === "solved" || s === "revealed";

function progressCount(p: AdminProgress, stages: readonly StageKey[]): number {
  return stages.filter((s) => isFinishedStatus(stageStatus(p, s))).length;
}

const isDone = (p: AdminProgress): boolean => p.completedAt !== null || p.currentStage === "done";

function stuckLevel(p: AdminProgress): "none" | "warn" | "alert" {
  if (isDone(p)) return "none";
  if (p.stuckMinutes >= STUCK_ALERT_MIN) return "alert";
  if (p.stuckMinutes >= STUCK_WARN_MIN) return "warn";
  return "none";
}

/** Same definition the server uses for durationSeconds: setup done -> completed. */
function finishDurationMs(p: AdminProgress): number | null {
  const end = ms(p.completedAt);
  const start = ms(p.setupDoneAt) ?? ms(p.startedAt);
  return end !== null && start !== null ? Math.max(0, end - start) : null;
}

function stageTooltip(p: AdminProgress, stage: StageKey, now: number): string {
  const status = stageStatus(p, stage);
  if (stage === "setup") {
    const start = ms(p.startedAt);
    const end = ms(p.setupDoneAt) ?? now;
    const spent = start !== null ? formatDuration(end - start) : "—";
    return T().admSetupTip(p.setupDoneAt !== null, spent);
  }
  const sp = p.stages[stage];
  const title = questionTitle(p.caseId, stage);
  if (!sp || status === "locked") return `${stage.toUpperCase()} ${title}: ${T().admStatus("locked")}`;
  const start = ms(sp.startedAt);
  const end = ms(sp.finishedAt) ?? now;
  const spent = start !== null ? formatDuration(end - start) : "—";
  return [
    `${stage.toUpperCase()} ${title}: ${T().admStatus(status)}`,
    T().admWrongAttempts(sp.wrongAttempts),
    T().admHintsUsed(sp.hintsRevealed),
    T().admTime(spent),
    status === "solved" ? T().admPoints(sp.points) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function sortPlayers(players: readonly AdminProgress[], key: LiveSortKey, stages: readonly StageKey[]): AdminProgress[] {
  const byName = (a: AdminProgress, b: AdminProgress): number => a.username.localeCompare(b.username);
  const prog = (p: AdminProgress): number => progressCount(p, stages);
  const list = [...players];
  switch (key) {
    case "score":
      return list.sort((a, b) => b.score - a.score || prog(b) - prog(a) || byName(a, b));
    case "progress":
      return list.sort((a, b) => prog(b) - prog(a) || b.score - a.score || byName(a, b));
    case "name":
      return list.sort(byName);
    case "stuck":
      return list.sort((a, b) => {
        const sa = isDone(a) ? -1 : a.stuckMinutes;
        const sb = isDone(b) ? -1 : b.stuckMinutes;
        return sb - sa || byName(a, b);
      });
  }
}

// ---- accounts ---------------------------------------------------------------------

function sortAccounts(list: readonly UserStats[], key: AcctSortKey): UserStats[] {
  const byName = (a: UserStats, b: UserStats): number => a.username.localeCompare(b.username);
  const desc = (a: string | null, b: string | null): number => (ms(b) ?? 0) - (ms(a) ?? 0);
  const out = [...list];
  switch (key) {
    case "rank":
      return out.sort(
        (a, b) =>
          (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || b.totalScore - a.totalScore || byName(a, b),
      );
    case "newest":
      return out.sort((a, b) => desc(a.createdAt, b.createdAt) || byName(a, b));
    case "seen":
      return out.sort((a, b) => desc(a.lastSeenAt, b.lastSeenAt) || byName(a, b));
    case "name":
      return out.sort(byName);
  }
}

/** Overall leaderboard: approved accounts that have played, by server rank. */
function topPlayers(accounts: readonly UserStats[], n: number): UserStats[] {
  return accounts
    .filter((a) => a.status === "approved" && a.rank !== null && a.casesStarted > 0)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.totalScore - a.totalScore || a.username.localeCompare(b.username))
    .slice(0, n);
}

// ---- stats ------------------------------------------------------------------------

type QuestionSummary = CaseSummary["questions"][QuestionId];

/** Hardest = highest give-up rate, then most wrong attempts, then most hints. Needs at least one finished attempt. */
function hardestQuestion(summary: CaseSummary): QuestionId | null {
  let best: { q: QuestionId; score: number } | null = null;
  for (const q of caseQuestionIds(summary.caseId)) {
    const s: QuestionSummary | undefined = summary.questions[q];
    if (!s) continue;
    const finished = s.solved + s.revealed;
    if (finished === 0) continue;
    const score = (s.revealed / finished) * 10 + s.avgWrong + s.avgHints * 0.5;
    if (best === null || score > best.score) best = { q, score };
  }
  return best && best.score > 0 ? best.q : null;
}

// ---- schedule ---------------------------------------------------------------------

const cloneSchedule = (s: Schedule): Schedule => ({ ...s, days: { ...s.days } });

function scheduleSig(s: Schedule): string {
  const days = Object.entries(s.days).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([s.timezone, s.defaultCaseId, s.lockToToday, days]);
}

// ---- keyed table rows (keep focus/scroll across 5s refreshes) -------------------------

type RowEntry = { rows: HTMLTableRowElement[]; sig: string };
type RowItem = { key: string; sig: string; build: () => HTMLTableRowElement[] };

function syncRows(tbody: HTMLTableSectionElement, cache: Map<string, RowEntry>, items: readonly RowItem[]): void {
  const keep = new Set<string>();
  let i = 0;
  for (const item of items) {
    keep.add(item.key);
    let entry = cache.get(item.key);
    if (!entry || entry.sig !== item.sig) {
      if (entry) for (const r of entry.rows) r.remove();
      entry = { rows: item.build(), sig: item.sig };
      cache.set(item.key, entry);
    }
    for (const row of entry.rows) {
      const at = tbody.children[i];
      if (at !== row) tbody.insertBefore(row, at ?? null);
      i += 1;
    }
  }
  for (const [key, entry] of cache) {
    if (keep.has(key)) continue;
    for (const r of entry.rows) r.remove();
    cache.delete(key);
  }
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

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : T().admUnknownError);

// ---- view ---------------------------------------------------------------------------

let activeCleanup: (() => void) | null = null;

export function renderAdmin(root: HTMLElement): void {
  // A re-render of the same route must not leak the previous instance's timers.
  if (activeCleanup) activeCleanup();

  const container = h("div", { class: "admin" });
  root.replaceChildren(container);

  let pollId: number | null = null;
  let tickId: number | null = null;
  let disposed = false;

  const state = {
    tab: readStoredTab(),
    accounts: null as AdminAccountsResult | null,
    today: null as TodayResponse | null,
    progress: null as AdminProgressResult | null,
    stats: null as AdminStatsResult | null,
    liveCaseId: null as string | null,
    lastUpdated: 0,
    paused: false,
    loading: false,
    queued: false,
    banner: null as string | null,
    failures: 0,
    leaderboard: false,
    // live tab
    liveSort: "score" as LiveSortKey,
    liveFilter: "",
    // accounts tab
    acctSort: "rank" as AcctSortKey,
    acctFilter: "all" as AcctFilter,
    acctSearch: "",
    expanded: new Set<string>(),
    // shared: two-step confirmations and in-flight row actions
    confirm: null as { kind: ConfirmKind; id: string } | null,
    busy: new Set<string>(),
    // schedule tab
    schedule: {
      server: null as Schedule | null,
      draft: null as Schedule | null,
      loading: false,
      saving: false,
      error: null as string | null,
      msg: null as string | null,
      month: null as { y: number; m: number } | null,
    },
  };

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
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("beforeunload", onBeforeUnload);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("visibilitychange", onVisibility);
    document.documentElement.classList.remove("admin-board-open");
    if (activeCleanup === dispose) activeCleanup = null;
  };
  activeCleanup = dispose;

  function onHashChange(): void {
    if (!location.hash.startsWith("#/admin")) dispose();
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape" && state.leaderboard) {
      state.leaderboard = false;
      renderLeaderboard();
    }
  }
  function onVisibility(): void {
    if (document.visibilityState === "hidden") {
      if (pollId !== null) window.clearTimeout(pollId);
      pollId = null;
    } else if (state.accounts && !state.paused) {
      void load();
    }
  }
  function onBeforeUnload(e: BeforeUnloadEvent): void {
    if (scheduleDirty()) e.preventDefault();
  }
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("beforeunload", onBeforeUnload);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("visibilitychange", onVisibility);

  // ---- login ---------------------------------------------------------------------

  function showLogin(error: string | null): void {
    stopTimers();
    state.accounts = null;
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
      ),
    );
    input.focus();
  }

  /** 401 / 503 send the instructor back to the key gate. Returns true when handled. */
  function handleAuthError(err: unknown): boolean {
    if (!(err instanceof AdminApiError)) return false;
    if (err.status === 401) {
      clearAdminKey();
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

  function requireKey(): string | null {
    const key = getAdminKey();
    if (!key) showLogin(null);
    return key;
  }

  function showActionError(err: unknown): void {
    if (handleAuthError(err)) return;
    state.banner = T().admActionFailed(errMessage(err));
    renderBanner();
  }

  // ---- shell: header, tabs, banner (built once; tab regions re-rendered) ------------------

  const updatedEl = h("span", { class: "admin-updated", "aria-live": "off" });
  const pauseBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admPause);
  const refreshBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admRefresh);
  const boardBtn = h("button", { type: "button", class: "btn btn-primary btn-sm" }, T().admLeaderboard);
  const logoutBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admSignOut);
  const bannerEl = h("div", { class: "admin-banner", role: "status" });
  const leaderboardEl = h("div", { class: "admin-board", role: "dialog", "aria-modal": "true", "aria-label": T().admLeaderboard });
  leaderboardEl.hidden = true;

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
  });
  logoutBtn.addEventListener("click", () => {
    clearAdminKey();
    showLogin(null);
  });

  const tabLabel = (tab: TabId): string =>
    tab === "accounts" ? T().admTabAccounts : tab === "live" ? T().admTabLive : tab === "schedule" ? T().admTabSchedule : T().admTabStats;

  const pendingTabBadge = h("span", { class: "tab-badge" });
  pendingTabBadge.hidden = true;
  const tabButtons = new Map<TabId, HTMLButtonElement>();
  const tabPanels = new Map<TabId, HTMLElement>();
  for (const tab of TABS) {
    const btn = h(
      "button",
      { type: "button", role: "tab", id: `admin-tab-${tab}`, class: "admin-tab", "aria-controls": `admin-panel-${tab}` },
      tabLabel(tab),
      tab === "accounts" ? pendingTabBadge : null,
    );
    btn.addEventListener("click", () => selectTab(tab));
    tabButtons.set(tab, btn);
    tabPanels.set(tab, h("div", { role: "tabpanel", id: `admin-panel-${tab}`, class: "admin-tabpanel", "aria-labelledby": `admin-tab-${tab}` }));
  }
  const tabList = h("div", { class: "admin-tabs", role: "tablist", "aria-label": T().admTabsLabel }, [...tabButtons.values()]);
  tabList.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const rtl = document.documentElement.dir === "rtl";
    const idx = TABS.indexOf(state.tab);
    let next = idx;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else next = (idx + ((e.key === "ArrowRight") !== rtl ? 1 : -1) + TABS.length) % TABS.length;
    const tab = TABS[next];
    if (!tab) return;
    e.preventDefault();
    selectTab(tab);
    tabButtons.get(tab)?.focus();
  });

  function syncTabs(): void {
    for (const tab of TABS) {
      const selected = tab === state.tab;
      const btn = tabButtons.get(tab);
      const panel = tabPanels.get(tab);
      if (btn) {
        btn.setAttribute("aria-selected", String(selected));
        btn.tabIndex = selected ? 0 : -1;
        btn.classList.toggle("is-active", selected);
      }
      if (panel) panel.hidden = !selected;
    }
  }

  function selectTab(tab: TabId): void {
    if (tab === state.tab) return;
    state.tab = tab;
    state.confirm = null;
    storeTab(tab);
    syncTabs();
    renderActiveTab();
    if (tab === "schedule" && !state.schedule.draft) void loadSchedule();
    void load();
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
        h("div", { class: "admin-head-actions" }, updatedEl, pauseBtn, refreshBtn, boardBtn, logoutBtn),
      ),
      tabList,
      bannerEl,
      [...tabPanels.values()],
      leaderboardEl,
    );
    buildAccountsPanel();
    buildLivePanel();
    buildStatsPanel();
    pauseBtn.textContent = state.paused ? T().admResume : T().admPause;
    syncTabs();
  }

  function renderUpdated(): void {
    if (!state.lastUpdated) {
      updatedEl.textContent = T().admLoading;
      return;
    }
    const sec = Math.max(0, Math.round((Date.now() - state.lastUpdated) / 1000));
    updatedEl.textContent = T().admUpdated(state.paused, sec);
    updatedEl.classList.toggle("is-stale", sec > 20);
  }

  function renderBanner(): void {
    bannerEl.textContent = state.banner ?? "";
    bannerEl.hidden = state.banner === null;
  }

  function tile(label: string, value: string, sub?: string): HTMLElement {
    return h(
      "div",
      { class: "admin-tile" },
      h("div", { class: "admin-tile-label" }, label),
      h("div", { class: "admin-tile-value" }, value),
      sub ? h("div", { class: "admin-tile-sub" }, sub) : null,
    );
  }

  function th(label: string, cls?: string): HTMLTableCellElement {
    return h("th", { scope: "col", class: cls }, label);
  }

  /** Inline two-step confirm (state-driven so it survives row rebuilds). */
  function twoStep(opts: {
    kind: ConfirmKind;
    id: string;
    label: string;
    ariaLabel: string;
    confirmAria: string;
    busyLabel: string;
    run: () => Promise<void>;
    rerender: () => void;
  }): HTMLElement {
    const busyKey = `${opts.kind}:${opts.id}`;
    const isConfirming = state.confirm?.kind === opts.kind && state.confirm.id === opts.id;
    if (!isConfirming) {
      return h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost btn-sm",
          "aria-label": opts.ariaLabel,
          onclick: () => {
            state.confirm = { kind: opts.kind, id: opts.id };
            opts.rerender();
            container.querySelector<HTMLButtonElement>(`[data-confirm="${CSS.escape(busyKey)}"]`)?.focus();
          },
        },
        opts.label,
      );
    }
    const busy = state.busy.has(busyKey);
    const yes = h(
      "button",
      { type: "button", class: "btn btn-danger btn-sm", "data-confirm": busyKey, disabled: busy },
      busy ? opts.busyLabel : T().admConfirm,
    );
    yes.addEventListener("click", () => {
      state.busy.add(busyKey);
      opts.rerender();
      opts
        .run()
        .then(() => {
          state.confirm = null;
          void load();
        })
        .catch((err: unknown) => {
          state.confirm = null;
          showActionError(err);
        })
        .finally(() => {
          state.busy.delete(busyKey);
          opts.rerender();
        });
    });
    const no = h(
      "button",
      {
        type: "button",
        class: "btn btn-ghost btn-sm",
        disabled: busy,
        onclick: () => {
          state.confirm = null;
          opts.rerender();
        },
      },
      T().admCancel,
    );
    return h("span", { class: "confirm-prompt", role: "group", "aria-label": opts.confirmAria }, yes, no);
  }

  // =====================================================================================
  // Accounts tab
  // =====================================================================================

  const acctTilesEl = h("div", { class: "admin-tiles" });
  const pendingEl = h("div", { class: "pending-wrap" });
  const pendingCountEl = h("span", { class: "count-badge" });
  const acctCountEl = h("span", { class: "muted small" });
  const acctTableEl = h("div", { class: "admin-table-wrap" });
  let pendingSig = "";

  const acctSearchInput = h("input", {
    type: "search",
    class: "admin-input admin-search",
    placeholder: T().admSearchPlaceholder,
    "aria-label": T().admSearchLabel,
  });
  acctSearchInput.addEventListener("input", () => {
    state.acctSearch = acctSearchInput.value;
    renderAccountsTable();
  });
  const acctFilterSelect = h(
    "select",
    { class: "admin-input", "aria-label": T().admFilterStatusLabel },
    h("option", { value: "all" }, T().admFilterAll),
    h("option", { value: "pending" }, T().admAcctStatus("pending")),
    h("option", { value: "approved" }, T().admAcctStatus("approved")),
    h("option", { value: "rejected" }, T().admAcctStatus("rejected")),
  );
  acctFilterSelect.addEventListener("change", () => {
    const v = acctFilterSelect.value;
    if (v === "all" || v === "pending" || v === "approved" || v === "rejected") {
      state.acctFilter = v;
      renderAccountsTable();
    }
  });
  const acctSortSelect = h(
    "select",
    { class: "admin-input", "aria-label": T().admSortLabel },
    h("option", { value: "rank" }, T().admSortRank),
    h("option", { value: "newest" }, T().admSortNewest),
    h("option", { value: "seen" }, T().admSortSeen),
    h("option", { value: "name" }, T().admSortName),
  );
  acctSortSelect.addEventListener("change", () => {
    const v = acctSortSelect.value;
    if (v === "rank" || v === "newest" || v === "seen" || v === "name") {
      state.acctSort = v;
      renderAccountsTable();
    }
  });

  const ACCT_COLS = 11;
  const acctTbody = h("tbody", {});
  const acctTable = h(
    "table",
    { class: "admin-table acct-table" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        th(T().admColUser),
        th(T().admColStatus),
        th(T().admColCreated),
        th(T().admColSeen),
        th(T().admColScore, "num"),
        th(T().admColRank, "num"),
        th(T().admColCompleted, "num"),
        th(T().admColAccuracy, "num"),
        th(T().admColHints, "num"),
        th(T().admColWrong, "num"),
        h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, T().admColActions)),
      ),
    ),
    acctTbody,
  );
  const acctRowCache = new Map<string, RowEntry>();

  function buildAccountsPanel(): void {
    setChildren(
      tabPanels.get("accounts") ?? container,
      acctTilesEl,
      h(
        "section",
        { class: "panel admin-panel pending-panel" },
        h("h2", { class: "admin-h2" }, T().admPendingTitle, " ", pendingCountEl),
        pendingEl,
      ),
      h(
        "section",
        { class: "panel admin-panel" },
        h(
          "div",
          { class: "admin-table-head" },
          h("h2", { class: "admin-h2" }, T().admAccountsTitle, " ", acctCountEl),
          h("div", { class: "admin-controls" }, acctSearchInput, acctFilterSelect, acctSortSelect),
        ),
        h("p", { class: "muted small admin-hint" }, T().admAccountsHint),
        acctTableEl,
      ),
    );
  }

  async function changeStatus(account: UserStats, action: "approve" | "reject"): Promise<void> {
    const key = requireKey();
    if (!key) return;
    const busyKey = `status:${account.accountId}`;
    state.busy.add(busyKey);
    renderAccounts();
    try {
      const updated = await setAccountStatus(key, account.accountId, action);
      if (state.accounts) {
        state.accounts = {
          ...state.accounts,
          accounts: state.accounts.accounts.map((a) => (a.accountId === updated.id ? { ...a, status: updated.status } : a)),
        };
      }
      state.banner = null;
      renderBanner();
      void load();
    } catch (err: unknown) {
      showActionError(err);
    } finally {
      state.busy.delete(busyKey);
      if (state.accounts) renderAccounts();
    }
  }

  function statusButtons(a: UserStats, compact: boolean): HTMLElement[] {
    const busy = state.busy.has(`status:${a.accountId}`);
    const out: HTMLElement[] = [];
    if (a.status !== "approved") {
      out.push(
        h(
          "button",
          {
            type: "button",
            class: compact ? "btn btn-ghost btn-sm btn-approve" : "btn btn-primary btn-sm",
            disabled: busy,
            "aria-label": T().admApproveLabel(a.username),
            onclick: () => void changeStatus(a, "approve"),
          },
          T().admApprove,
        ),
      );
    }
    if (a.status !== "rejected") {
      out.push(
        h(
          "button",
          {
            type: "button",
            class: "btn btn-ghost btn-sm",
            disabled: busy,
            "aria-label": T().admRejectLabel(a.username),
            title: a.status === "approved" ? T().admRevokeTip : undefined,
            onclick: () => void changeStatus(a, "reject"),
          },
          a.status === "approved" ? T().admRevoke : T().admReject,
        ),
      );
    }
    return out;
  }

  function statusPill(status: AccountStatus): HTMLElement {
    return h("span", { class: `status-pill is-${status}` }, T().admAcctStatus(status));
  }

  function renderPending(list: readonly UserStats[]): void {
    const pending = list.filter((a) => a.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    pendingCountEl.textContent = String(pending.length);
    pendingCountEl.classList.toggle("is-zero", pending.length === 0);
    pendingTabBadge.textContent = String(pending.length);
    pendingTabBadge.hidden = pending.length === 0;
    pendingTabBadge.setAttribute("aria-label", T().admPendingBadge(pending.length));
    // Rebuild only when something visible changed, so focus on Approve/Reject survives polling.
    const sig = [getLang(), ...pending.map((a) => `${a.accountId}:${a.username}:${state.busy.has(`status:${a.accountId}`) ? 1 : 0}`)].join("|");
    if (sig === pendingSig) return;
    pendingSig = sig;
    if (pending.length === 0) {
      setChildren(pendingEl, h("p", { class: "muted admin-empty-small" }, T().admNoPending));
      return;
    }
    setChildren(
      pendingEl,
      h(
        "ul",
        { class: "pending-list" },
        pending.map((a) =>
          h(
            "li",
            { class: "pending-item" },
            h("span", { class: "pending-name" }, a.username),
            h("span", { class: "pending-meta muted small" }, T().admSignedUp(formatDateTime(a.createdAt))),
            h("span", { class: "pending-actions" }, statusButtons(a, false)),
          ),
        ),
      ),
    );
  }

  function caseStatsTable(list: readonly CaseStats[]): HTMLElement {
    if (list.length === 0) return h("p", { class: "muted small admin-empty-small" }, T().admNoCasesYet);
    return h(
      "table",
      { class: "admin-table admin-subtable" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          th(T().admColCase),
          th(T().admColStatus),
          th(T().admColScore, "num"),
          th(T().admColSolved, "num"),
          th(T().admColRevealed, "num"),
          th(T().admColHints, "num"),
          th(T().admColWrong, "num"),
          th(T().admColDuration, "num"),
          th(T().admColStarted),
          th(T().admColFinishedAt),
        ),
      ),
      h(
        "tbody",
        {},
        list.map((c) =>
          h(
            "tr",
            {},
            h("td", {}, caseTitle(c.caseId)),
            h("td", {}, h("span", { class: `case-status is-${c.status}` }, T().admCaseStatus(c.status))),
            h("td", { class: "num" }, `${c.score}/${c.maxScore}`),
            h("td", { class: "num" }, String(c.solved)),
            h("td", { class: "num" }, String(c.revealed)),
            h("td", { class: "num" }, String(c.hintsUsed)),
            h("td", { class: "num" }, String(c.wrongAttempts)),
            h("td", { class: "num" }, formatSeconds(c.durationSeconds)),
            h("td", { class: "col-seen" }, formatDateTime(c.startedAt)),
            h("td", { class: "col-seen" }, formatDateTime(c.completedAt)),
          ),
        ),
      ),
    );
  }

  function acctSignature(a: UserStats, now: number): string {
    const id = a.accountId;
    return JSON.stringify([
      getLang(),
      a.username,
      a.status,
      a.totalScore,
      a.rank,
      a.casesCompleted,
      a.casesStarted,
      a.accuracy,
      a.hintsUsed,
      a.wrongAttempts,
      relativeAgo(a.lastSeenAt, now),
      state.expanded.has(id),
      state.expanded.has(id) ? a.cases : null,
      state.confirm?.kind === "delete" && state.confirm.id === id,
      state.busy.has(`delete:${id}`),
      state.busy.has(`status:${id}`),
    ]);
  }

  function buildAcctRows(a: UserStats, now: number): HTMLTableRowElement[] {
    const expanded = state.expanded.has(a.accountId);
    const detailId = `acct-detail-${a.accountId}`;
    const toggle = h(
      "button",
      {
        type: "button",
        class: "acct-toggle",
        "aria-expanded": String(expanded),
        "aria-controls": detailId,
        title: T().admShowCaseStats,
        onclick: () => {
          if (state.expanded.has(a.accountId)) state.expanded.delete(a.accountId);
          else state.expanded.add(a.accountId);
          renderAccountsTable();
          container.querySelector<HTMLButtonElement>(`[aria-controls="${CSS.escape(detailId)}"]`)?.focus();
        },
      },
      h("span", { class: "acct-caret", "aria-hidden": "true" }, "▸"),
      h("span", { class: "player-name" }, a.username),
    );
    const row = h(
      "tr",
      { class: `acct-row is-${a.status}${expanded ? " is-expanded" : ""}`, "data-id": a.accountId },
      h("td", { class: "col-name" }, toggle),
      h("td", {}, statusPill(a.status)),
      h("td", { class: "col-seen muted" }, formatDateTime(a.createdAt)),
      h("td", { class: "col-seen muted", title: formatDateTime(a.lastSeenAt) }, relativeAgo(a.lastSeenAt, now)),
      h("td", { class: "num col-score" }, String(a.totalScore)),
      h("td", { class: "num" }, a.rank === null ? "—" : `#${a.rank}`),
      h("td", { class: "num", title: T().admStartedCount(a.casesStarted) }, `${a.casesCompleted}/${a.casesStarted}`),
      h("td", { class: "num" }, formatPct(a.accuracy)),
      h("td", { class: "num" }, String(a.hintsUsed)),
      h("td", { class: "num" }, String(a.wrongAttempts)),
      h(
        "td",
        { class: "col-actions" },
        h(
          "span",
          { class: "row-actions" },
          statusButtons(a, true),
          twoStep({
            kind: "delete",
            id: a.accountId,
            label: T().admDelete,
            ariaLabel: T().admDeleteLabel(a.username),
            confirmAria: T().admConfirmDeleteLabel(a.username),
            busyLabel: T().admDeleting,
            run: async () => {
              const key = requireKey();
              if (!key) return;
              await deleteAccount(key, a.accountId);
              state.expanded.delete(a.accountId);
              if (state.accounts) {
                state.accounts = { ...state.accounts, accounts: state.accounts.accounts.filter((x) => x.accountId !== a.accountId) };
              }
            },
            rerender: () => {
              if (state.accounts) renderAccountsTable();
            },
          }),
        ),
      ),
    );
    if (!expanded) return [row];
    const detail = h(
      "tr",
      { class: "acct-detail", id: detailId },
      h(
        "td",
        { colspan: ACCT_COLS },
        h("div", { class: "acct-detail-inner" }, h("p", { class: "admin-label" }, T().admPerCaseTitle(a.username)), caseStatsTable(a.cases)),
      ),
    );
    return [row, detail];
  }

  function renderAccountsTable(): void {
    const all = state.accounts?.accounts ?? [];
    acctCountEl.textContent = `(${all.length})`;
    if (all.length === 0) {
      acctRowCache.clear();
      acctTbody.replaceChildren();
      const url = location.origin;
      setChildren(
        acctTableEl,
        h(
          "div",
          { class: "admin-empty" },
          h("p", { class: "admin-empty-title" }, T().admNoAccounts),
          h("p", { class: "muted" }, T().admShareLink),
          h("div", { class: "admin-share" }, h("code", { class: "admin-share-url" }, url), copyButton(() => url, T().admCopyLink)),
        ),
      );
      return;
    }
    const q = state.acctSearch.trim().toLowerCase();
    const filtered = all.filter(
      (a) => (state.acctFilter === "all" || a.status === state.acctFilter) && (!q || a.username.toLowerCase().includes(q)),
    );
    if (filtered.length === 0) {
      setChildren(acctTableEl, h("p", { class: "muted admin-empty-small" }, T().admNoMatch));
      return;
    }
    if (acctTable.parentNode !== acctTableEl) setChildren(acctTableEl, acctTable);
    const now = Date.now();
    syncRows(
      acctTbody,
      acctRowCache,
      sortAccounts(filtered, state.acctSort).map((a) => ({
        key: a.accountId,
        sig: acctSignature(a, now),
        build: () => buildAcctRows(a, now),
      })),
    );
  }

  function renderAccounts(): void {
    const all = state.accounts?.accounts ?? [];
    const count = (s: AccountStatus): number => all.filter((a) => a.status === s).length;
    const active = all.filter((a) => {
      const t = ms(a.lastSeenAt);
      return t !== null && Date.now() - t < 24 * 3600 * 1000;
    }).length;
    setChildren(
      acctTilesEl,
      tile(T().admTileAccounts, String(all.length), T().admActive24h(active)),
      tile(T().admAcctStatus("pending"), String(count("pending")), T().admAwaitingApproval),
      tile(T().admAcctStatus("approved"), String(count("approved"))),
      tile(T().admAcctStatus("rejected"), String(count("rejected"))),
    );
    renderPending(all);
    // Drop UI state for accounts that disappeared.
    const ids = new Set(all.map((a) => a.accountId));
    for (const id of state.expanded) if (!ids.has(id)) state.expanded.delete(id);
    if (state.confirm?.kind === "delete" && !ids.has(state.confirm.id)) state.confirm = null;
    renderAccountsTable();
  }

  // =====================================================================================
  // Live tab
  // =====================================================================================

  const liveCaseSelect = h("select", { class: "admin-input", id: "admin-live-case" });
  liveCaseSelect.addEventListener("change", () => {
    const v = liveCaseSelect.value;
    if (!v || v === state.liveCaseId) return;
    state.liveCaseId = v;
    state.progress = null;
    state.confirm = null;
    liveRowCache.clear();
    liveTbody.replaceChildren();
    renderLive();
    void load();
  });
  let liveCaseOptionsSig = "";
  const liveTodayTag = h("span", { class: "today-tag" }, T().admTodayTag);
  const liveTilesEl = h("div", { class: "admin-tiles" });
  const funnelEl = h("div", { class: "admin-funnel" });
  const helpEl = h("div", { class: "admin-help" });
  const liveTableEl = h("div", { class: "admin-table-wrap" });
  const liveBodyEl = h("div", { class: "admin-live-body" });

  const liveSearchInput = h("input", {
    type: "search",
    class: "admin-input admin-search",
    placeholder: T().admSearchPlaceholder,
    "aria-label": T().admSearchLabel,
  });
  liveSearchInput.addEventListener("input", () => {
    state.liveFilter = liveSearchInput.value;
    renderLiveTable();
  });
  const liveSortSelect = h(
    "select",
    { class: "admin-input admin-sort", "aria-label": T().admSortLabel },
    h("option", { value: "score" }, T().admSortScore),
    h("option", { value: "progress" }, T().admSortProgress),
    h("option", { value: "stuck" }, T().admSortStuck),
    h("option", { value: "name" }, T().admSortName),
  );
  liveSortSelect.addEventListener("change", () => {
    const v = liveSortSelect.value;
    if (v === "score" || v === "progress" || v === "name" || v === "stuck") {
      state.liveSort = v;
      renderLiveTable();
    }
  });

  // Reset this case: typed confirmation.
  const resetInput = h("input", {
    type: "text",
    class: "admin-input",
    placeholder: T().admResetPlaceholder,
    "aria-label": T().admResetLabel,
    autocomplete: "off",
  });
  const resetBtn = h("button", { type: "button", class: "btn btn-danger btn-sm", disabled: true }, T().admResetCase);
  const resetMsg = h("span", { class: "muted small", role: "status" });
  const resetTextEl = h("p", { class: "muted small" });
  resetInput.addEventListener("input", () => {
    resetBtn.disabled = resetInput.value.trim() !== "RESET";
  });
  resetBtn.addEventListener("click", () => {
    const key = requireKey();
    const caseId = state.liveCaseId;
    if (!key || !caseId || resetInput.value.trim() !== "RESET") return;
    resetBtn.disabled = true;
    resetMsg.textContent = T().admResetting;
    resetProgress(key, caseId)
      .then(() => {
        resetInput.value = "";
        resetMsg.textContent = T().admCaseReset(caseTitle(caseId));
        void load();
      })
      .catch((err: unknown) => {
        if (handleAuthError(err)) return;
        resetMsg.textContent = `${T().admResetFailed}: ${errMessage(err)}`;
        resetBtn.disabled = resetInput.value.trim() !== "RESET";
      });
  });

  const liveTbody = h("tbody", {});
  const liveTable = h(
    "table",
    { class: "admin-table" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        th(T().admColName),
        th(T().admColProgress),
        th(T().admColScore, "num"),
        th(T().admColStage),
        th(T().admColSeen),
        h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, T().admColActions)),
      ),
    ),
    liveTbody,
  );
  const liveRowCache = new Map<string, RowEntry>();

  function buildLivePanel(): void {
    setChildren(
      tabPanels.get("live") ?? container,
      h(
        "section",
        { class: "panel admin-panel admin-toolbar" },
        h("label", { class: "admin-label", for: "admin-live-case" }, T().admCasePicker),
        liveCaseSelect,
        liveTodayTag,
      ),
      liveBodyEl,
    );
  }

  function liveBodySkeleton(): HTMLElement[] {
    return [
      liveTilesEl,
      h(
        "div",
        { class: "admin-grid" },
        h("section", { class: "panel admin-panel" }, h("h2", { class: "admin-h2" }, T().admStageFunnel), funnelEl),
        h("section", { class: "panel admin-panel" }, h("h2", { class: "admin-h2" }, T().admNeedsHelp), helpEl),
      ),
      h(
        "section",
        { class: "panel admin-panel" },
        h(
          "div",
          { class: "admin-table-head" },
          h("h2", { class: "admin-h2" }, T().admPlayers),
          h("div", { class: "admin-controls" }, liveSearchInput, liveSortSelect),
        ),
        h(
          "div",
          { class: "admin-legend", "aria-hidden": "true" },
          h("span", { class: "cell is-solved" }), T().admStatus("solved"),
          h("span", { class: "cell is-revealed" }), T().admStatus("revealed"),
          h("span", { class: "cell is-active" }), T().admStatus("active"),
          h("span", { class: "cell is-locked" }), T().admStatus("locked"),
        ),
        liveTableEl,
      ),
      h(
        "section",
        { class: "panel admin-panel admin-danger" },
        h("h2", { class: "admin-h2" }, T().admDangerZone),
        resetTextEl,
        h("div", { class: "admin-reset" }, resetInput, resetBtn, resetMsg),
      ),
    ];
  }

  function syncLiveCaseOptions(): void {
    const released = state.today?.releasedCaseIds ?? [];
    const ids = [...released];
    if (state.liveCaseId && !ids.includes(state.liveCaseId)) ids.push(state.liveCaseId);
    const todayId = state.today?.caseId ?? null;
    const sig = JSON.stringify([getLang(), ids, todayId]);
    if (sig !== liveCaseOptionsSig) {
      liveCaseOptionsSig = sig;
      setChildren(
        liveCaseSelect,
        ids.map((id) => h("option", { value: id }, id === todayId ? `${caseTitle(id)} · ${T().admTodayTag}` : caseTitle(id))),
      );
    }
    if (state.liveCaseId) liveCaseSelect.value = state.liveCaseId;
    liveCaseSelect.disabled = ids.length === 0;
    liveTodayTag.hidden = !state.liveCaseId || state.liveCaseId !== todayId;
  }

  function renderLiveTiles(players: readonly AdminProgress[], caseId: string): void {
    const finished = players.filter(isDone);
    const avg = players.length ? Math.round(players.reduce((s, p) => s + p.score, 0) / players.length) : null;
    const maxScore = players[0]?.maxScore ?? caseMaxScore(caseId);
    const med = median(finished.map(finishDurationMs).filter((v): v is number => v !== null));
    const stuck = players.filter((p) => stuckLevel(p) !== "none").length;
    setChildren(
      liveTilesEl,
      tile(T().admPlayers, String(players.length), T().admStuckCount(stuck)),
      tile(T().admFinished, String(finished.length), players.length ? `${Math.round((finished.length / players.length) * 100)}%` : undefined),
      tile(T().admAvgScore, avg === null ? "—" : String(avg), maxScore ? T().admOf(maxScore) : undefined),
      tile(T().admMedianTime, med === null ? "—" : formatDuration(med), T().admFinishedPlayers),
    );
  }

  function renderFunnel(players: readonly AdminProgress[], caseId: string): void {
    const total = players.length;
    const rows = caseStages(caseId).map((stage) => {
      const reached = players.filter((p) => stageStatus(p, stage) !== "locked").length;
      const done = players.filter((p) => isFinishedStatus(stageStatus(p, stage))).length;
      const pct = (n: number): string => (total ? `${(n / total) * 100}%` : "0%");
      const title = stage === "setup" ? T().admSetup : questionTitle(caseId, stage);
      return h(
        "div",
        { class: "funnel-row", title: T().admFunnelTip(`${stageLabel(stage)} ${title}`, reached, done) },
        h("span", { class: "funnel-label" }, stageLabel(stage)),
        h(
          "div",
          { class: "funnel-track" },
          h("div", { class: "funnel-reached", style: `width:${pct(reached)}` }),
          h("div", { class: "funnel-done", style: `width:${pct(done)}` }),
        ),
        h("span", { class: "funnel-count" }, `${done}/${reached}`),
      );
    });
    setChildren(
      funnelEl,
      h(
        "p",
        { class: "muted small funnel-key" },
        h("span", { class: "key-done" }), `${T().admKeyFinished} `,
        h("span", { class: "key-reached" }), T().admKeyReached,
      ),
      rows,
    );
  }

  function stuckBadge(p: AdminProgress): HTMLElement | null {
    const level = stuckLevel(p);
    if (level === "none") return null;
    return h(
      "span",
      { class: `stuck-badge is-${level}`, title: T().admStuckTip(Math.floor(p.stuckMinutes)) },
      T().admStuckBadge(Math.floor(p.stuckMinutes)),
    );
  }

  function renderHelp(players: readonly AdminProgress[], caseId: string): void {
    const stuck = players.filter((p) => stuckLevel(p) !== "none").sort((a, b) => b.stuckMinutes - a.stuckMinutes);
    if (stuck.length === 0) {
      setChildren(helpEl, h("p", { class: "muted admin-empty-small" }, T().admNobodyStuck));
      return;
    }
    setChildren(
      helpEl,
      h(
        "ul",
        { class: "help-list" },
        stuck.map((p) => {
          const cur = p.currentStage;
          const sp = cur !== "setup" && cur !== "done" ? p.stages[cur] : undefined;
          const detail = sp ? T().admHelpDetail(sp.wrongAttempts, sp.hintsRevealed) : "";
          return h(
            "li",
            { class: `help-item is-${stuckLevel(p)}` },
            h("span", { class: "help-name" }, p.username),
            h("span", { class: "help-stage" }, stageLongLabel(caseId, cur)),
            h("span", { class: "help-detail muted" }, detail),
            stuckBadge(p),
          );
        }),
      ),
    );
  }

  function progressCells(p: AdminProgress, stages: readonly StageKey[], now: number): HTMLElement {
    return h(
      "div",
      { class: "progress-cells", role: "list", "aria-label": T().admProgressLabel(progressCount(p, stages), stages.length) },
      stages.map((stage) => {
        const status = stageStatus(p, stage);
        const tip = stageTooltip(p, stage, now);
        return h("span", { class: `cell is-${status}`, role: "listitem", title: tip, "aria-label": tip });
      }),
    );
  }

  function liveSignature(p: AdminProgress, stages: readonly StageKey[], now: number): string {
    const st = stages
      .map((s) => {
        const sp = s === "setup" ? undefined : p.stages[s];
        return `${stageStatus(p, s)}:${sp?.wrongAttempts ?? 0}:${sp?.hintsRevealed ?? 0}`;
      })
      .join(",");
    const id = p.accountId;
    return [
      getLang(),
      p.caseId,
      p.username,
      p.score,
      p.currentStage,
      Math.floor(p.stuckMinutes),
      st,
      relativeAgo(p.lastSeenAt, now),
      state.confirm?.kind === "restart" && state.confirm.id === id ? "confirm" : "",
      state.busy.has(`restart:${id}`) ? "busy" : "",
    ].join("|");
  }

  function buildLiveRow(p: AdminProgress, stages: readonly StageKey[], now: number): HTMLTableRowElement {
    const caseId = p.caseId;
    return h(
      "tr",
      { class: `is-${stuckLevel(p)}`, "data-id": p.accountId },
      h("td", { class: "col-name" }, h("span", { class: "player-name" }, p.username)),
      h("td", {}, progressCells(p, stages, now)),
      h("td", { class: "num col-score" }, String(p.score)),
      h(
        "td",
        { class: "col-stage" },
        h("span", { class: isDone(p) ? "stage-done" : "" }, stageLongLabel(caseId, p.currentStage)),
        " ",
        stuckBadge(p),
      ),
      h("td", { class: "col-seen muted" }, relativeAgo(p.lastSeenAt, now)),
      h(
        "td",
        { class: "col-actions" },
        twoStep({
          kind: "restart",
          id: p.accountId,
          label: T().admRestart,
          ariaLabel: T().admRestartLabel(p.username),
          confirmAria: T().admConfirmRestartLabel(p.username),
          busyLabel: T().admRestarting,
          run: async () => {
            const key = requireKey();
            if (!key) return;
            await restartPlayerCase(key, p.accountId, caseId);
          },
          rerender: () => renderLiveTable(),
        }),
      ),
    );
  }

  function renderLiveTable(): void {
    const caseId = state.liveCaseId;
    const players = state.progress?.players ?? [];
    if (!caseId) return;
    if (players.length === 0) {
      liveRowCache.clear();
      liveTbody.replaceChildren();
      const url = location.origin;
      setChildren(
        liveTableEl,
        h(
          "div",
          { class: "admin-empty" },
          h("p", { class: "admin-empty-title" }, state.progress ? T().admNoPlayers : T().admLoading),
          state.progress ? h("p", { class: "muted" }, T().admShareLink) : null,
          state.progress
            ? h("div", { class: "admin-share" }, h("code", { class: "admin-share-url" }, url), copyButton(() => url, T().admCopyLink))
            : null,
        ),
      );
      return;
    }
    const q = state.liveFilter.trim().toLowerCase();
    const filtered = q ? players.filter((p) => p.username.toLowerCase().includes(q)) : players;
    if (filtered.length === 0) {
      setChildren(liveTableEl, h("p", { class: "muted admin-empty-small" }, T().admNoMatch));
      return;
    }
    if (liveTable.parentNode !== liveTableEl) setChildren(liveTableEl, liveTable);
    const stages = caseStages(caseId);
    const now = Date.now();
    syncRows(
      liveTbody,
      liveRowCache,
      sortPlayers(filtered, state.liveSort, stages).map((p) => ({
        key: p.accountId,
        sig: liveSignature(p, stages, now),
        build: () => [buildLiveRow(p, stages, now)],
      })),
    );
  }

  function renderLive(): void {
    syncLiveCaseOptions();
    const caseId = state.liveCaseId;
    if (!caseId) {
      setChildren(liveBodyEl, h("section", { class: "panel admin-panel admin-empty" }, h("p", { class: "admin-empty-title" }, T().admNoReleased)));
      return;
    }
    if (liveTilesEl.parentNode !== liveBodyEl) setChildren(liveBodyEl, liveBodySkeleton());
    resetTextEl.textContent = T().admResetCaseText(caseTitle(caseId));
    // A response for a previously selected case is ignored until the new one arrives.
    const players = state.progress?.caseId === caseId ? state.progress.players : [];
    if (state.confirm?.kind === "restart" && !players.some((p) => p.accountId === state.confirm?.id)) state.confirm = null;
    renderLiveTiles(players, caseId);
    renderFunnel(players, caseId);
    renderHelp(players, caseId);
    renderLiveTable();
  }

  // =====================================================================================
  // Schedule tab
  // =====================================================================================

  const scheduleTodayEl = h("p", { class: "sched-today" });

  function scheduleDirty(): boolean {
    const { server, draft } = state.schedule;
    return server !== null && draft !== null && scheduleSig(server) !== scheduleSig(draft);
  }

  async function loadSchedule(): Promise<void> {
    const key = requireKey();
    if (!key) return;
    const sch = state.schedule;
    sch.loading = true;
    sch.error = null;
    renderSchedule();
    try {
      const s = await fetchSchedule(key);
      if (disposed) return;
      sch.server = cloneSchedule(s);
      sch.draft = cloneSchedule(s);
      if (!sch.month) sch.month = monthOf(state.today?.date ?? null);
    } catch (err: unknown) {
      if (disposed || handleAuthError(err)) return;
      sch.error = errMessage(err);
    } finally {
      sch.loading = false;
    }
    if (state.tab === "schedule") renderSchedule();
  }

  function monthOf(iso: string | null): { y: number; m: number } {
    const match = iso ? /^(\d{4})-(\d{2})-/.exec(iso) : null;
    if (match) return { y: Number(match[1]), m: Number(match[2]) - 1 };
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  }

  function caseOptions(selected: string | null, emptyLabel: string): HTMLOptionElement[] {
    const released = state.today?.releasedCaseIds ?? [];
    const opts = [h("option", { value: "", selected: selected === null }, emptyLabel)];
    for (const id of released) opts.push(h("option", { value: id, selected: id === selected }, caseTitle(id)));
    if (selected !== null && !released.includes(selected)) {
      opts.push(h("option", { value: selected, selected: true }, T().admNotReleased(caseTitle(selected))));
    }
    return opts;
  }

  function renderScheduleToday(): void {
    const today = state.today;
    if (!today) {
      scheduleTodayEl.textContent = "";
      return;
    }
    setChildren(
      scheduleTodayEl,
      h("strong", {}, T().admTodayIs(today.date, today.timezone)),
      " ",
      today.caseId ? caseTitle(today.caseId) : h("span", { class: "muted" }, T().admNoCaseToday),
      today.lockToToday ? h("span", { class: "today-tag" }, T().admLockedTag) : null,
    );
  }

  /** Re-render while keeping keyboard focus on the same control (selects are rebuilt). */
  function withFocusKept(render: () => void): void {
    const active = document.activeElement;
    const id = active instanceof HTMLElement && container.contains(active) ? active.id : "";
    render();
    if (id) document.getElementById(id)?.focus();
  }

  function updateDraft(mutate: (d: Schedule) => void): void {
    const sch = state.schedule;
    if (!sch.draft) return;
    mutate(sch.draft);
    sch.msg = null;
    sch.error = null;
    withFocusKept(renderSchedule);
  }

  async function onSaveSchedule(): Promise<void> {
    const key = requireKey();
    const sch = state.schedule;
    if (!key || !sch.draft) return;
    sch.saving = true;
    sch.error = null;
    sch.msg = null;
    renderSchedule();
    try {
      const saved = await saveSchedule(key, sch.draft);
      if (disposed) return;
      sch.server = cloneSchedule(saved);
      sch.draft = cloneSchedule(saved);
      sch.msg = T().admScheduleSaved;
      try {
        state.today = await fetchToday();
      } catch {
        // the next poll will pick it up
      }
    } catch (err: unknown) {
      if (disposed || handleAuthError(err)) return;
      sch.error = errMessage(err);
    } finally {
      sch.saving = false;
    }
    if (state.tab === "schedule") renderSchedule();
  }

  function calendar(draft: Schedule, month: { y: number; m: number }): HTMLElement {
    const { y, m } = month;
    const first = new Date(Date.UTC(y, m, 1));
    const startDow = first.getUTCDay(); // weeks start on Sunday (Israel)
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const todayIso = state.today?.date ?? "";
    const monthLabel = new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(first);
    const weekdayFmt = new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" });
    const dayFmt = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    // Day cells are narrow: a short "Default" label (the full title is in the tooltip and the settings above).
    const defaultLabel = draft.defaultCaseId ? T().admDefaultShort : T().admNoneOpt;
    const defaultTip = draft.defaultCaseId ? T().admDefaultOpt(caseTitle(draft.defaultCaseId)) : T().admNoneOpt;
    const rtl = document.documentElement.dir === "rtl";
    const shift = (delta: number): void => {
      const d = new Date(Date.UTC(y, m + delta, 1));
      state.schedule.month = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
      withFocusKept(renderSchedule);
    };

    const cells: HTMLElement[] = [];
    for (let i = 0; i < 7; i += 1) {
      cells.push(h("div", { class: "cal-dow", "aria-hidden": "true" }, weekdayFmt.format(Date.UTC(2023, 0, 1 + i))));
    }
    for (let i = 0; i < startDow; i += 1) cells.push(h("div", { class: "cal-day is-blank", "aria-hidden": "true" }));
    for (let d = 1; d <= daysInMonth; d += 1) {
      const iso = isoDay(y, m, d);
      const assigned = draft.days[iso] ?? null;
      const isToday = iso === todayIso;
      const isPast = todayIso !== "" && iso < todayIso;
      const select = h(
        "select",
        { class: "admin-input cal-select", id: `cal-${iso}`, "aria-label": T().admDayCaseLabel(dayFmt.format(Date.UTC(y, m, d))),
          title: assigned ? caseTitle(assigned) : defaultTip,
        },
        caseOptions(assigned, defaultLabel),
      );
      select.addEventListener("change", () => {
        const v = select.value;
        updateDraft((dr) => {
          if (v === "") delete dr.days[iso];
          else dr.days[iso] = v;
        });
      });
      cells.push(
        h(
          "div",
          { class: `cal-day${isToday ? " is-today" : ""}${assigned ? " is-set" : ""}${isPast ? " is-past" : ""}` },
          h("div", { class: "cal-day-head" }, h("span", { class: "cal-num" }, String(d)), isToday ? h("span", { class: "today-tag" }, T().admTodayTag) : null),
          select,
        ),
      );
    }
    return h(
      "section",
      { class: "panel admin-panel" },
      h(
        "div",
        { class: "cal-head" },
        h("button", { type: "button", class: "btn btn-ghost btn-sm", id: "cal-prev", "aria-label": T().admPrevMonth, onclick: () => shift(-1) }, rtl ? "→" : "←"),
        h("h2", { class: "admin-h2 cal-title", "aria-live": "polite" }, monthLabel),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", id: "cal-next", "aria-label": T().admNextMonth, onclick: () => shift(1) }, rtl ? "←" : "→"),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-ghost btn-sm",
            id: "cal-this",
            onclick: () => {
              state.schedule.month = monthOf(state.today?.date ?? null);
              withFocusKept(renderSchedule);
            },
          },
          T().admThisMonth,
        ),
      ),
      h("p", { class: "muted small admin-hint" }, T().admCalendarHint),
      h("div", { class: "cal-grid" }, cells),
    );
  }

  function renderSchedule(): void {
    const panel = tabPanels.get("schedule");
    if (!panel) return;
    const sch = state.schedule;
    renderScheduleToday();
    const todayPanel = h("section", { class: "panel admin-panel" }, h("h2", { class: "admin-h2" }, T().admIncidentOfDay), scheduleTodayEl);
    if (!sch.draft) {
      setChildren(
        panel,
        todayPanel,
        sch.error
          ? h(
              "section",
              { class: "panel admin-panel" },
              h("p", { class: "admin-error", role: "alert" }, T().admScheduleLoadFailed(sch.error)),
              h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => void loadSchedule() }, T().admRetry),
            )
          : h("p", { class: "muted admin-loading" }, T().admLoading),
      );
      return;
    }
    const draft = sch.draft;
    const month = sch.month ?? monthOf(state.today?.date ?? null);
    sch.month = month;
    const dirty = scheduleDirty();
    const tzValid = isValidTimeZone(draft.timezone);

    const defaultSelect = h("select", { class: "admin-input", id: "sched-default" }, caseOptions(draft.defaultCaseId, T().admNoneOpt));
    defaultSelect.addEventListener("change", () => {
      const v = defaultSelect.value;
      updateDraft((d) => {
        d.defaultCaseId = v === "" ? null : v;
      });
    });

    const tzListId = "sched-tz-list";
    const tzInput = h("input", {
      type: "text",
      class: "admin-input",
      id: "sched-tz",
      list: tzListId,
      value: draft.timezone,
      placeholder: DEFAULT_TIMEZONE,
      autocomplete: "off",
      spellcheck: "false",
      dir: "ltr",
      "aria-invalid": tzValid ? undefined : "true",
      "aria-describedby": "sched-tz-help",
    });
    tzInput.addEventListener("change", () => {
      const v = tzInput.value.trim();
      updateDraft((d) => {
        d.timezone = v === "" ? DEFAULT_TIMEZONE : v;
      });
    });
    const tzList = h("datalist", { id: tzListId }, timeZoneList().map((z) => h("option", { value: z })));

    const lockInput = h("input", { type: "checkbox", id: "sched-lock", checked: draft.lockToToday, "aria-describedby": "sched-lock-help" });
    lockInput.addEventListener("change", () => {
      const v = lockInput.checked;
      updateDraft((d) => {
        d.lockToToday = v;
      });
    });

    const saveBtn = h(
      "button",
      { type: "button", class: "btn btn-primary", id: "sched-save", disabled: !dirty || sch.saving || !tzValid },
      sch.saving ? T().admSaving : T().admSaveSchedule,
    );
    saveBtn.addEventListener("click", () => void onSaveSchedule());
    const discardBtn = h(
      "button",
      { type: "button", class: "btn btn-ghost", id: "sched-discard", disabled: !dirty || sch.saving },
      T().admDiscard,
    );
    discardBtn.addEventListener("click", () => {
      if (!sch.server) return;
      sch.draft = cloneSchedule(sch.server);
      sch.msg = null;
      sch.error = null;
      renderSchedule();
    });

    const entries = Object.keys(draft.days).length;
    setChildren(
      panel,
      todayPanel,
      h(
        "section",
        { class: "panel admin-panel" },
        h("h2", { class: "admin-h2" }, T().admScheduleSettings),
        h(
          "div",
          { class: "sched-form" },
          h(
            "div",
            { class: "sched-field" },
            h("label", { class: "admin-label", for: "sched-default" }, T().admDefaultCase),
            defaultSelect,
            h("p", { class: "muted small" }, T().admDefaultCaseHelp),
          ),
          h(
            "div",
            { class: "sched-field" },
            h("label", { class: "admin-label", for: "sched-tz" }, T().admTimezone),
            tzInput,
            tzList,
            h("p", { class: tzValid ? "muted small" : "small sched-invalid", id: "sched-tz-help" }, tzValid ? T().admTimezoneHelp : T().admTimezoneInvalid),
          ),
          h(
            "div",
            { class: "sched-field sched-lock" },
            h("label", { class: "sched-check", for: "sched-lock" }, lockInput, h("span", {}, T().admLockToday)),
            h("p", { class: "muted small", id: "sched-lock-help" }, T().admLockHelp),
          ),
        ),
      ),
      calendar(draft, month),
      h(
        "div",
        { class: "sched-actions panel admin-panel" },
        saveBtn,
        discardBtn,
        h("span", { class: `small ${dirty ? "sched-dirty" : "muted"}`, role: "status" }, dirty ? T().admUnsaved : sch.msg ?? T().admScheduledDays(entries)),
        sch.error ? h("p", { class: "admin-error", role: "alert" }, T().admScheduleSaveFailed(sch.error)) : null,
      ),
    );
  }

  // =====================================================================================
  // Stats tab
  // =====================================================================================

  const statsBoardEl = h("div", { class: "admin-table-wrap" });
  const statsCasesEl = h("div", { class: "stats-cases" });

  function buildStatsPanel(): void {
    setChildren(
      tabPanels.get("stats") ?? container,
      h("section", { class: "panel admin-panel" }, h("h2", { class: "admin-h2" }, T().admTop10), statsBoardEl),
      statsCasesEl,
    );
  }

  function renderStatsBoard(): void {
    const top = topPlayers(state.accounts?.accounts ?? [], 10);
    if (top.length === 0) {
      setChildren(statsBoardEl, h("p", { class: "muted admin-empty-small" }, T().admNoPlayersBoard));
      return;
    }
    setChildren(
      statsBoardEl,
      h(
        "table",
        { class: "admin-table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            th(T().admColRank, "num"),
            th(T().admColUser),
            th(T().admColScore, "num"),
            th(T().admColCompleted, "num"),
            th(T().admColAccuracy, "num"),
            th(T().admColHints, "num"),
          ),
        ),
        h(
          "tbody",
          {},
          top.map((a) =>
            h(
              "tr",
              { class: a.rank === 1 ? "is-first" : "" },
              h("td", { class: "num" }, `#${a.rank ?? "—"}`),
              h("td", { class: "col-name" }, h("span", { class: "player-name" }, a.username)),
              h("td", { class: "num col-score" }, String(a.totalScore)),
              h("td", { class: "num" }, String(a.casesCompleted)),
              h("td", { class: "num" }, formatPct(a.accuracy)),
              h("td", { class: "num" }, String(a.hintsUsed)),
            ),
          ),
        ),
      ),
    );
  }

  function caseSummaryPanel(s: CaseSummary): HTMLElement {
    const maxScore = s.maxScore > 0 ? s.maxScore : caseMaxScore(s.caseId);
    const title = getCase(s.caseId)?.title ?? s.title;
    const hardest = hardestQuestion(s);
    const isToday = state.today?.caseId === s.caseId;
    const children: Child[] = [
      h(
        "div",
        { class: "stats-case-head" },
        h("h2", { class: "admin-h2" }, title),
        isToday ? h("span", { class: "today-tag" }, T().admTodayTag) : null,
        h("code", { class: "muted small" }, s.caseId),
      ),
      h(
        "div",
        { class: "admin-tiles admin-tiles-sm" },
        tile(T().admPlayers, String(s.players)),
        tile(T().admFinished, String(s.completed), s.players ? `${Math.round((s.completed / s.players) * 100)}%` : undefined),
        tile(T().admAvgScore, s.avgScore === null ? "—" : String(Math.round(s.avgScore)), maxScore ? T().admOf(maxScore) : undefined),
        tile(T().admAvgTime, s.avgDurationSeconds === null ? "—" : formatSeconds(Math.round(s.avgDurationSeconds)), T().admFinishedPlayers),
      ),
    ];
    if (s.players === 0) {
      children.push(h("p", { class: "muted admin-empty-small" }, T().admNobodyPlayed));
    } else {
      children.push(
        h(
          "div",
          { class: "admin-table-wrap" },
          h(
            "table",
            { class: "admin-table stats-q-table" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                th(T().admColQuestion),
                th(T().admColSolved, "num"),
                th(T().admColRevealed, "num"),
                th(T().admColAvgWrong, "num"),
                th(T().admColAvgHints, "num"),
              ),
            ),
            h(
              "tbody",
              {},
              caseQuestionIds(s.caseId).map((q) => {
                const qs = s.questions[q];
                const isHardest = q === hardest;
                return h(
                  "tr",
                  { class: isHardest ? "is-hardest" : "" },
                  h(
                    "td",
                    {},
                    h("span", { class: "q-id" }, q.toUpperCase()),
                    " ",
                    questionTitle(s.caseId, q),
                    isHardest ? h("span", { class: "hardest-badge", title: T().admHardestTip }, T().admHardest) : null,
                  ),
                  h("td", { class: "num" }, qs ? String(qs.solved) : "—"),
                  h("td", { class: "num" }, qs ? String(qs.revealed) : "—"),
                  h("td", { class: "num" }, qs ? qs.avgWrong.toFixed(1) : "—"),
                  h("td", { class: "num" }, qs ? qs.avgHints.toFixed(1) : "—"),
                );
              }),
            ),
          ),
        ),
      );
    }
    return h("section", { class: "panel admin-panel stats-case" }, children);
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
    const ordered = [...stats.cases].sort((a, b) => Number(b.caseId === todayId) - Number(a.caseId === todayId) || b.players - a.players);
    setChildren(statsCasesEl, ordered.map(caseSummaryPanel));
  }

  // =====================================================================================
  // Projector leaderboard (overall, from accounts)
  // =====================================================================================

  function renderLeaderboard(): void {
    leaderboardEl.hidden = !state.leaderboard;
    document.documentElement.classList.toggle("admin-board-open", state.leaderboard);
    if (!state.leaderboard) {
      leaderboardEl.replaceChildren();
      boardBtn.focus();
      return;
    }
    const top = topPlayers(state.accounts?.accounts ?? [], 10);
    const close = h(
      "button",
      {
        type: "button",
        class: "btn btn-ghost admin-board-close",
        onclick: () => {
          state.leaderboard = false;
          renderLeaderboard();
        },
      },
      T().admClose,
    );
    setChildren(
      leaderboardEl,
      h(
        "div",
        { class: "admin-board-inner" },
        h("div", { class: "admin-board-head" }, h("h2", { class: "admin-board-title" }, T().admLeaderboard), close),
        top.length === 0
          ? h("p", { class: "muted admin-board-empty" }, T().admNoPlayersBoard)
          : h(
              "ol",
              { class: "admin-board-list" },
              top.map((a) =>
                h(
                  "li",
                  { class: `admin-board-row rank-${a.rank ?? 0}` },
                  h("span", { class: "board-rank" }, String(a.rank ?? "—")),
                  h("span", { class: "board-name" }, a.username),
                  h("span", { class: "board-time muted" }, T().admCasesDone(a.casesCompleted)),
                  h("span", { class: "board-score" }, String(a.totalScore)),
                ),
              ),
            ),
      ),
    );
    if (document.activeElement === boardBtn || !leaderboardEl.contains(document.activeElement)) close.focus();
  }

  // ---- render dispatch ------------------------------------------------------------------

  function renderActiveTab(): void {
    switch (state.tab) {
      case "accounts":
        renderAccounts();
        break;
      case "live":
        renderLive();
        break;
      case "schedule":
        renderSchedule();
        break;
      case "stats":
        renderStats();
        break;
    }
  }

  function renderData(): void {
    // The pending count is visible on the tab from anywhere.
    if (state.tab !== "accounts") renderPending(state.accounts?.accounts ?? []);
    if (state.tab === "schedule") renderScheduleToday(); // keep the editor (and focus) intact while polling
    else renderActiveTab();
    if (state.leaderboard) renderLeaderboard();
    renderUpdated();
    renderBanner();
  }

  // ---- data loading ----------------------------------------------------------------------

  function ensureLiveCase(): void {
    if (state.liveCaseId || !state.today) return;
    state.liveCaseId = state.today.caseId ?? state.today.releasedCaseIds[0] ?? null;
  }

  async function load(): Promise<void> {
    if (disposed) return;
    if (state.loading) {
      state.queued = true;
      return;
    }
    const key = getAdminKey();
    if (!key) return showLogin(null);
    state.loading = true;
    state.queued = false;
    const tab = state.tab;
    const liveCase = state.liveCaseId;
    try {
      const [accounts, today, progress, stats] = await Promise.all([
        fetchAccounts(key),
        fetchToday(),
        tab === "live" && liveCase ? fetchProgress(key, liveCase) : Promise.resolve(null),
        tab === "stats" ? fetchCaseStats(key) : Promise.resolve(null),
      ]);
      if (disposed) return;
      state.accounts = accounts;
      state.today = today;
      if (progress && progress.caseId === state.liveCaseId) state.progress = progress;
      if (stats) state.stats = stats;
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
    const key = getAdminKey();
    if (!key) return showLogin(null);
    try {
      const [accounts, today] = await Promise.all([fetchAccounts(key), fetchToday()]);
      if (disposed) return;
      state.accounts = accounts;
      state.today = today;
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
    stopTimers();
    renderData();
    renderActiveTab();
    if (state.tab === "schedule") void loadSchedule();
    // Live and Stats need a second request (progress / stats) before they have data.
    if (state.tab === "live" || state.tab === "stats") void load();
    else scheduleNext();
    tickId = window.setInterval(() => {
      if (!container.isConnected) return dispose();
      renderUpdated();
    }, 1000);
  }

  if (getAdminKey()) {
    setChildren(container, h("p", { class: "muted admin-loading" }, T().admLoadingDashboard));
    void start();
  } else {
    showLogin(null);
  }
}
