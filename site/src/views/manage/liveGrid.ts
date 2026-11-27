// The live players grid: per-stage progress cells, score, current stage, time on it, last seen and a row menu
// (restart a player's case), with search, sort, "active only", density, CSV export and the score breakdown in an
// expanded row. Phone and tablet widths get cards. Scoped by its options: the case and its progress come from
// the dashboard's poll, and the restart goes through `api`.
import { T } from "../../i18n/strings-tools";
import { getLang } from "../../i18n/i18n";
import { copyButton, h, setChildren } from "../../lib/dom";
import { dataTable, type Column } from "../../components/dataTable";
import type { SortState } from "../../components/table-core";
import type { AdminProgress } from "../../../shared/contract";
import type { AdminProgressResult } from "../../lib/admin-api";
import { caseQuestionIds, caseStages, caseTitle, questionTitle, type StageKey } from "./caseInfo";
import { fmtInt, formatDateTime, formatMinutes, ms, readPref, relativeAgo, writePref } from "./format";
import { NARROW_QUERY, syncSortSelect, type ManageHost } from "./host";
import { breakdownTable, progressCells } from "./liveCells";
import {
  commandsUsed,
  isDone,
  isFinishedStatus,
  isIdle,
  minutesSince,
  progressCount,
  sortPlayers,
  stageLongLabel,
  stageStatus,
  stuckLevel,
  type LiveSortKey,
} from "./progressMetrics";
import { tipped } from "./ui";

const DENSITY_STORAGE = "il.adminDensity";

export type LiveGridApi = {
  /** Move one player's progress on a case to the trash (the player starts the case again). */
  restartPlayer(accountId: string, caseId: string): Promise<void>;
};

export type LiveGridOptions = {
  host: ManageHost;
  /** The case on screen (null when none is released). */
  caseId(): string | null;
  /** The latest progress the dashboard fetched (it may still be for the previous case). */
  progress(): AdminProgressResult | null;
  api: LiveGridApi;
  /** After a confirmed restart: the admin dashboard offers Undo from its trash. */
  onRestarted?: (player: AdminProgress) => Promise<void>;
};

export type LiveGrid = {
  /** The "Players" section (built on each call; the table element is kept). */
  section(): HTMLElement;
  /** Re-draws the rows from the current progress, search and filters. */
  render(): void;
  /** Lists the player (clearing filters that hide them), then scrolls to, focuses and flashes the row. */
  jumpTo(accountId: string): void;
  /** Applies the remembered density to the buttons and the table. */
  syncDensity(): void;
  /** Players whose breakdown is open (dropped by the panel when they leave the list). */
  readonly expandedIds: Set<string>;
};

export function createLiveGrid(opts: LiveGridOptions): LiveGrid {
  const { host } = opts;
  let liveSort: LiveSortKey = "score";
  let liveFilter = "";
  let liveActiveOnly = false;
  let liveDensity: "compact" | "comfortable" = readPref(DENSITY_STORAGE) === "compact" ? "compact" : "comfortable";
  /** players whose score breakdown is open */
  const expandedIds = new Set<string>();

  const liveTableEl = h("div", { class: "admin-table-wrap live-table-wrap" });
  const playersCountEl = h("span", { class: "muted small" });

  const liveSearchInput = h("input", {
    type: "search",
    class: "admin-input admin-search",
    placeholder: T().admSearchPlaceholder,
    "aria-label": T().admSearchLabel,
    enterkeyhint: "search",
    dir: "auto",
  });
  liveSearchInput.addEventListener("input", () => {
    liveFilter = liveSearchInput.value;
    render();
  });
  const liveSortSelect = h(
    "select",
    { class: "admin-input admin-sort", "aria-label": T().admSortLabel },
    h("option", { value: "score" }, T().admSortScore),
    h("option", { value: "progress" }, T().admSortProgress),
    h("option", { value: "stuck" }, T().admSortStuck),
    h("option", { value: "name" }, T().admSortName),
    h("option", { value: "custom", hidden: true, disabled: true }, T().admSortCustom),
  );
  liveSortSelect.addEventListener("change", () => {
    const v = liveSortSelect.value;
    if (v === "score" || v === "progress" || v === "name" || v === "stuck") {
      liveSort = v;
      liveTable.setSort(LIVE_SORTS[v]);
    }
  });

  // "Active only": hides finished and idle players (the ones the instructor can't help right now).
  const activeOnlyInput = h("input", { type: "checkbox", id: "admin-live-active" });
  activeOnlyInput.addEventListener("change", () => {
    liveActiveOnly = activeOnlyInput.checked;
    render();
  });
  const activeOnlyLabel = h("label", { class: "admin-check", for: "admin-live-active" }, activeOnlyInput, h("span", {}, T().admActiveOnly));

  // Density: a segmented control (two toggle buttons) that changes how the same rows are drawn. Remembered.
  const densityBtns = (["comfortable", "compact"] as const).map((d) => {
    const btn = h("button", { type: "button", class: "seg-btn", "data-density": d }, d === "compact" ? T().admDensityCompact : T().admDensityComfortable);
    btn.addEventListener("click", () => {
      liveDensity = d;
      writePref(DENSITY_STORAGE, d);
      syncDensity();
    });
    return btn;
  });
  const densityGroup = h("div", { class: "seg", role: "group", "aria-label": T().admDensityLabel }, densityBtns);
  function syncDensity(): void {
    for (const btn of densityBtns) btn.setAttribute("aria-pressed", String(btn.dataset.density === liveDensity));
    liveTableEl.classList.toggle("is-compact", liveDensity === "compact");
  }

  // The players grid (components/dataTable.ts): per-stage cells, score, stage, time on it, last seen and the row
  // menu. Headers sort (the Sort select drives the same sort and is the only one on cards). Keyed rows keep focus
  // across the 5 s poll; the breakdown opens as a detail row. Cards on phones and tablets.
  let liveNow = Date.now();
  let liveStages: StageKey[] = [];
  const prog = (p: AdminProgress): number => progressCount(p, liveStages);
  const stuckKey = (p: AdminProgress): number => (isDone(p) ? -1 : p.stuckMinutes);
  const liveColumns: Column<AdminProgress>[] = [
    {
      id: "name",
      header: T().admColName,
      rowHeader: true,
      className: "col-name",
      cell: (p) => liveToggle(p, `live-detail-${p.accountId}`, T().admShowBreakdown),
      sortValue: (p) => p.username,
      csv: (p) => p.username,
    },
    {
      id: "progress",
      header: T().admColProgress,
      cell: (p) => progressCells(p, liveStages, liveNow),
      sortCompare: (a, b) => prog(a) - prog(b) || a.score - b.score,
      sortFirst: "desc",
      csv: (p) => prog(p),
    },
    {
      id: "score",
      header: T().admColScore,
      numeric: true,
      className: "col-score",
      cell: (p) => h("span", { title: T().admScoreParTip(p.maxScore) }, fmtInt(p.score)),
      sortCompare: (a, b) => a.score - b.score || prog(a) - prog(b),
      sortFirst: "desc",
      csv: (p) => p.score,
    },
    {
      id: "stage",
      header: T().admColStage,
      className: "col-stage",
      cell: (p) => {
        const stage = stageLongLabel(p.caseId, p.currentStage);
        return h("span", { class: `stage-text${isDone(p) ? " stage-done" : ""}`, title: stage }, stage);
      },
      csv: (p) => stageLongLabel(p.caseId, p.currentStage),
    },
    {
      id: "onstage",
      header: T().admColOnStage,
      numeric: true,
      className: "col-onstage",
      cell: (p) => onStage(p, liveNow),
      sortCompare: (a, b) => stuckKey(a) - stuckKey(b),
      sortFirst: "desc",
      csv: (p) => (isDone(p) ? null : Math.floor(p.stuckMinutes)),
    },
    {
      id: "seen",
      header: T().admColSeen,
      className: "col-seen muted",
      cell: (p) => tipped(h("span", {}, relativeAgo(p.lastSeenAt, liveNow)), formatDateTime(p.lastSeenAt)),
      sortValue: (p) => ms(p.lastSeenAt),
      sortFirst: "desc",
      csv: (p) => p.lastSeenAt,
    },
    { id: "actions", header: T().admColActions, headerHidden: true, className: "col-actions", cell: (p) => liveMenu(p) },
  ];
  const LIVE_SORTS: Record<LiveSortKey, SortState> = {
    score: { id: "score", dir: "desc" },
    progress: { id: "progress", dir: "desc" },
    stuck: { id: "onstage", dir: "desc" },
    name: { id: "name", dir: "asc" },
  };
  const liveTable = dataTable<AdminProgress>({
    columns: liveColumns,
    rows: [],
    rowKey: (p) => p.accountId,
    rowSig: (p) => liveSignature(p, liveStages, liveNow),
    rowAttrs: (p) => ({ class: `acct-row is-${stuckLevel(p)}${expandedIds.has(p.accountId) ? " is-expanded" : ""}`, "data-id": p.accountId }),
    detail: (p) =>
      expandedIds.has(p.accountId)
        ? {
            attrs: { class: "acct-detail", id: `live-detail-${p.accountId}` },
            content: h("div", { class: "acct-detail-inner" }, h("p", { class: "admin-label" }, T().admBreakdownTitle(p.username)), breakdownTable(p)),
          }
        : null,
    labelledBy: "admin-players-title",
    className: "admin-table live-table",
    wrapClass: "admin-dt",
    initialSort: LIVE_SORTS[liveSort],
    virtualize: { rowHeight: 52 },
    cards: { query: NARROW_QUERY, build: (p) => buildLiveCard(p, liveStages, liveNow), className: "player-cards", labelledBy: "admin-players-title" },
    onSortChange: (s) => syncSortSelect(liveSortSelect, LIVE_SORTS, s),
  });
  const liveExportBtn = h(
    "button",
    {
      type: "button",
      class: "btn btn-ghost btn-sm",
      title: T().admExportViewHint,
      onclick: () => liveTable.downloadCsv(`incidentlab-live-${opts.caseId() ?? "case"}-${new Date().toISOString().slice(0, 10)}.csv`),
    },
    T().admExportView,
  );

  /** "Jump" from Needs help: make sure the player is listed (clear filters that hide them), then scroll, focus and flash. */
  function jumpTo(id: string): void {
    const p = opts.progress()?.players.find((x) => x.accountId === id);
    if (!p) return;
    const q = liveFilter.trim().toLowerCase();
    if (q && !p.username.toLowerCase().includes(q)) {
      liveFilter = "";
      liveSearchInput.value = "";
    }
    if (liveActiveOnly && !isLiveActive(p, Date.now())) {
      liveActiveOnly = false;
      activeOnlyInput.checked = false;
    }
    render();
    const target = liveTableEl.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "auto" });
    target.querySelector<HTMLElement>(".acct-toggle")?.focus({ preventScroll: true });
    target.classList.remove("is-flash");
    void target.offsetWidth; // restart the highlight
    target.classList.add("is-flash");
    window.setTimeout(() => target.classList.remove("is-flash"), 2000);
  }

  const isLiveActive = (p: AdminProgress, now: number): boolean => !isDone(p) && !isIdle(p, now);

  function liveSignature(p: AdminProgress, stages: readonly StageKey[], now: number): string {
    const st = stages
      .map((s) => {
        const sp = s === "setup" ? undefined : p.stages[s];
        return `${stageStatus(p, s)}:${sp?.wrongAttempts ?? 0}:${sp?.hintsRevealed ?? 0}`;
      })
      .join(",");
    const id = p.accountId;
    return [
      getLang(),
      p.caseId,
      p.username,
      p.score,
      p.currentStage,
      Math.floor(p.stuckMinutes),
      st,
      relativeAgo(p.lastSeenAt, now),
      isIdle(p, now),
      commandsUsed(p),
      expandedIds.has(id) ? JSON.stringify(p.stages) : "",
    ].join("|");
  }

  function liveToggle(p: AdminProgress, detailId: string, title: string): HTMLButtonElement {
    const expanded = expandedIds.has(p.accountId);
    return h(
      "button",
      {
        type: "button",
        class: "acct-toggle",
        "aria-expanded": String(expanded),
        "aria-controls": detailId,
        title,
        onclick: () => {
          if (expandedIds.has(p.accountId)) expandedIds.delete(p.accountId);
          else expandedIds.add(p.accountId);
          render();
          host.container.querySelector<HTMLButtonElement>(`[aria-controls="${CSS.escape(detailId)}"]`)?.focus();
        },
      },
      h("span", { class: "acct-caret", "aria-hidden": "true" }, "▸"),
      h("span", { class: "player-name", dir: "auto" }, p.username),
    );
  }

  /** Restart lives in the row's actions menu: a destructive per-player action, not a button on every row. */
  function liveMenu(p: AdminProgress): HTMLButtonElement {
    const caseId = p.caseId;
    const key = `live:${p.accountId}`;
    return host.menuButton(T().admActionsFor(p.username), key, () => [
      {
        label: T().admRestartItem,
        tone: "danger",
        run: () => {
          const solved = caseQuestionIds(caseId).filter((q) => isFinishedStatus(p.stages[q]?.status ?? "locked")).length;
          void host.askConfirm({
            title: T().admRestartTitle(p.username, caseTitle(caseId)),
            body: T().admRestartBody(solved, p.score),
            confirmLabel: T().admRestartLabel(p.username),
            cancelLabel: T().admKeepProgress,
            busyLabel: T().admRestarting,
            tone: "danger",
            run: async () => {
              await opts.api.restartPlayer(p.accountId, caseId);
              host.refresh();
            },
            returnFocus: () => host.menuTriggerEl(key),
          }).then(async (ok) => {
            if (!ok) return;
            await opts.onRestarted?.(p);
          });
        },
      },
    ]);
  }

  /** "12 min" on the current stage (nothing for finished players), toned like the stuck badge. */
  function onStage(p: AdminProgress, now: number): HTMLElement {
    if (isDone(p)) return h("span", { class: "muted" }, host.narrow() ? "" : "—");
    if (isIdle(p, now)) return h("span", { class: "help-chip is-idle" }, T().admIdleChip(formatMinutes(minutesSince(p.lastSeenAt, now) ?? 0)));
    const level = stuckLevel(p);
    return h("span", { class: level === "none" ? "" : `stuck-badge is-${level}`, title: T().admStuckTip(Math.floor(p.stuckMinutes)) }, formatMinutes(p.stuckMinutes));
  }

  /** Phone/tablet card: name, score, current stage, minutes on it, and an expandable labelled stage strip. */
  function buildLiveCard(p: AdminProgress, stages: readonly StageKey[], now: number): HTMLLIElement {
    const expanded = expandedIds.has(p.accountId);
    const detailId = `live-card-${p.accountId}`;
    const stage = stageLongLabel(p.caseId, p.currentStage);
    const strip = expanded
      ? h(
          "ol",
          { class: "stage-strip", id: detailId },
          stages.map((s) => {
            const status = stageStatus(p, s);
            const sp = s === "setup" ? undefined : p.stages[s];
            const title = s === "setup" ? T().admSetup : questionTitle(p.caseId, s);
            const extra = sp && status === "solved" ? T().admPointsShort(fmtInt(sp.points)) : sp && sp.wrongAttempts > 0 ? T().admWrongChip(fmtInt(sp.wrongAttempts)) : "";
            return h(
              "li",
              { class: `strip-item is-${status}` },
              h("span", { class: `cell is-${status}`, "aria-hidden": "true" }),
              h("span", { class: "strip-label" }, s === "setup" ? T().admSetup : s.toUpperCase(), " ", h("span", { class: "muted" }, s === "setup" ? "" : title)),
              h("span", { class: "strip-status" }, T().admStatus(status), extra ? ` · ${extra}` : ""),
            );
          }),
        )
      : null;
    return h(
      "li",
      { class: `player-card is-${stuckLevel(p)}${expanded ? " is-expanded" : ""}`, "data-id": p.accountId },
      h(
        "div",
        { class: "pc-head" },
        liveToggle(p, detailId, T().admShowStages),
        h("span", { class: "pc-score", title: T().admScoreParTip(p.maxScore) }, T().admPointsShort(fmtInt(p.score))),
        liveMenu(p),
      ),
      h(
        "div",
        { class: "pc-meta" },
        h("span", { class: `pc-stage${isDone(p) ? " stage-done" : ""}`, title: stage }, stage),
        onStage(p, now),
      ),
      expanded ? null : progressCells(p, stages, now),
      strip,
      expanded ? h("p", { class: "muted small pc-seen" }, T().admSeenLine(relativeAgo(p.lastSeenAt, now))) : null,
    );
  }

  function render(): void {
    const caseId = opts.caseId();
    const players = opts.progress()?.players ?? [];
    if (!caseId) return;
    if (players.length === 0) {
      playersCountEl.textContent = "";
      const url = location.origin;
      setChildren(
        liveTableEl,
        h(
          "div",
          { class: "admin-empty" },
          h("p", { class: "admin-empty-title" }, opts.progress() ? T().admNoPlayers : T().admLoading),
          opts.progress() ? h("p", { class: "muted" }, T().admShareLink) : null,
          opts.progress()
            ? h("div", { class: "admin-share" }, h("code", { class: "admin-share-url" }, url), copyButton(() => url, T().admCopyLink))
            : null,
        ),
      );
      return;
    }
    const now = Date.now();
    const q = liveFilter.trim().toLowerCase();
    const filtered = players.filter((p) => (!q || p.username.toLowerCase().includes(q)) && (!liveActiveOnly || isLiveActive(p, now)));
    playersCountEl.textContent = filtered.length === players.length ? `(${fmtInt(players.length)})` : `(${T().admShownOf(fmtInt(filtered.length), fmtInt(players.length))})`;
    if (filtered.length === 0) {
      setChildren(liveTableEl, h("p", { class: "muted admin-empty-small" }, liveActiveOnly && !q ? T().admNoActive : T().admNoMatch));
      return;
    }
    liveNow = now;
    liveStages = caseStages(caseId);
    // Name order first: the table's sort is stable, so ties read alphabetically.
    liveTable.update(sortPlayers(filtered, "name", liveStages));
    if (liveTable.element.parentNode !== liveTableEl) setChildren(liveTableEl, liveTable.element);
  }

  function section(): HTMLElement {
    return h(
      "section",
      { class: "panel admin-panel", "aria-labelledby": "admin-players-title" },
      h(
        "div",
        { class: "admin-table-head" },
        h("h2", { class: "admin-h2", id: "admin-players-title" }, T().admPlayers, " ", playersCountEl),
        h("div", { class: "admin-controls" }, liveSearchInput, liveSortSelect, activeOnlyLabel, densityGroup, liveExportBtn),
      ),
      h(
        "div",
        { class: "admin-legend", "aria-hidden": "true" },
        h("span", { class: "cell is-solved" }), T().admStatus("solved"),
        h("span", { class: "cell is-revealed" }), T().admStatus("revealed"),
        h("span", { class: "cell is-active" }), T().admStatus("active"),
        h("span", { class: "cell is-locked" }), T().admStatus("locked"),
      ),
      liveTableEl,
    );
  }

  return { section, render, jumpTo, syncDensity, expandedIds };
}
