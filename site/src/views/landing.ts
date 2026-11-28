// The landing page at #/ (#279), for everyone: what IncidentLab is, how a case works, the cases, what you practise,
// what a teacher gets, and a footer with the trust line and the About and Privacy links. The dashboard lives at
// #/home (views/home.ts).
// - Visitors: one primary, "Play now, no sign-up" (a guest, straight into the start-here case, lib/playNow.ts),
//   Create account as a secondary button and Sign in as a text link.
// - Signed-in players and guests: "Go to your dashboard" (#/home) is the one primary, Play now is secondary.
// site/index.html paints the same hero before the app boots (both languages and both call-to-action sets;
// public/settings-boot.js picks one), so the app's hero takes its place without a shift. Keep the two in step.
// API budget: only CDN-cached public reads (the catalog, /api/today and the public board), each once per load.
import "../landing.css";
import type { LeaderboardResponse, TodayResponse } from "../../shared/contract";
import type { CaseSummary } from "../content/catalog-schema";
import { caseSummaries, catalogFailed, catalogReady, reloadCatalog, startHereCaseId } from "../content/load";
import { fetchLeaderboard } from "../lib/api";
import { listNode, nameNode } from "../lib/bidi";
import { h, setChildren, type Child } from "../lib/dom";
import { likelySignedIn, loadToday, onAccountChange } from "../lib/session";
import { TL, practiceItems, teachItems } from "../i18n/strings-landing";
import { TO } from "../i18n/strings-onboard";
import { TS } from "../i18n/strings-shell";
import type { ViewResult } from "../shell/types";
import { difficultyCell, playNowButton } from "./home";

/** Players fewer than this on the public board: the proof line says only how many cases there are (no weak numbers). */
const PROOF_MIN_PLAYERS = 5;

/** The public board (CDN-cached), asked for once per page load for the proof line. */
let boardOnce: Promise<LeaderboardResponse | null> | null = null;
const publicBoard = (): Promise<LeaderboardResponse | null> => (boardOnce ??= fetchLeaderboard(null).catch(() => null));

/* ================= the hero (same markup as the static copy in site/index.html) ================= */

/** The example stage's log lines: [line number, time, source, level, message], the matching line marked. */
const LOG_LINES: readonly (readonly [string, string, string, string, string])[] = [
  ["2041", "03:12:04", "orders", "WARN ", "pool 58/64"],
  ["2057", "03:12:07", "orders", "ERROR", "pool exhausted"],
  ["2058", "03:12:07", "edge  ", "ERROR", "502 /checkout"],
  ["2090", "03:12:31", "pager ", "PAGE ", "p99 > 4s"],
];
const HIT_LINE = "2057";

/** The hero's picture of the product: a terminal pane with the evidence, then the stage's question and answer. */
function heroFigure(): HTMLElement {
  const lines = LOG_LINES.map(([n, time, src, level, msg]) =>
    h("span", { class: n === HIT_LINE ? "lp-log is-hit" : "lp-log" }, h("span", { class: "lp-log-n" }, n), ` ${time} ${src} ${level} ${msg}`),
  );
  return h(
    "figure",
    { class: "lp-shot", "aria-labelledby": "lp-shot-cap" },
    h(
      "div",
      { class: "lp-term" },
      h("div", { class: "lp-term-bar", dir: "ltr" }, h("span", { class: "lp-term-dots", "aria-hidden": "true" }), h("span", { class: "lp-term-path" }, "evidence/orders.log")),
      h("pre", { class: "lp-term-body", dir: "ltr" }, h("code", {}, h("span", { class: "lp-log-cmd" }, "$ grep -nE 'WARN|ERROR|PAGE' orders.log"), lines)),
      h(
        "div",
        { class: "lp-term-q" },
        h("p", { class: "lp-q-stage" }, TL().figureStage),
        h("p", { class: "lp-q-text" }, TL().figureQuestion),
        h("p", { class: "lp-q-answer" }, h("span", { class: "lp-q-label" }, TL().figureAnswerLabel), h("bdi", { class: "lp-q-value", dir: "ltr" }, "orders")),
        h("p", { class: "lp-q-result" }, h("span", { "aria-hidden": "true" }, "✓ "), TL().figureResult),
      ),
    ),
    h("figcaption", { id: "lp-shot-cap", class: "lp-shot-cap" }, TL().figureCaption),
  );
}

/** The hero's calls to action: visitors play now; signed-in players and guests go to their dashboard. */
function heroActions(signedIn: boolean): HTMLElement {
  if (signedIn) {
    return h(
      "div",
      { class: "lp-actions lp-actions-in" },
      h("a", { class: "btn btn-primary btn-lg lp-go", href: "#/home" }, TL().goDashboard),
      playNowButton("btn btn-lg lp-play", TL().playSecondary),
    );
  }
  return h(
    "div",
    { class: "lp-actions lp-actions-out" },
    playNowButton("btn btn-primary btn-lg lp-play", TO().playNow),
    h("a", { class: "btn btn-lg lp-create", href: "#/signup" }, TO().ctaCreate),
    h("a", { class: "lp-signin hit-link", href: "#/login" }, TO().signInLink),
  );
}

/* ================= the sections ================= */

function section(id: string, cls: string, title: string, ...body: Child[]): HTMLElement {
  return h("section", { class: `lp-section ${cls}`, "aria-labelledby": id }, h("h2", { id, class: "lp-h2" }, title), body);
}

function howSection(): HTMLElement {
  const steps = [
    [TL().how1Title, TL().how1Body],
    [TL().how2Title, TL().how2Body],
    [TL().how3Title, TL().how3Body],
  ] as const;
  return section(
    "lp-how-h",
    "lp-how",
    TL().howTitle,
    h(
      "ol",
      { class: "lp-steps" },
      steps.map(([title, body], i) => h("li", { class: "lp-step" }, h("span", { class: "lp-step-n", "aria-hidden": "true" }, String(i + 1)), h("h3", { class: "lp-h3" }, title), h("p", {}, body))),
    ),
  );
}

/** One case as a card: the title links to the case; difficulty, time, stages and a few tags. */
function caseCard(c: CaseSummary, startHere: boolean): HTMLElement {
  return h(
    "li",
    { class: `lp-case${startHere ? " is-start" : ""}`, "data-case": c.id },
    startHere ? h("p", { class: "chip lp-case-start" }, TO().startHereTitle) : null,
    h("h3", { class: "lp-h3 lp-case-title" }, h("a", { class: "lp-case-link", href: `#/case/${encodeURIComponent(c.id)}` }, nameNode(c.title))),
    h("p", { class: "lp-case-sub" }, c.subtitle),
    h(
      "p",
      { class: "lp-case-meta" },
      difficultyCell(c.difficulty),
      h("span", { class: "lp-sep", "aria-hidden": "true" }, "·"),
      h("bdi", {}, TO().minutes(c.estMinutes)),
      h("span", { class: "lp-sep", "aria-hidden": "true" }, "·"),
      TO().stages(c.questionCount),
    ),
    c.tags.length > 0 ? h("p", { class: "lp-case-tags" }, listNode(c.tags.slice(0, 4))) : null,
  );
}

function caseSkeleton(): HTMLElement {
  return h("li", { class: "lp-case is-skeleton", "aria-hidden": "true" }, h("span", { class: "dt-skeleton lp-skel-title" }), h("span", { class: "dt-skeleton" }), h("span", { class: "dt-skeleton lp-skel-short" }));
}

/** The cases in landing order: the start-here case first, then easiest and shortest first. */
function landingOrder(cases: readonly CaseSummary[], startId: string | null): CaseSummary[] {
  const rank = { easy: 0, medium: 1, hard: 2 } as const;
  return [...cases].sort(
    (a, b) => Number(b.id === startId) - Number(a.id === startId) || rank[a.difficulty] - rank[b.difficulty] || a.estMinutes - b.estMinutes || a.title.localeCompare(b.title),
  );
}

/* ================= the page ================= */

export function landingView(): ViewResult {
  const main = h("div", { class: "view landing" });
  return { main, start: () => renderLanding(main) };
}

let activeRender: symbol | null = null;
let accountChanged: (() => void) | null = null;
onAccountChange(() => accountChanged?.());

function renderLanding(root: HTMLElement): void {
  document.title = TL().pageTitle;
  const token = Symbol("landing");
  activeRender = token;
  const onLanding = (): boolean => activeRender === token && root.isConnected;

  let signedIn = likelySignedIn();
  let today: TodayResponse | null = null;
  let board: LeaderboardResponse | null = null;
  let loaded = false;

  const proof = h("p", { class: "lp-proof", "aria-label": TO().proofLabel });
  const actionsSlot = h("div", { class: "lp-actions-slot" }, heroActions(signedIn));
  const hero = h(
    "section",
    { class: "lp-hero", "aria-labelledby": "lp-h1" },
    h(
      "div",
      { class: "lp-hero-text" },
      h("h1", { id: "lp-h1", class: "lp-title" }, TO().heroTitle),
      h("p", { class: "lp-sub" }, TO().heroSub),
      proof,
      actionsSlot,
      h("p", { class: "lp-trust" }, TO().ctaNote),
    ),
    heroFigure(),
  );

  const caseList = h("ul", { class: "lp-cases", "aria-busy": "true" }, caseSkeleton(), caseSkeleton(), caseSkeleton());
  const caseNote = h("div", { class: "lp-cases-note" });
  const cases = section(
    "lp-cases-h",
    "lp-cases-sec",
    TL().casesTitle,
    h("p", { class: "lp-lead" }, TL().casesLead),
    caseList,
    caseNote,
    h("p", { class: "lp-more" }, h("a", { class: "hit-link", href: "#/cases" }, TL().casesAll)),
  );

  const practice = section(
    "lp-practice-h",
    "lp-practice",
    TL().practiceTitle,
    h("ul", { class: "lp-skills" }, practiceItems().map((p) => h("li", { class: "lp-skill" }, h("h3", { class: "lp-h3" }, p.title), h("p", {}, p.body)))),
  );

  const teach = section(
    "lp-teach-h",
    "lp-teach",
    TL().teachTitle,
    h("p", { class: "lp-lead" }, TL().teachLead),
    h("ul", { class: "lp-teach-list" }, teachItems().map((t) => h("li", {}, h("h3", { class: "lp-h3" }, t.title), h("p", {}, t.body)))),
    h("p", { class: "lp-teach-cta" }, h("a", { class: "btn btn-lg", href: "#/classes" }, TL().teachCta)),
  );

  const closingSlot = h("div", { class: "lp-closing" });
  const footer = h(
    "footer",
    { class: "lp-foot", "aria-label": TL().footerLabel },
    closingSlot,
    h("p", { class: "lp-foot-trust" }, TO().ctaNote),
    h(
      "ul",
      { class: "lp-foot-links" },
      h("li", {}, h("a", { href: "#/about" }, TS().navAbout)),
      h("li", {}, h("a", { href: "#/privacy" }, TS().navPrivacy)),
      h("li", {}, h("a", { href: "/accessibility.html" }, TS().a11yStatement)),
    ),
    h("p", { class: "lp-foot-tag" }, TO().footerTagline),
  );

  setChildren(root, hero, howSection(), cases, practice, teach, footer);

  const drawClosing = (): void => {
    setChildren(
      closingSlot,
      h("h2", { class: "lp-h2", id: "lp-closing-h" }, signedIn ? TL().closingTitleIn : TL().closingTitle),
      signedIn ? h("a", { class: "btn btn-lg", href: "#/home" }, TL().goDashboard) : playNowButton("btn btn-lg lp-play-again", TO().playNow),
    );
  };

  const released = (): CaseSummary[] => {
    const ids = today?.releasedCaseIds;
    return caseSummaries().filter((c) => ids === undefined || ids.includes(c.id));
  };

  const drawProof = (): void => {
    if (!loaded) return;
    const count = released().length;
    const players = board?.entries.length ?? 0;
    const stages = board?.entries.reduce((sum, e) => sum + e.stagesSolved, 0) ?? 0;
    const parts = [count > 0 ? TO().proofCases(count) : null, players >= PROOF_MIN_PLAYERS ? TO().proofLine(players, stages) : null];
    proof.textContent = parts.filter((p): p is string => p !== null).join(" · ");
  };

  const drawCases = (): void => {
    caseList.removeAttribute("aria-busy");
    if (catalogFailed()) {
      setChildren(caseList);
      setChildren(caseNote, h("p", { role: "alert" }, TL().casesFailed, " "), h("button", { type: "button", class: "btn btn-sm", onclick: reload }, TL().casesRetry));
      return;
    }
    const list = released();
    const startId = startHereCaseId(today?.releasedCaseIds ?? null);
    setChildren(caseNote, list.length === 0 ? h("p", { class: "lp-empty" }, TL().casesEmpty) : null);
    setChildren(caseList, landingOrder(list, startId).map((c) => caseCard(c, c.id === startId)));
  };

  function load(): void {
    const catalog = catalogFailed() ? reloadCatalog() : catalogReady;
    const todayLoad = loadToday().catch(() => null);
    void Promise.all([catalog, todayLoad]).then(([, t]) => {
      if (!onLanding()) return;
      today = t;
      loaded = true;
      drawCases();
      drawProof();
    });
    void publicBoard().then((b) => {
      board = b;
      if (onLanding()) drawProof();
    });
  }
  function reload(): void {
    caseList.setAttribute("aria-busy", "true");
    setChildren(caseNote);
    setChildren(caseList, caseSkeleton(), caseSkeleton(), caseSkeleton());
    load();
  }

  // Signing in, starting a guest session or signing out elsewhere changes the calls to action.
  accountChanged = (): void => {
    if (!onLanding()) return;
    const now = likelySignedIn();
    if (now === signedIn) return;
    signedIn = now;
    setChildren(actionsSlot, heroActions(signedIn));
    drawClosing();
  };

  drawClosing();
  load();
}
