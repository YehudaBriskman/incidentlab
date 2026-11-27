// One case on the stats panel: completion, the median finish time and the hardest question with its numbers,
// then per question how many solved, gave up or are still on it (bars, with the full table one disclosure away).
import { T } from "../../i18n/strings-tools";
import { h } from "../../lib/dom";
import { dataTable } from "../../components/dataTable";
import { cachedCase } from "../../content/load";
import type { AdminProgress, CaseSummary, QuestionId } from "../../../shared/contract";
import { caseMaxScore, caseQuestionIds, questionTitle } from "./caseInfo";
import { fmtDec1, fmtInt, formatFinish, formatPct, median } from "./format";
import { finishDurationMs } from "./progressMetrics";

/** "Hardest question" needs at least this many players who reached it. */
const HARDEST_MIN_PLAYERS = 3;

export type CaseSummaryOptions = {
  /** Every player's progress on the case (who reached each question), or null when not loaded. */
  progress: readonly AdminProgress[] | null;
  /** Today's case gets a "today" tag. */
  isToday: boolean;
  /** Cases whose "Show as a table" is open: the panels re-render on every poll and must not snap shut. */
  tableOpen: Set<string>;
};

export type QuestionFunnel = { q: QuestionId; reached: number; solved: number; revealed: number; avgWrong: number; avgHints: number };

/**
 * Per question: how many players reached it (from the per-player progress when we have it; otherwise the
 * lower bound solved + gave up), and the server's solved / gave-up / averages.
 */
export function questionFunnel(summary: CaseSummary, players: readonly AdminProgress[] | null): QuestionFunnel[] {
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
export function hardestQuestion(rows: readonly QuestionFunnel[]): { row: QuestionFunnel; rate: number } | null {
  let best: { row: QuestionFunnel; rate: number } | null = null;
  for (const row of rows) {
    if (row.reached < HARDEST_MIN_PLAYERS) continue;
    const rate = (row.reached - row.solved) / row.reached;
    if (rate === 0 && row.avgWrong === 0) continue;
    if (best === null || rate > best.rate || (rate === best.rate && row.avgWrong > best.row.avgWrong)) best = { row, rate };
  }
  return best;
}

/**
 * One case: a headline row that answers "how did it go?" (completion, median time, hardest stage with its numbers),
 * then per-question solved / gave up / still on it as bars, with the full numbers one disclosure away.
 */
export function caseSummaryPanel(s: CaseSummary, opts: CaseSummaryOptions): HTMLElement {
  const maxScore = s.maxScore > 0 ? s.maxScore : caseMaxScore(s.caseId);
  const title = cachedCase(s.caseId)?.title ?? s.title;
  const { progress, isToday, tableOpen } = opts;
  const funnel = questionFunnel(s, progress);
  const hardest = hardestQuestion(funnel);
  // Median from the per-player progress when we have it; otherwise the server's mean, labelled as such.
  const finishTimes = progress ? progress.map(finishDurationMs).filter((v): v is number => v !== null) : [];
  const med = median(finishTimes);
  const timeValue = med !== null ? formatFinish(med) : s.avgDurationSeconds !== null ? formatFinish(s.avgDurationSeconds * 1000) : "—";
  const timeLabel = med !== null || s.avgDurationSeconds === null ? T().admMedianTime : T().admAvgTime;
  const timeSample = med !== null ? finishTimes.length : s.completed;
  const head = h(
    "div",
    { class: "stats-case-head" },
    h("h2", { class: "admin-h2" }, title),
    isToday ? h("span", { class: "today-tag" }, T().admTodayTag) : null,
    h("code", { class: "muted small" }, s.caseId),
  );
  if (s.players === 0) {
    return h("section", { class: "panel admin-panel stats-case" }, head, h("p", { class: "muted admin-empty-small" }, T().admNobodyPlayed));
  }
  const hardestLabel = hardest ? `${hardest.row.q.toUpperCase()} ${questionTitle(s.caseId, hardest.row.q)}`.trim() : null;
  const headline = h(
    "div",
    { class: "stats-headline" },
    h(
      "div",
      { class: "stats-kpi is-lead" },
      h("div", { class: "admin-tile-label" }, T().admCompletion),
      h("div", { class: "stats-kpi-value" }, formatPct(s.completed / s.players)),
      h("div", { class: "admin-tile-sub" }, T().admCompletionSub(fmtInt(s.completed), s.players, fmtInt(s.players))),
    ),
    h(
      "div",
      { class: "stats-kpi" },
      h("div", { class: "admin-tile-label" }, timeLabel),
      h("div", { class: "stats-kpi-value" }, timeValue),
      h("div", { class: "admin-tile-sub" }, T().admFinishedSample(timeSample, fmtInt(timeSample))),
    ),
    h(
      "div",
      { class: "stats-kpi is-hardest", title: T().admHardestTip },
      h("div", { class: "admin-tile-label" }, T().admHardestStage),
      hardest && hardestLabel
        ? [
            h("div", { class: "stats-kpi-value stats-kpi-text", title: hardestLabel }, hardestLabel),
            h(
              "div",
              { class: "admin-tile-sub" },
              T().admHardestNumbers(formatPct(hardest.rate), fmtInt(hardest.row.reached), fmtDec1(hardest.row.avgWrong)),
            ),
          ]
        : h("div", { class: "admin-tile-sub" }, T().admHardestNotEnough(HARDEST_MIN_PLAYERS)),
    ),
  );
  const secondary = h(
    "p",
    { class: "muted small stats-secondary" },
    `${T().admAvgScoreFinishers}: ${s.avgScore === null ? "—" : fmtInt(Math.round(s.avgScore))}`,
    maxScore ? ` (${T().admPar(fmtInt(maxScore))})` : "",
    ` · ${T().admFinishedSample(s.completed, fmtInt(s.completed))}`,
  );
  // Per question: a bar of everyone who reached it, split into solved / gave up / still on it (text says the same).
  const bars = h(
    "ol",
    { class: "q-bars", "aria-label": T().admQBarsLabel },
    funnel.map((row) => {
      const stillOn = Math.max(0, row.reached - row.solved - row.revealed);
      const pct = (n: number): string => (row.reached > 0 ? `${(n / row.reached) * 100}%` : "0%");
      const isHardest = hardest?.row.q === row.q;
      const qTitle = questionTitle(s.caseId, row.q);
      return h(
        "li",
        { class: `q-bar-row${isHardest ? " is-hardest" : ""}` },
        h(
          "span",
          { class: "q-bar-label", title: qTitle },
          h("span", { class: "q-id" }, row.q.toUpperCase()),
          " ",
          qTitle,
          isHardest ? h("span", { class: "hardest-badge" }, "⚑ ", T().admHardest) : null,
        ),
        h(
          "span",
          { class: "q-bar-track", "aria-hidden": "true" },
          h("span", { class: "q-bar-seg is-solved", style: `width:${pct(row.solved)}` }),
          h("span", { class: "q-bar-seg is-revealed", style: `width:${pct(row.revealed)}` }),
          h("span", { class: "q-bar-seg is-open", style: `width:${pct(stillOn)}` }),
        ),
        h(
          "span",
          { class: "q-bar-nums" },
          row.reached > 0
            ? T().admQBarNums(fmtInt(row.solved), fmtInt(row.revealed), fmtInt(stillOn), fmtInt(row.reached))
            : T().admQBarNobody,
        ),
      );
    }),
  );
  const qTable = dataTable<QuestionFunnel>({
    columns: [
      { id: "q", header: T().admColQuestion, rowHeader: true, cell: (row) => [h("span", { class: "q-id" }, row.q.toUpperCase()), " ", questionTitle(s.caseId, row.q)] },
      { id: "reached", header: T().admColReached, numeric: true, cell: (row) => fmtInt(row.reached), sortValue: (row) => row.reached, sortFirst: "desc" },
      { id: "solved", header: T().admColSolved, numeric: true, cell: (row) => { const qs = s.questions[row.q]; return qs ? fmtInt(qs.solved) : "—"; }, sortValue: (row) => s.questions[row.q]?.solved ?? null, sortFirst: "desc" },
      { id: "revealed", header: T().admColRevealed, numeric: true, cell: (row) => { const qs = s.questions[row.q]; return qs ? fmtInt(qs.revealed) : "—"; }, sortValue: (row) => s.questions[row.q]?.revealed ?? null, sortFirst: "desc" },
      {
        id: "notSolved",
        header: T().admColNotSolved,
        numeric: true,
        cell: (row) => (row.reached > 0 ? `${fmtInt(row.reached - row.solved)} · ${formatPct((row.reached - row.solved) / row.reached)}` : "—"),
        sortValue: (row) => (row.reached > 0 ? (row.reached - row.solved) / row.reached : null),
        sortFirst: "desc",
      },
      { id: "avgWrong", header: T().admColAvgWrong, numeric: true, cell: (row) => { const qs = s.questions[row.q]; return qs ? fmtDec1(qs.avgWrong) : "—"; }, sortValue: (row) => s.questions[row.q]?.avgWrong ?? null, sortFirst: "desc" },
      { id: "avgHints", header: T().admColAvgHints, numeric: true, cell: (row) => { const qs = s.questions[row.q]; return qs ? fmtDec1(qs.avgHints) : "—"; }, sortValue: (row) => s.questions[row.q]?.avgHints ?? null, sortFirst: "desc" },
    ],
    rows: funnel,
    rowAttrs: (row) => ({ class: hardest?.row.q === row.q ? "is-hardest" : "" }),
    className: "admin-table stats-q-table",
    wrapClass: "admin-dt",
    caption: `${title} · ${T().admQBarsTitle}`,
  });
  const table = h(
    "details",
    { class: "stats-table-view", open: tableOpen.has(s.caseId) },
    h("summary", { class: "link-btn" }, T().admTableView),
    qTable.element,
  );
  table.addEventListener("toggle", () => {
    if (table.open) tableOpen.add(s.caseId);
    else tableOpen.delete(s.caseId);
  });
  return h(
    "section",
    { class: "panel admin-panel stats-case" },
    head,
    headline,
    secondary,
    h("h3", { class: "admin-label stats-q-title" }, T().admQBarsTitle),
    h(
      "p",
      { class: "muted small funnel-key" },
      h("span", { class: "key-done" }), `${T().admColSolved} `,
      h("span", { class: "key-revealed" }), `${T().admColRevealed} `,
      h("span", { class: "key-open" }), T().admStillOn,
    ),
    bars,
    table,
  );
}
