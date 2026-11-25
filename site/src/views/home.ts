import type { CaseStats, TodayResponse } from "../../shared/contract";
import { caseSummaries, caseSummary, teasers } from "../content/load";
import type { CaseSummary } from "../content/catalog-schema";
import type { Teaser } from "../content/schema";
import { fetchMyStats } from "../lib/api";
import { h, setChildren } from "../lib/dom";
import { cachedAccount, isAccountKnown, loadAccount, loadToday } from "../lib/session";
import { getLang } from "../i18n/i18n";
import { cachedEvent, isEventActive, onEventChange } from "../lib/event";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { eventDisplayPhase, eventWhen } from "./leaderboard";
import { T } from "../i18n/strings-player";

const steps = (): ReadonlyArray<{ title: string; body: string }> => [
  { title: T().step1Title, body: T().step1Body },
  { title: T().step2Title, body: T().step2Body },
  { title: T().step3Title, body: T().step3Body },
];

type HomeState = {
  /** true until /api/today and the player's stats have both answered: draw skeletons, no CTAs */
  loading: boolean;
  today: TodayResponse | null;
  stats: ReadonlyMap<string, CaseStats>;
  isSignedIn: boolean;
};

/** Placeholders with the real cards' footprint, so nothing jumps when today's case and the catalog arrive. */
function todaySkeleton(): HTMLElement {
  return h(
    "div",
    { class: "featured-card today-card skeleton-card", "aria-hidden": "true" },
    h("span", { class: "skeleton-line w-40" }),
    h("span", { class: "skeleton-line w-30" }),
    h("span", { class: "skeleton-line skeleton-title w-60" }),
    h("span", { class: "skeleton-line w-90" }),
    h("span", { class: "skeleton-line w-70" }),
    h("span", { class: "skeleton-btn" }),
  );
}

function caseSkeleton(): HTMLElement {
  return h(
    "div",
    { class: "case-card skeleton-card", "aria-hidden": "true" },
    h("span", { class: "skeleton-line w-40" }),
    h("span", { class: "skeleton-line skeleton-title w-70" }),
    h("span", { class: "skeleton-line w-90" }),
    h("span", { class: "skeleton-line w-60" }),
  );
}

const formatDate = (isoDate: string): string => {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return isoDate;
  return new Intl.DateTimeFormat(getLang() === "he" ? "he-IL" : "en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
};

function statusLine(stats: CaseStats | undefined): string | null {
  if (!stats || stats.status === "not-started") return null;
  const scorePar = TG().scorePar(stats.score, stats.maxScore);
  return stats.status === "completed" ? TA().caseStatusDone(scorePar) : TA().caseStatusProgress(scorePar);
}

/** Can this case be opened right now? (lock-to-today hides the button for other unstarted cases) */
function isOpenToday(c: CaseSummary, state: HomeState): boolean {
  const today = state.today;
  if (!today?.lockToToday) return true;
  const started = state.stats.get(c.id);
  return today.caseId === c.id || (started !== undefined && started.status !== "not-started");
}

function caseCta(c: CaseSummary, state: HomeState, primary: boolean): HTMLElement {
  if (!isOpenToday(c, state)) return h("span", { class: "chip chip-muted mono" }, TA().lockedToday);
  const stats = state.stats.get(c.id);
  const label = !state.isSignedIn
    ? TA().signInToPlay
    : stats && stats.status !== "not-started"
      ? T().resumeInvestigation
      : primary
        ? T().startInvestigation
        : TA().openCase;
  return h("a", { class: `btn ${primary ? "btn-primary btn-lg" : "btn-sm"}`, href: `#/case/${c.id}` }, label);
}

function todayCard(c: CaseSummary, state: HomeState, date: string): HTMLElement {
  const line = statusLine(state.stats.get(c.id));
  return h(
    "article",
    { class: "featured-card today-card", "aria-labelledby": "today-title" },
    h("p", { class: "today-kicker mono" }, h("span", { class: "dot", "aria-hidden": "true" }), TA().todayKicker(formatDate(date))),
    h("p", { class: "featured-meta mono" }, T().featuredMeta(c.difficulty, c.estMinutes, c.questionCount)),
    h("h2", { id: "today-title", class: "featured-title" }, c.title),
    h("p", { class: "featured-sub" }, c.subtitle),
    line ? h("p", { class: "case-status mono" }, line) : null,
    caseCta(c, state, true),
  );
}

function caseCard(c: CaseSummary, state: HomeState): HTMLElement {
  const line = statusLine(state.stats.get(c.id));
  const isToday = state.today?.caseId === c.id;
  return h(
    "article",
    { class: `case-card${isToday ? " is-today" : ""}` },
    h("p", { class: "featured-meta mono" }, T().featuredMeta(c.difficulty, c.estMinutes, c.questionCount)),
    h("h3", { class: "case-card-title" }, c.title),
    h("p", { class: "muted case-card-sub" }, c.subtitle),
    h("div", { class: "tag-row" }, c.tags.slice(0, 4).map((tag) => h("span", { class: "chip mono" }, tag))),
    h("div", { class: "case-card-foot" }, line ? h("span", { class: "case-status mono" }, line) : h("span", { class: "muted small" }, TA().caseStatusNew), caseCta(c, state, false)),
  );
}

/**
 * Event strip: phase-aware kicker ("Upcoming event" / "● Live event" / "Event ended"), name and countdown,
 * ticking every second; it removes its own timers once detached. Only a running event gets the live dot.
 */
function eventStrip(): HTMLElement {
  const name = h("p", { class: "event-strip-name" });
  const when = h("p", { class: "event-strip-when mono" });
  const dot = h("span", { class: "dot", "aria-hidden": "true" });
  const kickerText = h("span", {});
  const strip = h(
    "section",
    { class: "event-strip", hidden: true },
    h("p", { class: "today-kicker mono" }, dot, kickerText),
    name,
    when,
    h("a", { class: "btn btn-sm", href: "#/leaderboard" }, TG().homeLeaderboard),
  );
  const draw = (): void => {
    const event = cachedEvent();
    if (!isEventActive(event)) {
      strip.hidden = true;
      return;
    }
    const phase = eventDisplayPhase();
    const kicker = phase === "before" ? TG().eventKickerBefore : phase === "over" ? TG().eventKickerOver : TG().eventKicker;
    strip.hidden = false;
    strip.className = `event-strip is-${phase}`;
    strip.setAttribute("aria-label", kicker);
    kickerText.textContent = kicker;
    dot.hidden = phase !== "live";
    name.textContent = event.name;
    name.hidden = event.name.length === 0;
    when.textContent = phase === "over" ? TG().eventFinal : eventWhen();
    when.classList.toggle("mono", phase !== "over"); // a sentence, not a clock
    when.hidden = when.textContent.length === 0;
  };
  const unsubscribe = onEventChange(draw);
  const timer = window.setInterval(() => {
    if (!strip.isConnected) {
      window.clearInterval(timer);
      unsubscribe();
      return;
    }
    draw();
  }, 1000);
  draw();
  return strip;
}

function teaserCard(t: Teaser): HTMLElement {
  return h("article", { class: "teaser-card" }, h("h3", { class: "teaser-title" }, t.title), h("p", { class: "muted" }, t.tagline));
}

function heroSub(): HTMLElement {
  const account = cachedAccount();
  // Until the server says who this is, keep the line's space but show nothing: no signed-out flash.
  if (!isAccountKnown()) return h("p", { class: "hero-sub is-pending", "aria-hidden": "true" }, T().heroSub);
  return h("p", { class: "hero-sub" }, account && account.status === "approved" ? TA().welcomeBack(account.username) : T().heroSub);
}

function draw(root: HTMLElement, state: HomeState): void {
  const released = state.today?.releasedCaseIds;
  const playable = caseSummaries().filter((c) => released === undefined || released.includes(c.id));
  const todayCase = state.today?.caseId ? caseSummary(state.today.caseId) : undefined;

  setChildren(
    root,
    h(
      "section",
      { class: "hero" },
      h("h1", { class: "hero-title" }, T().heroA, h("span", { class: "accent" }, T().heroB)),
      heroSub(),
      h("p", { class: "hero-links" }, h("a", { href: "#/leaderboard" }, TG().homeLeaderboard)),
    ),
    eventStrip(),
    h(
      "section",
      { class: "section", "aria-label": T().featuredCase, "aria-busy": state.loading ? "true" : null },
      state.loading
        ? todaySkeleton()
        : todayCase && state.today
        ? todayCard(todayCase, state, state.today.date)
        : state.today
          ? h("p", { class: "muted" }, TA().todayNone)
          : null,
    ),
    h(
      "section",
      { class: "section", "aria-labelledby": "cases-h", "aria-busy": state.loading ? "true" : null },
      h("h2", { id: "cases-h", class: "section-title" }, TA().allCases),
      state.today?.lockToToday ? h("p", { class: "muted small" }, TA().casesLockedToday) : null,
      state.loading
        ? h("div", { class: "case-grid" }, caseSummaries().map(() => caseSkeleton()))
        : playable.length > 0
          ? h("div", { class: "case-grid" }, playable.map((c) => caseCard(c, state)))
          : h("p", { class: "muted" }, T().noCases),
    ),
    h(
      "section",
      { class: "section", "aria-labelledby": "how-h" },
      h("h2", { id: "how-h", class: "section-title" }, T().howItWorks),
      h("ol", { class: "how" }, steps().map((s, i) => h("li", {}, h("span", { class: "how-n mono" }, String(i + 1)), h("div", {}, h("h3", {}, s.title), h("p", { class: "muted" }, s.body))))),
    ),
    teasers.length > 0
      ? h(
          "section",
          { class: "section", "aria-labelledby": "soon-h" },
          h("h2", { id: "soon-h", class: "section-title" }, T().comingSoon),
          h("div", { class: "teaser-grid" }, teasers.map(teaserCard)),
        )
      : null,
  );
}

export function renderHome(root: HTMLElement): void {
  document.title = T().homeTitle;
  const token = Symbol("home");
  activeRender = token;
  const state: HomeState = { loading: true, today: null, stats: new Map(), isSignedIn: cachedAccount() !== null };
  draw(root, state);

  // Today's case and (when signed in and approved) per-case status fill in as they arrive.
  const today = loadToday().then(
    (value) => value,
    () => null,
  );
  const account = loadAccount();
  let settled = false;
  // Once we know who is signed in, put the right hero line up while the cards are still loading.
  if (!isAccountKnown()) {
    void account.then(
      () => {
        if (activeRender === token && !settled) draw(root, { ...state, isSignedIn: cachedAccount() !== null });
      },
      () => undefined,
    );
  }
  const stats = account.then(
    (acc) => (acc?.status === "approved" ? fetchMyStats().then((s) => s.cases, () => []) : []),
    () => [],
  );
  void Promise.all([today, stats]).then(([todayValue, caseStats]) => {
    if (activeRender !== token) return; // user navigated away
    settled = true;
    draw(root, { loading: false, today: todayValue, stats: new Map(caseStats.map((c) => [c.caseId, c])), isSignedIn: cachedAccount() !== null });
  });
}

let activeRender: symbol | null = null;
