// The projector board: a full-screen dialog (lib/overlay.ts) with the top 10 and "+N more", scoped to all cases
// or one, the event's countdown and whether the standings are frozen. It shows the PUBLIC board, so a freeze
// hides the live standings from the room exactly as it does for players; never ranks from private data.
// Scoped by its options: the board loads through `api`, the scopes and the event clock come from the dashboard.
import { T } from "../../i18n/strings-tools";
import { h, setChildren } from "../../lib/dom";
import { showDialog, type DialogHandle } from "../../lib/overlay";
import { eventPhase, formatCountdown } from "../../lib/event";
import type { LeaderboardResponse, LiveEvent } from "../../../shared/contract";
import { caseTitle } from "./caseInfo";
import { errMessage, fmtInt, formatDateTime, ms } from "./format";
import type { ManageHost } from "./host";

/** Rows on the projector board; the rest are summed up as "+N more". */
const BOARD_ROWS = 10;

export type BoardApi = {
  /** The public board, overall (null) or for one case. */
  load(scope: string | null): Promise<LeaderboardResponse>;
};

export type BoardOptions = {
  host: ManageHost;
  api: BoardApi;
  /** The cases the scope picker offers after "Overall". */
  cases(): readonly string[];
  /** The event as the room sees it, and the clock to count it down with. */
  eventClock(): { event: LiveEvent | null; now: number };
};

export type BoardPanel = {
  /** Opens the dialog and loads the board. */
  open(): void;
  /** Reloads the board while it is open (with the dashboard's poll). */
  refresh(): void;
  /** Ticks the countdown (once a second). */
  tick(): void;
  close(): void;
};

export function createBoardPanel(opts: BoardOptions): BoardPanel {
  const { host } = opts;
  // A full-screen modal dialog whose content re-renders in place.
  const leaderboardEl = h("div", { class: "admin-board-content" });
  let boardDialog: DialogHandle<string> | null = null;
  let showing = false;
  /** null scope = overall */
  const b = {
    scope: null as string | null,
    data: null as LeaderboardResponse | null,
    error: null as string | null,
  };

  let boardSeq = 0;
  async function loadBoard(): Promise<void> {
    const scope = b.scope;
    const seq = ++boardSeq;
    try {
      const data = await opts.api.load(scope);
      if (host.disposed() || seq !== boardSeq) return;
      b.data = data;
      b.error = null;
    } catch (err: unknown) {
      if (host.disposed() || seq !== boardSeq) return;
      b.error = errMessage(err);
    }
    if (showing) render();
  }

  const boardScopeSelect = h("select", { class: "admin-input admin-board-scope", id: "admin-board-scope" });
  boardScopeSelect.addEventListener("change", () => {
    const v = boardScopeSelect.value;
    const scope = v === "" ? null : v;
    if (scope === b.scope) return;
    b.scope = scope;
    b.data = null;
    b.error = null;
    render();
    void loadBoard();
  });

  // Event line and freeze state in the board header: kept across re-renders and ticked once a second.
  const boardEventEl = h("p", { class: "admin-board-event", "aria-live": "off" });
  const boardStateEl = h("p", { class: "admin-board-state" });

  function renderBoardClock(): void {
    const { event, now } = opts.eventClock();
    const name = event?.name.trim() ?? "";
    const phase = eventPhase(event, now);
    const when =
      phase.kind === "before"
        ? T().admBoardStartsIn(formatCountdown(phase.msLeft))
        : phase.kind === "running"
          ? phase.msLeft === null
            ? ""
            : T().admBoardEndsIn(formatCountdown(phase.msLeft))
          : phase.kind === "over"
            ? T().admBoardEventOver
            : "";
    setChildren(boardEventEl, name ? h("strong", { dir: "auto" }, name) : null, name && when ? " · " : "", when ? h("span", { class: "board-clock" }, when) : null);
    boardEventEl.hidden = !name && !when;

    const data = b.data && b.data.caseId === b.scope ? b.data : null;
    if (!data) {
      boardStateEl.hidden = true;
      return;
    }
    boardStateEl.hidden = false;
    const freezeAt = ms(event?.freezeAt ?? null);
    const detail = data.frozen
      ? data.frozenAt
        ? T().admBoardFrozenAt(formatDateTime(data.frozenAt))
        : ""
      : freezeAt !== null && freezeAt > now
        ? T().admBoardFreezesIn(formatCountdown(freezeAt - now))
        : "";
    boardStateEl.classList.toggle("is-frozen", data.frozen);
    setChildren(
      boardStateEl,
      data.frozen ? h("span", { class: "board-frozen-chip" }, "❄ ", T().admBoardFrozen) : h("span", { class: "board-live-chip" }, T().admBoardLive),
      detail ? h("span", { class: "board-frozen-at" }, detail) : null,
    );
  }

  function render(): void {
    if (!showing) {
      boardDialog?.close(null); // focus goes back to the button (or the "More" menu) that opened it
      return;
    }
    const opening = boardDialog === null;
    if (opening) {
      const handle = showDialog<string>({ size: "full", title: T().admLeaderboard, header: false, closeButton: false, body: leaderboardEl, className: "admin-board" });
      boardDialog = handle;
      void handle.result.then(() => {
        if (boardDialog === handle) boardDialog = null;
        showing = false;
        leaderboardEl.replaceChildren();
      });
    }
    // Scope options: overall + released cases (rebuilt each time; keeps the selection).
    const released = opts.cases();
    setChildren(
      boardScopeSelect,
      h("option", { value: "", selected: b.scope === null }, T().admBoardOverall),
      released.map((id) => h("option", { value: id, selected: id === b.scope }, caseTitle(id))),
    );
    const data = b.data && b.data.caseId === b.scope ? b.data : null;
    const top = data ? data.entries.slice(0, BOARD_ROWS) : [];
    const close = h(
      "button",
      {
        type: "button",
        class: "btn btn-ghost admin-board-close",
        onclick: () => boardDialog?.close(null),
      },
      T().admClose,
    );
    renderBoardClock();
    const more = data ? Math.max(0, data.entries.length - BOARD_ROWS) : 0;
    let body: HTMLElement;
    if (b.error && !data) body = h("p", { class: "admin-error admin-board-empty", role: "alert" }, T().admBoardFailed(b.error));
    else if (!data) body = h("p", { class: "muted admin-board-empty" }, T().admLoading);
    else if (top.length === 0) body = h("p", { class: "muted admin-board-empty" }, T().admNoPlayersBoard);
    else {
      const overall = data.caseId === null;
      body = h(
        "ol",
        { class: "admin-board-list" },
        top.map((e) =>
          h(
            "li",
            { class: `admin-board-row rank-${e.rank}` },
            h("span", { class: "board-rank" }, fmtInt(e.rank)),
            h("span", { class: "board-name", dir: "auto" }, e.username),
            h("span", { class: "board-time muted" }, overall ? T().admCasesDone(e.casesCompleted) : T().admStagesSolved(e.stagesSolved)),
            h("span", { class: "board-score" }, fmtInt(e.score)),
          ),
        ),
      );
    }
    const focusedScope = document.activeElement === boardScopeSelect;
    const focusInside = opening || leaderboardEl.contains(document.activeElement);
    setChildren(
      leaderboardEl,
      h(
        "div",
        { class: "admin-board-inner" },
        // The header answers what the room asks: which event, how long is left, and are the standings frozen.
        h(
          "div",
          { class: "admin-board-head" },
          h("h2", { class: "admin-board-title" }, T().admLeaderboard),
          h(
            "div",
            { class: "admin-board-tools" },
            h("label", { class: "admin-label", for: "admin-board-scope" }, T().admBoardScope),
            boardScopeSelect,
            close,
          ),
          h("div", { class: "admin-board-meta" }, boardEventEl, boardStateEl),
        ),
        body,
        more > 0 ? h("p", { class: "admin-board-more" }, T().admBoardMore(more, fmtInt(more))) : null,
      ),
    );
    // Re-appending moves focus out of the dialog: put it back (Close on first open).
    if (focusedScope) boardScopeSelect.focus();
    else if (focusInside || document.activeElement === boardDialog?.el) close.focus();
  }

  return {
    open: () => {
      showing = true;
      render();
      void loadBoard();
    },
    refresh: () => {
      if (showing) void loadBoard();
    },
    tick: () => {
      if (showing && boardDialog !== null) renderBoardClock();
    },
    close: () => boardDialog?.close(null),
  };
}
