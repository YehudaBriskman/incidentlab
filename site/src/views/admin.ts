// Instructor dashboard (#/admin). All API data (usernames above all) is rendered via textContent / attributes only — never innerHTML.
// Tabs: Accounts (approve sign-ups, per-user stats, invite code, CSV) · Live (one case, polled) · Event (window, freeze,
// announcement) · Schedule (incident of the day) · Stats (per case) · Audit log.
// Auth: the `admin` session cookie (signed in on #/login with the ADMIN_KEY) or an admin key typed into the gate.
import "../admin.css";
import { T } from "../i18n/strings-tools";
import { getLang } from "../i18n/i18n";
import {
  QUESTION_ORDER,
  TRASH_RETENTION_DAYS,
  type AccountStatus,
  type AdminProgress,
  type AuditEntry,
  type CaseStats,
  type CaseSummary,
  type LeaderboardResponse,
  type LiveEvent,
  type QuestionId,
  type Schedule,
  type ScoreBreakdown,
  type Settings,
  type StageStatus,
  type TodayResponse,
  type TrashEntry,
  type UserStats,
} from "../../shared/contract";
import { cachedCase } from "../content/load";
import { copyButton, h, setChildren, type Child } from "../lib/dom";
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
  setAccountStatus,
  setAdminKey,
  type AdminAccountsResult,
  type AdminEventResult,
  type AdminProgressResult,
  type AdminStatsResult,
} from "../lib/admin-api";

const POLL_MS = 5000;
const MAX_BACKOFF_MS = 60000;
const STUCK_WARN_MIN = 8;
const STUCK_ALERT_MIN = 15;
const TAB_STORAGE = "il.adminTab";
const DEFAULT_TIMEZONE = "Asia/Jerusalem";

type TabId = "accounts" | "live" | "event" | "schedule" | "stats" | "audit";
const TABS: readonly TabId[] = ["accounts", "live", "event", "schedule", "stats", "audit"];
const isTabId = (v: string | null): v is TabId => TABS.some((t) => t === v);
const AUDIT_LIMIT = 100;
const EVENT_QUICK_MINUTES = 60;
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L: easy to read aloud and type

type StageKey = "setup" | QuestionId;
type LiveSortKey = "score" | "progress" | "name" | "stuck";
type AcctSortKey = "rank" | "newest" | "seen" | "name";
type AcctFilter = "all" | AccountStatus;
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

// ---- content lookups (titles come from the case content, all loaded before this view renders; ids from the server) ----

const QUESTION_IDS: ReadonlySet<string> = new Set<string>(QUESTION_ORDER);
const isQuestionId = (id: string): id is QuestionId => QUESTION_IDS.has(id);

function caseTitle(caseId: string): string {
  return cachedCase(caseId)?.title ?? caseId;
}

function caseQuestionIds(caseId: string): QuestionId[] {
  const c = cachedCase(caseId);
  const ids = c ? c.questions.map((q) => q.id).filter(isQuestionId) : [];
  return ids.length > 0 ? ids : [...QUESTION_ORDER];
}

function questionTitle(caseId: string, q: QuestionId): string {
  return cachedCase(caseId)?.questions.find((x) => x.id === q)?.title ?? "";
}

function caseMaxScore(caseId: string): number | null {
  const c = cachedCase(caseId);
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

/** "in 6 days" / "בעוד 6 ימים" for a future instant (localized by Intl). */
function relativeIn(iso: string | null, now: number): string {
  const t = ms(iso);
  if (t === null) return "—";
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  const diffMin = Math.max(0, Math.round((t - now) / 60000));
  if (diffMin >= 24 * 60) return rtf.format(Math.round(diffMin / (24 * 60)), "day");
  if (diffMin >= 60) return rtf.format(Math.round(diffMin / 60), "hour");
  return rtf.format(diffMin, "minute");
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
  const lines = [
    `${stage.toUpperCase()} ${title}: ${T().admStatus(status)}`,
    T().admWrongAttempts(sp.wrongAttempts),
    T().admHintsUsed(sp.hintsRevealed),
    T().admCommandsUsed(sp.commandsRevealed),
    T().admTime(spent),
  ];
  if (status === "solved") {
    lines.push(T().admPoints(sp.points));
    if (sp.breakdown) lines.push(...breakdownLines(sp.breakdown).map((l) => `  ${l}`));
  }
  return lines.join("\n");
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

const cloneSchedule = (s: Schedule): Schedule => ({ ...s, days: { ...s.days } });

function scheduleSig(s: Schedule): string {
  const days = Object.entries(s.days).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([s.timezone, s.defaultCaseId, s.lockToToday, days]);
}

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

// ---- scoring breakdown -------------------------------------------------------------------

const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");

function breakdownLines(b: ScoreBreakdown): string[] {
  const lines = [`${T().admBdBase} ${b.base}`];
  if (b.hints) lines.push(`${T().admBdHints} ${signed(b.hints)}`);
  if (b.commands) lines.push(`${T().admBdCommands} ${signed(b.commands)}`);
  if (b.wrong) lines.push(`${T().admBdWrong} ${signed(b.wrong)}`);
  if (b.time) lines.push(`${T().admBdTime} ${signed(b.time)}`);
  if (b.clean) lines.push(`${T().admBdClean} ${signed(b.clean)}`);
  if (b.firstBlood) lines.push(`${T().admBdFirstBlood} ${signed(b.firstBlood)}`);
  lines.push(`${T().admBdTotal} ${b.total}`);
  lines.push(T().admBdSolve(formatSeconds(b.solveSeconds), formatSeconds(b.targetSeconds)));
  return lines;
}

/** Commands paid for on this case (summed over stages, like the server's UserStats). */
function commandsUsed(p: AdminProgress): number {
  return QUESTION_ORDER.reduce((sum, q) => sum + (p.stages[q]?.commandsRevealed ?? 0), 0);
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

/**
 * The live dashboard. The router re-runs on every hash change (it runs before any listener registered here), so a
 * Back/Forward between tabs (#/admin?tab=…) calls renderAdmin again: we re-attach the same instance instead of
 * rebuilding it, which keeps drafts, focus and data. Only a language switch rebuilds (with the drafts carried over).
 */
type AdminInstance = {
  container: HTMLElement;
  lang: string;
  alive: () => boolean;
  reattach: () => void;
  dirtyDrafts: () => { schedule: Schedule | null; event: LiveEvent | null };
};
let activeInstance: AdminInstance | null = null;

export function renderAdmin(root: HTMLElement): void {
  const prev = activeInstance;
  if (prev && prev.alive()) {
    if (isAdminHash(location.hash) && prev.lang === getLang()) {
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
    // live tab
    liveSort: "score" as LiveSortKey,
    liveFilter: "",
    // accounts tab
    acctSort: "rank" as AcctSortKey,
    acctFilter: "all" as AcctFilter,
    acctSearch: "",
    expanded: new Set<string>(),
    tempPassword: null as { username: string; password: string } | null,
    approvedMsg: null as string | null,
    exporting: false,
    // live tab: players whose score breakdown is open
    liveExpanded: new Set<string>(),
    // shared: in-flight row actions
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
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("click", onDocClick, { capture: true });
    document.documentElement.classList.remove("admin-board-open", "admin-savebar-open");
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
    if (scheduleDirty()) parts.push(T().admSecSchedule);
    if (eventDirty()) parts.push(T().admSecEvent);
    return parts.join(" + ");
  }

  /**
   * Runs after the router (which registered first). Leaving #/admin with unsaved edits asks; staying puts the
   * old URL back and re-runs the route, which re-attaches this same instance (drafts intact).
   */
  function onHashChange(): void {
    if (disposed || isAdminHash(location.hash)) return; // inside #/admin: renderAdmin re-attaches us
    const dirty = dirtySections();
    if (dirty !== "" && !leaveConfirmed && !window.confirm(T().admLeaveConfirm(dirty))) {
      history.replaceState(history.state, "", shownUrl);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
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
    if (dirty === "") return;
    if (window.confirm(T().admLeaveConfirm(dirty))) {
      leaveConfirmed = true;
      window.setTimeout(() => (leaveConfirmed = false), 1000); // the link may not change the hash after all
    } else {
      e.preventDefault();
    }
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
    lang: getLang(),
    alive: () => !disposed,
    reattach: () => {
      if (state.accounts) applyUrlState();
      if (lastFocused && lastFocused.isConnected) lastFocused.focus({ preventScroll: true });
    },
    dirtyDrafts: () => ({ schedule: scheduleDirty() ? state.schedule.draft : null, event: eventDirty() ? state.event.draft : null }),
  };
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape" && state.leaderboard && !pwDialog.open && !confirmDialog.open) {
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
    if (scheduleDirty() || eventDirty()) e.preventDefault();
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
      if (overlap > 0) window.scrollBy({ top: overlap });
    });
  }
  window.addEventListener("hashchange", onHashChange);
  document.addEventListener("click", onDocClick, { capture: true });
  window.addEventListener("beforeunload", onBeforeUnload);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("focusin", onFocusIn);

  // ---- login ---------------------------------------------------------------------

  function showLogin(error: string | null): void {
    stopTimers();
    state.accounts = null;
    state.auth = null;
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

  /**
   * Leaving the Schedule or Event tab with unsaved edits asks first; confirming discards the draft.
   * Returns false when the instructor chose to stay.
   */
  function selectTab(tab: TabId, opts: { fromUrl?: boolean } = {}): boolean {
    if (tab === state.tab) return true;
    const leaving = state.tab;
    const dirty = leaving === "schedule" ? scheduleDirty() : leaving === "event" ? eventDirty() : false;
    if (dirty) {
      if (!window.confirm(T().admLeaveConfirm(leaving === "schedule" ? T().admSecSchedule : T().admSecEvent))) return false;
      if (leaving === "schedule") discardSchedule();
      else discardEvent();
    }
    state.tab = tab;
    storeTab(tab);
    if (!opts.fromUrl) setUrl(adminHash(tab, state.liveCaseId), "push");
    syncTabs();
    syncSaveBarClass();
    renderActiveTab();
    if (tab === "schedule" && !state.schedule.draft) void loadSchedule();
    if (tab === "event" && !state.event.draft) void loadEvent();
    void load();
    return true;
  }

  /** The sticky save bar is visible on the active tab: leave room for it when the browser scrolls focus into view. */
  function syncSaveBarClass(): void {
    const open =
      (state.tab === "schedule" && scheduleBarVisible()) || (state.tab === "event" && eventBarVisible());
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
        h(
          "div",
          { class: "admin-head-actions" },
          state.auth === "session" ? h("span", { class: "admin-session-tag" }, T().admSignedInAsAdmin) : null,
          updatedEl,
          pauseBtn,
          refreshBtn,
          boardBtn,
          logoutBtn,
        ),
      ),
      tabList,
      bannerEl,
      [...tabPanels.values()],
      leaderboardEl,
      pwDialog,
      confirmDialog,
    );
    buildAccountsPanel();
    buildLivePanel();
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

  // ---- confirm dialog (native modal <dialog>: focus trap, Esc = cancel) ---------------------
  // The title names the target and the action, the button repeats it ("Delete dana_k"), focus starts on the
  // safe choice, and only destructive actions are red.

  const confirmDialog = h("dialog", { class: "admin-dialog admin-confirm", "aria-labelledby": "admin-confirm-title", "aria-describedby": "admin-confirm-body" });
  let confirmBusy = false;
  confirmDialog.addEventListener("cancel", (e) => {
    // Esc while the action is running would hide its outcome.
    if (confirmBusy) e.preventDefault();
  });

  function askConfirm(opts: {
    title: string;
    body: string;
    note?: string;
    confirmLabel: string;
    cancelLabel?: string;
    busyLabel?: string;
    tone: "danger" | "primary";
    /** runs while the dialog stays open (button shows busyLabel); an error closes it and shows the banner */
    run?: () => Promise<void>;
    /** where focus goes after the dialog closes (the trigger may have been re-rendered meanwhile) */
    returnFocus?: () => HTMLElement | null;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        confirmBusy = false;
        if (confirmDialog.open) confirmDialog.close();
        confirmDialog.replaceChildren();
        resolve(ok);
        const target = opts.returnFocus?.() ?? null;
        if (target && target.isConnected) target.focus();
      };
      const cancel = h("button", { type: "button", class: "btn btn-ghost", "data-confirm-cancel": "" }, opts.cancelLabel ?? T().admCancel);
      const yes = h(
        "button",
        { type: "button", class: `btn ${opts.tone === "danger" ? "btn-danger" : "btn-primary"}`, "data-confirm-ok": "" },
        opts.confirmLabel,
      );
      cancel.addEventListener("click", () => finish(false));
      yes.addEventListener("click", () => {
        const run = opts.run;
        if (!run) return finish(true);
        confirmBusy = true;
        yes.disabled = true;
        cancel.disabled = true;
        yes.textContent = opts.busyLabel ?? opts.confirmLabel;
        run()
          .then(() => finish(true))
          .catch((err: unknown) => {
            finish(false);
            showActionError(err);
          });
      });
      confirmDialog.onclose = () => {
        if (!confirmDialog.open) finish(false); // Esc; a stale close event from an earlier dialog finds it open again
      };
      setChildren(
        confirmDialog,
        h("h2", { class: "admin-h2", id: "admin-confirm-title" }, opts.title),
        h("p", { id: "admin-confirm-body" }, opts.body),
        opts.note ? h("p", { class: "muted small" }, opts.note) : null,
        h("div", { class: "admin-dialog-actions" }, cancel, yes),
      );
      if (!confirmDialog.open) confirmDialog.showModal();
      cancel.focus();
    });
  }

  /** A row button that opens a confirm; `key` finds it again after a re-render (focus return). */
  function rowAction(label: string, ariaLabel: string, key: string, cls: string, open: () => Promise<boolean>): HTMLButtonElement {
    return h("button", { type: "button", class: cls, "aria-label": ariaLabel, "data-action": key, onclick: () => void open() }, label);
  }
  const rowActionEl = (key: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-action="${CSS.escape(key)}"]`);

  // =====================================================================================
  // Accounts tab
  // =====================================================================================

  const acctTilesEl = h("div", { class: "admin-tiles" });
  const pendingEl = h("div", { class: "pending-wrap" });
  const approveAllEl = h("div", { class: "pending-approve-all" });
  const pendingStatusEl = h("p", { class: "muted small pending-status", role: "status" });
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

  const ACCT_COLS = 14;
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
        th(T().admColCommands, "num"),
        th(T().admColBadges, "num"),
        th(T().admColStreak, "num"),
        h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, T().admColActions)),
      ),
    ),
    acctTbody,
  );
  const acctRowCache = new Map<string, RowEntry>();

  // ---- CSV export ----
  const exportBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", title: T().admExportHint }, T().admExportCsv);
  exportBtn.addEventListener("click", () => void exportCsv());

  async function exportCsv(): Promise<void> {
    if (state.exporting) return;
    state.exporting = true;
    exportBtn.disabled = true;
    exportBtn.textContent = T().admExporting;
    try {
      const { blob, filename } = await fetchExportCsv();
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: filename, hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err: unknown) {
      if (!handleAuthError(err)) {
        state.banner = T().admExportFailed(errMessage(err));
        renderBanner();
      }
    } finally {
      state.exporting = false;
      exportBtn.disabled = false;
      exportBtn.textContent = T().admExportCsv;
    }
  }

  // ---- one-time temporary password (native modal dialog: focus trap + Esc for free) ----
  const pwDialog = h("dialog", { class: "admin-dialog", "aria-labelledby": "admin-pw-title" });
  pwDialog.addEventListener("close", () => {
    // The password is shown once: drop it from the DOM and from memory.
    state.tempPassword = null;
    pwDialog.replaceChildren();
  });

  function showTempPassword(username: string, password: string): void {
    state.tempPassword = { username, password };
    const done = h("button", { type: "button", class: "btn btn-primary", onclick: () => pwDialog.close() }, T().admDone);
    setChildren(
      pwDialog,
      h("h2", { class: "admin-h2", id: "admin-pw-title" }, T().admTempPwTitle(username)),
      h("p", { class: "muted" }, T().admTempPwHelp),
      h("div", { class: "admin-share admin-pw" }, h("code", { class: "admin-share-url admin-pw-value" }, password), copyButton(() => password, T().admCopyPassword)),
      h("div", { class: "admin-dialog-actions" }, done),
    );
    if (!pwDialog.open) pwDialog.showModal();
    done.focus();
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
    "aria-describedby": "admin-invite-help",
  });
  inviteInput.addEventListener("input", () => {
    state.settings.input = inviteInput.value;
    state.settings.msg = null;
    state.settings.error = null;
    renderInvite();
  });
  const inviteSetBtn = h("button", { type: "submit", class: "btn btn-primary btn-sm" }, T().admInviteSave);
  const inviteGenBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admInviteGenerate);
  const inviteClearBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admInviteClear);
  const inviteMsgEl = h("p", { class: "small invite-msg", role: "status" });
  const inviteForm = h(
    "form",
    { class: "invite-form" },
    h("label", { class: "admin-label", for: "admin-invite" }, T().admInviteInputLabel),
    h("div", { class: "invite-row" }, inviteInput, inviteSetBtn, inviteGenBtn, inviteClearBtn),
  );
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
  inviteClearBtn.addEventListener("click", () => void storeInvite(null));

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
    const trimmed = st.input.trim();
    inviteSetBtn.disabled = st.saving || trimmed === "";
    inviteGenBtn.disabled = st.saving;
    inviteClearBtn.disabled = st.saving || code === null;
    inviteInput.setAttribute("aria-invalid", st.error !== null && st.error === T().admInviteInvalid ? "true" : "false");
    inviteMsgEl.textContent = st.error ?? st.msg ?? "";
    inviteMsgEl.className = `small invite-msg${st.error ? " sched-invalid" : ""}`;
    inviteMsgEl.hidden = !st.error && !st.msg;
  }

  // ---- recently deleted (trash): deleted accounts and reset case progress, restorable for a few days ----
  const trashBodyEl = h("div", { class: "admin-table-wrap" });
  const trashMsgEl = h("p", { class: "small trash-msg", role: "status", hidden: true });
  let trashSig = "";

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
    setChildren(
      trashBodyEl,
      h(
        "table",
        { class: "admin-table trash-table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            th(T().admColItem),
            th(T().admColDeletedAt),
            th(T().admColExpires),
            th(T().admColRecords, "num"),
            h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, T().admColActions)),
          ),
        ),
        h(
          "tbody",
          {},
          t.entries.map((e) => {
            const busy = t.busy.has(e.id);
            return h(
              "tr",
              {},
              h("td", { class: "trash-label" }, h("span", { dir: "auto" }, e.label)),
              h("td", { class: "col-seen", title: e.deletedAt }, formatDateTime(e.deletedAt)),
              h("td", { class: "col-seen", title: formatDateTime(e.expiresAt) }, relativeIn(e.expiresAt, now)),
              h("td", { class: "num" }, String(e.records)),
              h(
                "td",
                { class: "col-actions" },
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn-ghost btn-sm",
                    disabled: busy,
                    "aria-label": T().admRestoreLabel(e.label),
                    onclick: () => void restoreEntry(e),
                  },
                  busy ? T().admRestoring : T().admRestore,
                ),
              ),
            );
          }),
        ),
      ),
    );
  }

  function buildAccountsPanel(): void {
    setChildren(
      tabPanels.get("accounts") ?? container,
      acctTilesEl,
      h(
        "section",
        { class: "panel admin-panel pending-panel" },
        h("div", { class: "admin-table-head" }, h("h2", { class: "admin-h2" }, T().admPendingTitle, " ", pendingCountEl), approveAllEl),
        pendingStatusEl,
        pendingEl,
      ),
      h(
        "section",
        { class: "panel admin-panel" },
        h(
          "div",
          { class: "admin-table-head" },
          h("h2", { class: "admin-h2" }, T().admAccountsTitle, " ", acctCountEl),
          h("div", { class: "admin-controls" }, acctSearchInput, acctFilterSelect, acctSortSelect, exportBtn),
        ),
        h("p", { class: "muted small admin-hint" }, T().admAccountsHint),
        acctTableEl,
      ),
      h(
        "section",
        { class: "panel admin-panel trash-panel", "aria-labelledby": "admin-trash-title" },
        h("h2", { class: "admin-h2", id: "admin-trash-title" }, T().admTrashTitle),
        h("p", { class: "muted small admin-hint" }, T().admTrashHelp(TRASH_RETENTION_DAYS)),
        trashMsgEl,
        trashBodyEl,
      ),
      h(
        "section",
        { class: "panel admin-panel invite-panel" },
        h("h2", { class: "admin-h2" }, T().admInviteTitle),
        h("p", { class: "muted small admin-hint", id: "admin-invite-help" }, T().admInviteHelp),
        inviteCurrentEl,
        inviteForm,
        inviteMsgEl,
      ),
    );
    renderInvite();
  }

  async function changeStatus(account: UserStats, action: "approve" | "reject"): Promise<void> {
    const busyKey = `status:${account.accountId}`;
    state.busy.add(busyKey);
    renderAccounts();
    try {
      const updated = await setAccountStatus(account.accountId, action);
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
            "aria-label": a.status === "approved" ? T().admRevokeLabel(a.username) : T().admRejectLabel(a.username),
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
    pendingStatusEl.textContent = state.approvedMsg ?? "";
    pendingStatusEl.hidden = state.approvedMsg === null;
    // Rebuild only when something visible changed, so focus on Approve/Reject survives polling.
    const sig = [
      getLang(),
      ...pending.map((a) => `${a.accountId}:${a.username}:${state.busy.has(`status:${a.accountId}`) ? 1 : 0}`),
    ].join("|");
    if (sig === pendingSig) return;
    pendingSig = sig;
    if (pending.length === 0) {
      approveAllEl.replaceChildren();
      setChildren(pendingEl, h("p", { class: "muted admin-empty-small" }, T().admNoPending));
      return;
    }
    const n = pending.length;
    // Approving is the intended, safe action: a primary confirm, never a red one.
    setChildren(
      approveAllEl,
      h(
        "button",
        {
          type: "button",
          class: "btn btn-primary btn-sm",
          id: "admin-approve-all",
          "aria-label": T().admApproveAllLabel(n),
          onclick: () =>
            void askConfirm({
              title: T().admApproveAllTitle(n),
              body: T().admApproveAllBody,
              confirmLabel: T().admApproveAll(n),
              busyLabel: T().admApproving,
              tone: "primary",
              run: async () => {
                const approved = await approveAll();
                state.approvedMsg = T().admApprovedN(approved);
                pendingSig = "";
                void load();
              },
              returnFocus: () => document.getElementById("admin-approve-all") ?? pendingEl.querySelector("button"),
            }),
        },
        T().admApproveAll(n),
      ),
    );
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
          th(T().admColCommands, "num"),
          th(T().admColWrong, "num"),
          th(T().admColFirstBloods, "num"),
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
            h(
              "td",
              { class: "num", title: T().admScoreParTip(c.maxScore) },
              String(c.score),
              " ",
              h("span", { class: "muted small" }, `(${T().admPar(c.maxScore)})`),
            ),
            h("td", { class: "num" }, String(c.solved)),
            h("td", { class: "num" }, String(c.revealed)),
            h("td", { class: "num" }, String(c.hintsUsed)),
            h("td", { class: "num" }, String(c.commandsRevealed)),
            h("td", { class: "num" }, String(c.wrongAttempts)),
            h("td", { class: "num" }, String(c.firstBloods)),
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
      a.commandsRevealed,
      a.achievements.map((x) => x.id),
      a.streak,
      relativeAgo(a.lastSeenAt, now),
      state.expanded.has(id),
      state.expanded.has(id) ? a.cases : null,
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
      h("td", { class: "num" }, String(a.commandsRevealed)),
      h(
        "td",
        { class: "num", title: T().admBadgesTip(a.achievements.map((x) => T().admAchievement(x.id)).join(", ")) },
        String(a.achievements.length),
      ),
      h("td", { class: "num", title: T().admStreakTip(a.streak.current, a.streak.best) }, `${a.streak.current}/${a.streak.best}`),
      h(
        "td",
        { class: "col-actions" },
        h(
          "span",
          { class: "row-actions" },
          statusButtons(a, true),
          rowAction(T().admResetPw, T().admResetPwLabel(a.username), `reset-password:${a.accountId}`, "btn btn-ghost btn-sm", () =>
            askConfirm({
              title: T().admResetPwTitle(a.username),
              body: T().admResetPwBody,
              confirmLabel: T().admResetPwLabel(a.username),
              busyLabel: T().admResettingPw,
              tone: "primary",
              run: async () => {
                const password = await resetAccountPassword(a.accountId);
                showTempPassword(a.username, password);
              },
              returnFocus: () => rowActionEl(`reset-password:${a.accountId}`),
            }),
          ),
          rowAction(T().admDelete, T().admDeleteLabel(a.username), `delete:${a.accountId}`, "btn btn-ghost btn-sm btn-delete", () =>
            askConfirm({
              title: T().admDeleteTitle(a.username),
              body: T().admDeleteBody(TRASH_RETENTION_DAYS),
              confirmLabel: T().admDeleteLabel(a.username),
              cancelLabel: T().admKeepAccount,
              busyLabel: T().admDeleting,
              tone: "danger",
              run: async () => {
                await deleteAccount(a.accountId);
                state.expanded.delete(a.accountId);
                if (state.accounts) {
                  state.accounts = { ...state.accounts, accounts: state.accounts.accounts.filter((x) => x.accountId !== a.accountId) };
                }
                renderAccounts();
                void load();
              },
              returnFocus: () => acctSearchInput,
            }),
          ),
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
        h(
          "div",
          { class: "acct-detail-inner" },
          h("p", { class: "admin-label" }, T().admPerCaseTitle(a.username)),
          caseStatsTable(a.cases),
          h(
            "p",
            { class: "muted small acct-detail-meta" },
            T().admBadgesTip(a.achievements.map((x) => T().admAchievement(x.id)).join(", ")),
            " · ",
            T().admStreakTip(a.streak.current, a.streak.best),
          ),
        ),
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
    renderInvite();
    renderTrash();
    // Drop UI state for accounts that disappeared.
    const ids = new Set(all.map((a) => a.accountId));
    for (const id of state.expanded) if (!ids.has(id)) state.expanded.delete(id);
    renderAccountsTable();
  }

  // =====================================================================================
  // Live tab
  // =====================================================================================

  const liveCaseSelect = h("select", { class: "admin-input", id: "admin-live-case" });
  liveCaseSelect.addEventListener("change", () => {
    const v = liveCaseSelect.value;
    if (v) selectLiveCase(v, true);
  });

  /** Switches the Live tab to another case; the case goes into the URL (replacing the entry: not a new Back step). */
  function selectLiveCase(caseId: string, updateUrl: boolean): void {
    if (caseId === state.liveCaseId) return;
    state.liveCaseId = caseId;
    state.progress = null;
    liveRowCache.clear();
    liveTbody.replaceChildren();
    if (updateUrl && state.tab === "live") setUrl(adminHash("live", caseId), "replace");
    if (state.accounts) {
      renderLive();
      void load();
    }
  }
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
    const caseId = state.liveCaseId;
    if (!caseId || resetInput.value.trim() !== "RESET") return;
    resetBtn.disabled = true;
    resetMsg.textContent = T().admResetting;
    resetProgress(caseId)
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
        th(T().admColCommands, "num"),
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
      // Averaged over every player on the case (Stats averages finishers only): the label says which.
      tile(
        T().admAvgScoreAll,
        avg === null ? "—" : String(avg),
        [maxScore ? T().admPar(maxScore) : null, T().admSample(players.length)].filter((x) => x !== null).join(" · "),
      ),
      tile(T().admMedianTime, med === null ? "—" : formatDuration(med), `${T().admFinishedPlayers} · ${T().admSample(finished.length)}`),
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
      commandsUsed(p),
      state.liveExpanded.has(id) ? JSON.stringify(p.stages) : "",
    ].join("|");
  }

  const LIVE_COLS = 7;

  /** Per-stage scoring for one player (the same numbers as the cell tooltips, reachable by keyboard and touch). */
  function breakdownTable(p: AdminProgress): HTMLElement {
    const num = (n: number | undefined): string => (n === undefined ? "—" : signed(n));
    return h(
      "table",
      { class: "admin-table admin-subtable" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          th(T().admColStageShort),
          th(T().admColStatus),
          th(T().admBdBase, "num"),
          th(T().admBdHints, "num"),
          th(T().admBdCommands, "num"),
          th(T().admBdWrong, "num"),
          th(T().admBdTime, "num"),
          th(T().admBdClean, "num"),
          th(T().admBdFirstBlood, "num"),
          th(T().admBdTotal, "num"),
          th(T().admColSolveTime, "num"),
        ),
      ),
      h(
        "tbody",
        {},
        caseQuestionIds(p.caseId).map((q) => {
          const sp = p.stages[q];
          const b = sp?.status === "solved" ? sp.breakdown : null;
          return h(
            "tr",
            {},
            h("td", {}, h("span", { class: "q-id" }, q.toUpperCase()), " ", questionTitle(p.caseId, q)),
            h("td", {}, h("span", { class: `case-status is-${sp?.status ?? "locked"}` }, T().admStatus(sp?.status ?? "locked"))),
            h("td", { class: "num" }, b ? String(b.base) : "—"),
            h("td", { class: "num" }, num(b?.hints)),
            h("td", { class: "num", title: T().admCommandsUsed(sp?.commandsRevealed ?? 0) }, num(b?.commands)),
            h("td", { class: "num" }, num(b?.wrong)),
            h("td", { class: "num" }, num(b?.time)),
            h("td", { class: "num" }, num(b?.clean)),
            h("td", { class: "num" }, num(b?.firstBlood)),
            h("td", { class: "num col-score" }, b ? String(b.total) : sp?.status === "solved" ? String(sp.points) : "—"),
            h("td", { class: "num col-seen" }, b ? `${formatSeconds(b.solveSeconds)} / ${formatSeconds(b.targetSeconds)}` : "—"),
          );
        }),
      ),
    );
  }

  function buildLiveRows(p: AdminProgress, stages: readonly StageKey[], now: number): HTMLTableRowElement[] {
    const expanded = state.liveExpanded.has(p.accountId);
    const detailId = `live-detail-${p.accountId}`;
    const toggle = h(
      "button",
      {
        type: "button",
        class: "acct-toggle",
        "aria-expanded": String(expanded),
        "aria-controls": detailId,
        title: T().admShowBreakdown,
        onclick: () => {
          if (state.liveExpanded.has(p.accountId)) state.liveExpanded.delete(p.accountId);
          else state.liveExpanded.add(p.accountId);
          renderLiveTable();
          container.querySelector<HTMLButtonElement>(`[aria-controls="${CSS.escape(detailId)}"]`)?.focus();
        },
      },
      h("span", { class: "acct-caret", "aria-hidden": "true" }, "▸"),
      h("span", { class: "player-name" }, p.username),
    );
    const row = buildLiveRow(p, stages, now, toggle);
    if (!expanded) return [row];
    row.classList.add("is-expanded");
    const detail = h(
      "tr",
      { class: "acct-detail", id: detailId },
      h(
        "td",
        { colspan: LIVE_COLS },
        h("div", { class: "acct-detail-inner" }, h("p", { class: "admin-label" }, T().admBreakdownTitle(p.username)), breakdownTable(p)),
      ),
    );
    return [row, detail];
  }

  function buildLiveRow(p: AdminProgress, stages: readonly StageKey[], now: number, nameCell: HTMLElement): HTMLTableRowElement {
    const caseId = p.caseId;
    const cmds = commandsUsed(p);
    return h(
      "tr",
      { class: `acct-row is-${stuckLevel(p)}`, "data-id": p.accountId },
      h("td", { class: "col-name" }, nameCell),
      h("td", {}, progressCells(p, stages, now)),
      h("td", { class: "num col-score", title: T().admScoreParTip(p.maxScore) }, String(p.score)),
      h("td", { class: "num", title: T().admCommandsUsed(cmds) }, String(cmds)),
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
        rowAction(T().admRestart, T().admRestartLabel(p.username), `restart:${p.accountId}`, "btn btn-ghost btn-sm", () => {
          const solved = caseQuestionIds(caseId).filter((q) => isFinishedStatus(p.stages[q]?.status ?? "locked")).length;
          return askConfirm({
            title: T().admRestartTitle(p.username, caseTitle(caseId)),
            body: T().admRestartBody(solved, p.score),
            confirmLabel: T().admRestartLabel(p.username),
            cancelLabel: T().admKeepProgress,
            busyLabel: T().admRestarting,
            tone: "danger",
            run: async () => {
              await restartPlayerCase(p.accountId, caseId);
              void load();
            },
            returnFocus: () => rowActionEl(`restart:${p.accountId}`),
          });
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
        build: () => buildLiveRows(p, stages, now),
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
    for (const id of state.liveExpanded) if (!players.some((p) => p.accountId === id)) state.liveExpanded.delete(id);
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

  /** The save bar shows only while there is something to say: unsaved edits, an error, or a fresh "saved". */
  function scheduleBarVisible(): boolean {
    const sch = state.schedule;
    return sch.draft !== null && (scheduleDirty() || sch.error !== null || sch.msg !== null);
  }

  function discardSchedule(): void {
    const sch = state.schedule;
    if (!sch.server) return;
    sch.draft = cloneSchedule(sch.server);
    sch.msg = null;
    sch.error = null;
  }

  /** Hides a "saved" note after a moment (the bar goes away with it). */
  let savedNoteTimer: number | null = null;
  function clearSavedNoteLater(): void {
    if (savedNoteTimer !== null) window.clearTimeout(savedNoteTimer);
    savedNoteTimer = window.setTimeout(() => {
      savedNoteTimer = null;
      if (disposed) return;
      state.schedule.msg = null;
      state.event.msg = null;
      if (state.tab === "schedule") withFocusKept(renderSchedule);
      if (state.tab === "event") renderEventControls();
    }, SAVED_NOTE_MS);
  }

  async function loadSchedule(): Promise<void> {
    const sch = state.schedule;
    sch.loading = true;
    sch.error = null;
    renderSchedule();
    try {
      const s = await fetchSchedule();
      if (disposed) return;
      sch.server = cloneSchedule(s);
      // A draft carried over from the previous render (language switch) wins over the fresh copy.
      sch.draft = carry?.schedule ? cloneSchedule(carry.schedule) : cloneSchedule(s);
      if (carry) carry.schedule = null;
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
    const sch = state.schedule;
    if (!sch.draft) return;
    if (!isValidTimeZone(sch.draft.timezone)) {
      document.getElementById("sched-tz")?.focus();
      return;
    }
    sch.saving = true;
    sch.error = null;
    sch.msg = null;
    renderSchedule();
    try {
      const saved = await saveSchedule(sch.draft);
      if (disposed) return;
      sch.server = cloneSchedule(saved);
      sch.draft = cloneSchedule(saved);
      sch.msg = T().admScheduleSaved;
      clearSavedNoteLater();
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
    // Validate while typing (in place: re-rendering would move the caret); the draft updates on change.
    const tzHelp = h("p", { class: tzValid ? "muted small" : "small sched-invalid", id: "sched-tz-help" }, tzValid ? T().admTimezoneHelp : T().admTimezoneInvalid);
    tzInput.addEventListener("input", () => {
      const v = tzInput.value.trim();
      const ok = v === "" || isValidTimeZone(v);
      if (ok) tzInput.removeAttribute("aria-invalid");
      else tzInput.setAttribute("aria-invalid", "true");
      tzHelp.className = ok ? "muted small" : "small sched-invalid";
      tzHelp.textContent = ok ? T().admTimezoneHelp : T().admTimezoneInvalid;
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
      { type: "button", class: "btn btn-primary", id: "sched-save", disabled: !dirty || sch.saving },
      sch.saving ? T().admSaving : T().admSaveSchedule,
    );
    saveBtn.addEventListener("click", () => void onSaveSchedule());
    const discardBtn = h(
      "button",
      { type: "button", class: "btn btn-ghost", id: "sched-discard", disabled: !dirty || sch.saving },
      T().admDiscard,
    );
    discardBtn.addEventListener("click", () => {
      discardSchedule();
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
            tzHelp,
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
        { class: "sched-actions panel admin-panel", hidden: !scheduleBarVisible() },
        saveBtn,
        discardBtn,
        h("span", { class: `small ${dirty ? "sched-dirty" : "muted"}`, role: "status" }, dirty ? T().admUnsaved : sch.msg ?? T().admScheduledDays(entries)),
        sch.error ? h("p", { class: "admin-error", role: "alert" }, T().admScheduleSaveFailed(sch.error)) : null,
      ),
    );
    syncSaveBarClass();
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
  function eventFieldErrors(d: LiveEvent): { end: string | null; freeze: string | null; enforce: string | null } {
    const start = ms(d.startsAt);
    const end = ms(d.endsAt);
    const freeze = ms(d.freezeAt);
    return {
      end: start !== null && end !== null && end <= start ? T().admErrEndBeforeStart : null,
      freeze: freeze !== null && end !== null && freeze > end ? T().admErrFreezeAfterEnd : null,
      enforce: d.enforceWindow && (start === null || end === null) ? T().admErrEnforceNeedsWindow : null,
    };
  }

  const evStatusEl = h("p", { class: "adm-ev-status", "aria-live": "off" });
  const evClockEl = h("p", { class: "muted small adm-ev-clock" });
  const evBodyEl = h("div", { class: "admin-tabpanel adm-ev-body" });

  const evName = h("input", { type: "text", id: "ev-name", class: "admin-input", maxlength: 80, placeholder: T().admEventNamePh, autocomplete: "off" });
  const timeInput = (id: string): HTMLInputElement =>
    h("input", { type: "datetime-local", id, class: "admin-input ev-time", step: 60, dir: "ltr", "aria-describedby": "ev-tz" });
  const evStart = timeInput("ev-start");
  const evEnd = timeInput("ev-end");
  const evFreeze = timeInput("ev-freeze");
  const evEnforce = h("input", { type: "checkbox", id: "ev-enforce", "aria-describedby": "ev-enforce-help" });
  const evAnnText = h("textarea", { id: "ev-ann", class: "admin-input ev-ann", maxlength: 280, rows: 3, "aria-describedby": "ev-ann-help ev-ann-count" });
  const evAnnCount = h("span", { class: "muted small", id: "ev-ann-count" });
  const evAnnLevel = h(
    "select",
    { id: "ev-ann-level", class: "admin-input" },
    h("option", { value: "info" }, T().admLevel("info")),
    h("option", { value: "warning" }, T().admLevel("warning")),
  );
  const evAnnClear = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admAnnClear);
  const evStartNow = h("button", { type: "button", class: "btn btn-primary btn-sm" }, T().admStartNow);
  const evEndNow = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admEndNow);
  const evFreezeBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, T().admFreezeNow);
  const evSave = h("button", { type: "button", class: "btn btn-primary", id: "ev-save" }, T().admSaveEvent);
  const evDiscard = h("button", { type: "button", class: "btn btn-ghost", id: "ev-discard" }, T().admDiscard);
  const evStateEl = h("span", { class: "small", role: "status" });
  const evErrorEl = h("p", { class: "admin-error", role: "alert" });
  const evBar = h("div", { class: "sched-actions panel admin-panel" }, evSave, evDiscard, evStateEl, evErrorEl);
  const fieldError = (id: string): HTMLParagraphElement => h("p", { class: "small sched-invalid field-error", id, hidden: true });
  const evEndErr = fieldError("ev-end-err");
  const evFreezeErr = fieldError("ev-freeze-err");
  const evEnforceErr = fieldError("ev-enforce-err");
  /** Puts (or clears) an inline error under a field and wires it to the input for screen readers. */
  function setFieldError(input: HTMLInputElement, errEl: HTMLElement, baseDescribedBy: string, message: string | null): void {
    errEl.textContent = message ?? "";
    errEl.hidden = message === null;
    if (message === null) input.removeAttribute("aria-invalid");
    else input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", message === null ? baseDescribedBy : `${errEl.id} ${baseDescribedBy}`);
  }

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
  evEnforce.addEventListener("change", () => editEvent((d) => (d.enforceWindow = evEnforce.checked)));
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
    const first = errs.end ? evEnd : errs.freeze ? evFreeze : errs.enforce ? evEnforce : null;
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
  async function quickEvent(mutate: (d: LiveEvent, now: number) => void): Promise<void> {
    const ev = state.event;
    if (!ev.server || ev.saving) return;
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
      if (disposed) return;
      applyEventResult(res, false);
      const merged = cloneEvent(res.event);
      if (draftBefore) {
        // Keep each field the instructor had edited (it differs from the old saved value) and the action didn't touch.
        const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
        if (!same(draftBefore.name, base.name)) merged.name = draftBefore.name;
        if (!same(draftBefore.startsAt, base.startsAt) && same(next.startsAt, base.startsAt)) merged.startsAt = draftBefore.startsAt;
        if (!same(draftBefore.endsAt, base.endsAt) && same(next.endsAt, base.endsAt)) merged.endsAt = draftBefore.endsAt;
        if (!same(draftBefore.freezeAt, base.freezeAt) && same(next.freezeAt, base.freezeAt)) merged.freezeAt = draftBefore.freezeAt;
        if (draftBefore.enforceWindow !== base.enforceWindow) merged.enforceWindow = draftBefore.enforceWindow;
        if (!same(draftBefore.announcement, base.announcement)) merged.announcement = draftBefore.announcement ? { ...draftBefore.announcement } : null;
      }
      ev.draft = merged;
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
      body: saved.enforceWindow ? T().admEndBodyEnforced : T().admEndBodyOpen,
      note: draftNote(),
      confirmLabel: T().admEndNow,
      tone: "danger",
      returnFocus: () => evEndNow,
    }).then((ok) => {
      if (!ok) return;
      void quickEvent((d, now) => {
        d.endsAt = isoAt(now);
        const s = ms(d.startsAt);
        if ((s !== null && s >= now) || (s === null && d.enforceWindow)) d.startsAt = isoAt(now - 60_000);
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
    }).then((ok) => {
      if (!ok) return;
      void quickEvent((d, now) => {
        if (unfreeze) {
          d.freezeAt = null;
          return;
        }
        const end = ms(d.endsAt);
        d.freezeAt = end !== null && end < now ? isoAt(end) : isoAt(now);
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
    evEnforce.checked = d.enforceWindow;
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
    const errs = ev.draft ? eventFieldErrors(ev.draft) : { end: null, freeze: null, enforce: null };
    setFieldError(evEnd, evEndErr, "ev-tz", errs.end);
    setFieldError(evFreeze, evFreezeErr, "ev-tz", errs.freeze);
    setFieldError(evEnforce, evEnforceErr, "ev-enforce-help", errs.enforce);
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
    if (start !== null || end !== null) parts.push(e.enforceWindow ? T().admStatusEnforced : T().admStatusNotEnforced);
    const f = ms(e.freezeAt);
    if (f !== null) parts.push(f <= now ? T().admStatusFrozen(formatDateTime(e.freezeAt)) : T().admStatusFreezesIn(formatDuration(f - now)));
    const label = e.name.trim();
    setChildren(evStatusEl, h("span", { class: `adm-ev-dot is-${tone}`, "aria-hidden": "true" }), label ? h("strong", {}, label) : null, label ? " · " : "", parts.join(" · "));
    evClockEl.textContent = T().admServerClock(new Intl.DateTimeFormat(locale(), { timeStyle: "medium" }).format(now));
  }

  function buildEventPanel(): void {
    const tz = browserTimeZone();
    const field = (id: string, label: string, ...rest: Child[]): HTMLElement =>
      h("div", { class: "sched-field" }, h("label", { class: "admin-label", for: id }, label), rest);
    setChildren(
      evBodyEl,
      h("section", { class: "panel admin-panel" }, h("h2", { class: "admin-h2" }, T().admEventTitle), evStatusEl, evClockEl),
      h(
        "section",
        { class: "panel admin-panel" },
        h("h2", { class: "admin-h2" }, T().admQuickActions),
        h("p", { class: "muted small admin-hint" }, T().admQuickHelp),
        h("div", { class: "adm-ev-quick" }, evStartNow, evEndNow, evFreezeBtn),
      ),
      h(
        "section",
        { class: "panel admin-panel" },
        h("h2", { class: "admin-h2" }, T().admScheduleSettings),
        h(
          "div",
          { class: "sched-form adm-ev-form" },
          field("ev-name", T().admEventName, evName),
          field("ev-start", T().admStartsAt, h("div", { class: "ev-time-row" }, evStart, clearTimeBtn(evStart, T().admStartsAt, (d) => (d.startsAt = null)))),
          field(
            "ev-end",
            T().admEndsAt,
            h("div", { class: "ev-time-row" }, evEnd, clearTimeBtn(evEnd, T().admEndsAt, (d) => (d.endsAt = null))),
            evEndErr,
          ),
          field(
            "ev-freeze",
            T().admFreezeAt,
            h("div", { class: "ev-time-row" }, evFreeze, clearTimeBtn(evFreeze, T().admFreezeAt, (d) => (d.freezeAt = null))),
            evFreezeErr,
            h("p", { class: "muted small" }, T().admFreezeHelp),
          ),
          h(
            "div",
            { class: "sched-field sched-lock" },
            h("label", { class: "sched-check", for: "ev-enforce" }, evEnforce, h("span", {}, T().admEnforce)),
            evEnforceErr,
            h("p", { class: "muted small", id: "ev-enforce-help" }, T().admEnforceHelp),
          ),
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
  let auditSig = "";

  function buildAuditPanel(): void {
    setChildren(
      tabPanels.get("audit") ?? container,
      h(
        "section",
        { class: "panel admin-panel" },
        h("h2", { class: "admin-h2" }, T().admAuditTitle),
        h("p", { class: "muted small admin-hint" }, T().admAuditHint),
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
          ? h("span", { class: "player-name" }, name)
          : h("span", { class: "muted", title: e.target }, T().admUnknownAccount),
      );
    }
    if (e.detail !== null) {
      let detail = e.detail;
      if (e.action === "progress.restart" || e.action === "progress.reset") {
        detail = e.detail === "all cases" ? T().admAllCases : caseTitle(e.detail);
      }
      if (out.length > 0) out.push(" · ");
      out.push(h("span", { class: "muted" }, detail));
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
    if (entries === null) {
      setChildren(auditBodyEl, h("p", { class: "muted admin-empty-small" }, T().admLoading));
      return;
    }
    if (entries.length === 0) {
      setChildren(auditBodyEl, h("p", { class: "muted admin-empty-small" }, T().admAuditEmpty));
      return;
    }
    setChildren(
      auditBodyEl,
      h(
        "table",
        { class: "admin-table audit-table" },
        h("thead", {}, h("tr", {}, th(T().admColTime), th(T().admColAction), th(T().admColTarget), th(T().admColVia))),
        h(
          "tbody",
          {},
          entries.map((e) =>
            h(
              "tr",
              {},
              h("td", { class: "col-seen", title: e.at }, formatDateTime(e.at)),
              h("td", { title: e.action }, T().admAuditAction(e.action)),
              h("td", { class: "audit-target" }, auditTarget(e, names)),
              h("td", {}, h("span", { class: `via-pill is-${e.via}` }, T().admVia(e.via))),
            ),
          ),
        ),
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
    const title = cachedCase(s.caseId)?.title ?? s.title;
    const funnel = questionFunnel(s, state.statsProgress.get(s.caseId) ?? null);
    const hardest = hardestQuestion(funnel);
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
        // The server averages finished players only (Live averages everyone): the label says which.
        tile(
          T().admAvgScoreFinishers,
          s.avgScore === null ? "—" : String(Math.round(s.avgScore)),
          [maxScore ? T().admPar(maxScore) : null, T().admSample(s.completed)].filter((x) => x !== null).join(" · "),
        ),
        tile(
          T().admAvgTime,
          s.avgDurationSeconds === null ? "—" : formatSeconds(Math.round(s.avgDurationSeconds)),
          `${T().admFinishedPlayers} · ${T().admSample(s.completed)}`,
        ),
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
                th(T().admColReached, "num"),
                th(T().admColSolved, "num"),
                th(T().admColRevealed, "num"),
                th(T().admColNotSolved, "num"),
                th(T().admColAvgWrong, "num"),
                th(T().admColAvgHints, "num"),
              ),
            ),
            h(
              "tbody",
              {},
              funnel.map((row) => {
                const q = row.q;
                const qs = s.questions[q];
                const isHardest = hardest?.row.q === q;
                const notSolved = row.reached - row.solved;
                return h(
                  "tr",
                  { class: isHardest ? "is-hardest" : "" },
                  h(
                    "td",
                    {},
                    h("span", { class: "q-id" }, q.toUpperCase()),
                    " ",
                    questionTitle(s.caseId, q),
                    isHardest ? h("span", { class: "hardest-badge", title: T().admHardestTip }, "⚑ ", T().admHardest) : null,
                  ),
                  h("td", { class: "num" }, String(row.reached)),
                  h("td", { class: "num" }, qs ? String(qs.solved) : "—"),
                  h("td", { class: "num" }, qs ? String(qs.revealed) : "—"),
                  h("td", { class: "num" }, row.reached > 0 ? `${notSolved} · ${formatPct(notSolved / row.reached)}` : "—"),
                  h("td", { class: "num" }, qs ? qs.avgWrong.toFixed(1) : "—"),
                  h("td", { class: "num" }, qs ? qs.avgHints.toFixed(1) : "—"),
                );
              }),
            ),
          ),
        ),
        h(
          "p",
          { class: "muted small stats-hardest", title: T().admHardestTip },
          hardest
            ? T().admHardestLine(
                `${hardest.row.q.toUpperCase()} ${questionTitle(s.caseId, hardest.row.q)}`.trim(),
                Math.round(hardest.rate * 100),
                hardest.row.reached,
              )
            : T().admHardestNotEnough(HARDEST_MIN_PLAYERS),
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

  function renderLeaderboard(): void {
    leaderboardEl.hidden = !state.leaderboard;
    document.documentElement.classList.toggle("admin-board-open", state.leaderboard);
    if (!state.leaderboard) {
      leaderboardEl.replaceChildren();
      boardBtn.focus();
      return;
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
    const top = data ? data.entries.slice(0, 10) : [];
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
    const frozen = data?.frozen === true;
    const stateChip = data
      ? h(
          "p",
          { class: `admin-board-state${frozen ? " is-frozen" : ""}` },
          frozen ? h("span", { class: "board-frozen-chip" }, "❄ ", T().admBoardFrozen) : h("span", { class: "board-live-chip" }, T().admBoardLive),
          frozen && data.frozenAt ? h("span", { class: "board-frozen-at" }, T().admBoardFrozenAt(formatDateTime(data.frozenAt))) : null,
        )
      : null;
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
            h("span", { class: "board-rank" }, String(e.rank)),
            h("span", { class: "board-name" }, e.username),
            h("span", { class: "board-time muted" }, overall ? T().admCasesDone(e.casesCompleted) : T().admStagesSolved(e.stagesSolved)),
            h("span", { class: "board-score" }, String(e.score)),
          ),
        ),
      );
    }
    const focusedScope = document.activeElement === boardScopeSelect;
    setChildren(
      leaderboardEl,
      h(
        "div",
        { class: "admin-board-inner" },
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
        ),
        stateChip,
        body,
      ),
    );
    // Re-appending moves focus to <body>: put it back (Close on first open).
    if (focusedScope) boardScopeSelect.focus();
    else close.focus();
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
    if (state.tab !== "accounts") renderPending(state.accounts?.accounts ?? []);
    // Keep the schedule and event editors (and focus) intact while polling.
    if (state.tab === "schedule") renderScheduleToday();
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
      const [accounts, today, progress, stats, settings, event, audit] = await Promise.all([
        fetchAccounts(),
        fetchToday(),
        tab === "live" && liveCase ? fetchProgress(liveCase) : Promise.resolve(null),
        tab === "stats" ? fetchCaseStats() : Promise.resolve(null),
        tab === "accounts" ? fetchSettings() : Promise.resolve(null),
        tab === "event" && !state.event.saving ? fetchEvent() : Promise.resolve(null),
        tab === "audit" ? fetchAudit(AUDIT_LIMIT) : Promise.resolve(null),
      ]);
      if (disposed) return;
      state.accounts = accounts;
      state.today = today;
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
    if (state.tab === "schedule") void loadSchedule();
    if (state.tab === "event") void loadEvent();
    // Live, Stats, Audit and Recently deleted (Accounts) need a second request before they have data.
    if (state.tab === "live" || state.tab === "stats" || state.tab === "audit" || state.tab === "accounts") void load();
    else scheduleNext();
    tickId = window.setInterval(() => {
      if (!container.isConnected) return dispose();
      renderUpdated();
      if (state.tab === "event") renderEventStatus();
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
