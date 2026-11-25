import type { CaseStats, TodayResponse } from "../../shared/contract";
import { allCases, getCase, teasers } from "../content/load";
import type { Case, Teaser } from "../content/schema";
import { fetchMyStats } from "../lib/api";
import { h, setChildren } from "../lib/dom";
import { cachedAccount, loadAccount, loadToday } from "../lib/session";
import { getLang } from "../i18n/i18n";
import { cachedEvent, isEventActive, onEventChange } from "../lib/event";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { eventWhen } from "./leaderboard";
import { T } from "../i18n/strings-player";

const steps = (): ReadonlyArray<{ title: string; body: string }> => [
  { title: T().step1Title, body: T().step1Body },
  { title: T().step2Title, body: T().step2Body },
  { title: T().step3Title, body: T().step3Body },
];

type HomeState = {
  today: TodayResponse | null;
  stats: ReadonlyMap<string, CaseStats>;
  isSignedIn: boolean;
};

const formatDate = (isoDate: string): string => {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return isoDate;
  return new Intl.DateTimeFormat(getLang() === "he" ? "he-IL" : "en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
};

function statusLine(stats: CaseStats | undefined): string | null {
  if (!stats || stats.status === "not-started") return null;
  return stats.status === "completed" ? TA().caseStatusDone(stats.score, stats.maxScore) : TA().caseStatusProgress(stats.score, stats.maxScore);
}

/** Can this case be opened right now? (lock-to-today hides the button for other unstarted cases) */
function isOpenToday(c: Case, state: HomeState): boolean {
  const today = state.today;
  if (!today?.lockToToday) return true;
  const started = state.stats.get(c.id);
  return today.caseId === c.id || (started !== undefined && started.status !== "not-started");
}

function caseCta(c: Case, state: HomeState, primary: boolean): HTMLElement {
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

function todayCard(c: Case, state: HomeState, date: string): HTMLElement {
  const line = statusLine(state.stats.get(c.id));
  return h(
    "article",
    { class: "featured-card today-card", "aria-labelledby": "today-title" },
    h("p", { class: "today-kicker mono" }, h("span", { class: "dot", "aria-hidden": "true" }), TA().todayKicker(formatDate(date))),
    h("p", { class: "featured-meta mono" }, T().featuredMeta(c.difficulty, c.estMinutes, c.questions.length)),
    h("h2", { id: "today-title", class: "featured-title" }, c.title),
    h("p", { class: "featured-sub" }, c.subtitle),
    line ? h("p", { class: "case-status mono" }, line) : null,
    caseCta(c, state, true),
  );
}

function caseCard(c: Case, state: HomeState): HTMLElement {
  const line = statusLine(state.stats.get(c.id));
  const isToday = state.today?.caseId === c.id;
  return h(
    "article",
    { class: `case-card${isToday ? " is-today" : ""}` },
    h("p", { class: "featured-meta mono" }, T().featuredMeta(c.difficulty, c.estMinutes, c.questions.length)),
    h("h3", { class: "case-card-title" }, c.title),
    h("p", { class: "muted case-card-sub" }, c.subtitle),
    h("div", { class: "tag-row" }, c.tags.slice(0, 4).map((tag) => h("span", { class: "chip mono" }, tag))),
    h("div", { class: "case-card-foot" }, line ? h("span", { class: "case-status mono" }, line) : h("span", { class: "muted small" }, TA().caseStatusNew), caseCta(c, state, false)),
  );
}

/** "Live event" strip: name + countdown, ticking every second; it removes its own timers once detached. */
function eventStrip(): HTMLElement {
  const name = h("p", { class: "event-strip-name" });
  const when = h("p", { class: "event-strip-when mono" });
  const strip = h(
    "section",
    { class: "event-strip", "aria-label": TG().eventKicker, hidden: true },
    h("p", { class: "today-kicker mono" }, h("span", { class: "dot", "aria-hidden": "true" }), TG().eventKicker),
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
    strip.hidden = false;
    name.textContent = event.name;
    name.hidden = event.name.length === 0;
    when.textContent = eventWhen();
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

function draw(root: HTMLElement, state: HomeState): void {
  const account = cachedAccount();
  const released = state.today?.releasedCaseIds;
  const playable = allCases().filter((c) => released === undefined || released.includes(c.id));
  const todayCase = state.today?.caseId ? getCase(state.today.caseId) : undefined;

  setChildren(
    root,
    h(
      "section",
      { class: "hero" },
      h("h1", { class: "hero-title" }, T().heroA, h("span", { class: "accent" }, T().heroB)),
      h("p", { class: "hero-sub" }, account && account.status === "approved" ? TA().welcomeBack(account.username) : T().heroSub),
      h("p", { class: "hero-links" }, h("a", { href: "#/leaderboard" }, TG().homeLeaderboard)),
    ),
    eventStrip(),
    h(
      "section",
      { class: "section", "aria-label": T().featuredCase },
      todayCase && state.today
        ? todayCard(todayCase, state, state.today.date)
        : state.today
          ? h("p", { class: "muted" }, TA().todayNone)
          : null,
    ),
    h(
      "section",
      { class: "section", "aria-labelledby": "cases-h" },
      h("h2", { id: "cases-h", class: "section-title" }, TA().allCases),
      state.today?.lockToToday ? h("p", { class: "muted small" }, TA().casesLockedToday) : null,
      playable.length > 0 ? h("div", { class: "case-grid" }, playable.map((c) => caseCard(c, state))) : h("p", { class: "muted" }, T().noCases),
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
  const state: HomeState = { today: null, stats: new Map(), isSignedIn: cachedAccount() !== null };
  draw(root, state);

  // Today's case and (when signed in and approved) per-case status fill in as they arrive.
  const today = loadToday().then(
    (value) => value,
    () => null,
  );
  const stats = loadAccount().then(
    (account) => (account?.status === "approved" ? fetchMyStats().then((s) => s.cases, () => []) : []),
    () => [],
  );
  void Promise.all([today, stats]).then(([todayValue, caseStats]) => {
    if (activeRender !== token) return; // user navigated away
    draw(root, { today: todayValue, stats: new Map(caseStats.map((c) => [c.caseId, c])), isSignedIn: cachedAccount() !== null });
  });
}

let activeRender: symbol | null = null;
