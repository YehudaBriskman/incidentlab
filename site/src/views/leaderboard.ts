// Public leaderboard: overall or per case, this week, this month or all time (#239). It polls every 10 s during a live event, every 60 s otherwise, and
// pauses after 15 idle minutes (lib/boardPoll.ts, #242). `?projector=1` = big-screen mode for a class:
// huge type, top 10, no header chrome, frozen badge. Usernames are rendered only as text nodes.
// Search and "Jump to me" (±5 rows) cut the one cached list the board polls: neither costs a function call.
// The same view draws a class board (#182) from its capability URL (`board`): #/classboard/<token>, and
// embedded on the class page. A class board shows the class's own event and every active member (no opt-in).
import {
  LeaderboardPeriodSchema,
  usernameKey,
  type ClassBoardResponse,
  type ClassEvent,
  type LeaderboardPeriod,
  type LeaderboardResponse,
  type LiveEvent,
} from "../../shared/contract";
import { caseSummaries, caseSummary } from "../content/load";
import { ApiError, fetchLeaderboard } from "../lib/api";
import { boardPollDecision, boardSignature } from "../lib/boardPoll";
import { nearWindow, searchEntries } from "../lib/boardView";
import { fetchClassBoard } from "../lib/class-api";
import { TC } from "../i18n/strings-classes";
import { dataTable, type Column } from "../components/dataTable";
import { h, setChildren } from "../lib/dom";
import "../player.css";
import { cachedEvent, eventPhase, formatCountdown, isEventActive, onEventChange } from "../lib/event";
import { cachedAccount, loadAccount } from "../lib/session";
import type { AccountView } from "../../shared/contract";
import { formatNumber, getLang } from "../i18n/i18n";
import { TB } from "../i18n/strings-board";
import { TG } from "../i18n/strings-game";
import { TO } from "../i18n/strings-onboard";

type LeaderboardEntry = LeaderboardResponse["entries"][number];

const PROJECTOR_ROWS = 10;
const MAX_ROWS = 100;

let pollTimer: number | null = null;
let tickTimer: number | null = null;
let unsubscribe: (() => void) | null = null;
/** Listeners that only live while the board is on screen (visibility, Esc in projector mode). */
let detachers: Array<() => void> = [];

export function stopLeaderboard(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  if (tickTimer !== null) window.clearInterval(tickTimer);
  pollTimer = null;
  tickTimer = null;
  unsubscribe?.();
  unsubscribe = null;
  for (const detach of detachers) detach();
  detachers = [];
  document.body.classList.remove("projector");
}

/** How long the projector's exit link stays visible after the pointer stops moving. */
const PROJECTOR_CONTROLS_MS = 3000;

function listen<K extends keyof DocumentEventMap>(type: K, fn: (ev: DocumentEventMap[K]) => void): void {
  document.addEventListener(type, fn);
  detachers.push(() => document.removeEventListener(type, fn));
}

const timeFmt = (): Intl.DateTimeFormat => new Intl.DateTimeFormat(getLang() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function hashFor(caseId: string | null, projector: boolean, board: string | null = null, period: LeaderboardPeriod = "all"): string {
  const params = new URLSearchParams();
  if (caseId !== null) params.set("case", caseId);
  if (period !== "all") params.set("period", period);
  if (projector) params.set("projector", "1");
  const query = params.toString();
  return `${board === null ? "#/leaderboard" : `#/classboard/${encodeURIComponent(board)}`}${query ? `?${query}` : ""}`;
}

/** A class event as the event helpers read it (they take the site event's shape). */
export const asLiveEvent = (e: ClassEvent): LiveEvent => ({ ...e, enforceWindow: false });

/** "starts in 05:00" / "ends in 1:02:03" / "event over" for the event ("" without a window). */
export function eventWhen(event: LiveEvent | null = cachedEvent()): string {
  const phase = eventPhase(event);
  if (phase.kind === "before") return TG().eventStartsIn(formatCountdown(phase.msLeft));
  if (phase.kind === "running") return phase.msLeft === null ? TG().eventLive : TG().eventEndsIn(formatCountdown(phase.msLeft));
  if (phase.kind === "over") return TG().eventOver;
  return "";
}

/** Where the event stands for display: live (running or no window), upcoming, or over. */
export function eventDisplayPhase(): "live" | "before" | "over" {
  const kind = eventPhase(cachedEvent()).kind;
  return kind === "before" ? "before" : kind === "over" ? "over" : "live";
}

/** Countdown line for the event ("Event name · ends in 12:03"), or "" when no event is set. */
export function eventLine(): string {
  const event = cachedEvent();
  if (!isEventActive(event)) return "";
  return [event.name, eventWhen()].filter((part) => part.length > 0).join(" · ");
}

/** The class event's line ("Event night · ends in 12:03"), or "" when the class has none. */
function classEventLine(event: LiveEvent | null): string {
  if (!isEventActive(event)) return "";
  return [event.name, eventWhen(event)].filter((part) => part.length > 0).join(" · ");
}

export type BoardOptions = {
  /** A class board token: draws that class's board instead of the global one. */
  board?: string;
  /** Inside another page (the class page): no page title, no URL updates, a section heading. */
  embedded?: boolean;
};

export function renderLeaderboard(root: HTMLElement, query: URLSearchParams, opts: BoardOptions = {}): void {
  stopLeaderboard();
  const board = opts.board ?? null;
  const embedded = opts.embedded === true;
  const projector = !embedded && query.get("projector") === "1";
  const requested = query.get("case");
  let caseId: string | null = requested !== null && caseSummary(requested) !== undefined ? requested : null;
  // The period is in the URL (#239). A class board has its own window (its event), so it is always all time.
  let period: LeaderboardPeriod = board === null ? (LeaderboardPeriodSchema.safeParse(query.get("period")).data ?? "all") : "all";
  /** "top": the first MAX_ROWS; "near": the ±5 rows around the signed-in player (Jump to me). */
  let view: "top" | "near" = "top";
  let search = "";
  /** Set by Jump to me: the next draw moves focus to the player's row (a poll's redraw never does). */
  let focusMe = false;
  const here = (): string => hashFor(caseId, projector, board, period);
  /** The class's assigned cases once the board answered ([] = any case). */
  let classCases: readonly string[] = [];
  let classEvent: LiveEvent | null = null;
  let className = "";
  if (!embedded) document.title = `${board === null ? TG().lbTitle : TC().boardTitle} · IncidentLab`;
  document.body.classList.toggle("projector", projector);

  // Only an approved, opted-in player can have a row (#175); the admin session, guests, pending players and
  // players who keep themselves off the board have none.
  const canPlay = (a: AccountView | null): a is AccountView => a !== null && a.role !== "admin" && a.status === "approved" && a.kind === "user";
  // A class board lists every active member, opted in or not (members see each other there by design).
  const keyOf = (a: AccountView | null): string | null => (canPlay(a) && (board !== null || a.showOnGlobalBoard) ? usernameKey(a.username) : null);
  let me = cachedAccount();
  let myKey = keyOf(me);
  // Cold load: the account may answer after the first board; redraw with the "you" row then.
  void loadAccount().then(
    (account) => {
      if (keyOf(account) === myKey && canPlay(account) === canPlay(me)) return;
      me = account;
      myKey = keyOf(account);
      drawOptIn();
      if (lastData !== null && root.contains(body)) drawTable(lastData);
    },
    () => undefined,
  );

  const select = h(
    "select",
    { id: "lb-case", class: "input lb-select" },
    h("option", { value: "" }, TG().lbOverall),
    caseSummaries().map((c) => h("option", { value: c.id }, c.title)),
  );
  select.value = caseId ?? "";
  select.addEventListener("change", () => {
    caseId = select.value === "" ? null : select.value;
    if (!embedded) history.replaceState(null, "", here());
    projectorLink.href = hashFor(caseId, !projector, board, period);
    titleSub.textContent = scopeTitle();
    lastFrozen = undefined;
    lastSignature = null;
    void load();
  });

  const periodName = (p: LeaderboardPeriod): string => (p === "week" ? TB().lbPeriodWeek : p === "month" ? TB().lbPeriodMonth : TB().lbPeriodAll);
  const scopeTitle = (): string => {
    const scope = caseId === null ? TG().lbOverall : (caseSummary(caseId)?.title ?? caseId);
    return period === "all" ? scope : `${scope} · ${periodName(period)}`;
  };

  // This week | This month | All time: a segmented control over native radios (one Tab stop, arrows inside).
  const periodGroup = h(
    "fieldset",
    { class: "lb-period", hidden: projector || board !== null },
    h("legend", { class: "visually-hidden" }, TB().lbPeriodLabel),
    h(
      "div",
      { class: "lb-period-track" },
      (["week", "month", "all"] as const).map((p) =>
        h(
          "label",
          { class: "lb-period-opt" },
          h("input", { type: "radio", name: "lb-period", value: p, checked: p === period }),
          h("span", {}, periodName(p)),
        ),
      ),
    ),
  );
  periodGroup.addEventListener("change", (ev) => {
    const parsed = LeaderboardPeriodSchema.safeParse(ev.target instanceof HTMLInputElement ? ev.target.value : null);
    if (!parsed.success || parsed.data === period) return;
    period = parsed.data;
    if (!embedded) history.replaceState(null, "", here());
    projectorLink.href = hashFor(caseId, !projector, board, period);
    titleSub.textContent = scopeTitle();
    lastFrozen = undefined;
    lastSignature = null;
    void load();
  });
  // The resolved start of the period, with the time zone (a week is Sunday 00:00 in the site's zone).
  const sinceEl = h("p", { class: "lb-since muted small", hidden: true });

  // Find a player: filters the loaded list by name as you type.
  const searchInput = h("input", { id: "lb-search", type: "search", class: "input lb-search-input", autocomplete: "off", spellcheck: "false", enterkeyhint: "search" });
  searchInput.addEventListener("input", () => {
    search = searchInput.value;
    if (search.trim() !== "") view = "top";
    if (lastData !== null) drawTable(lastData);
  });
  const searchField = h(
    "div",
    { class: "lb-search", hidden: projector },
    h("label", { class: "field-label", for: "lb-search" }, TB().lbSearchLabel),
    searchInput,
  );
  // Jump to me / Back to the top: only while the signed-in player is on this board.
  const jumpBtn = h("button", { type: "button", class: "btn btn-sm lb-jump", hidden: true }, TB().lbJumpToMe);
  jumpBtn.addEventListener("click", () => {
    if (view === "near") {
      view = "top";
    } else {
      view = "near";
      focusMe = true;
      search = "";
      searchInput.value = "";
    }
    if (lastData !== null) drawTable(lastData);
  });
  // Announces the search count and the near-me window (exists before its text changes, so it is read out).
  const viewStatusEl = h("p", { class: "lb-view-status muted small", role: "status" });
  const controlsEl = h("div", { class: "lb-controls", hidden: projector }, periodGroup, searchField, jumpBtn);
  // The select already names the scope on the normal page; the projector has no select, so it shows it.
  const titleSub = h("p", { class: `lb-case-title${projector ? "" : " visually-hidden"}`, dir: "auto" }, scopeTitle());
  const eventEl = h("p", { class: "lb-event" });
  // Frozen is the headline state for the room: a banner, not a chip. The region exists from the start so a
  // freeze that lands while the page is open is announced (politely, once: it only changes on a new state).
  const frozenEl = h("div", { class: "lb-frozen-banner", hidden: true });
  const frozenRegion = h("div", { role: "status" }, frozenEl);
  const updatedEl = h("p", { class: "lb-updated muted small" });
  // Who is listed: only players who opted in. A signed-in player who isn't gets the way to the setting.
  const optInEl = h("p", { class: "lb-optin muted small", hidden: projector || board !== null });
  const drawOptIn = (): void => {
    if (board !== null) return;
    const hidden = canPlay(me) && !me.showOnGlobalBoard;
    setChildren(
      optInEl,
      TB().lbOptInNote,
      hidden ? [" ", TB().lbYouHidden, " ", h("a", { href: "#/settings/privacy" }, TB().lbOptInLink)] : null,
    );
  };
  const subEl = h("p", { class: "muted small lb-sub" });
  // Shown once the board stops polling after 15 idle minutes; Resume polls at once and starts the clock again.
  const resumeBtn = h("button", { type: "button", class: "btn btn-sm" }, TB().lbResume);
  const pausedEl = h("div", { class: "lb-paused", hidden: true }, h("p", { class: "muted small" }, TB().lbIdlePaused), resumeBtn);
  const pausedRegion = h("div", { role: "status" }, pausedEl);
  const body = h("div", { class: "lb-body", "aria-busy": "true" });
  const projectorLink = h(
    "a",
    { class: projector ? "lb-exit" : "btn btn-sm btn-ghost", href: hashFor(caseId, !projector, board, period) },
    projector ? TO().lbExitProjector : TG().lbProjector,
  );
  // The class name heads a class board once it answered (the token alone names nothing).
  const headingEl = h(embedded ? "h2" : "h1", { dir: "auto", class: embedded ? "lb-embed-title" : null }, board === null ? TG().lbTitle : TC().boardTitle);
  const eyebrowEl = h("p", { class: "eyebrow lb-class-eyebrow", hidden: true }, TC().boardTitle);
  /** The case picker lists the class's assigned cases once they are known. */
  let optionsSig = "";
  const syncClassOptions = (): void => {
    const ids = classCases.length > 0 ? classCases : caseSummaries().map((c) => c.id);
    const sig = JSON.stringify(ids);
    if (sig === optionsSig) return;
    optionsSig = sig;
    setChildren(select, h("option", { value: "" }, TG().lbOverall), ids.map((id) => h("option", { value: id }, caseSummary(id)?.title ?? id)));
    select.value = caseId !== null && ids.includes(caseId) ? caseId : "";
  };
  const applyClass = (data: ClassBoardResponse): void => {
    classCases = data.caseIds;
    classEvent = asLiveEvent(data.event);
    if (!embedded && className !== data.className) {
      headingEl.textContent = data.className; // textContent only: a class admin chose it
      eyebrowEl.hidden = false;
      document.title = `${data.className} · ${TC().boardTitle} · IncidentLab`;
    }
    className = data.className;
    syncClassOptions();
    drawEvent();
  };
  let lastFrozen: string | null | undefined; // undefined = not drawn yet
  let lastData: LeaderboardResponse | null = null;
  /** boardSignature of the last drawn answer: an unchanged poll draws nothing (null: draw the next one). */
  let lastSignature: string | null = null;
  /** The event this board follows: the site event on the global board, the class's own on a class board. */
  const followedPhase = () => eventPhase(board === null ? cachedEvent() : classEvent);
  /** Draws an answer unless it shows exactly what is on screen already. */
  const drawIfChanged = (data: LeaderboardResponse): void => {
    const signature = boardSignature(data);
    if (signature === lastSignature) return;
    lastSignature = signature;
    drawTable(data);
  };

  const drawEvent = (): void => {
    const line = board === null ? eventLine() : classEventLine(classEvent);
    eventEl.textContent = line;
    eventEl.hidden = line.length === 0;
  };

  const drawState = (data: LeaderboardResponse | null): void => {
    const frozen = data?.frozen === true;
    subEl.hidden = projector;
    subEl.textContent = document.hidden ? TO().lbSubPaused : frozen ? TO().lbSubFrozen : followedPhase().kind === "running" ? TO().lbSubLive : TB().lbSubQuiet;
    if (data === null) return;
    const frozenKey = frozen ? (data.frozenAt ?? "") : null;
    if (frozenKey === lastFrozen) return;
    lastFrozen = frozenKey;
    frozenEl.hidden = !frozen;
    if (!frozen) {
      setChildren(frozenEl);
      return;
    }
    setChildren(
      frozenEl,
      h("span", { class: "lb-frozen-icon", "aria-hidden": "true" }, "❄"),
      h(
        "div",
        {},
        h("p", { class: "lb-frozen-title" }, data.frozenAt ? TO().lbFrozenTitle(timeFmt().format(new Date(data.frozenAt))) : TO().lbFrozenTitleNoTime),
        projector ? null : h("p", { class: "lb-frozen-body" }, TO().lbFrozenBody),
      ),
    );
  };

  const row = (e: LeaderboardEntry, overall: boolean): HTMLElement => {
    const isMe = myKey !== null && usernameKey(e.username) === myKey;
    return h(
      "tr",
      { class: `rank-${Math.min(e.rank, 4)}${isMe ? " is-me" : ""}` },
      h("td", { class: "num lb-rank" }, formatNumber(e.rank)),
      h("th", { scope: "row", class: "lb-name" }, h("bdi", {}, e.username), isMe ? h("span", { class: "chip lb-you" }, TG().lbYou) : null),
      h("td", { class: "num lb-score" }, formatNumber(e.score)),
      h("td", { class: "num lb-opt" }, formatNumber(e.stagesSolved)),
      overall ? h("td", { class: "num lb-opt" }, formatNumber(e.casesCompleted)) : null,
      h("td", { class: "num lb-opt" }, formatNumber(e.firstBloods)),
    );
  };

  /** The signed-in player below the list: their real row when it's past the cut, or "not ranked yet". */
  const meRow = (data: LeaderboardResponse, shown: readonly LeaderboardEntry[], overall: boolean): HTMLElement | null => {
    if (myKey === null || me === null || projector) return null;
    if (shown.some((e) => usernameKey(e.username) === myKey)) return null;
    const mine = data.entries.find((e) => usernameKey(e.username) === myKey);
    if (mine !== undefined) return row(mine, overall);
    const span = overall ? 4 : 3;
    return h(
      "tr",
      { class: "is-me is-unranked" },
      h("td", { class: "num lb-rank" }, h("span", { "aria-hidden": "true" }, "—"), h("span", { class: "visually-hidden" }, TO().unranked)),
      h("th", { scope: "row", class: "lb-name" }, h("bdi", {}, me.username), h("span", { class: "chip lb-you" }, TG().lbYou)),
      h(
        "td",
        { class: "lb-unranked-note", colspan: String(span) },
        data.period === "week" ? TB().lbUnrankedWeek : data.period === "month" ? TB().lbUnrankedMonth : TO().lbUnrankedRow,
      ),
    );
  };

  const sinceFmt = (): Intl.DateTimeFormat =>
    new Intl.DateTimeFormat(getLang() === "he" ? "he-IL" : "en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

  /** The rows on screen: the top of the list, the search matches, or the window around the player. */
  const pickRows = (data: LeaderboardResponse): { rows: LeaderboardEntry[]; status: string } => {
    if (projector) return { rows: data.entries.slice(0, PROJECTOR_ROWS), status: "" };
    if (search.trim() !== "") {
      const found = searchEntries(data.entries, search);
      const status = found.length === 0 ? TB().lbSearchNone : TB().lbSearchCount(found.length, data.entries.length);
      return { rows: found.slice(0, MAX_ROWS), status: found.length > MAX_ROWS ? `${status} ${TB().lbSearchCapped(MAX_ROWS)}` : status };
    }
    if (view === "near") {
      const near = nearWindow(data.entries, myKey);
      const mine = near?.rows[near.index];
      if (near !== null && mine !== undefined) return { rows: near.rows, status: TB().lbNearStatus(mine.rank, data.entries.length) };
      view = "top"; // not on this board (another period or case): back to the top
    }
    return { rows: data.entries.slice(0, MAX_ROWS), status: "" };
  };

  const drawTable = (data: LeaderboardResponse): void => {
    lastData = data;
    const picked = pickRows(data);
    const rows = picked.rows;
    viewStatusEl.textContent = picked.status;
    const onBoard = myKey !== null && data.entries.some((e) => usernameKey(e.username) === myKey);
    jumpBtn.hidden = projector || !onBoard;
    jumpBtn.textContent = view === "near" ? TB().lbBackToTop : TB().lbJumpToMe;
    jumpBtn.setAttribute("aria-pressed", view === "near" ? "true" : "false");
    sinceEl.hidden = projector || data.periodStart === null;
    sinceEl.textContent = data.periodStart === null ? "" : TB().lbPeriodSince(sinceFmt().format(new Date(data.periodStart)));
    drawState(data);
    updatedEl.textContent = TG().lbUpdated(timeFmt().format(new Date(data.generatedAt)));
    body.setAttribute("aria-busy", "false");
    const overall = data.caseId === null;
    const searching = search.trim() !== "";
    const mine = searching ? null : meRow(data, rows, overall);
    if (rows.length === 0 && mine === null) {
      if (searching) {
        setChildren(body); // the status line says nothing matches
        return;
      }
      const empty = data.frozen ? TO().lbEmptyFrozen : data.period === "week" ? TB().lbEmptyWeek : data.period === "month" ? TB().lbEmptyMonth : TO().lbEmptyLive;
      setChildren(body, h("p", { class: "muted lb-empty" }, empty));
      return;
    }
    const scope = board !== null && className !== "" ? `${className} · ${scopeTitle()}` : caseId === null ? TO().lbCaptionOverall : TO().lbCaptionCase(scopeTitle());
    const periodPart = data.period === "all" ? "" : ` · ${periodName(data.period)}`;
    const nearPart = view === "near" && !searching ? ` · ${TB().lbNearCaption}` : "";
    const caption = `${scope}${periodPart}${nearPart}${data.frozen && data.frozenAt ? TO().lbCaptionFrozen(timeFmt().format(new Date(data.frozenAt))) : ""}`;
    // Ranked order is the point of this table, so its columns don't sort. lb-opt (not "optional") keeps the
    // projector showing every column while phones drop the extras.
    const cols: Column<LeaderboardEntry>[] = [
      { id: "rank", header: TG().lbRank, numeric: true, className: "lb-rank", cell: (e) => formatNumber(e.rank) },
      {
        id: "player",
        header: TG().lbPlayer,
        rowHeader: true,
        className: "lb-name",
        cell: (e) => [h("bdi", {}, e.username), myKey !== null && usernameKey(e.username) === myKey ? h("span", { class: "chip lb-you" }, TG().lbYou) : null],
      },
      { id: "score", header: TG().lbScore, numeric: true, className: "lb-score", cell: (e) => formatNumber(e.score) },
      { id: "stages", header: TG().lbStages, numeric: true, className: "lb-opt", cell: (e) => formatNumber(e.stagesSolved) },
      ...(overall ? [{ id: "cases", header: TG().lbCases, numeric: true, className: "lb-opt", cell: (e: LeaderboardEntry) => formatNumber(e.casesCompleted) }] : []),
      { id: "firstBloods", header: TG().lbFirstBloods, numeric: true, className: "lb-opt", cell: (e) => formatNumber(e.firstBloods) },
    ];
    setChildren(
      body,
      dataTable({
        columns: cols,
        rows,
        rowAttrs: (e) => {
          const isMe = myKey !== null && usernameKey(e.username) === myKey;
          // The player's row can take focus (Jump to me moves it there) without becoming a Tab stop.
          return { class: `rank-${Math.min(e.rank, 4)}${isMe ? " is-me" : ""}`, tabindex: isMe ? "-1" : null };
        },
        caption: projector ? `${caption} · ${TG().lbTop(PROJECTOR_ROWS)}` : caption,
        className: "lb-table",
        extraRows: mine,
      }).element,
    );
    if (focusMe) {
      focusMe = false;
      const row = body.querySelector<HTMLElement>("tr.is-me");
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "center", behavior: "auto" });
    }
  };

  let inFlight = false;
  /** A switch of case or period while a load was in flight: load again once it lands. */
  let again = false;
  /** The class board link answered 404: it will never work again. */
  let dead = false;
  const load = async (): Promise<void> => {
    if (dead) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    const wanted = caseId;
    const wantedPeriod = period;
    try {
      if (board === null) {
        const data = await fetchLeaderboard(wanted, wantedPeriod);
        // A reply for a case or period the viewer has since left is dropped (its own load follows).
        if (wanted === caseId && wantedPeriod === period && root.contains(body)) drawIfChanged(data);
      } else {
        const data = await fetchClassBoard(board, wanted);
        if (!root.contains(body)) return;
        applyClass(data);
        if (wanted === caseId) drawIfChanged(data);
      }
    } catch (err: unknown) {
      if (!root.contains(body)) return;
      // A rotated token or an archived class: the link is dead for good, so stop asking.
      if (board !== null && err instanceof ApiError && err.status === 404) {
        if (pollTimer !== null) window.clearTimeout(pollTimer);
        pollTimer = null;
        dead = true;
        body.setAttribute("aria-busy", "false");
        setChildren(body, h("p", { class: "muted lb-empty", role: "alert" }, TC().boardGone));
        return;
      }
      if (body.childElementCount === 0) setChildren(body, h("p", { class: "muted", role: "alert" }, TG().lbFailed));
    } finally {
      inFlight = false;
      if (again) {
        again = false;
        void load();
      }
    }
  };

  if (board !== null) syncClassOptions();
  // A class board sits under Classes, so it links back there; the global board is a top-level page (#222: no
  // "← Cases" that went home).
  const backLink = board !== null ? h("a", { class: "back-link", href: "#/classes" }, TC().navClasses) : null;
  setChildren(
    root,
    h(
      embedded ? "div" : "section",
      { class: `lb-page${projector ? " is-projector" : ""}${embedded ? " is-embedded" : ""}` },
      h(
        "header",
        { class: "lb-head" },
        h(
          "div",
          { class: "lb-head-main" },
          projector ? h("p", { class: "lb-brand mono" }, "▲ incidentlab") : embedded ? null : backLink,
          embedded ? null : eyebrowEl,
          headingEl,
          titleSub,
          eventEl,
        ),
        projector ? null : h("div", { class: "lb-tools" }, h("label", { class: "field-label", for: "lb-case" }, TG().lbShow), select, projectorLink),
      ),
      optInEl,
      controlsEl,
      sinceEl,
      viewStatusEl,
      frozenRegion,
      body,
      pausedRegion,
      subEl,
      updatedEl,
      projector ? projectorLink : null,
    ),
  );

  // The poll (lib/boardPoll.ts): a timeout chain whose next delay follows the event, the tab and the viewer.
  let lastInputMs = Date.now();
  const setPaused = (value: boolean): void => {
    pausedEl.hidden = !value;
  };
  const schedule = (): void => {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
    if (dead || !root.contains(body)) return;
    drawState(lastData); // the cadence line follows the event even when the standings didn't change
    const phase = followedPhase();
    const decision = boardPollDecision({
      hidden: document.hidden,
      eventLive: phase.kind === "running",
      msUntilStart: phase.kind === "before" ? phase.msLeft : null,
      projector,
      nowMs: Date.now(),
      lastInputMs,
    });
    if (decision.kind === "paused") setPaused(true);
    if (decision.kind !== "wait") return;
    pollTimer = window.setTimeout(() => {
      pollTimer = null;
      void load().finally(schedule);
    }, decision.delayMs);
  };
  /** Poll now and restart the idle clock: Resume, or the tab coming back into view. */
  const resume = (): void => {
    lastInputMs = Date.now();
    setPaused(false);
    void load().finally(schedule);
  };
  resumeBtn.addEventListener("click", resume);
  // Any pointer or key input keeps the board live. It doesn't undo a pause by itself: Resume does that.
  const markInput = (): void => {
    lastInputMs = Date.now();
  };
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel"] as const) listen(type, markInput);
  listen("visibilitychange", () => {
    drawState(lastData);
    if (document.hidden) schedule(); // clears the timer
    else resume(); // coming back counts as activity, and refreshes at once
  });
  if (projector) {
    // The big screen has no visible controls: Esc (or the small corner link) leaves projector mode.
    listen("keydown", (ev) => {
      if (ev.key === "Escape") window.location.hash = hashFor(caseId, false, board, period);
    });
    // The exit link shows only while the pointer moves (and on keyboard focus), so the room sees no chrome.
    let pointerTimer: number | null = null;
    listen("pointermove", () => {
      document.body.classList.add("projector-pointer");
      if (pointerTimer !== null) window.clearTimeout(pointerTimer);
      pointerTimer = window.setTimeout(() => document.body.classList.remove("projector-pointer"), PROJECTOR_CONTROLS_MS);
    });
    detachers.push(() => {
      if (pointerTimer !== null) window.clearTimeout(pointerTimer);
      document.body.classList.remove("projector-pointer");
    });
  }

  drawEvent();
  drawOptIn();
  drawState(null);
  if (board === null) unsubscribe = onEventChange(drawEvent);
  tickTimer = window.setInterval(drawEvent, 1000);
  void load().finally(schedule);
}
