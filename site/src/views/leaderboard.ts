// Public leaderboard: overall or per case, polled every 10 s. `?projector=1` = big-screen mode for a class:
// huge type, top 10, no header chrome, frozen badge. Usernames are rendered only as text nodes.
import { usernameKey, type LeaderboardResponse } from "../../shared/contract";
import { caseSummaries, caseSummary } from "../content/load";
import { fetchLeaderboard } from "../lib/api";
import { dataTable, type Column } from "../components/dataTable";
import { h, setChildren } from "../lib/dom";
import "../player.css";
import { cachedEvent, eventPhase, formatCountdown, isEventActive, onEventChange } from "../lib/event";
import { cachedAccount, loadAccount } from "../lib/session";
import type { AccountView } from "../../shared/contract";
import { formatNumber, getLang } from "../i18n/i18n";
import { TG } from "../i18n/strings-game";
import { TO } from "../i18n/strings-onboard";
import { T } from "../i18n/strings-player";

type LeaderboardEntry = LeaderboardResponse["entries"][number];

const POLL_MS = 10_000;
const PROJECTOR_ROWS = 10;
const MAX_ROWS = 100;

let pollTimer: number | null = null;
let tickTimer: number | null = null;
let unsubscribe: (() => void) | null = null;
/** Listeners that only live while the board is on screen (visibility, Esc in projector mode). */
let detachers: Array<() => void> = [];

export function stopLeaderboard(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
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

function hashFor(caseId: string | null, projector: boolean): string {
  const params = new URLSearchParams();
  if (caseId !== null) params.set("case", caseId);
  if (projector) params.set("projector", "1");
  const query = params.toString();
  return `#/leaderboard${query ? `?${query}` : ""}`;
}

/** "starts in 05:00" / "ends in 1:02:03" / "event over" for the current event ("" without a window). */
export function eventWhen(): string {
  const phase = eventPhase(cachedEvent());
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

export function renderLeaderboard(root: HTMLElement, query: URLSearchParams): void {
  stopLeaderboard();
  const projector = query.get("projector") === "1";
  const requested = query.get("case");
  let caseId: string | null = requested !== null && caseSummary(requested) !== undefined ? requested : null;
  document.title = `${TG().lbTitle} · IncidentLab`;
  document.body.classList.toggle("projector", projector);

  // Only an approved player can have a row; the admin session and pending players have none.
  const keyOf = (a: AccountView | null): string | null => (a !== null && a.role !== "admin" && a.status === "approved" ? usernameKey(a.username) : null);
  let me = cachedAccount();
  let myKey = keyOf(me);
  // Cold load: the account may answer after the first board; redraw with the "you" row then.
  void loadAccount().then(
    (account) => {
      if (keyOf(account) === myKey) return;
      me = account;
      myKey = keyOf(account);
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
    history.replaceState(null, "", hashFor(caseId, projector));
    projectorLink.href = hashFor(caseId, !projector);
    titleSub.textContent = scopeTitle();
    lastFrozen = undefined;
    void load();
  });

  const scopeTitle = (): string => (caseId === null ? TG().lbOverall : (caseSummary(caseId)?.title ?? caseId));
  // The select already names the scope on the normal page; the projector has no select, so it shows it.
  const titleSub = h("p", { class: `lb-case-title${projector ? "" : " visually-hidden"}`, dir: "auto" }, scopeTitle());
  const eventEl = h("p", { class: "lb-event" });
  // Frozen is the headline state for the room: a banner, not a chip. The region exists from the start so a
  // freeze that lands while the page is open is announced (politely, once: it only changes on a new state).
  const frozenEl = h("div", { class: "lb-frozen-banner", hidden: true });
  const frozenRegion = h("div", { role: "status" }, frozenEl);
  const updatedEl = h("p", { class: "lb-updated muted small" });
  const subEl = h("p", { class: "muted small lb-sub" });
  const body = h("div", { class: "lb-body", "aria-busy": "true" });
  const projectorLink = h(
    "a",
    { class: projector ? "lb-exit" : "btn btn-sm btn-ghost", href: hashFor(caseId, !projector) },
    projector ? TO().lbExitProjector : TG().lbProjector,
  );
  let lastFrozen: string | null | undefined; // undefined = not drawn yet
  let lastData: LeaderboardResponse | null = null;

  const drawEvent = (): void => {
    const line = eventLine();
    eventEl.textContent = line;
    eventEl.hidden = line.length === 0;
  };

  const drawState = (data: LeaderboardResponse | null): void => {
    const frozen = data?.frozen === true;
    subEl.hidden = projector;
    subEl.textContent = document.hidden ? TO().lbSubPaused : frozen ? TO().lbSubFrozen : TO().lbSubLive;
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
      h("td", { class: "lb-unranked-note", colspan: String(span) }, TO().lbUnrankedRow),
    );
  };

  const drawTable = (data: LeaderboardResponse): void => {
    lastData = data;
    const rows = data.entries.slice(0, projector ? PROJECTOR_ROWS : MAX_ROWS);
    drawState(data);
    updatedEl.textContent = TG().lbUpdated(timeFmt().format(new Date(data.generatedAt)));
    body.setAttribute("aria-busy", "false");
    const overall = data.caseId === null;
    const mine = meRow(data, rows, overall);
    if (rows.length === 0 && mine === null) {
      setChildren(body, h("p", { class: "muted lb-empty" }, data.frozen ? TO().lbEmptyFrozen : TO().lbEmptyLive));
      return;
    }
    const scope = caseId === null ? TO().lbCaptionOverall : TO().lbCaptionCase(scopeTitle());
    const caption = `${scope}${data.frozen && data.frozenAt ? TO().lbCaptionFrozen(timeFmt().format(new Date(data.frozenAt))) : ""}`;
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
        rowAttrs: (e) => ({ class: `rank-${Math.min(e.rank, 4)}${myKey !== null && usernameKey(e.username) === myKey ? " is-me" : ""}` }),
        caption: projector ? `${caption} · ${TG().lbTop(PROJECTOR_ROWS)}` : caption,
        className: "lb-table",
        extraRows: mine,
      }).element,
    );
  };

  let inFlight = false;
  const load = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    const wanted = caseId;
    try {
      const data = await fetchLeaderboard(wanted);
      if (wanted === caseId && root.contains(body)) drawTable(data);
    } catch {
      if (root.contains(body) && body.childElementCount === 0) setChildren(body, h("p", { class: "muted", role: "alert" }, TG().lbFailed));
    } finally {
      inFlight = false;
    }
  };

  setChildren(
    root,
    h(
      "section",
      { class: `lb-page${projector ? " is-projector" : ""}` },
      h(
        "header",
        { class: "lb-head" },
        h(
          "div",
          { class: "lb-head-main" },
          projector ? h("p", { class: "lb-brand mono" }, "▲ incidentlab") : h("a", { class: "back-link", href: "#/" }, T().navCases),
          h("h1", {}, TG().lbTitle),
          titleSub,
          eventEl,
        ),
        projector ? null : h("div", { class: "lb-tools" }, h("label", { class: "field-label", for: "lb-case" }, TG().lbShow), select, projectorLink),
      ),
      frozenRegion,
      body,
      subEl,
      updatedEl,
      projector ? projectorLink : null,
    ),
  );

  // Poll only while the tab is visible; coming back refreshes at once.
  const startPolling = (): void => {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = document.hidden ? null : window.setInterval(() => void load(), POLL_MS);
  };
  listen("visibilitychange", () => {
    startPolling();
    drawState(lastData);
    if (!document.hidden) void load();
  });
  if (projector) {
    // The big screen has no visible controls: Esc (or the small corner link) leaves projector mode.
    listen("keydown", (ev) => {
      if (ev.key === "Escape") window.location.hash = hashFor(caseId, false);
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
  drawState(null);
  unsubscribe = onEventChange(drawEvent);
  tickTimer = window.setInterval(drawEvent, 1000);
  startPolling();
  void load();
}
