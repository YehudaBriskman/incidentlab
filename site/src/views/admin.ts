// Instructor dashboard (#/admin). All API data is rendered via textContent / attributes only — never innerHTML.
import "../admin.css";
import { z } from "zod";
import { QUESTION_ORDER, type AdminPlayer, type QuestionId, type StageStatus } from "../../shared/contract";
import caseJson from "../content/cases/3am-outage.json";
import { copyButton, h, setChildren } from "../lib/dom";
import {
  AdminApiError,
  clearAdminKey,
  deleteAdminPlayer,
  fetchAdminPlayers,
  getAdminKey,
  resetAllPlayers,
  setAdminKey,
  type AdminPlayersResult,
} from "../lib/admin-api";

const POLL_MS = 5000;
const MAX_BACKOFF_MS = 60000;
const STUCK_WARN_MIN = 8;
const STUCK_ALERT_MIN = 15;

type StageKey = "setup" | QuestionId;
const STAGES: readonly StageKey[] = ["setup", ...QUESTION_ORDER];
type SortKey = "score" | "progress" | "name" | "stuck";

const CaseTitlesSchema = z.object({
  questions: z.array(z.object({ id: z.string(), title: z.string(), points: z.number() })),
});
const caseParsed = CaseTitlesSchema.safeParse(caseJson);
const QUESTION_TITLES = new Map<string, string>(
  caseParsed.success ? caseParsed.data.questions.map((q) => [q.id, q.title]) : [],
);

function stageLabel(stage: StageKey): string {
  return stage === "setup" ? "Setup" : stage.toUpperCase();
}

function stageLongLabel(stage: AdminPlayer["currentStage"]): string {
  if (stage === "done") return "Finished";
  if (stage === "setup") return "Setup";
  const title = QUESTION_TITLES.get(stage);
  return title ? `${stage.toUpperCase()} · ${title}` : stage.toUpperCase();
}

// ---- derived player metrics ------------------------------------------------

function stageStatus(p: AdminPlayer, stage: StageKey): StageStatus {
  if (stage === "setup") return p.setupDoneAt ? "solved" : "active";
  return p.stages[stage]?.status ?? "locked";
}

function isFinishedStatus(s: StageStatus): boolean {
  return s === "solved" || s === "revealed";
}

function progressCount(p: AdminPlayer): number {
  return STAGES.filter((s) => isFinishedStatus(stageStatus(p, s))).length;
}

function isDone(p: AdminPlayer): boolean {
  return p.completedAt !== null || p.currentStage === "done";
}

function stuckLevel(p: AdminPlayer): "none" | "warn" | "alert" {
  if (isDone(p)) return "none";
  if (p.stuckMinutes >= STUCK_ALERT_MIN) return "alert";
  if (p.stuckMinutes >= STUCK_WARN_MIN) return "warn";
  return "none";
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function finishDurationMs(p: AdminPlayer): number | null {
  const end = ms(p.completedAt);
  const start = ms(p.createdAt);
  return end !== null && start !== null ? Math.max(0, end - start) : null;
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

function relativeAgo(iso: string | null, now: number): string {
  const t = ms(iso);
  if (t === null) return "—";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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

function stageTooltip(p: AdminPlayer, stage: StageKey, now: number): string {
  const status = stageStatus(p, stage);
  if (stage === "setup") {
    const start = ms(p.createdAt);
    const end = ms(p.setupDoneAt) ?? now;
    const spent = start !== null ? formatDuration(end - start) : "—";
    return `Setup: ${p.setupDoneAt ? "done" : "in progress"} · time ${spent}`;
  }
  const sp = p.stages[stage];
  const title = QUESTION_TITLES.get(stage) ?? "";
  if (!sp || status === "locked") return `${stage.toUpperCase()} ${title}: locked`;
  const start = ms(sp.startedAt);
  const end = ms(sp.finishedAt) ?? now;
  const spent = start !== null ? formatDuration(end - start) : "—";
  return [
    `${stage.toUpperCase()} ${title}: ${status}`,
    `wrong attempts: ${sp.wrongAttempts}`,
    `hints used: ${sp.hintsRevealed}`,
    `time: ${spent}`,
    status === "solved" ? `points: ${sp.points}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function sortPlayers(players: readonly AdminPlayer[], key: SortKey): AdminPlayer[] {
  const byName = (a: AdminPlayer, b: AdminPlayer): number => a.name.localeCompare(b.name);
  const list = [...players];
  switch (key) {
    case "score":
      return list.sort((a, b) => b.score - a.score || progressCount(b) - progressCount(a) || byName(a, b));
    case "progress":
      return list.sort((a, b) => progressCount(b) - progressCount(a) || b.score - a.score || byName(a, b));
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

function leaderboardOrder(players: readonly AdminPlayer[]): AdminPlayer[] {
  return [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const fa = finishDurationMs(a);
    const fb = finishDurationMs(b);
    if (fa !== null && fb !== null) return fa - fb;
    if (fa !== null) return -1;
    if (fb !== null) return 1;
    return progressCount(b) - progressCount(a);
  });
}

// ---- view ------------------------------------------------------------------

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
    data: null as AdminPlayersResult | null,
    lastUpdated: 0,
    paused: false,
    sort: "score" as SortKey,
    filter: "",
    pendingDeleteId: null as string | null,
    leaderboard: false,
    loading: false,
    banner: null as string | null,
    failures: 0,
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
    } else if (state.data && !state.paused) {
      void load();
    }
  }
  window.addEventListener("hashchange", onHashChange);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("visibilitychange", onVisibility);

  // ---- login ---------------------------------------------------------------

  function showLogin(error: string | null): void {
    stopTimers();
    state.data = null;
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
    const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Open dashboard");
    const form = h(
      "form",
      { class: "admin-login-form" },
      h("label", { for: "admin-key", class: "admin-label" }, "Admin key"),
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
      submit.textContent = "Checking…";
      void start();
    });
    setChildren(
      container,
      h(
        "section",
        { class: "admin-login panel" },
        h("p", { class: "eyebrow" }, "Instructor"),
        h("h1", { class: "admin-title" }, "IncidentLab dashboard"),
        h("p", { class: "muted" }, "Enter the admin key to watch the class live. The key stays in this browser tab only."),
        form,
      ),
    );
    input.focus();
  }

  function handleAuthError(err: unknown): boolean {
    if (!(err instanceof AdminApiError)) return false;
    if (err.status === 401) {
      clearAdminKey();
      showLogin("That admin key was rejected. Check it and try again.");
      return true;
    }
    if (err.status === 503) {
      clearAdminKey();
      showLogin("Admin is disabled: set the ADMIN_KEY env var on Netlify");
      return true;
    }
    return false;
  }

  // ---- dashboard shell (built once, regions re-rendered) ----------------------

  const updatedEl = h("span", { class: "admin-updated", "aria-live": "off" });
  const pauseBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Pause");
  const refreshBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Refresh now");
  const boardBtn = h("button", { type: "button", class: "btn btn-primary btn-sm" }, "Leaderboard");
  const logoutBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Sign out");
  const bannerEl = h("div", { class: "admin-banner", role: "status" });
  const tilesEl = h("div", { class: "admin-tiles" });
  const funnelEl = h("div", { class: "admin-funnel" });
  const helpEl = h("div", { class: "admin-help" });
  const tableEl = h("div", { class: "admin-table-wrap" });
  const leaderboardEl = h("div", { class: "admin-board", role: "dialog", "aria-modal": "true", "aria-label": "Leaderboard" });
  leaderboardEl.hidden = true;

  const searchInput = h("input", {
    type: "search",
    class: "admin-input admin-search",
    placeholder: "Search players…",
    "aria-label": "Search players by name",
  });
  searchInput.addEventListener("input", () => {
    state.filter = searchInput.value;
    renderTable();
  });

  const sortSelect = h(
    "select",
    { class: "admin-input admin-sort", "aria-label": "Sort players" },
    h("option", { value: "score" }, "Sort: score"),
    h("option", { value: "progress" }, "Sort: progress"),
    h("option", { value: "stuck" }, "Sort: stuck longest"),
    h("option", { value: "name" }, "Sort: name"),
  );
  sortSelect.addEventListener("change", () => {
    const v = sortSelect.value;
    if (v === "score" || v === "progress" || v === "name" || v === "stuck") {
      state.sort = v;
      renderTable();
    }
  });

  pauseBtn.addEventListener("click", () => {
    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? "Resume" : "Pause";
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

  // Reset-all: typed confirmation.
  const resetInput = h("input", {
    type: "text",
    class: "admin-input",
    placeholder: "Type RESET",
    "aria-label": "Type RESET to confirm deleting all players",
    autocomplete: "off",
  });
  const resetBtn = h("button", { type: "button", class: "btn btn-danger btn-sm", disabled: true }, "Reset all players");
  const resetMsg = h("span", { class: "muted small" });
  resetInput.addEventListener("input", () => {
    resetBtn.disabled = resetInput.value.trim() !== "RESET";
  });
  resetBtn.addEventListener("click", () => {
    const key = getAdminKey();
    if (!key || resetInput.value.trim() !== "RESET") return;
    resetBtn.disabled = true;
    resetMsg.textContent = "Resetting…";
    resetAllPlayers(key)
      .then(() => {
        resetInput.value = "";
        resetMsg.textContent = "All players deleted.";
        void load();
      })
      .catch((err: unknown) => {
        if (handleAuthError(err)) return;
        resetMsg.textContent = err instanceof Error ? err.message : "Reset failed";
        resetBtn.disabled = resetInput.value.trim() !== "RESET";
      });
  });

  function buildDashboard(): void {
    setChildren(
      container,
      h(
        "header",
        { class: "admin-head" },
        h(
          "div",
          { class: "admin-head-title" },
          h("p", { class: "eyebrow" }, "Instructor · live"),
          h("h1", { class: "admin-title" }, "Class dashboard"),
        ),
        h("div", { class: "admin-head-actions" }, updatedEl, pauseBtn, refreshBtn, boardBtn, logoutBtn),
      ),
      bannerEl,
      tilesEl,
      h(
        "div",
        { class: "admin-grid" },
        h("section", { class: "panel admin-panel" }, h("h2", { class: "admin-h2" }, "Stage funnel"), funnelEl),
        h("section", { class: "panel admin-panel" }, h("h2", { class: "admin-h2" }, "Needs help"), helpEl),
      ),
      h(
        "section",
        { class: "panel admin-panel" },
        h(
          "div",
          { class: "admin-table-head" },
          h("h2", { class: "admin-h2" }, "Players"),
          h("div", { class: "admin-controls" }, searchInput, sortSelect),
        ),
        h(
          "div",
          { class: "admin-legend", "aria-hidden": "true" },
          h("span", { class: "cell is-solved" }), "solved",
          h("span", { class: "cell is-revealed" }), "revealed",
          h("span", { class: "cell is-active" }), "active",
          h("span", { class: "cell is-locked" }), "locked",
        ),
        tableEl,
      ),
      h(
        "section",
        { class: "panel admin-panel admin-danger" },
        h("h2", { class: "admin-h2" }, "Danger zone"),
        h("p", { class: "muted small" }, "Deletes every player and their progress. This cannot be undone."),
        h("div", { class: "admin-reset" }, resetInput, resetBtn, resetMsg),
      ),
      leaderboardEl,
    );
    pauseBtn.textContent = state.paused ? "Resume" : "Pause";
  }

  // ---- regions ---------------------------------------------------------------

  function renderUpdated(): void {
    if (!state.lastUpdated) {
      updatedEl.textContent = "Loading…";
      return;
    }
    const sec = Math.max(0, Math.round((Date.now() - state.lastUpdated) / 1000));
    updatedEl.textContent = `${state.paused ? "Paused · " : ""}updated ${sec}s ago`;
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

  function renderTiles(players: readonly AdminPlayer[]): void {
    const finished = players.filter(isDone);
    const avg = players.length ? Math.round(players.reduce((s, p) => s + p.score, 0) / players.length) : null;
    const maxScore = players[0]?.maxScore;
    const med = median(finished.map(finishDurationMs).filter((v): v is number => v !== null));
    const stuck = players.filter((p) => stuckLevel(p) !== "none").length;
    setChildren(
      tilesEl,
      tile("Players", String(players.length), stuck ? `${stuck} stuck` : "none stuck"),
      tile(
        "Finished",
        String(finished.length),
        players.length ? `${Math.round((finished.length / players.length) * 100)}%` : undefined,
      ),
      tile("Avg score", avg === null ? "—" : String(avg), maxScore ? `of ${maxScore}` : undefined),
      tile("Median time", med === null ? "—" : formatDuration(med), "finished players"),
    );
  }

  function renderFunnel(players: readonly AdminPlayer[]): void {
    const total = players.length;
    const rows = STAGES.map((stage) => {
      const reached = players.filter((p) => stageStatus(p, stage) !== "locked").length;
      const done = players.filter((p) => isFinishedStatus(stageStatus(p, stage))).length;
      const pct = (n: number): string => (total ? `${(n / total) * 100}%` : "0%");
      const title = stage === "setup" ? "Setup" : QUESTION_TITLES.get(stage) ?? "";
      return h(
        "div",
        { class: "funnel-row", title: `${stageLabel(stage)} ${title}: ${reached} reached, ${done} finished` },
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
        h("span", { class: "key-done" }), "finished ",
        h("span", { class: "key-reached" }), "reached",
      ),
      rows,
    );
  }

  function stuckBadge(p: AdminPlayer): HTMLElement | null {
    const level = stuckLevel(p);
    if (level === "none") return null;
    return h(
      "span",
      { class: `stuck-badge is-${level}`, title: `${Math.floor(p.stuckMinutes)} minutes on the current stage` },
      `stuck ${Math.floor(p.stuckMinutes)}m`,
    );
  }

  function renderHelp(players: readonly AdminPlayer[]): void {
    const stuck = players
      .filter((p) => stuckLevel(p) !== "none")
      .sort((a, b) => b.stuckMinutes - a.stuckMinutes);
    if (stuck.length === 0) {
      setChildren(helpEl, h("p", { class: "muted admin-empty-small" }, "Nobody is stuck right now."));
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
          const detail = sp ? `${sp.wrongAttempts} wrong · ${sp.hintsRevealed} hints` : "";
          return h(
            "li",
            { class: `help-item is-${stuckLevel(p)}` },
            h("span", { class: "help-name" }, p.name),
            h("span", { class: "help-stage" }, stageLongLabel(cur)),
            h("span", { class: "help-detail muted" }, detail),
            stuckBadge(p),
          );
        }),
      ),
    );
  }

  function progressCells(p: AdminPlayer, now: number): HTMLElement {
    return h(
      "div",
      { class: "progress-cells", role: "list", "aria-label": `Progress: ${progressCount(p)} of ${STAGES.length}` },
      STAGES.map((stage) => {
        const status = stageStatus(p, stage);
        const tip = stageTooltip(p, stage, now);
        return h("span", { class: `cell is-${status}`, role: "listitem", title: tip, "aria-label": tip });
      }),
    );
  }

  function deleteControl(p: AdminPlayer): HTMLElement {
    if (state.pendingDeleteId !== p.id) {
      return h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost btn-sm",
          "aria-label": `Delete ${p.name}`,
          onclick: () => {
            state.pendingDeleteId = p.id;
            renderTable();
          },
        },
        "Delete",
      );
    }
    const yes = h("button", { type: "button", class: "btn btn-danger btn-sm" }, "Confirm");
    yes.addEventListener("click", () => {
      const key = getAdminKey();
      if (!key) return showLogin(null);
      yes.disabled = true;
      yes.textContent = "Deleting…";
      deleteAdminPlayer(key, p.id)
        .then(() => {
          state.pendingDeleteId = null;
          if (state.data) state.data = { ...state.data, players: state.data.players.filter((x) => x.id !== p.id) };
          renderData();
          void load();
        })
        .catch((err: unknown) => {
          if (handleAuthError(err)) return;
          state.banner = err instanceof Error ? `Delete failed: ${err.message}` : "Delete failed";
          state.pendingDeleteId = null;
          renderBanner();
          renderTable();
        });
    });
    const no = h(
      "button",
      {
        type: "button",
        class: "btn btn-ghost btn-sm",
        onclick: () => {
          state.pendingDeleteId = null;
          renderTable();
        },
      },
      "Cancel",
    );
    return h("span", { class: "confirm-prompt", role: "group", "aria-label": `Confirm deleting ${p.name}` }, yes, no);
  }

  // Persistent table; rows are keyed by player id and rebuilt only when their visible data changes,
  // so scroll position, focus and open tooltips survive each 5s refresh even with 100+ players.
  const tbody = h("tbody", {});
  const tableNode = h(
    "table",
    { class: "admin-table" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { scope: "col" }, "Name"),
        h("th", { scope: "col" }, "Progress"),
        h("th", { scope: "col", class: "num" }, "Score"),
        h("th", { scope: "col" }, "Current stage"),
        h("th", { scope: "col" }, "Last seen"),
        h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions")),
      ),
    ),
    tbody,
  );
  const rowCache = new Map<string, { row: HTMLTableRowElement; sig: string }>();

  function rowSignature(p: AdminPlayer, now: number): string {
    const stages = STAGES.map((st) => {
      const sp = st === "setup" ? undefined : p.stages[st];
      return `${stageStatus(p, st)}:${sp?.wrongAttempts ?? 0}:${sp?.hintsRevealed ?? 0}`;
    }).join(",");
    return [
      p.name,
      p.score,
      p.currentStage,
      Math.floor(p.stuckMinutes),
      stages,
      relativeAgo(p.lastSeenAt, now),
      state.pendingDeleteId === p.id ? "del" : "",
    ].join("|");
  }

  function buildRow(p: AdminPlayer, now: number): HTMLTableRowElement {
    return h(
      "tr",
      { class: `is-${stuckLevel(p)}`, "data-id": p.id },
      h("td", { class: "col-name" }, h("span", { class: "player-name" }, p.name)),
      h("td", {}, progressCells(p, now)),
      h("td", { class: "num col-score" }, String(p.score)),
      h(
        "td",
        { class: "col-stage" },
        h("span", { class: isDone(p) ? "stage-done" : "" }, stageLongLabel(p.currentStage)),
        " ",
        stuckBadge(p),
      ),
      h("td", { class: "col-seen muted" }, relativeAgo(p.lastSeenAt, now)),
      h("td", { class: "col-actions" }, deleteControl(p)),
    );
  }

  function renderTable(): void {
    const players = state.data?.players ?? [];
    if (players.length === 0) {
      rowCache.clear();
      tbody.replaceChildren();
      const url = location.origin;
      setChildren(
        tableEl,
        h(
          "div",
          { class: "admin-empty" },
          h("p", { class: "admin-empty-title" }, "No players yet"),
          h("p", { class: "muted" }, "Share this link with the class:"),
          h("div", { class: "admin-share" }, h("code", { class: "admin-share-url" }, url), copyButton(() => url, "Copy link")),
        ),
      );
      return;
    }
    const q = state.filter.trim().toLowerCase();
    const filtered = q ? players.filter((p) => p.name.toLowerCase().includes(q)) : players;
    if (filtered.length === 0) {
      setChildren(tableEl, h("p", { class: "muted admin-empty-small" }, "No players match that search."));
      return;
    }
    if (tableNode.parentNode !== tableEl) setChildren(tableEl, tableNode);

    const sorted = sortPlayers(filtered, state.sort);
    const now = Date.now();
    const keep = new Set<string>();
    sorted.forEach((p, i) => {
      keep.add(p.id);
      const sig = rowSignature(p, now);
      let entry = rowCache.get(p.id);
      if (!entry || entry.sig !== sig) {
        const row = buildRow(p, now);
        if (entry) entry.row.replaceWith(row);
        entry = { row, sig };
        rowCache.set(p.id, entry);
      }
      const at = tbody.children[i];
      if (at !== entry.row) tbody.insertBefore(entry.row, at ?? null);
    });
    for (const [id, entry] of rowCache) {
      if (!keep.has(id)) {
        entry.row.remove();
        rowCache.delete(id);
      }
    }
  }

  function renderLeaderboard(): void {
    leaderboardEl.hidden = !state.leaderboard;
    document.documentElement.classList.toggle("admin-board-open", state.leaderboard);
    if (!state.leaderboard) {
      leaderboardEl.replaceChildren();
      boardBtn.focus();
      return;
    }
    const top = leaderboardOrder(state.data?.players ?? []).slice(0, 10);
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
      "Close (Esc)",
    );
    setChildren(
      leaderboardEl,
      h(
        "div",
        { class: "admin-board-inner" },
        h("div", { class: "admin-board-head" }, h("h2", { class: "admin-board-title" }, "Leaderboard"), close),
        top.length === 0
          ? h("p", { class: "muted admin-board-empty" }, "No players yet.")
          : h(
              "ol",
              { class: "admin-board-list" },
              top.map((p, i) => {
                const dur = finishDurationMs(p);
                return h(
                  "li",
                  { class: `admin-board-row rank-${i + 1}` },
                  h("span", { class: "board-rank" }, String(i + 1)),
                  h("span", { class: "board-name" }, p.name),
                  h("span", { class: "board-time muted" }, dur !== null ? formatDuration(dur) : `${progressCount(p)}/${STAGES.length}`),
                  h("span", { class: "board-score" }, String(p.score)),
                );
              }),
            ),
      ),
    );
    if (document.activeElement === boardBtn || !leaderboardEl.contains(document.activeElement)) close.focus();
  }

  function renderData(): void {
    const players = state.data?.players ?? [];
    if (state.pendingDeleteId && !players.some((p) => p.id === state.pendingDeleteId)) state.pendingDeleteId = null;
    renderTiles(players);
    renderFunnel(players);
    renderHelp(players);
    renderTable();
    if (state.leaderboard) renderLeaderboard();
    renderUpdated();
    renderBanner();
  }

  // ---- data loading ------------------------------------------------------------

  async function load(): Promise<void> {
    if (disposed || state.loading) return;
    const key = getAdminKey();
    if (!key) return showLogin(null);
    state.loading = true;
    try {
      const result = await fetchAdminPlayers(key);
      if (disposed) return;
      state.data = result;
      state.lastUpdated = Date.now();
      state.banner = null;
      state.failures = 0;
      renderData();
    } catch (err: unknown) {
      if (disposed) return;
      if (handleAuthError(err)) return;
      state.failures += 1;
      const reason = err instanceof Error ? err.message : "unknown error";
      state.banner = `Connection problem (${reason}), retrying in ${Math.round(nextDelay() / 1000)}s. Showing last known data.`;
      renderBanner();
    } finally {
      state.loading = false;
      scheduleNext();
    }
  }

  // 5s normally; exponential backoff on errors: 10s, 20s, 40s, capped at 60s.
  function nextDelay(): number {
    return state.failures === 0 ? POLL_MS : Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** state.failures);
  }

  function scheduleNext(): void {
    if (pollId !== null) window.clearTimeout(pollId);
    pollId = null;
    if (disposed || state.paused || !state.data || document.visibilityState === "hidden") return;
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
      const result = await fetchAdminPlayers(key);
      if (disposed) return;
      state.data = result;
      state.lastUpdated = Date.now();
      state.banner = null;
    } catch (err: unknown) {
      if (disposed) return;
      if (handleAuthError(err)) return;
      showLogin(err instanceof Error ? err.message : "Could not load the dashboard");
      return;
    }
    buildDashboard();
    renderData();
    stopTimers();
    scheduleNext();
    tickId = window.setInterval(() => {
      if (!container.isConnected) return dispose();
      renderUpdated();
    }, 1000);
  }

  if (getAdminKey()) {
    setChildren(container, h("p", { class: "muted admin-loading" }, "Loading dashboard…"));
    void start();
  } else {
    showLogin(null);
  }
}
