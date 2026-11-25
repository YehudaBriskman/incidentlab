// Public leaderboard: overall or per case, polled every 10 s. `?projector=1` = big-screen mode for a class:
// huge type, top 10, no header chrome, frozen badge. Usernames are rendered only as text nodes.
import { usernameKey, type LeaderboardResponse } from "../../shared/contract";
import { caseSummaries, caseSummary } from "../content/load";
import { fetchLeaderboard } from "../lib/api";
import { h, setChildren } from "../lib/dom";
import { cachedEvent, eventPhase, formatCountdown, isEventActive, onEventChange } from "../lib/event";
import { cachedAccount } from "../lib/session";
import { getLang } from "../i18n/i18n";
import { TG } from "../i18n/strings-game";
import { T } from "../i18n/strings-player";

const POLL_MS = 10_000;
const PROJECTOR_ROWS = 10;
const MAX_ROWS = 100;

let pollTimer: number | null = null;
let tickTimer: number | null = null;
let unsubscribe: (() => void) | null = null;

export function stopLeaderboard(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  if (tickTimer !== null) window.clearInterval(tickTimer);
  pollTimer = null;
  tickTimer = null;
  unsubscribe?.();
  unsubscribe = null;
  document.body.classList.remove("projector");
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

  const me = cachedAccount();
  const myKey = me !== null && me.role === "player" ? usernameKey(me.username) : null;

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
    titleSub.textContent = caseId === null ? TG().lbOverall : (caseSummary(caseId)?.title ?? caseId);
    void load();
  });

  const titleSub = h("p", { class: "lb-case-title" }, caseId === null ? TG().lbOverall : (caseSummary(caseId)?.title ?? caseId));
  const eventEl = h("p", { class: "lb-event mono" });
  const frozenEl = h("p", { class: "lb-frozen", hidden: true });
  const updatedEl = h("p", { class: "lb-updated muted small mono" });
  const body = h("div", { class: "lb-body", "aria-busy": "true" });
  const projectorLink = h("a", { class: "btn btn-sm btn-ghost", href: hashFor(caseId, !projector) }, projector ? TG().lbExitProjector : TG().lbProjector);

  const drawEvent = (): void => {
    const line = eventLine();
    eventEl.textContent = line;
    eventEl.hidden = line.length === 0;
  };

  const drawTable = (data: LeaderboardResponse): void => {
    const rows = data.entries.slice(0, projector ? PROJECTOR_ROWS : MAX_ROWS);
    frozenEl.hidden = !data.frozen;
    setChildren(
      frozenEl,
      h("span", { class: "chip chip-frozen" }, "🧊 ", TG().lbFrozen),
      " ",
      data.frozenAt ? TG().lbFrozenAt(timeFmt().format(new Date(data.frozenAt))) : null,
    );
    updatedEl.textContent = TG().lbUpdated(timeFmt().format(new Date(data.generatedAt)));
    body.setAttribute("aria-busy", "false");
    if (rows.length === 0) {
      setChildren(body, h("p", { class: "muted lb-empty" }, TG().lbEmpty));
      return;
    }
    const overall = data.caseId === null;
    setChildren(
      body,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "stats-table lb-table" },
          h("caption", { class: "visually-hidden" }, projector ? TG().lbTop(PROJECTOR_ROWS) : TG().lbTitle),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col", class: "num" }, TG().lbRank),
              h("th", { scope: "col" }, TG().lbPlayer),
              h("th", { scope: "col", class: "num" }, TG().lbScore),
              h("th", { scope: "col", class: "num lb-opt" }, TG().lbStages),
              overall ? h("th", { scope: "col", class: "num lb-opt" }, TG().lbCases) : null,
              h("th", { scope: "col", class: "num lb-opt" }, TG().lbFirstBloods),
            ),
          ),
          h(
            "tbody",
            {},
            rows.map((e) => {
              const isMe = myKey !== null && usernameKey(e.username) === myKey;
              return h(
                "tr",
                { class: `rank-${Math.min(e.rank, 4)}${isMe ? " is-me" : ""}` },
                h("td", { class: "num mono lb-rank" }, e.rank <= 3 ? ["🥇", "🥈", "🥉"][e.rank - 1] : String(e.rank)),
                h("th", { scope: "row", class: "lb-name" }, h("span", { dir: "auto" }, e.username), isMe ? h("span", { class: "chip lb-you" }, TG().lbYou) : null),
                h("td", { class: "num mono lb-score" }, String(e.score)),
                h("td", { class: "num mono lb-opt" }, String(e.stagesSolved)),
                overall ? h("td", { class: "num mono lb-opt" }, String(e.casesCompleted)) : null,
                h("td", { class: "num mono lb-opt" }, e.firstBloods > 0 ? `🩸 ${e.firstBloods}` : "0"),
              );
            }),
          ),
        ),
      ),
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
        h("div", {}, projector ? h("p", { class: "lb-brand mono" }, "▲ incidentlab") : h("a", { class: "back-link", href: "#/" }, T().navCases), h("h1", {}, TG().lbTitle), titleSub, eventEl),
        h("div", { class: "lb-tools" }, projector ? null : [h("label", { class: "field-label", for: "lb-case" }, TG().lbShow), select], projectorLink),
      ),
      frozenEl,
      body,
      projector ? null : h("p", { class: "muted small" }, TG().lbSub),
      updatedEl,
    ),
  );

  drawEvent();
  unsubscribe = onEventChange(drawEvent);
  tickTimer = window.setInterval(drawEvent, 1000);
  pollTimer = window.setInterval(() => void load(), POLL_MS);
  void load();
}
