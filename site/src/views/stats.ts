// "My stats": the signed-in player's stats in four groups (#240): a summary (four KPI tiles), progress per case,
// achievements (with a meter toward the counted ones) and history, then (#183) the player's classes with their
// rank on each class board. A player who hasn't solved a stage yet gets one card with one next action instead.
// Guests see their stats with the upgrade card.
import { ACHIEVEMENT_IDS, type AccountView, type CaseStats, type ClassSummary, type LeaderboardResponse, type UserStats } from "../../shared/contract";
import { caseSummary, startHereCaseId } from "../content/load";
import { ApiError, fetchLeaderboard, fetchMyStats } from "../lib/api";
import { h, html, setChildren, type Child } from "../lib/dom";
import { iconSvg } from "../shell/icons";
import { tooltip } from "../lib/overlay";
import "../player.css";
import "../stats.css";
import { fetchClass, fetchClassBoard, fetchMyClasses } from "../lib/class-api";
import { HOME_CLASS_LIMIT, achievementProgress, boardEntryFor, classRoleKind, type ClassRoleKind } from "../lib/challenges";
import { TC } from "../i18n/strings-challenges";
import { TGu } from "../i18n/strings-guest";
import { openUpgradeDialog } from "./guest";
import { dataTable, type Column } from "../components/dataTable";
import { statGrid, statTile } from "../components/statGrid";
import { formatElapsed } from "../lib/time";
import { formatNumber, getLang } from "../i18n/i18n";
import { TA } from "../i18n/strings-account";
import { TB } from "../i18n/strings-board";
import { TG, achievementInfo } from "../i18n/strings-game";
import { TO } from "../i18n/strings-onboard";
import { T } from "../i18n/strings-player";
import { withApprovedAccount } from "./auth";
import { TSe } from "../i18n/strings-settings";
import { settingsHref } from "../lib/settings-route";
import { TS, achievementCountText } from "../i18n/strings-stats";

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
        // A locked achievement the stats can count shows how far along the player is (#240).
        const progress = at === undefined ? achievementProgress(stats, id) : null;
        const pct = progress === null ? 0 : Math.round((progress.have / progress.need) * 100);
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
            progress === null
              ? h("p", { class: "ach-when small" }, at ? TG().earnedOn(fmt.format(new Date(at))) : TG().lockedBadge)
              : h(
                  "div",
                  { class: "ach-progress" },
                  // The text carries the number; the bar repeats it for the eye only.
                  h("p", { class: "ach-when small" }, h("span", { class: "visually-hidden" }, `${TG().lockedBadge} · ${TS().achProgress}: `), achievementCountText(id, progress.have, progress.need)),
                  h("span", { class: "ach-meter", "aria-hidden": "true" }, h("span", { class: "ach-meter-fill", style: `inline-size:${pct}%` })),
                ),
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

/** The four KPI tiles. Rank: the place on the live public board, or why there is none (#175). */
function kpiGrid(stats: UserStats, board: LeaderboardResponse | null): HTMLElement {
  const firstBloods = stats.cases.reduce((sum, c) => sum + c.firstBloods, 0);
  const tries = stats.stagesSolved + stats.wrongAttempts;
  const pct = stats.accuracy === null ? null : new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(stats.accuracy);
  const released = stats.cases.length;
  const inProgress = stats.cases.filter((c) => c.status === "in-progress").length;
  const completed = stats.cases.filter((c) => c.status === "completed");
  // Score as a share of par on finished cases (#211): a signed "vs par" sum read as a loss almost always.
  // Par is a target that bonuses can beat, so this can pass 100%.
  const parOnCompleted = completed.reduce((sum, c) => sum + c.maxScore, 0);
  const ofPar = parOnCompleted > 0 ? Math.round((100 * completed.reduce((sum, c) => sum + c.score, 0)) / parOnCompleted) : null;
  // Comparisons come from the live public board (a frozen board would compare against stale scores).
  const live = board !== null && !board.frozen ? board : null;
  // The median of the opt-in global board (#211), shown only to players on it, who are compared against their peers there.
  // Hidden while the player is unranked: a first-day "−688" says nothing useful.
  const boardMedian = stats.onGlobalBoard && stats.rank !== null && live !== null && live.entries.length >= 2 ? median(live.entries.map((e) => e.score)) : null;
  const ranked = live?.entries.length ?? null;
  // The rank is on the global board, which players join by choice (#175); class ranks are in the Classes section.
  // Unranked exactly when the board doesn't list the player (#240): it lists everyone with a solved stage, even
  // at 0 points, so the rank decides, not the score.
  const rankTile = !stats.onGlobalBoard
    ? kpi(TB().kpiRank, TB().notOnBoard, null, [TC().rankNote, TB().notOnBoardSub])
    : stats.rank === null
      ? kpi(TB().kpiRank, TO().unranked, null, [TC().rankNote, TO().unrankedSub])
      : kpi(TB().kpiRank, ranked !== null ? TO().rankOfN(stats.rank, Math.max(ranked, stats.rank)) : TO().rankAlone(stats.rank), null, [TC().rankNote]);
  return statGrid([
    kpi(TO().kpiScore, formatNumber(stats.totalScore), TO().ptsUnit, [
      boardMedian !== null ? TO().vsMedian(stats.totalScore - boardMedian, boardMedian) : null,
      ofPar !== null ? TO().ofPar(ofPar) : null,
      firstBloods > 0 ? TS().firstBloods(firstBloods) : null,
    ]),
    rankTile,
    kpi(TO().kpiCases, TO().casesOf(stats.casesCompleted, released), null, [
      inProgress > 0 ? TO().inProgress(inProgress) : null,
      TS().stagesSolved(stats.stagesSolved),
      pct === null ? null : `${TO().accuracy}: ${TO().accuracyOf(pct, stats.stagesSolved, tries)}`,
    ]),
    kpi(TO().kpiStreak, TO().streakDays(stats.streak.current), null, [TS().streakBest(stats.streak.best)]),
  ]);
}

/**
 * Where the account settings went (#219): password and recovery code (accounts only) and the global-board switch
 * live on #/settings now. A guest's link opens Account, which leads with the Create account card.
 */
function settingsLink(account: AccountView): HTMLElement {
  const href = settingsHref(account.kind === "user" ? "privacy" : "account");
  return h("p", { class: "stats-settings-link small" }, h("a", { href }, account.kind === "user" ? TSe().statsSettingsLink : TSe().menuSettings));
}

/** True for a player with nothing to show yet: no stage solved or revealed and no case opened. */
const isZeroState = (stats: UserStats): boolean => stats.stagesSolved === 0 && stats.stagesRevealed === 0 && stats.casesStarted === 0;

/** The new player's one card (#240): what will appear here, and the one next action (the start-here case). */
function zeroState(): HTMLElement {
  const id = startHereCaseId();
  const title = id === null ? null : (caseSummary(id)?.title ?? null);
  return h(
    "section",
    { class: "stats-card stats-zero", "aria-labelledby": "zero-h" },
    h("p", { class: "eyebrow" }, TS().zeroEyebrow),
    h("h2", { id: "zero-h", class: "stats-zero-title" }, TS().zeroTitle),
    h("p", { class: "muted" }, TS().zeroBody),
    id === null
      ? h("a", { class: "btn btn-primary", href: "#/cases" }, TS().zeroBrowse)
      : h(
          "a",
          { class: "btn btn-primary stats-zero-play", href: `#/case/${encodeURIComponent(id)}` },
          TS().zeroPlay,
          title === null ? null : [h("span", { "aria-hidden": "true" }, ": "), h("bdi", {}, title)],
        ),
  );
}

type HistoryItem = { readonly at: string; readonly kind: "completed" | "earned"; readonly name: string; readonly href: string | null };

/** History: finished cases and earned achievements, newest first (the last HISTORY_ITEMS). */
const HISTORY_ITEMS = 8;

function historySection(stats: UserStats): HTMLElement | null {
  const items: HistoryItem[] = [
    ...stats.cases
      .filter((c) => c.completedAt !== null)
      .map((c): HistoryItem => ({ at: c.completedAt ?? "", kind: "completed", name: caseSummary(c.caseId)?.title ?? c.caseId, href: `#/case/${c.caseId}` })),
    ...stats.achievements.map((a): HistoryItem => ({ at: a.earnedAt, kind: "earned", name: achievementInfo(getLang(), a.id).label, href: null })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, HISTORY_ITEMS);
  if (items.length === 0) return null;
  const fmt = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric" });
  const full = new Intl.DateTimeFormat(locale(), { dateStyle: "full", timeStyle: "short" });
  return h(
    "section",
    { class: "stats-history", "aria-labelledby": "history-h" },
    h("h2", { id: "history-h", class: "section-title" }, TS().historyTitle),
    h("p", { class: "muted small stats-group-note" }, TS().historyNote),
    h(
      "ol",
      { class: "stats-history-list" },
      items.map((item) =>
        h(
          "li",
          { class: `stats-history-item is-${item.kind}` },
          h("time", { class: "stats-history-when small muted", datetime: item.at, title: full.format(new Date(item.at)) }, fmt.format(new Date(item.at))),
          h("span", { class: "stats-history-kind small" }, item.kind === "completed" ? TS().histCompleted : TS().histEarned),
          h("bdi", { class: "stats-history-name" }, item.href === null ? item.name : h("a", { href: item.href }, item.name)),
        ),
      ),
    ),
  );
}

function draw(root: HTMLElement, account: AccountView, stats: UserStats, board: LeaderboardResponse | null): void {
  const since = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", year: "numeric" }).format(new Date(stats.createdAt));
  const zero = isZeroState(stats);

  setChildren(
    root,
    h(
      "section",
      { class: "stats-page" },
      h("h1", {}, TA().statsTitle),
      withTip(h("p", { class: "page-meta" }, h("strong", {}, h("bdi", {}, stats.username)), " · ", TA().memberSince(since)), TO().statsSub),
      account.kind === "guest" ? upgradeCard() : null,
      zero
        ? zeroState()
        : [
            // 1. Summary: the four numbers that answer "how am I doing?"
            h("section", { class: "stats-summary", "aria-labelledby": "summary-h" }, h("h2", { id: "summary-h", class: "visually-hidden" }, TS().summaryTitle), kpiGrid(stats, board)),
            // 2. Progress per case, right under the tiles: "how did I do on each case?"
            h(
              "section",
              { class: "stats-progress", "aria-labelledby": "per-case-h" },
              h("h2", { id: "per-case-h", class: "section-title" }, TS().progressTitle),
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
            ),
            // 3. Achievements, with progress toward the counted ones.
            achievementsGrid(stats),
            // 4. History.
            historySection(stats),
          ],
      classesSection(account, stats.username),
      settingsLink(account),
    ),
  );
}

/** A guest's upgrade card: the same dialog as the guest banner (views/guest.ts). */
function upgradeCard(): HTMLElement {
  return h(
    "section",
    { class: "stats-upgrade", "aria-labelledby": "upgrade-h" },
    h("div", { class: "stats-upgrade-text" }, h("h2", { id: "upgrade-h", class: "stats-upgrade-title" }, TC().guestTitle), h("p", { class: "muted small" }, TC().upgradeNote)),
    h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => openUpgradeDialog() }, TGu().createAccount),
  );
}

type ClassRow = { readonly summary: ClassSummary; readonly rank: number | null; readonly of: number; readonly score: number | null; readonly failed: boolean };

const roleText = (kind: ClassRoleKind): string =>
  kind === "owner" ? TC().roleOwner : kind === "admin" ? TC().roleAdmin : kind === "member" ? TC().roleMember : TC().rolePending;

function classColumns(): Column<ClassRow>[] {
  return [
    {
      id: "class",
      header: TC().colClass,
      rowHeader: true,
      sortValue: (r) => r.summary.name.toLocaleLowerCase(),
      cell: (r) => h("a", { href: `#/class/${encodeURIComponent(r.summary.id)}` }, h("bdi", {}, r.summary.name)),
    },
    { id: "role", header: TC().colRole, sortValue: (r) => classRoleKind(r.summary), cell: (r) => roleText(classRoleKind(r.summary)) },
    {
      id: "rank",
      header: TC().colClassRank,
      numeric: true,
      sortValue: (r) => r.rank,
      cell: (r) =>
        r.rank !== null
          ? TO().rankOfN(r.rank, Math.max(r.of, r.rank))
          : r.failed || classRoleKind(r.summary) === "pending"
            ? none()
            : h("span", { class: "muted" }, TC().noClassPoints),
    },
    { id: "score", header: TC().colClassScore, numeric: true, sortFirst: "desc", sortValue: (r) => r.score, cell: (r) => (r.score === null ? none() : TG().scorePts(r.score)) },
  ];
}

/**
 * Each class's board place: GET /api/classes, then for at most HOME_CLASS_LIMIT active memberships the class detail
 * (for its board token) and the class board, which is public and CDN-cached. Pending requests have no board.
 */
async function loadClassRows(username: string): Promise<ClassRow[]> {
  const classes = (await fetchMyClasses()).filter((c) => c.status === "active" && c.membership !== null);
  let budget = HOME_CLASS_LIMIT;
  return Promise.all(
    classes.map(async (summary): Promise<ClassRow> => {
      const blank: ClassRow = { summary, rank: null, of: 0, score: null, failed: false };
      if (summary.membership?.status !== "active" || budget <= 0) return blank;
      budget -= 1;
      try {
        const detail = await fetchClass(summary.id);
        if (detail.boardToken === undefined) return blank;
        const board = await fetchClassBoard(detail.boardToken, null);
        const entry = boardEntryFor(board.entries, username);
        return { summary, rank: entry?.rank ?? null, of: board.entries.length, score: entry?.score ?? null, failed: false };
      } catch {
        return { ...blank, failed: true };
      }
    }),
  );
}

function classesSection(account: AccountView, username: string): HTMLElement {
  const body = h("div", { class: "stats-classes-body" });
  const section = h(
    "section",
    { class: "stats-card stats-classes", "aria-labelledby": "classes-h" },
    h(
      "header",
      { class: "stats-card-head" },
      h("h2", { id: "classes-h", class: "section-title" }, TC().statsClassesTitle),
      account.kind === "guest" ? null : h("a", { class: "small", href: "#/classes" }, TC().allClasses),
    ),
    body,
  );
  if (account.kind === "guest") {
    setChildren(body, h("p", { class: "muted small" }, TC().statsClassesGuest));
    return section;
  }
  const load = (): void => {
    setChildren(body, h("p", { class: "muted small", role: "status" }, T().loading));
    loadClassRows(username)
      .then((rows) => {
        if (rows.length === 0) {
          setChildren(body, h("p", { class: "muted small" }, TC().statsClassesEmpty), h("a", { class: "btn btn-sm", href: "#/classes" }, TC().ctaAction));
          return;
        }
        setChildren(
          body,
          dataTable({ columns: classColumns(), rows, labelledBy: "classes-h", className: "stats-classes-table", wrapClass: "stats-classes-wrap", regionLabel: TC().classesRegion, stackOnPhone: true }).element,
        );
      })
      .catch(() => {
        setChildren(
          body,
          h("div", { class: "stats-classes-error", role: "alert" }, h("p", { class: "small" }, TC().classesFailed), h("button", { type: "button", class: "btn btn-sm", onclick: load }, T().tryAgain)),
        );
      });
  };
  load();
  return section;
}

export function renderStats(root: HTMLElement): void {
  document.title = `${TA().statsTitle} · IncidentLab`;
  withApprovedAccount(
    root,
    TA().statsTitle,
    (account) => {
      setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted" }, TA().statsLoading)));
      const board = fetchLeaderboard(null).catch(() => null); // comparisons only: never blocks the page
      Promise.all([fetchMyStats(), board])
        .then(([stats, leaderboard]) => draw(root, account, stats, leaderboard))
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
