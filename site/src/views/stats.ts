// "My stats": the signed-in player's totals, rank and per-case breakdown.
import { ACHIEVEMENT_IDS, type CaseStats, type LeaderboardResponse, type UserStats } from "../../shared/contract";
import { caseSummary } from "../content/load";
import { ApiError, fetchLeaderboard, fetchMyStats } from "../lib/api";
import { h, setChildren, type Child } from "../lib/dom";
import { formatElapsed } from "../lib/time";
import { formatNumber, getLang } from "../i18n/i18n";
import { setAccount } from "../lib/session";
import { TA } from "../i18n/strings-account";
import { TG, achievementInfo } from "../i18n/strings-game";
import { TO } from "../i18n/strings-onboard";
import { T } from "../i18n/strings-player";
import { passwordChangeForm, withApprovedAccount } from "./auth";

const locale = (): string => (getLang() === "he" ? "he-IL" : "en-GB");

/** A KPI card: label, value (+ unit), then comparison lines that give the number its context. */
function kpi(label: string, value: string, unit: string | null, subs: ReadonlyArray<string | null>): HTMLElement {
  return h(
    "div",
    { class: "stat-tile kpi" },
    h("p", { class: "stat-label" }, label),
    h("p", { class: "stat-value-row" }, h("span", { class: "stat-value" }, value), unit ? h("span", { class: "stat-unit" }, unit) : null),
    subs.filter((s): s is string => s !== null).map((s) => h("p", { class: "stat-sub muted small" }, s)),
  );
}

/** Missing is never zero: a muted dash, with "No data" for screen readers. */
function none(): HTMLElement {
  return h("span", { class: "no-data" }, h("span", { "aria-hidden": "true" }, "—"), h("span", { class: "visually-hidden" }, TO().noData));
}

function statusText(c: CaseStats): string {
  return c.status === "completed" ? TA().statusDone : c.status === "in-progress" ? TA().statusProgress : TA().statusNew;
}

function caseRow(c: CaseStats): HTMLElement {
  const title = caseSummary(c.caseId)?.title ?? c.caseId;
  const played = c.status !== "not-started";
  // maxScore is par, not a ceiling: bonuses (first blood, time, clean) can beat it. Cap the bar and say so.
  const pct = c.maxScore > 0 ? Math.min(100, Math.round((c.score / c.maxScore) * 100)) : 0;
  const abovePar = c.maxScore > 0 && c.score > c.maxScore;
  const count = (n: number): Child => (played ? formatNumber(n) : none());
  // data-label: the column name shown beside each value when the table stacks into cards on phones.
  return h(
    "tr",
    { class: `status-${c.status}` },
    h("th", { scope: "row", class: "case-cell" }, h("bdi", {}, played ? h("a", { href: `#/case/${c.caseId}` }, title) : title)),
    h("td", { "data-label": TA().colStatus }, h("span", { class: `chip chip-${c.status}` }, statusText(c))),
    h(
      "td",
      { class: "num", "data-label": TA().colScore },
      played
        ? [
            h("span", { class: "score-val", dir: "auto" }, TG().scorePts(c.score)), // not .mono: RTL forces mono LTR and splits "נק'"
            h("span", { class: `bar${abovePar ? " is-above-par" : ""}`, "aria-hidden": "true" }, h("span", { class: "bar-fill", style: `width:${pct}%` })),
            h("span", { class: "score-par muted small" }, TG().parOf(c.maxScore), abovePar ? h("span", { class: "above-par" }, ` · ▲ ${TG().abovePar}`) : null),
          ]
        : none(),
    ),
    h("td", { class: "num mono", "data-label": TA().colTime }, c.durationSeconds === null || !played ? none() : formatElapsed(c.durationSeconds * 1000)),
    h("td", { class: "num mono", "data-label": TA().colHints }, count(c.hintsUsed)),
    h("td", { class: "num mono", "data-label": TG().colCommands }, count(c.commandsRevealed)),
    h("td", { class: "num mono", "data-label": TA().colWrong }, count(c.wrongAttempts)),
  );
}

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
          h("span", { class: "ach-icon", "aria-hidden": "true" }, at ? info.icon : "🔒"),
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
  const detail = (label: string, value: Child): HTMLElement[] => [h("dt", {}, label), h("dd", {}, value)];

  setChildren(
    root,
    h(
      "section",
      { class: "stats-page" },
      h("a", { class: "back-link", href: "#/" }, T().navCases),
      h("h1", {}, TA().statsTitle),
      h("p", { class: "muted" }, h("strong", {}, h("bdi", {}, stats.username)), " · ", TA().memberSince(since)),
      h("p", { class: "muted small" }, TO().statsSub),
      h(
        "div",
        { class: "kpi-grid" },
        kpi(TO().kpiScore, formatNumber(stats.totalScore), TO().ptsUnit, [
          classMedian !== null ? TO().vsMedian(stats.totalScore - classMedian, classMedian) : null,
          parDiff !== null ? TO().vsPar(parDiff) : null,
        ]),
        kpi(TO().kpiRank, rankValue, null, [stats.rank === null || stats.totalScore === 0 ? TO().unrankedSub : null]),
        kpi(TO().kpiCases, TO().casesOf(stats.casesCompleted, released), null, [inProgress > 0 ? TO().inProgress(inProgress) : null]),
        kpi(TO().kpiStreak, TO().streakDays(stats.streak.current), null, [TO().streakBest(stats.streak.best)]),
      ),
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
      h(
        "div",
        { class: "table-wrap per-case-wrap", role: "region", "aria-label": TO().perCaseRegion, tabindex: "0" },
        h(
          "table",
          { class: "stats-table per-case-table", "aria-labelledby": "per-case-h" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col" }, TA().colCase),
              h("th", { scope: "col" }, TA().colStatus),
              h("th", { scope: "col", class: "num" }, TA().colScore),
              h("th", { scope: "col", class: "num" }, TA().colTime),
              h("th", { scope: "col", class: "num" }, TA().colHints),
              h("th", { scope: "col", class: "num" }, TG().colCommands),
              h("th", { scope: "col", class: "num" }, TA().colWrong),
            ),
          ),
          h("tbody", {}, stats.cases.map(caseRow)),
        ),
      ),
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
      setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted mono" }, TA().statsLoading)));
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
