// Read-only pieces of the live grid: a player's per-stage progress cells (the tooltip carries the details) and
// the per-stage score breakdown table in an expanded row.
import { T } from "../../i18n/strings-tools";
import { h } from "../../lib/dom";
import type { AdminProgress } from "../../../shared/contract";
import { caseQuestionIds, questionTitle, type StageKey } from "./caseInfo";
import { fmtInt, formatSeconds } from "./format";
import { progressCount, signed, stageStatus, stageTooltip } from "./progressMetrics";
import { th } from "./ui";

export function progressCells(p: AdminProgress, stages: readonly StageKey[], now: number): HTMLElement {
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

/** Per-stage scoring for one player (the same numbers as the cell tooltips, reachable by keyboard and touch). */
export function breakdownTable(p: AdminProgress): HTMLElement {
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
          h("td", { class: "num" }, b ? fmtInt(b.base) : "—"),
          h("td", { class: "num" }, num(b?.hints)),
          h("td", { class: "num", title: T().admCommandsUsed(sp?.commandsRevealed ?? 0) }, num(b?.commands)),
          h("td", { class: "num" }, num(b?.wrong)),
          h("td", { class: "num" }, num(b?.time)),
          h("td", { class: "num" }, num(b?.clean)),
          h("td", { class: "num" }, num(b?.firstBlood)),
          h("td", { class: "num col-score" }, b ? fmtInt(b.total) : sp?.status === "solved" ? fmtInt(sp.points) : "—"),
          h("td", { class: "num col-seen" }, b ? T().admSolveVsTarget(formatSeconds(b.solveSeconds), formatSeconds(b.targetSeconds)) : "—"),
        );
      }),
    ),
  );
}
