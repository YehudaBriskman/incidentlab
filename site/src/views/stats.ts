// "My stats": the signed-in player's totals, rank and per-case breakdown.
import { ACHIEVEMENT_IDS, type CaseStats, type UserStats } from "../../shared/contract";
import { getCase } from "../content/load";
import { ApiError, fetchMyStats } from "../lib/api";
import { h, setChildren } from "../lib/dom";
import { formatElapsed } from "../lib/time";
import { getLang } from "../i18n/i18n";
import { setAccount } from "../lib/session";
import { TA } from "../i18n/strings-account";
import { TG, achievementInfo } from "../i18n/strings-game";
import { T } from "../i18n/strings-player";
import { passwordChangeForm, withApprovedAccount } from "./auth";

const locale = (): string => (getLang() === "he" ? "he-IL" : "en-GB");

function tile(label: string, value: string, sub?: string): HTMLElement {
  return h("div", { class: "stat-tile" }, h("p", { class: "stat-label" }, label), h("p", { class: "stat-value mono" }, value), sub ? h("p", { class: "muted small" }, sub) : null);
}

function statusText(c: CaseStats): string {
  return c.status === "completed" ? TA().statusDone : c.status === "in-progress" ? TA().statusProgress : TA().statusNew;
}

function caseRow(c: CaseStats): HTMLElement {
  const title = getCase(c.caseId)?.title ?? c.caseId;
  const pct = c.maxScore > 0 ? Math.round((c.score / c.maxScore) * 100) : 0;
  return h(
    "tr",
    { class: `status-${c.status}` },
    h("th", { scope: "row" }, c.status === "not-started" ? title : h("a", { href: `#/case/${c.caseId}` }, title)),
    h("td", {}, h("span", { class: `chip chip-${c.status}` }, statusText(c))),
    h(
      "td",
      { class: "num" },
      h("span", { class: "mono" }, `${c.score}/${c.maxScore}`),
      h("span", { class: "bar", "aria-hidden": "true" }, h("span", { class: "bar-fill", style: `width:${pct}%` })),
    ),
    h("td", { class: "num mono" }, c.durationSeconds === null ? "—" : formatElapsed(c.durationSeconds * 1000)),
    h("td", { class: "num mono" }, String(c.hintsUsed)),
    h("td", { class: "num mono" }, String(c.commandsRevealed)),
    h("td", { class: "num mono" }, String(c.wrongAttempts)),
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

function draw(root: HTMLElement, stats: UserStats): void {
  const since = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", year: "numeric" }).format(new Date(stats.createdAt));
  const accuracy = stats.accuracy === null ? "—" : `${Math.round(stats.accuracy * 100)}%`;
  const released = stats.cases.length;
  const firstBloods = stats.cases.reduce((sum, c) => sum + c.firstBloods, 0);
  setChildren(
    root,
    h(
      "section",
      { class: "stats-page" },
      h("a", { class: "back-link", href: "#/" }, T().navCases),
      h("h1", {}, TA().statsTitle),
      h("p", { class: "muted" }, h("strong", { dir: "auto" }, stats.username), " · ", TA().memberSince(since)),
      h(
        "div",
        { class: "stat-grid" },
        tile(TA().statTotal, String(stats.totalScore)),
        tile(TA().statRank, stats.rank === null ? TA().noRank : TA().rankOf(stats.rank)),
        tile(TA().statCompleted, `${stats.casesCompleted}/${released}`),
        tile(TA().statSolved, String(stats.stagesSolved)),
        tile(TA().statAccuracy, accuracy),
        tile(TA().statHints, String(stats.hintsUsed)),
        tile(TA().statRevealed, String(stats.stagesRevealed)),
        tile(TA().statWrong, String(stats.wrongAttempts)),
        tile(TG().statCommands, String(stats.commandsRevealed)),
        tile(TG().statFirstBloods, String(firstBloods)),
        tile(TG().statStreak, TG().streakValue(stats.streak.current, stats.streak.best), TG().streakSub),
      ),
      achievementsGrid(stats),
      h("h2", { class: "section-title" }, TA().perCase),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "stats-table" },
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
        "section",
        { class: "pw-section", "aria-labelledby": "pw-h" },
        h("h2", { id: "pw-h", class: "section-title" }, TG().pwTitle),
        passwordChangeForm({ forced: false, idPrefix: "me-pw", onChanged: (account) => setAccount(account) }),
      ),
    ),
  );
}

export function renderStats(root: HTMLElement): void {
  document.title = `${TA().statsTitle} · IncidentLab`;
  withApprovedAccount(root, TA().statsTitle, () => {
    setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted mono" }, TA().statsLoading)));
    fetchMyStats()
      .then((stats) => draw(root, stats))
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
  });
}
