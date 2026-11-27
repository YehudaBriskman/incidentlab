// The class page (#/class/<id>, #182): what a member needs on a class night. The class's case of the day (from
// its schedule, in its time zone), the event (window, freeze, announcement), the assigned cases, and the class
// board embedded (views/leaderboard.ts with the board token) with a projector link. Members may leave (asks
// first); pending requests see a waiting state and may cancel. Class admins get the way to Manage.
// The class name, the event name and the announcement are admin-authored: textContent only. Nothing here polls
// but the embedded board (the CDN-cached class board, every 10 s while the tab is visible).
import "../classes.css";
import type { ClassDetail } from "../../shared/contract";
import { pageHeader } from "../components/pagePanel";
import { caseSummary } from "../content/load";
import { TC } from "../i18n/strings-classes";
import { ApiError } from "../lib/api";
import { classToday, fetchClass, leaveClass } from "../lib/class-api";
import { isClassAdmin } from "../lib/class-permissions";
import { h, setChildren, type Child } from "../lib/dom";
import { eventPhase, serverNow } from "../lib/event";
import { confirm, toast } from "../lib/overlay";
import { cachedAccount, isGuest, loadAccount } from "../lib/session";
import { openGuestUpgrade } from "../shell/frame";
import { setPageCrumb } from "../shell/topbar";
import type { ViewResult } from "../shell/types";
import { asLiveEvent, eventWhen, renderLeaderboard } from "./leaderboard";
import { formatDateTimeZone } from "./manage/format";
import { classChips } from "./classes";

let tickTimer: number | null = null;

/** Stops the event countdown (the router calls it on every route change). */
export function stopClassPage(): void {
  if (tickTimer !== null) window.clearInterval(tickTimer);
  tickTimer = null;
}

export function classPageView(id: string): ViewResult {
  const main = h("div", { class: "view class-page" });
  return { main, start: () => renderClassPage(main, id) };
}

const boardHref = (token: string): string => `#/classboard/${encodeURIComponent(token)}?projector=1`;
const caseLink = (caseId: string): HTMLElement => h("a", { href: `#/case/${encodeURIComponent(caseId)}`, dir: "auto" }, caseSummary(caseId)?.title ?? caseId);

function card(id: string, title: string, aside: Child, body: Child, extra = ""): HTMLElement {
  return h(
    "section",
    { class: `class-card${extra ? ` ${extra}` : ""}`, "aria-labelledby": id },
    h("header", { class: "class-card-head" }, h("h2", { id, class: "class-card-title" }, title), aside ? h("span", { class: "class-card-aside" }, aside) : null),
    h("div", { class: "class-card-pad" }, body),
  );
}

function note(title: string, body: string, actions?: Child): HTMLElement {
  return h(
    "section",
    { class: "class-note", "aria-labelledby": "class-note-title" },
    h("h2", { id: "class-note-title", class: "class-note-title", tabindex: "-1" }, title),
    h("div", { class: "class-note-body" }, h("p", {}, body)),
    actions ? h("div", { class: "class-note-actions" }, actions) : null,
  );
}

function renderClassPage(root: HTMLElement, id: string): void {
  stopClassPage();
  setChildren(root, h("p", { class: "muted" }, TC().loading));
  void loadAccount()
    .then(async (account) => {
      if (account === null) {
        setChildren(root, note(TC().signedOutTitle, TC().signedOutBody, [h("a", { class: "btn btn-primary", href: "#/login" }, TC().signIn), h("a", { class: "btn", href: "#/signup" }, TC().signUp)]));
        return;
      }
      if (isGuest(account)) {
        const btn = h("button", { type: "button", class: "btn btn-primary" }, TC().signUp);
        btn.addEventListener("click", openGuestUpgrade);
        setChildren(root, note(TC().guestTitle, TC().guestBody, btn));
        return;
      }
      draw(await fetchClass(id));
    })
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) {
        document.title = `${TC().notFoundTitle} · IncidentLab`;
        setChildren(root, note(TC().notFoundTitle, TC().notFoundBody, h("a", { class: "btn", href: "#/classes" }, TC().allClasses)));
        return;
      }
      const retry = h("button", { type: "button", class: "btn btn-primary" }, TC().retry);
      retry.addEventListener("click", () => renderClassPage(root, id));
      setChildren(root, h("div", { class: "class-note", role: "alert" }, h("p", {}, TC().loadFailed, " ", err instanceof Error ? err.message : ""), retry));
    });

  function draw(c: ClassDetail): void {
    document.title = `${c.name} · IncidentLab`;
    setPageCrumb(null); // redraws the breadcrumb with the class name (lib/class-api.ts remembers it)
    const m = c.membership;
    const admin = isClassAdmin({ membership: m, accountId: cachedAccount()?.id ?? null });
    const canLeave = m !== null && !m.isOwner;
    const leaveBtn = canLeave ? h("button", { type: "button", class: "btn btn-ghost" }, m.status === "pending" ? TC().cancelRequest : TC().leave) : null;
    leaveBtn?.addEventListener("click", () => {
      const pending = m?.status === "pending";
      void confirm({
        title: pending ? TC().cancelRequestTitle(c.name) : TC().leaveTitle(c.name),
        body: pending ? TC().cancelRequestBody : TC().leaveBody,
        confirmLabel: pending ? TC().cancelRequest : TC().leave,
        cancelLabel: TC().keep,
        busyLabel: TC().leaving,
        tone: "danger",
        run: () => leaveClass(c.id),
        returnFocus: () => leaveBtn,
      }).then(
        (ok) => {
          if (!ok) return;
          toast({ tone: "success", text: pending ? TC().requestCancelled : TC().left(c.name) });
          window.location.hash = "#/classes";
        },
        (err: unknown) => toast({ tone: "error", text: TC().actionFailed(err instanceof Error ? err.message : TC().unknownError) }),
      );
    });
    const actions: Child[] = [
      admin ? h("a", { class: "btn btn-primary", href: `#/class/${encodeURIComponent(c.id)}/manage` }, TC().manage) : null,
      c.boardToken !== undefined ? h("a", { class: "btn", href: boardHref(c.boardToken) }, TC().projector) : null,
      leaveBtn,
    ];
    const header = pageHeader({ title: h("bdi", {}, c.name), meta: h("span", { class: "class-chips" }, classChips(c)), actions, id: "class-title" });

    if (m !== null && m.status === "pending") {
      setChildren(root, header, note(TC().pendingPageTitle, TC().pendingPageBody(c.name)));
      return;
    }

    const today = classToday(c.schedule);
    const todayCase = today?.caseId ?? null;
    const todayCard = card(
      "class-today-h",
      TC().todayTitle,
      today ? TC().todayDate(today.date) : null,
      todayCase !== null && caseSummary(todayCase) !== undefined
        ? h(
            "div",
            { class: "class-today" },
            h("a", { class: "class-today-title", href: `#/case/${encodeURIComponent(todayCase)}`, dir: "auto" }, caseSummary(todayCase)?.title ?? todayCase),
            h("p", { class: "muted small", dir: "auto" }, caseSummary(todayCase)?.subtitle ?? ""),
            h("a", { class: "btn btn-sm", href: `#/case/${encodeURIComponent(todayCase)}` }, TC().openCase),
          )
        : h("p", { class: "muted" }, TC().todayNone),
    );

    const eventCard = drawEvent(c);
    const assigned = c.caseIds ?? [];
    const casesCard = card(
      "class-cases-h",
      TC().casesTitle,
      assigned.length > 0 ? TC().casesCount(assigned.length) : null,
      assigned.length > 0 ? h("ul", { class: "class-case-list" }, assigned.map((cid) => h("li", {}, caseLink(cid)))) : h("p", { class: "muted" }, TC().anyCase),
    );

    const boardHost = h("div", { class: "class-board-host" });
    const boardCard = h("section", { class: "class-card class-board", "aria-label": TC().boardTitle }, boardHost);
    setChildren(
      root,
      header,
      c.status === "archived" ? h("p", { class: "class-archived-note", role: "note" }, TC().archivedNote) : null,
      h("div", { class: "class-top" }, todayCard, eventCard, casesCard),
      c.boardToken !== undefined && c.status === "active" ? boardCard : null,
    );
    if (c.boardToken !== undefined && c.status === "active") renderLeaderboard(boardHost, new URLSearchParams(), { board: c.boardToken, embedded: true });
  }
}

/** The event card: phase and countdown, the window, the freeze and the announcement (text only). */
function drawEvent(c: ClassDetail): HTMLElement {
  const ev = c.event;
  if (ev === undefined || (ev.name === "" && ev.startsAt === null && ev.endsAt === null && ev.freezeAt === null && ev.announcement === null)) {
    return card("class-event-h", TC().eventTitle, null, h("p", { class: "muted" }, TC().eventNone));
  }
  const live = asLiveEvent(ev);
  const phaseEl = h("span", { class: "chip" });
  const whenEl = h("span", { class: "muted small class-event-when" });
  const drawPhase = (): void => {
    const phase = eventPhase(live, serverNow());
    const [cls, label] =
      phase.kind === "before" ? ["chip pill-info", TC().eventUpcoming] : phase.kind === "running" ? ["chip pill-success", TC().eventLive] : phase.kind === "over" ? ["chip chip-muted", TC().eventOver] : ["chip", ""];
    phaseEl.className = cls;
    phaseEl.textContent = label;
    phaseEl.hidden = label === "";
    whenEl.textContent = phase.kind === "none" ? TC().eventNoWindow : eventWhen(live);
  };
  drawPhase();
  stopClassPage();
  tickTimer = window.setInterval(() => {
    if (!phaseEl.isConnected) return stopClassPage();
    drawPhase();
  }, 1000);
  const when = (iso: string | null): string => (iso === null ? "—" : formatDateTimeZone(iso));
  const rows: Array<[string, string]> = [];
  if (ev.startsAt !== null) rows.push([TC().eventStarts, when(ev.startsAt)]);
  if (ev.endsAt !== null) rows.push([TC().eventEnds, when(ev.endsAt)]);
  if (ev.freezeAt !== null) rows.push([TC().eventFreeze, when(ev.freezeAt)]);
  return card(
    "class-event-h",
    TC().eventTitle,
    phaseEl,
    [
      ev.name !== "" ? h("p", { class: "class-event-name", dir: "auto" }, ev.name) : null,
      whenEl,
      rows.length > 0 ? h("dl", { class: "class-facts" }, rows.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))) : null,
      ev.announcement !== null
        ? h(
            "div",
            { class: `class-announcement is-${ev.announcement.level}`, role: "note" },
            h("span", { class: "visually-hidden" }, `${TC().announcement}: `),
            h("p", { dir: "auto" }, ev.announcement.text),
          )
        : null,
    ],
  );
}
