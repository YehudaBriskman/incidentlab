// Read-only pieces of the members table: the status and author pills, the per-case table in an expanded row,
// its one-line-per-case form on phone cards, and the extra numbers that the column picker may have hidden.
import { T } from "../../i18n/strings-tools";
import { h, type Child } from "../../lib/dom";
import type { AccountStatus, CaseStats, UserStats } from "../../../shared/contract";
import { caseTitle } from "./caseInfo";
import { fmtInt, formatDateTime, formatSeconds } from "./format";
import { th } from "./ui";

export function statusPill(status: AccountStatus): HTMLElement {
  return h("span", { class: `status-pill is-${status}` }, T().admAcctStatus(status));
}

/** The author pill sits beside the status; players get none. */
export function rolePill(a: UserStats): Child {
  return a.role === "author" ? [" ", h("span", { class: "status-pill is-author" }, T().admAuthorPill)] : null;
}

export function caseStatsTable(list: readonly CaseStats[]): HTMLElement {
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
            fmtInt(c.score),
            " ",
            h("span", { class: "muted small" }, `(${T().admPar(fmtInt(c.maxScore))})`),
          ),
          h("td", { class: "num" }, fmtInt(c.solved)),
          h("td", { class: "num" }, fmtInt(c.revealed)),
          h("td", { class: "num" }, fmtInt(c.hintsUsed)),
          h("td", { class: "num" }, fmtInt(c.commandsRevealed)),
          h("td", { class: "num" }, fmtInt(c.wrongAttempts)),
          h("td", { class: "num" }, fmtInt(c.firstBloods)),
          h("td", { class: "num" }, formatSeconds(c.durationSeconds)),
          h("td", { class: "col-seen" }, formatDateTime(c.startedAt)),
          h("td", { class: "col-seen" }, formatDateTime(c.completedAt)),
        ),
      ),
    ),
  );
}

/** The per-case summary on a phone card: one line per case instead of a 12-column table. */
export function caseStatsList(list: readonly CaseStats[]): HTMLElement {
  if (list.length === 0) return h("p", { class: "muted small admin-empty-small" }, T().admNoCasesYet);
  return h(
    "ul",
    { class: "case-lines" },
    list.map((c) =>
      h(
        "li",
        {},
        h("span", { class: "case-line-title" }, caseTitle(c.caseId)),
        h("span", { class: `case-status is-${c.status}` }, T().admCaseStatus(c.status)),
        h("span", { class: "muted small" }, `${T().admPointsShort(fmtInt(c.score))} · ${formatSeconds(c.durationSeconds)}`),
      ),
    ),
  );
}

/** The columns that are off in the chooser still show in the expanded row, so nothing is out of reach. */
export function acctExtras(a: UserStats): string {
  return [
    T().admExtraLine(fmtInt(a.hintsUsed), fmtInt(a.wrongAttempts), fmtInt(a.commandsRevealed)),
    T().admBadgesTip(a.achievements.map((x) => T().admAchievement(x.id)).join(", ")),
    T().admStreakTip(a.streak.current, a.streak.best),
    `${T().admColCreated}: ${formatDateTime(a.createdAt)}`,
  ].join(" · ");
}
