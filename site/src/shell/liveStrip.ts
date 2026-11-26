// The live strip under the navbar: "on-call: you", today's case with a countdown to the next one, the event
// clock and connectivity (it replaces the old sticky .net-banner). Also owns the dismissible announcement
// banner that follows the header. The strip hides itself when it has nothing to say.
import { T } from "../i18n/strings-player";
import { TG } from "../i18n/strings-game";
import { TS } from "../i18n/strings-shell";
import { onConnectivity } from "../lib/api";
import { cachedEvent, formatCountdown, onEventChange, serverNow, startEventPolling } from "../lib/event";
import { h } from "../lib/dom";
import { caseSummary } from "../content/load";
import { eventDisplayPhase, eventLine, eventWhen } from "../views/leaderboard";
import { cachedToday, msUntilNextDay, onTodayChange, refreshToday } from "./today";

const DISMISSED_KEY = "il.announce.dismissed";
function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}
function writeDismissed(text: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, text);
  } catch {
    /* storage blocked: the banner just stays dismissed for this page load */
  }
}

/** Today's case and the countdown until the schedule's date changes. */
function createToday(onChange: () => void): { el: HTMLElement; tick: () => void } {
  const label = h("span", { class: "strip-label" });
  const title = h("bdi", { class: "strip-today-title" });
  const next = h("span", { class: "strip-today-next" });
  const el = h("span", { class: "strip-today", hidden: true }, label, " ", title, next);
  let rolling = false;
  const tick = (): void => {
    const today = cachedToday();
    const summary = today?.caseId ? caseSummary(today.caseId) : undefined;
    const wasHidden = el.hidden;
    el.hidden = today === null || summary === undefined;
    if (wasHidden !== el.hidden) onChange();
    if (today === null || summary === undefined) return;
    label.textContent = TS().stripToday;
    if (title.textContent !== summary.title) title.textContent = summary.title;
    const ms = msUntilNextDay(today.timezone, serverNow());
    next.hidden = ms === null;
    if (ms === null) return;
    next.textContent = TS().stripNextIn(formatCountdown(ms));
    // The day rolled over: ask the server for the new schedule (once per rollover).
    if (ms <= 1000 && !rolling) {
      rolling = true;
      window.setTimeout(() => {
        rolling = false;
        refreshToday(true);
      }, 2000);
    }
  };
  onTodayChange(tick);
  return { el, tick };
}

/** The event clock pill: the name truncates, the countdown never does. Full text in `title`. */
function createEventClock(onChange: () => void): { el: HTMLElement; tick: () => void } {
  const dot = h("span", { class: "dot", "aria-hidden": "true" });
  const name = h("span", { class: "event-clock-name", dir: "auto" });
  const time = h("span", { class: "event-clock-time" });
  const el = h("span", { class: "event-clock mono", hidden: true }, dot, name, time);
  const tick = (): void => {
    const line = eventLine();
    const event = cachedEvent();
    const wasHidden = el.hidden;
    el.hidden = line.length === 0;
    if (wasHidden !== el.hidden) onChange();
    if (line.length === 0 || event === null) return;
    const phase = eventDisplayPhase();
    el.className = `event-clock mono is-${phase}`;
    el.title = line;
    dot.hidden = phase !== "live";
    if (name.textContent !== event.name) name.textContent = event.name; // textContent only: admin-authored
    name.hidden = event.name.length === 0;
    time.textContent = eventWhen();
    time.hidden = time.textContent.length === 0;
  };
  return { el, tick };
}

function createAnnouncement(): HTMLElement {
  let dismissedText = readDismissed();
  let currentText: string | null = null;
  const text = h("p", { class: "announce-text", dir: "auto" });
  const label = h("span", { class: "announce-label" });
  const close = h("button", { type: "button", class: "announce-close", "aria-label": TG().dismiss }, "×");
  const banner = h("div", { class: "announce", role: "region", hidden: true }, h("div", { class: "announce-inner", "aria-live": "polite" }, label, text), close);
  close.addEventListener("click", () => {
    if (currentText !== null) {
      dismissedText = currentText;
      writeDismissed(currentText);
    }
    banner.hidden = true;
    document.getElementById("app")?.focus({ preventScroll: true });
  });
  onEventChange((event) => {
    const a = event?.announcement ?? null;
    currentText = a?.text ?? null;
    if (a === null || a.text === dismissedText) {
      banner.hidden = true;
      return;
    }
    banner.className = `announce announce-${a.level}`;
    banner.setAttribute("aria-label", TG().announcement);
    label.textContent = a.level === "warning" ? "⚠ " : "📣 ";
    if (text.textContent !== a.text) text.textContent = a.text; // textContent only: admin-authored text
    close.setAttribute("aria-label", TG().dismiss);
    banner.hidden = false;
  });
  return banner;
}

/** Fills .live-strip inside the header and puts the announcement banner right after the header. */
export function mountLiveStrip(header: HTMLElement): void {
  const strip = header.querySelector(".live-strip");
  if (!(strip instanceof HTMLElement)) return;
  const inner = strip.querySelector(".live-strip-inner") ?? strip;
  const status = strip.querySelector(".topbar-status");

  // Connectivity: a polite status region that stays in the DOM so its text change is announced.
  const net = h("span", { class: "net-status", role: "status" });
  let netState: "ok" | "retrying" | "unreachable" = "ok";

  const sync = (): void => {
    strip.setAttribute("aria-label", TS().liveStrip);
    const showStatus = status !== null && !status.classList.contains("is-off") && eventClock.el.hidden;
    const any = showStatus || !today.el.hidden || !eventClock.el.hidden || netState !== "ok";
    strip.hidden = !any;
    header.classList.toggle("has-event", !eventClock.el.hidden);
  };
  const today = createToday(sync);
  const eventClock = createEventClock(sync);
  inner.append(today.el, eventClock.el, net);

  onConnectivity((state) => {
    netState = state;
    net.classList.toggle("is-down", state !== "ok");
    sync(); // show the strip first: a live region that appears with its text already in it is often not read
    window.setTimeout(() => {
      net.textContent = netState === "ok" ? "" : netState === "retrying" ? T().netRetrying : T().netDown;
    }, 100);
  });
  if (status !== null) new MutationObserver(sync).observe(status, { attributes: true, attributeFilter: ["class"] });

  header.after(createAnnouncement());
  onEventChange(() => eventClock.tick());
  const tick = (): void => {
    today.tick();
    eventClock.tick();
  };
  window.addEventListener("hashchange", () => {
    tick(); // re-label on language change
    sync();
  });
  window.setInterval(tick, 1000);
  tick();
  sync();
  startEventPolling();
}
