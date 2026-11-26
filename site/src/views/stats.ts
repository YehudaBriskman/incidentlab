// "My stats": the signed-in player's totals, rank and per-case breakdown.
import { ACHIEVEMENT_IDS, type CaseStats, type LeaderboardResponse, type UserStats } from "../../shared/contract";
import { caseSummary } from "../content/load";
import { ApiError, fetchLeaderboard, fetchMyStats } from "../lib/api";
import { h, html, setChildren, type Child } from "../lib/dom";
import { iconSvg } from "../shell/icons";
import { tooltip } from "../lib/overlay";
import "../player.css";
import { dataTable, type Column } from "../components/dataTable";
import { statGrid, statTile } from "../components/statGrid";
import { formatElapsed } from "../lib/time";
import { formatNumber, getLang } from "../i18n/i18n";
import { setAccount } from "../lib/session";
import { TA } from "../i18n/strings-account";
import { TG, achievementInfo } from "../i18n/strings-game";
import { TO } from "../i18n/strings-onboard";
import { T } from "../i18n/strings-player";
import { passwordChangeForm, withApprovedAccount } from "./auth";

const locale = (): string => (getLang() === "he" ? "he-IL" : "en-GB");

/** Puts a secondary line in a hover tooltip; the text stays in the DOM for screen readers. */
function withTip(el: HTMLElement, text: string): HTMLElement {
  el.append(h("span", { class: "visually-hidden" }, ` ${text}`));
  tooltip(el, text);
  return el;
}

/** A KPI card: label, value (+ unit), then comparison lines that give the number its context. */
function kpi(label: string, value: string, unit: string | null, subs: ReadonlyArray<string | null>): HTMLElement {
  return statTile({ label, value, unit, subs });
}

/** Missing is never zero: a muted dash, with "No data" for screen readers. */
function none(): HTMLElement {
  return h("span", { class: "no-data" }, h("span", { "aria-hidden": "true" }, "—"), h("span", { class: "visually-hidden" }, TO().noData));
}

function statusText(c: CaseStats): string {
  return c.status === "completed" ? TA().statusDone : c.status === "in-progress" ? TA().statusProgress : TA().statusNew;
}

/** The per-case table's columns. Unplayed cases show a muted dash, never a zero. */
function caseColumns(): Column<CaseStats>[] {
  const played = (c: CaseStats): boolean => c.status !== "not-started";
  const count = (c: CaseStats, n: number): Child => (played(c) ? formatNumber(n) : none());
  const statusOrder = { "completed": 0, "in-progress": 1, "not-started": 2 } as const;
  return [
    {
      id: "case",
      header: TA().colCase,
      rowHeader: true,
      className: "case-cell",
      sortValue: (c) => caseSummary(c.caseId)?.title ?? c.caseId,
      cell: (c) => {
        const title = caseSummary(c.caseId)?.title ?? c.caseId;
        return h("bdi", {}, played(c) ? h("a", { href: `#/case/${c.caseId}` }, title) : title);
      },
    },
    {
      id: "status",
      header: TA().colStatus,
      sortValue: (c) => statusOrder[c.status],
      cell: (c) => h("span", { class: `chip chip-${c.status}` }, statusText(c)),
    },
    {
      id: "score",
      header: TA().colScore,
      numeric: true,
      sortFirst: "desc",
      sortValue: (c) => (played(c) ? c.score : null),
      cell: (c) => {
        if (!played(c)) return none();
        // maxScore is par, not a ceiling: bonuses (first blood, time, clean) can beat it. Cap the bar and say so.
        const pct = c.maxScore > 0 ? Math.min(100, Math.round((c.score / c.maxScore) * 100)) : 0;
        const abovePar = c.maxScore > 0 && c.score > c.maxScore;
        return [
          h("span", { class: "score-val", dir: "auto" }, TG().scorePts(c.score)), // not .mono: RTL forces mono LTR and splits "נק'"
          h("span", { class: `bar${abovePar ? " is-above-par" : ""}`, "aria-hidden": "true" }, h("span", { class: "bar-fill", style: `width:${pct}%` })),
          h("span", { class: "score-par muted small" }, TG().parOf(c.maxScore), abovePar ? h("span", { class: "above-par" }, ` · ▲ ${TG().abovePar}`) : null),
        ];
      },
    },
    {
      id: "time",
      header: TA().colTime,
      numeric: true,
      className: "tnum",
      sortValue: (c) => (played(c) ? c.durationSeconds : null),
      cell: (c) => (c.durationSeconds === null || !played(c) ? none() : formatElapsed(c.durationSeconds * 1000)),
    },
    { id: "hints", header: TA().colHints, numeric: true, className: "tnum", sortValue: (c) => (played(c) ? c.hintsUsed : null), cell: (c) => count(c, c.hintsUsed) },
    { id: "commands", header: TG().colCommands, numeric: true, className: "tnum", sortValue: (c) => (played(c) ? c.commandsRevealed : null), cell: (c) => count(c, c.commandsRevealed) },
    { id: "wrong", header: TA().colWrong, numeric: true, className: "tnum", sortValue: (c) => (played(c) ? c.wrongAttempts : null), cell: (c) => count(c, c.wrongAttempts) },
  ];
}

/** Achievement tiles draw their icon at 22px inside the 40px badge. */
const ACH_ICON_PX = 22;

function achievementsGrid(stats: UserStats): HTMLElement {
  const earned = new Map(stats.achievements.map((a) => [a.id, a.earnedAt]));
  const fmt = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric" });
  const ids: string[] = [...ACHIEVEMENT_IDS, ...stats.achievements.map((a) => a.id).filter((id) => !(ACHIEVEMENT_IDS as readonly string[]).includes(id))];
  const count = ids.filter((id) => earned.has(id)).length;
  return h(
    "section",
    { class: "achievements", "aria-labelledby": "ach-h" },
    h("h2", { id: "ach-h", class: "section-title" }, TG().achievementsTitle, h("span", { class: "section-count" }, ` · ${TG().achievementsCount(count, ids.length)}`)),
    h(
      "ul",
      { class: "ach-grid" },
      ids.map((id) => {
        const info = achievementInfo(getLang(), id);
        const at = earned.get(id);
        return h(
          "li",
          { class: `ach${at ? " is-earned" : " is-locked"}` },
          // Decorative: the label beside it names the achievement, and "Locked" / "Earned on" says its state.
          html("span", { class: "ach-icon", "aria-hidden": "true" }, iconSvg(at ? info.icon : "lock", ACH_ICON_PX)),
          h(
            "div",
            { class: "ach-text" },
            h("p", { class: "ach-label" }, info.label),
            h("p", { class: "ach-desc muted small" }, info.description),
            h("p", { class: "ach-when small" }, at ? TG().earnedOn(fmt.format(new Date(at))) : TG().lockedBadge),
          ),
        );
      }),
    ),
  );
}

/** Median of the ranked players' scores (the public overall board). */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

function draw(root: HTMLElement, stats: UserStats, board: LeaderboardResponse | null): void {
  const since = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", year: "numeric" }).format(new Date(stats.createdAt));
  const tries = stats.stagesSolved + stats.wrongAttempts;
  const pct = stats.accuracy === null ? null : new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(stats.accuracy);
  const released = stats.cases.length;
  const inProgress = stats.cases.filter((c) => c.status === "in-progress").length;
  const firstBloods = stats.cases.reduce((sum, c) => sum + c.firstBloods, 0);
  const completed = stats.cases.filter((c) => c.status === "completed");
  const parDiff = completed.length > 0 ? completed.reduce((sum, c) => sum + c.score - c.maxScore, 0) : null;
  // Class comparisons come from the live public board (a frozen board would compare against stale scores).
  const live = board !== null && !board.frozen ? board : null;
  const classMedian = live !== null && live.entries.length >= 2 ? median(live.entries.map((e) => e.score)) : null;
  const ranked = live?.entries.length ?? null;
  const rankValue =
    stats.rank === null || stats.totalScore === 0
      ? TO().unranked
      : ranked !== null
        ? TO().rankOfN(stats.rank, Math.max(ranked, stats.rank))
        : TO().rankAlone(stats.rank);
  // Each pair in its own <div> (valid inside <dl>): the grid places whole pairs, so a label can never wrap away
  // from its value onto another row.
  const detail = (label: string, value: Child): HTMLElement => h("div", { class: "detail-pair" }, h("dt", {}, label), h("dd", {}, value));

  setChildren(
    root,
    h(
      "section",
      { class: "stats-page" },
      h("a", { class: "back-link", href: "#/" }, T().navCases),
      h("h1", {}, TA().statsTitle),
      withTip(h("p", { class: "page-meta" }, h("strong", {}, h("bdi", {}, stats.username)), " · ", TA().memberSince(since)), TO().statsSub),
      statGrid([
        kpi(TO().kpiScore, formatNumber(stats.totalScore), TO().ptsUnit, [
          classMedian !== null ? TO().vsMedian(stats.totalScore - classMedian, classMedian) : null,
          parDiff !== null ? TO().vsPar(parDiff) : null,
        ]),
        kpi(TO().kpiRank, rankValue, null, [stats.rank === null || stats.totalScore === 0 ? TO().unrankedSub : null]),
        kpi(TO().kpiCases, TO().casesOf(stats.casesCompleted, released), null, [inProgress > 0 ? TO().inProgress(inProgress) : null]),
        kpi(TO().kpiStreak, TO().streakDays(stats.streak.current), null, [TO().streakBest(stats.streak.best)]),
      ]),
      h(
        "section",
        { class: "stat-details", "aria-labelledby": "detail-h" },
        h("h2", { id: "detail-h", class: "visually-hidden" }, TO().detailTitle),
        h(
          "dl",
          { class: "detail-list" },
          detail(TO().stagesSolved, formatNumber(stats.stagesSolved)),
          detail(TO().accuracy, pct === null ? none() : TO().accuracyOf(pct, stats.stagesSolved, tries)),
          detail(TA().statHints, formatNumber(stats.hintsUsed)),
          detail(TA().statRevealed, formatNumber(stats.stagesRevealed)),
          detail(TA().statWrong, formatNumber(stats.wrongAttempts)),
          detail(TG().statCommands, formatNumber(stats.commandsRevealed)),
          detail(TG().statFirstBloods, formatNumber(firstBloods)),
        ),
      ),
      achievementsGrid(stats),
      h("h2", { id: "per-case-h", class: "section-title" }, TA().perCase),
      dataTable({
        columns: caseColumns(),
        rows: stats.cases,
        rowAttrs: (c) => ({ class: `status-${c.status}` }),
        labelledBy: "per-case-h",
        className: "per-case-table",
        wrapClass: "per-case-wrap",
        regionLabel: TO().perCaseRegion,
        stackOnPhone: true,
      }).element,
      h(
        "details",
        { class: "pw-section" },
        h("summary", { class: "section-title" }, TG().pwTitle),
        passwordChangeForm({ forced: false, idPrefix: "me-pw", onChanged: (account) => setAccount(account) }),
      ),
    ),
  );
}

export function renderStats(root: HTMLElement): void {
  document.title = `${TA().statsTitle} · IncidentLab`;
  withApprovedAccount(
    root,
    TA().statsTitle,
    () => {
      setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted" }, TA().statsLoading)));
      const board = fetchLeaderboard(null).catch(() => null); // comparisons only: never blocks the page
      Promise.all([fetchMyStats(), board])
        .then(([stats, leaderboard]) => draw(root, stats, leaderboard))
        .catch((err: unknown) => {
          setChildren(
            root,
            h(
              "section",
              { class: "center-card", role: "alert" },
              h("h1", {}, TA().statsFailed),
              h("p", { class: "muted" }, err instanceof ApiError ? err.message : T().genericError),
              h("button", { type: "button", class: "btn btn-primary", onclick: () => renderStats(root) }, T().tryAgain),
            ),
          );
        });
    },
    { signInTitle: TO().signInForStats },
  );
}
