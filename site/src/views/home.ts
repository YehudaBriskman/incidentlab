import type { AccountView, CaseStats, LeaderboardResponse, TodayResponse } from "../../shared/contract";
import { caseSummaries, caseSummary, teasers } from "../content/load";
import type { CaseSummary, Teaser } from "../content/catalog-schema";
import { fetchLeaderboard, fetchMyStats } from "../lib/api";
import { h, setChildren, type Child } from "../lib/dom";
import { cachedAccount, isAccountKnown, loadAccount, loadToday } from "../lib/session";
import { getLang } from "../i18n/i18n";
import { cachedEvent, isEventActive, onEventChange } from "../lib/event";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { TO } from "../i18n/strings-onboard";
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
  /** public overall board, for the signed-out proof line (null until it answers or when it fails) */
  board: LeaderboardResponse | null;
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

/**
 * Hebrew prefixes glued to a Latin word ("ה-commit", "ל-27") must not break after the hyphen and leave
 * "ה-" orphaned at a line end: use a non-breaking hyphen (U+2011) there.
 */
function keepPrefix(text: string): string {
  return text.replace(/([\u0590-\u05FF])-(?=[A-Za-z0-9])/g, "$1\u2011");
}

/**
 * A case title as bidi-isolated segments: mixed titles ("The 3 AM Outage – התקלה של 3 לפנות בוקר") keep each
 * language's run in order instead of the Unicode bidi algorithm reordering words across the dash.
 */
function titleNode(title: string): Child[] {
  const parts = keepPrefix(title).split(" – ");
  return parts.flatMap((part, i) => (i === 0 ? [h("bdi", {}, part)] : [" – ", h("bdi", {}, part)]));
}

/** "Hard · ~60 min · 6 stages", translated, with the duration isolated so "~60" and its unit stay together. */
function caseMeta(c: CaseSummary): HTMLElement {
  return h("p", { class: "featured-meta" }, TO().difficulty(c.difficulty), " · ", h("bdi", {}, TO().minutes(c.estMinutes)), " · ", TO().stages(c.questionCount));
}

/** Can this case be opened right now? (lock-to-today hides the button for other unstarted cases) */
function isOpenToday(c: CaseSummary, state: HomeState): boolean {
  const today = state.today;
  if (!today?.lockToToday) return true;
  const started = state.stats.get(c.id);
  return today.caseId === c.id || (started !== undefined && started.status !== "not-started");
}

/**
 * The case's action. Amber is spent once per view: on the hero CTA (signed out), the resume card, or (when
 * there is nothing to resume) today's incident. Everything else is a neutral button.
 */
function caseCta(c: CaseSummary, state: HomeState, opts: { primary: boolean; today: boolean }): HTMLElement {
  if (!isOpenToday(c, state)) return h("span", { class: "chip chip-muted" }, TA().lockedToday);
  const stats = state.stats.get(c.id);
  const label = !state.isSignedIn
    ? opts.today
      ? TA().signInToPlay
      : TO().openCase
    : stats?.status === "completed"
      ? TO().reviewDebrief
      : stats?.status === "in-progress"
        ? T().resumeInvestigation
        : opts.today
          ? T().startInvestigation
          : TO().openCase;
  const size = opts.today ? " btn-lg" : " btn-sm";
  return h("a", { class: `btn${opts.primary ? " btn-primary" : opts.today ? "" : " btn-ghost"}${size}`, href: `#/case/${c.id}` }, label);
}

/** The player's most recently started, unfinished case (the "resume" focal point). */
function resumeCase(state: HomeState): { c: CaseSummary; stats: CaseStats } | null {
  const open = [...state.stats.values()]
    .filter((s) => s.status === "in-progress")
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  for (const stats of open) {
    const c = caseSummary(stats.caseId);
    if (c !== undefined) return { c, stats };
  }
  return null;
}

function resumeCard(c: CaseSummary, stats: CaseStats): HTMLElement {
  const done = stats.solved + stats.revealed;
  const stage = done >= c.questionCount ? TO().allSolved(c.questionCount) : TO().stageOf(done + 1, c.questionCount);
  return h(
    "article",
    { class: "resume-card", "aria-labelledby": "resume-title" },
    h("p", { class: "resume-kicker" }, TO().resumeKicker),
    h("h2", { id: "resume-title", class: "resume-title" }, titleNode(c.title)),
    h("p", { class: "resume-meta" }, stage, " · ", TG().scorePar(stats.score, stats.maxScore)),
    h(
      "span",
      { class: "resume-track", "aria-hidden": "true" },
      Array.from({ length: c.questionCount }, (_, i) => h("span", { class: `resume-seg${i < done ? " is-done" : ""}` })),
    ),
    h("a", { class: "btn btn-primary btn-lg", href: `#/case/${c.id}` }, TO().resume, h("bdi", {}, c.title)),
  );
}

function todayCard(c: CaseSummary, state: HomeState, date: string, primary: boolean): HTMLElement {
  const line = statusLine(state.stats.get(c.id));
  return h(
    "article",
    { class: "featured-card today-card", "aria-labelledby": "today-title" },
    h("p", { class: "today-kicker" }, h("span", { class: "dot", "aria-hidden": "true" }), TA().todayKicker(formatDate(date))),
    caseMeta(c),
    h("h2", { id: "today-title", class: "featured-title" }, titleNode(c.title)),
    h("p", { class: "featured-sub" }, keepPrefix(c.subtitle)),
    line ? h("p", { class: "case-status" }, line) : null,
    caseCta(c, state, { primary, today: true }),
  );
}

function caseCard(c: CaseSummary, state: HomeState): HTMLElement {
  const line = statusLine(state.stats.get(c.id));
  const isToday = state.today?.caseId === c.id;
  return h(
    "article",
    { class: `case-card${isToday ? " is-today" : ""}` },
    h("div", { class: "case-card-top" }, caseMeta(c), isToday ? h("span", { class: "chip today-chip" }, TO().todayTag) : null),
    h("h3", { class: "case-card-title" }, titleNode(c.title)),
    h("p", { class: "muted case-card-sub" }, keepPrefix(c.subtitle)),
    h("div", { class: "tag-row" }, c.tags.slice(0, 4).map((tag) => h("span", { class: "chip mono" }, tag))),
    h("div", { class: "case-card-foot" }, line ? h("span", { class: "case-status" }, line) : h("span", { class: "muted small" }, TA().caseStatusNew), caseCta(c, state, { primary: false, today: false })),
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

function learnSection(): HTMLElement {
  const items = [
    { title: TO().learn1Title, body: TO().learn1Body },
    { title: TO().learn2Title, body: TO().learn2Body },
    { title: TO().learn3Title, body: TO().learn3Body },
  ];
  return h(
    "section",
    { class: "section learn", "aria-labelledby": "learn-h" },
    h("h2", { id: "learn-h", class: "section-title" }, TO().learnTitle),
    h("ul", { class: "learn-list" }, items.map((it) => h("li", {}, h("h3", {}, it.title), h("p", { class: "muted" }, it.body)))),
  );
}

/** Live proof from the public board ("12 investigators on the leaderboard · 48 stages solved"). */
function proofLine(board: LeaderboardResponse | null): HTMLElement | null {
  if (board === null || board.entries.length === 0) return null;
  const stages = board.entries.reduce((sum, e) => sum + e.stagesSolved, 0);
  return h("p", { class: "hero-proof" }, h("a", { href: "#/leaderboard" }, TO().proofLine(board.entries.length, stages)));
}

/**
 * The first screen. Signed out: what this is and for whom, then one primary CTA ("Create account") with
 * "Sign in" beside it. Signed in: a welcome and the case to resume. Until the account is known, the
 * signed-out hero holds the space invisibly (no flash of the wrong CTA).
 */
function hero(account: AccountView | null, state: HomeState, resume: { c: CaseSummary; stats: CaseStats } | null): HTMLElement {
  const known = isAccountKnown();
  if (known && account !== null && account.status === "approved") {
    return h(
      "section",
      { class: "hero hero-in" },
      h("h1", { class: "hero-title hero-welcome" }, TO().welcome, h("bdi", {}, account.username)),
      resume ? resumeCard(resume.c, resume.stats) : null,
    );
  }
  const signedOut = known && account === null;
  return h(
    "section",
    { class: `hero${known ? "" : " is-pending"}`, "aria-hidden": known ? null : "true" },
    h("h1", { class: "hero-title" }, TO().heroTitle),
    h("p", { class: "hero-sub" }, TO().heroSub),
    signedOut || !known
      ? [
          h(
            "div",
            { class: "hero-ctas" },
            h("a", { class: "btn btn-primary btn-lg", href: "#/signup", tabindex: known ? null : "-1" }, TO().ctaCreate),
            h("a", { class: "btn btn-ghost btn-lg", href: "#/login", tabindex: known ? null : "-1" }, TO().ctaSignIn),
          ),
          h("p", { class: "muted small hero-note" }, TO().ctaNote),
        ]
      : null,
    proofLine(state.board),
  );
}

function draw(root: HTMLElement, state: HomeState): void {
  const released = state.today?.releasedCaseIds;
  const playable = caseSummaries().filter((c) => released === undefined || released.includes(c.id));
  const todayCase = state.today?.caseId ? caseSummary(state.today.caseId) : undefined;
  const account = cachedAccount();
  const signedOut = isAccountKnown() && account === null;
  const resume = state.loading ? null : resumeCase(state);
  // Today's incident takes the amber CTA only when the hero doesn't already have it.
  const todayPrimary = state.isSignedIn && resume === null;

  setChildren(
    root,
    hero(account, state, resume),
    eventStrip(),
    h(
      "section",
      { class: "section", "aria-label": T().featuredCase, "aria-busy": state.loading ? "true" : null },
      state.loading
        ? todaySkeleton()
        : todayCase && state.today
          ? todayCard(todayCase, state, state.today.date, todayPrimary)
          : state.today
            ? h("p", { class: "muted" }, TA().todayNone)
            : null,
    ),
    signedOut ? learnSection() : null,
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
      h(
        "ol",
        { class: "how" },
        // The <ol> already numbers the steps for screen readers: the visual digit is decorative.
        steps().map((s, i) => h("li", {}, h("span", { class: "how-n mono", "aria-hidden": "true" }, String(i + 1)), h("div", {}, h("h3", {}, s.title), h("p", { class: "muted" }, s.body)))),
      ),
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
  const state: HomeState = { loading: true, today: null, stats: new Map(), isSignedIn: cachedAccount() !== null, board: null };
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
  // Public board for the signed-out proof line; a failure just drops the line.
  const board = account.then(
    (acc) => (acc === null ? fetchLeaderboard(null).catch(() => null) : null),
    () => null,
  );
  void Promise.all([today, stats, board]).then(([todayValue, caseStats, boardValue]) => {
    if (activeRender !== token) return; // user navigated away
    settled = true;
    draw(root, { loading: false, today: todayValue, stats: new Map(caseStats.map((c) => [c.caseId, c])), isSignedIn: cachedAccount() !== null, board: boardValue });
  });
}

let activeRender: symbol | null = null;
