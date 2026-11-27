// The live progress panel for one case: the case picker, "Needs help" (manage/liveHelp.ts), the KPI tiles, the
// players grid (manage/liveGrid.ts), the stage funnel and the danger zone (reset the case for everyone).
// Scoped by its options: the case, the cases to pick from and the progress come from the dashboard's poll;
// picking a case and the destructive actions go back through callbacks and `api`.
import { T } from "../../i18n/strings-tools";
import { TE } from "../../i18n/strings-errors";
import { T as TP } from "../../i18n/strings-player";
import { getLang } from "../../i18n/i18n";
import { h, setChildren } from "../../lib/dom";
import { statGrid } from "../../components/statGrid";
import type { AdminProgress } from "../../../shared/contract";
import type { AdminProgressResult } from "../../lib/admin-api";
import { caseMaxScore, caseStages, caseTitle, questionTitle } from "./caseInfo";
import { fmtInt, formatFinish, formatPct, median } from "./format";
import { setTilesSummary, type ManageHost } from "./host";
import { createLiveGrid, type LiveGridApi } from "./liveGrid";
import { createLiveHelp } from "./liveHelp";
import { finishDurationMs, helpEntries, isDone, isFinishedStatus, stageLabel, stageStatus, type HelpEntry } from "./progressMetrics";
import { tile } from "./ui";

export type LiveApi = LiveGridApi & {
  /** Move everyone's progress on the case to the trash. Optional: without it there is no danger zone (classes). */
  resetCase?(caseId: string): Promise<void>;
};

export type LiveOptions = {
  host: ManageHost;
  /** The case on screen (null when none is released). */
  caseId(): string | null;
  /** The cases to pick from, and today's case (tagged in the picker). */
  cases(): { released: readonly string[]; todayId: string | null };
  /** The latest progress the dashboard fetched (ignored while it is for another case). */
  progress(): AdminProgressResult | null;
  /** The instructor picked another case: the dashboard switches, fetches and calls render(). */
  onSelectCase(caseId: string): void;
  api: LiveApi;
  /**
   * Why the latest progress fetch failed (null: it did not). Without progress for the case on screen the panel
   * shows this with Retry instead of an empty state; with older progress it keeps that and marks it stale.
   */
  loadError?(): string | null;
  /** Retry after `loadError`: the dashboard fetches again and calls render(). */
  onRetry?(): void;
  /** After a confirmed case reset: the admin dashboard offers Undo from its trash. */
  onCaseReset?: (caseId: string, title: string) => Promise<void>;
  /** After a confirmed player restart: the admin dashboard offers Undo from its trash. */
  onRestarted?: (player: AdminProgress) => Promise<void>;
};

export type LivePanel = {
  /** Fills the dashboard's section element with the picker and the panel body. */
  mount(panel: HTMLElement): void;
  render(): void;
};

export function createLivePanel(opts: LiveOptions): LivePanel {
  const { host } = opts;
  const liveCaseSelect = h("select", { class: "admin-input", id: "admin-live-case" });
  liveCaseSelect.addEventListener("change", () => {
    const v = liveCaseSelect.value;
    if (v) opts.onSelectCase(v);
  });

  let liveCaseOptionsSig = "";
  const liveTodayTag = h("span", { class: "today-tag" }, T().admTodayTag);
  const liveTilesEl = statGrid([], "admin-tiles");
  liveTilesEl.id = "admin-live-tiles";
  const liveTiles = host.foldableTiles(liveTilesEl);
  const funnelEl = h("div", { class: "admin-funnel" });
  const help = createLiveHelp({ onJump: (id) => grid.jumpTo(id), rerender: () => render() });
  const grid = createLiveGrid({ host, caseId: opts.caseId, progress: opts.progress, api: opts.api, onRestarted: opts.onRestarted });
  const liveBodyEl = h("div", { class: "admin-live-body" });
  /** "Couldn't load" above data that is still on screen from an earlier fetch. */
  const staleEl = h("p", { class: "admin-error", role: "alert", hidden: true });

  /** The panel-scoped error: the fetch failed and there is nothing current to show. */
  function errorPanel(detail: string): HTMLElement {
    const retry = opts.onRetry;
    return h(
      "section",
      { class: "panel admin-panel admin-empty admin-load-failed", role: "alert" },
      h("p", { class: "admin-empty-title" }, TE().panelLoadFailed),
      h("p", { class: "muted small" }, detail),
      retry === undefined ? null : h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => retry() }, TP().tryAgain),
    );
  }

  // Reset this case: a danger confirm that needs the case id typed in.
  const resetBtn = h("button", { type: "button", class: "btn btn-danger btn-sm" }, T().admResetCase);
  const resetTextEl = h("p", { class: "muted small" });
  resetBtn.addEventListener("click", () => {
    const caseId = opts.caseId();
    const resetCase = opts.api.resetCase;
    if (!caseId || resetCase === undefined) return;
    const title = caseTitle(caseId);
    void host
      .askConfirm({
        title: T().admResetCaseTitle(title),
        body: T().admResetCaseText(title),
        confirmLabel: T().admResetCase,
        busyLabel: T().admResetting,
        tone: "danger",
        typedName: caseId,
        run: () => resetCase(caseId),
        returnFocus: () => resetBtn,
      })
      .then(async (ok) => {
        if (!ok) return;
        host.refresh();
        await opts.onCaseReset?.(caseId, title);
      });
  });

  function mount(panel: HTMLElement): void {
    setChildren(
      panel,
      h(
        "div",
        { class: "admin-toolbar" },
        h("label", { class: "admin-label", for: "admin-live-case" }, T().admCasePicker),
        liveCaseSelect,
        liveTodayTag,
      ),
      liveBodyEl,
    );
    grid.syncDensity();
  }

  function liveBodySkeleton(): HTMLElement[] {
    return [
      staleEl,
      // The first question on this tab is "who needs me right now?": answered before anything else.
      help.el,
      liveTiles,
      grid.section(),
      h("section", { class: "panel admin-panel" }, h("h2", { class: "admin-h2" }, T().admStageFunnel), funnelEl),
      opts.api.resetCase === undefined
        ? null
        : h(
            "section",
            { class: "panel admin-panel admin-danger" },
            h("h2", { class: "admin-h2" }, T().admDangerZone),
            resetTextEl,
            h("div", { class: "admin-reset" }, resetBtn),
          ),
    ].filter((el): el is HTMLElement => el !== null);
  }

  function syncLiveCaseOptions(): void {
    const { released, todayId } = opts.cases();
    const current = opts.caseId();
    const ids = [...released];
    if (current && !ids.includes(current)) ids.push(current);
    const sig = JSON.stringify([getLang(), ids, todayId]);
    if (sig !== liveCaseOptionsSig) {
      liveCaseOptionsSig = sig;
      setChildren(
        liveCaseSelect,
        ids.map((id) => h("option", { value: id }, id === todayId ? `${caseTitle(id)} · ${T().admTodayTag}` : caseTitle(id))),
      );
    }
    if (current) liveCaseSelect.value = current;
    liveCaseSelect.disabled = ids.length === 0;
    liveTodayTag.hidden = !current || current !== todayId;
  }

  function renderLiveTiles(players: readonly AdminProgress[], caseId: string, entries: readonly HelpEntry[]): void {
    const finished = players.filter(isDone);
    const avg = players.length ? Math.round(players.reduce((s, p) => s + p.score, 0) / players.length) : null;
    const maxScore = players[0]?.maxScore ?? caseMaxScore(caseId);
    const med = median(finished.map(finishDurationMs).filter((v): v is number => v !== null));
    const needing = entries.filter((e) => e.level !== "idle").length;
    setChildren(
      liveTilesEl,
      tile(T().admPlayers, fmtInt(players.length), T().admStuckCount(needing)),
      tile(T().admFinished, fmtInt(finished.length), players.length ? formatPct(finished.length / players.length) : undefined),
      // Averaged over every player on the case (Stats averages finishers only): the label says which.
      tile(
        T().admAvgScoreAll,
        avg === null ? "—" : fmtInt(avg),
        [maxScore ? T().admPar(fmtInt(maxScore)) : null, T().admSample(players.length, fmtInt(players.length))].filter((x) => x !== null).join(" · "),
      ),
      tile(T().admMedianTime, med === null ? "—" : formatFinish(med), T().admFinishedSample(finished.length, fmtInt(finished.length))),
    );
    setTilesSummary(liveTiles, T().admLiveSummary(fmtInt(players.length), fmtInt(finished.length), fmtInt(needing)));
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
        h("span", { class: "funnel-count" }, `${fmtInt(done)}/${fmtInt(reached)}`),
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

  function render(): void {
    syncLiveCaseOptions();
    const caseId = opts.caseId();
    const error = opts.loadError?.() ?? null;
    const progress = opts.progress();
    const current = caseId !== null && progress?.caseId === caseId;
    // A failed fetch never reads as "no released cases" or an empty class: it gets its own message and Retry.
    if (error !== null && !current) {
      setChildren(liveBodyEl, errorPanel(error));
      return;
    }
    if (!caseId) {
      setChildren(liveBodyEl, h("section", { class: "panel admin-panel admin-empty" }, h("p", { class: "admin-empty-title" }, T().admNoReleased)));
      return;
    }
    if (help.el.parentNode !== liveBodyEl) {
      help.reset();
      setChildren(liveBodyEl, liveBodySkeleton());
    }
    resetTextEl.textContent = T().admResetCaseText(caseTitle(caseId));
    staleEl.hidden = error === null;
    staleEl.textContent = error === null ? "" : `${TE().panelLoadFailed} ${TE().staleData}`;
    // A response for a previously selected case is ignored until the new one arrives.
    const players = progress?.caseId === caseId ? progress.players : [];
    for (const id of grid.expandedIds) if (!players.some((p) => p.accountId === id)) grid.expandedIds.delete(id);
    const entries = progress?.caseId === caseId ? helpEntries(players, Date.now()) : null;
    help.render(entries, caseId);
    renderLiveTiles(players, caseId, entries ?? []);
    renderFunnel(players, caseId);
    grid.render();
  }

  return { mount, render };
}
