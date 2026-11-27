// The stats panel: one summary per released case (manage/caseSummary.ts), today's case first, then the
// overall top 10. Scoped by its options: the per-case stats and the accounts come from the dashboard's poll, and
// the per-player progress behind "who reached each question" loads through `api`.
import { T } from "../../i18n/strings-tools";
import { getLang } from "../../i18n/i18n";
import { h, setChildren } from "../../lib/dom";
import { dataTable } from "../../components/dataTable";
import type { AdminProgress, UserStats } from "../../../shared/contract";
import type { AdminProgressResult, AdminStatsResult } from "../../lib/admin-api";
import { caseSummaryPanel } from "./caseSummary";
import { fmtInt, formatPct } from "./format";

export type StatsApi = {
  /** Every player's progress on one case. */
  progress(caseId: string): Promise<AdminProgressResult>;
};

export type StatsOptions = {
  api: StatsApi;
  /** The per-case stats (null before the first load). */
  stats(): AdminStatsResult | null;
  /** The accounts behind the top 10. */
  accounts(): readonly UserStats[];
  /** Today's case (listed first and tagged). */
  todayId(): string | null;
};

export type StatsPanel = {
  /** Fills the dashboard's section element. */
  mount(panel: HTMLElement): void;
  render(): void;
  /** Loads who reached each question (drop-off): one progress request per case that has players. */
  loadProgress(stats: AdminStatsResult): Promise<void>;
};

/** Overall leaderboard: approved accounts that have played, by server rank. */
function topPlayers(accounts: readonly UserStats[], n: number): UserStats[] {
  return accounts
    .filter((a) => a.status === "approved" && a.rank !== null && a.casesStarted > 0)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.totalScore - a.totalScore || a.username.localeCompare(b.username))
    .slice(0, n);
}

export function createStatsPanel(opts: StatsOptions): StatsPanel {
  /** per-case player progress (how many reached each question) */
  let statsProgress = new Map<string, readonly AdminProgress[]>();
  /** Cases whose "Show as a table" is open: the panels re-render on every poll and must not snap shut. */
  const statsTableOpen = new Set<string>();

  const statsBoardEl = h("div", { class: "admin-table-wrap" });
  const statsCasesEl = h("div", { class: "stats-cases" });

  function mount(panel: HTMLElement): void {
    setChildren(
      panel,
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
    const top = topPlayers(opts.accounts(), 10);
    if (top.length === 0) {
      setChildren(statsBoardEl, h("p", { class: "muted admin-empty-small" }, T().admNoPlayersBoard));
      return;
    }
    statsBoardTable.update(top);
    if (statsBoardTable.element.parentNode !== statsBoardEl) setChildren(statsBoardEl, statsBoardTable.element);
  }

  function render(): void {
    renderStatsBoard();
    const stats = opts.stats();
    if (!stats) {
      setChildren(statsCasesEl, h("p", { class: "muted admin-loading" }, T().admLoading));
      return;
    }
    if (stats.cases.length === 0) {
      setChildren(statsCasesEl, h("section", { class: "panel admin-panel" }, h("p", { class: "muted admin-empty-small" }, T().admNoReleased)));
      return;
    }
    const todayId = opts.todayId() ?? undefined;
    // Rebuild only when the numbers changed: a poll must not move focus out of a sorted per-question table.
    const sig = JSON.stringify([getLang(), stats, [...statsProgress], todayId]);
    if (sig === statsSig) return;
    statsSig = sig;
    const ordered = [...stats.cases].sort((a, b) => Number(b.caseId === todayId) - Number(a.caseId === todayId) || b.players - a.players);
    setChildren(statsCasesEl, ordered.map((c) => caseSummaryPanel(c, { progress: statsProgress.get(c.caseId) ?? null, isToday: todayId === c.caseId, tableOpen: statsTableOpen })));
  }
  let statsSig = "";

  async function loadProgress(stats: AdminStatsResult): Promise<void> {
    const ids = stats.cases.filter((c) => c.players > 0).map((c) => c.caseId);
    const results = await Promise.all(ids.map((id) => opts.api.progress(id).catch(() => null)));
    const next = new Map<string, readonly AdminProgress[]>();
    for (const r of results) if (r) next.set(r.caseId, r.players);
    statsProgress = next;
  }

  return { mount, render, loadProgress };
}
