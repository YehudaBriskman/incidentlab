// A class event's status line ("● Spring finals · ends in 12:03 [Board frozen]"), shared by home's class rows
// (#183) and the case status line (#216), plus the page's one shared 1 s tick and the case page's class lookup.
import type { ClassDetail } from "../../shared/contract";
import { fetchClass, fetchMyClasses } from "../lib/class-api";
import { classEventPhase, homeClasses, isClassBoardFrozen, needsDetail, pickClassEvent, type CaseClassEvent } from "../lib/challenges";
import { h } from "../lib/dom";
import { formatCountdown, serverNow } from "../lib/event";
import { TC } from "../i18n/strings-challenges";
import { TG } from "../i18n/strings-game";

/* ================= one shared 1 s tick ================= */

const ticks = new Set<() => void>();
let tickTimer = 0;

/**
 * Runs `draw` now and then every second while `el` is in the document (one interval for the whole page, shared
 * with the Today card's event line). `onStop` runs once `el` has left the page.
 */
export function everySecond(el: HTMLElement, draw: () => void, onStop?: () => void): void {
  const fn = (): void => {
    if (!el.isConnected) {
      ticks.delete(fn);
      onStop?.();
      return;
    }
    draw();
  };
  ticks.add(fn);
  draw();
  if (tickTimer !== 0) return;
  tickTimer = window.setInterval(() => {
    for (const f of [...ticks]) f();
    if (ticks.size === 0) {
      window.clearInterval(tickTimer);
      tickTimer = 0;
    }
  }, 1000);
}

/* ================= the status ================= */

/** "● Spring finals · ends in 12:03 [Board frozen]", redrawn every second from the class's own event window. */
export function eventStatus(event: ClassDetail["event"]): HTMLElement {
  const dot = h("span", { class: "dot", "aria-hidden": "true" });
  const name = h("bdi", { class: "home-class-event-name" });
  const when = h("span", { class: "home-class-when" });
  const frozen = h("span", { class: "chip pill-info home-class-frozen" }, TC().frozen);
  const el = h("span", { class: "home-class-event" }, dot, name, when, frozen);
  everySecond(el, () => {
    const now = serverNow();
    const phase = classEventPhase(event, now);
    const named = (event?.name ?? "").length > 0 ? (event?.name ?? "") : null;
    el.className = `home-class-event is-${phase.kind}`;
    dot.hidden = phase.kind !== "live";
    frozen.hidden = !(phase.kind === "live" || phase.kind === "over") || !isClassBoardFrozen(event, now);
    if (phase.kind === "none") {
      name.textContent = named ?? TC().noEvent;
      when.textContent = "";
    } else if (phase.kind === "before") {
      name.textContent = named ?? TC().eventUpcoming;
      when.textContent = TG().eventStartsIn(formatCountdown(phase.msLeft));
    } else if (phase.kind === "live") {
      name.textContent = named ?? TC().eventLive;
      when.textContent = phase.msLeft === null ? TG().eventLive : TG().eventEndsIn(formatCountdown(phase.msLeft));
    } else {
      name.textContent = named ?? TC().eventEnded;
      when.textContent = named === null ? "" : TG().eventOver;
    }
    // a frozen board says so instead of the countdown (the class page keeps the clock): the row stays one line
    when.hidden = when.textContent === "" || !frozen.hidden;
  });
  return el;
}

/* ================= the case page's class event (#216) ================= */

type ClassEventPick = CaseClassEvent<NonNullable<ClassDetail["event"]>> | null;

/** One lookup per page load and case (zero budget: GET /api/classes plus one detail per class, at most 5). */
const CACHE_MS = 10 * 60_000;
let cache: { at: number; details: Promise<ClassDetail[]> } | null = null;

function myClassDetails(): Promise<ClassDetail[]> {
  if (cache !== null && Date.now() - cache.at < CACHE_MS) return cache.details;
  const details = fetchMyClasses().then((all) =>
    Promise.all(homeClasses(all).shown.filter(needsDetail).map((c) => fetchClass(c.id).catch((): null => null))).then((list) =>
      list.filter((d): d is ClassDetail => d !== null),
    ),
  );
  cache = { at: Date.now(), details };
  // a failed lookup is tried again on the next case page, not cached for ten minutes
  details.catch(() => {
    if (cache?.details === details) cache = null;
  });
  return details;
}

/** The class event to show on `caseId`'s page, or null (no class, no event, or the lookup failed). */
export function caseClassEvent(caseId: string): Promise<ClassEventPick> {
  return myClassDetails().then(
    (details) => pickClassEvent(details.map((d) => ({ id: d.id, name: d.name, event: d.event ?? undefined, caseIds: d.caseIds })), caseId, serverNow()),
    (): ClassEventPick => null,
  );
}
