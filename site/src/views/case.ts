import { QUESTION_ORDER, SCORING, type ProgressView, type QuestionId, type ScoreBreakdown, type StageProgress } from "../../shared/contract";
import type { Case, Question } from "../../shared/case";
import { ApiError, getDebrief, getProgress, revealAnswer, revealHint, setupDone, submitAnswer } from "../lib/api";
import { playErrorText } from "../lib/errors";
import { loadAccount, loadToday, setAccount, signOut } from "../lib/session";
import { caseSummary } from "../content/load";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { withApprovedAccount } from "./auth";
import { announce, confirmButton, copyButton, ensureAnnouncer, h, html, setChildren } from "../lib/dom";
import { md, mdInline } from "../lib/markdown";
import { formatElapsed } from "../lib/time";
import { formatNumber, isRelabel, locale } from "../i18n/i18n";
import { commandCard, isCleanSoFar, lockedToday, type CommandContext, type LockedToday } from "./toolbox";
import { T } from "../i18n/strings-player";
import { TP } from "../i18n/strings-play";
import { getLang } from "../i18n/i18n";

type StageKey = "setup" | QuestionId | "debrief";
type StepState = "locked" | "active" | "solved" | "revealed";
/**
 * Where focus goes after the next redraw. Every action that redraws the stage names one, so focus never
 * falls back to <body>: the stage heading (stepper, Continue, I'm ready), the result title (solve, reveal)
 * or the hint that was just bought.
 */
type FocusTarget = { kind: "heading" } | { kind: "result" } | { kind: "hint"; index: number };

const timers = new Set<number>();
const drafts = new Map<QuestionId, string>();
/** Answer cooldown end (epoch ms) per "caseId:questionId": survives redraws (hint, reveal, language). */
const cooldowns = new Map<string, number>();
/** The stage last shown, so a language switch (which re-renders the route) keeps the player where they were. */
let lastView: { caseId: string; stage: StageKey } | null = null;

export function stopCaseTimers(): void {
  for (const t of timers) window.clearInterval(t);
  timers.clear();
}

function every(ms: number, fn: () => void): number {
  const id = window.setInterval(fn, ms);
  timers.add(id);
  return id;
}

/* ---------- UI prefs (best effort, never required) ---------- */
function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(`il.pref.${key}`);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(`il.pref.${key}`, value);
  } catch {
    /* ignore */
  }
}

const errorMessage = playErrorText;

/* ---------- scoring v2 helpers (mirror server/services/scoring.ts; display only) ---------- */

/** Time-bonus target for a stage: `targetMinutes`, else the case estimate split over six stages. */
function targetSeconds(c: Case, q: Question): number {
  return Math.max(1, Math.round((q.targetMinutes ?? c.estMinutes / QUESTION_ORDER.length) * 60));
}

/** Full bonus within the target, fading linearly to 0 at 3x the target. */
function timeBonus(solveSeconds: number, target: number): number {
  const ratio = Math.min(1, Math.max(0, (3 * target - solveSeconds) / (2 * target)));
  return Math.round(SCORING.TIME_BONUS_MAX * ratio);
}

function hintPenalty(q: Question, revealed: number): number {
  return q.hints.slice(0, revealed).reduce((sum, hint) => sum + hint.cost, 0);
}

function wrongPenalty(wrong: number): number {
  return Math.min(SCORING.WRONG_CAP, SCORING.WRONG_COST * wrong);
}

/* ================= entry ================= */

export function renderCase(root: HTMLElement, c: Case): void {
  stopCaseTimers();
  document.title = `${c.title} · IncidentLab`;
  ensureAnnouncer();
  withApprovedAccount(root, c.title, () => loadProgress(root, c));
}

function loadProgress(root: HTMLElement, c: Case, refreshToday = false): void {
  setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted mono" }, T().loadingInvestigation)));
  const today = loadToday(refreshToday).catch(() => null);
  getProgress(c.id)
    .then(async (progress) => renderStaged(root, c, progress, lockedToday(progress, await today, c.id)))
    .catch((err: unknown) => {
      // Session expired or approval revoked since the page loaded: re-run the gate with fresh state.
      if (err instanceof ApiError && (err.isUnauthorized || err.isNotApproved || err.needsGate)) {
        if (err.isUnauthorized) setAccount(null);
        void loadAccount(true).finally(() => renderCase(root, c));
        return;
      }
      setChildren(
        root,
        h(
          "section",
          { class: "center-card", role: "alert" },
          h("h1", {}, T().cantLoadProgress),
          h("p", { class: "muted" }, errorMessage(err)),
          h("button", { type: "button", class: "btn btn-primary", onclick: () => renderCase(root, c) }, T().tryAgain),
        ),
      );
    });
}

/* ================= staged view ================= */

function questionFor(c: Case, id: QuestionId): Question | undefined {
  return c.questions.find((q) => q.id === id);
}

function stageLabel(c: Case, id: QuestionId): string {
  const q = questionFor(c, id);
  return q?.stage?.name ?? q?.title ?? id.toUpperCase();
}

function stageProgress(player: ProgressView, id: QuestionId): StageProgress | undefined {
  return player.stages[id];
}

function isDone(s: StageProgress | undefined): boolean {
  return s !== undefined && (s.status === "solved" || s.status === "revealed");
}

function currentStage(player: ProgressView): StageKey {
  if (player.setupDoneAt === null) return "setup";
  for (const id of QUESTION_ORDER) {
    if (!isDone(stageProgress(player, id))) return id;
  }
  return "debrief";
}

function stepState(player: ProgressView, key: StageKey): StepState {
  if (key === "setup") return player.setupDoneAt === null ? "active" : "solved";
  if (key === "debrief") return currentStage(player) === "debrief" ? "active" : "locked";
  const s = stageProgress(player, key);
  if (s === undefined) return "locked";
  return s.status;
}

const STAGE_KEYS: readonly StageKey[] = ["setup", ...QUESTION_ORDER, "debrief"];

function renderStaged(root: HTMLElement, c: Case, initialPlayer: ProgressView, locked: LockedToday | null): void {
  stopCaseTimers();
  let player = initialPlayer;
  const kept = isRelabel() && lastView !== null && lastView.caseId === c.id ? lastView.stage : null;
  let viewing: StageKey = kept !== null && stepState(player, kept) !== "locked" ? kept : currentStage(player);
  let justSolved: QuestionId | null = null;
  let focusNext: FocusTarget | null = null;

  const update = (next: ProgressView, view?: StageKey, focus: FocusTarget = { kind: "heading" }): void => {
    player = next;
    viewing = view ?? currentStage(player);
    focusNext = focus;
    draw();
  };

  const applyFocus = (): void => {
    const target = focusNext;
    focusNext = null;
    if (target === null) return;
    const stage = document.getElementById("stage");
    if (stage === null) return;
    const el =
      target.kind === "result"
        ? stage.querySelector<HTMLElement>(".result-title")
        : target.kind === "hint"
          ? stage.querySelector<HTMLElement>(`[data-hint="${target.index}"]`)
          : null;
    const heading = el ?? stage.querySelector<HTMLElement>(".stage-goal") ?? stage;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "nearest", behavior: "auto" });
  };

  const switchPlayer = (): void => {
    drafts.clear();
    // One tap: sign out and go straight to the sign-in screen (the local session clears even if logout fails).
    void signOut()
      .catch(() => undefined)
      .finally(() => {
        location.hash = "#/login";
      });
  };

  const elStats = h("span", { class: "progress-stats mono" });
  const elFill = h("span", { class: "progress-fill" });
  const tick = (): void => {
    const solved = QUESTION_ORDER.filter((id) => isDone(stageProgress(player, id))).length;
    const score = formatNumber(player.score);
    const par = formatNumber(player.maxScore);
    // The clock starts at "I'm ready" (setupDoneAt), not while the player reads the briefing.
    if (player.setupDoneAt === null) {
      elStats.textContent = TP().progressLineSetup(QUESTION_ORDER.length, score, par);
    } else {
      const start = Date.parse(player.setupDoneAt);
      const end = player.completedAt !== null ? Date.parse(player.completedAt) : Date.now();
      elStats.textContent = TP().progressLine(solved, QUESTION_ORDER.length, score, par, formatElapsed(end - start));
    }
    elFill.style.width = `${(solved / QUESTION_ORDER.length) * 100}%`;
  };

  const stepName = (key: StageKey): string => (key === "setup" ? T().setup : key === "debrief" ? T().debrief : stageLabel(c, key));

  const stepper = (): HTMLElement => {
    const current = currentStage(player);
    return h(
      "ol",
      { class: "stepper", "aria-label": T().stagesLabel },
      STAGE_KEYS.map((key, i) => {
        const state = stepState(player, key);
        const label = stepName(key);
        const num = key === "setup" ? "0" : key === "debrief" ? "★" : String(i);
        const icon = state === "solved" ? "✓" : state === "revealed" ? "👁" : num;
        const stateText = { locked: T().stLocked, active: T().stCurrent, solved: T().stSolved, revealed: T().stRevealed }[state];
        const isViewing = key === viewing;
        const locked = state === "locked";
        // aria-current marks the stage the player is on; the one on screen is named "viewing" and underlined.
        // Locked steps stay focusable (aria-disabled), so their names can be read ahead.
        const btn = h(
          "button",
          {
            type: "button",
            class: `step step-${state}${isViewing ? " is-viewing" : ""}${key === current ? " is-current" : ""}`,
            "aria-disabled": locked ? "true" : null,
            "aria-current": key === current ? "step" : null,
            "aria-label": `${key === "setup" || key === "debrief" ? "" : T().stageN(i)}${label} (${stateText})${isViewing ? `, ${TP().viewing}` : ""}`,
            title: label,
            onclick: () => {
              if (locked) return;
              viewing = key;
              justSolved = null;
              focusNext = { kind: "heading" };
              draw();
            },
          },
          h("span", { class: "step-icon", "aria-hidden": "true" }, icon),
          h("span", { class: "step-label" }, label),
        );
        return h("li", {}, btn);
      }),
    );
  };

  /** Phones hide the step labels: this line keeps the viewed stage's name next to the dots. */
  const stepNow = (): HTMLElement | null => {
    if (viewing === "setup" || viewing === "debrief") return h("p", { class: "step-now", "aria-hidden": "true" }, stepName(viewing));
    return h("p", { class: "step-now", "aria-hidden": "true" }, TP().stepNow(QUESTION_ORDER.indexOf(viewing) + 1, QUESTION_ORDER.length, stepName(viewing)));
  };

  const draw = (): void => {
    stopCaseTimers();
    lastView = { caseId: c.id, stage: viewing };
    const header = h(
      "header",
      { class: "case-head" },
      h(
        "div",
        { class: "case-head-top" },
        h("a", { class: "back-link", href: "#/" }, T().navCases),
        h(
          "span",
          { class: "player-tag" },
          T().playingAs,
          h("strong", { dir: "auto" }, player.username), // textContent only
          " · ",
          h("button", { type: "button", class: "link-btn", onclick: switchPlayer }, T().switchPlayer),
        ),
      ),
      h(
        "div",
        { class: "case-head-title" },
        h("h1", {}, c.title),
        h("a", { class: "btn btn-ghost btn-sm", href: `#/case/${c.id}/toolbox` }, T().allCommands),
      ),
      stepper(),
      stepNow(),
      h("div", { class: "progress" }, h("div", { class: "progress-track", "aria-hidden": "true" }, elFill), elStats),
    );

    const main = h("section", { class: "stage-wrap", id: "stage", tabindex: "-1" });
    if (viewing === "setup") main.append(renderSetup(c, player, update, locked, () => loadProgress(root, c, true)));
    else if (viewing === "debrief") main.append(renderDebrief(c, player));
    else main.append(renderQuestionStage(c, player, viewing, justSolved === viewing, (next, correct) => {
      if (correct) justSolved = viewing === "setup" || viewing === "debrief" ? null : viewing;
      update(next, viewing, { kind: "result" });
    }, update));

    setChildren(root, header, main);
    applyFocus();
    tick();
    if (player.completedAt === null) every(1000, tick);
  };

  draw();
  if (!isRelabel()) window.scrollTo(0, 0);
}

/* ================= Stage 0: setup ================= */

/** "Go to today's incident" + "Back to all cases": the way out of a case that can't be started today. */
function lockedActions(locked: LockedToday): HTMLElement {
  const todayCase = locked.todayCaseId !== null ? caseSummary(locked.todayCaseId) : undefined;
  return h(
    "div",
    { class: "row-actions" },
    todayCase ? h("a", { class: "btn btn-primary", href: `#/case/${todayCase.id}` }, TA().lockedGoToday) : null,
    h("a", { class: "btn", href: "#/" }, T().backToCases),
  );
}

function lockedCard(c: Case, locked: LockedToday): HTMLElement {
  const todayCase = locked.todayCaseId !== null ? caseSummary(locked.todayCaseId) : undefined;
  return h(
    "div",
    { class: "notice locked-card", role: "status" },
    h("p", { class: "stage-kicker mono" }, TA().lockedKicker),
    h("p", { class: "notice-title" }, TA().lockedTitle(c.title)),
    h("p", { class: "muted" }, TA().lockedBody, todayCase ? ` ${TA().lockedTodayIs(todayCase.title)}` : null),
    lockedActions(locked),
  );
}

/**
 * Every gain and cost, stated before the player starts: the bonuses a hint, command, wrong answer or
 * revealed answer forfeits are otherwise first met mid-stage. Open until the player has started.
 */
function scoringRules(player: ProgressView): HTMLElement {
  return h(
    "details",
    { class: "briefing scoring-rules", open: player.setupDoneAt === null },
    h("summary", {}, TP().scoringHead),
    h(
      "ul",
      {},
      h("li", {}, TP().scoringGain(SCORING.TIME_BONUS_MAX, SCORING.CLEAN_BONUS, SCORING.FIRST_BLOOD_BONUS)),
      h("li", {}, TP().scoringCost(SCORING.COMMAND_COST, SCORING.WRONG_COST, SCORING.WRONG_CAP, SCORING.CLEAN_BONUS)),
      h("li", {}, TP().scoringReveal(SCORING.COMPLETION_BONUS)),
      h("li", {}, TP().scoringPar(formatNumber(player.maxScore))),
    ),
  );
}

function renderSetup(c: Case, player: ProgressView, update: (p: ProgressView) => void, locked: LockedToday | null, recheck: () => void): HTMLElement {
  const done = player.setupDoneAt !== null;
  const briefing = h(
    "details",
    { class: "briefing", open: readPref("briefingRead") === null },
    h("summary", {}, T().briefing),
    prose("prose", c.briefing),
  );
  briefing.addEventListener("toggle", () => {
    if (!briefing.open) writePref("briefingRead", "1");
  });

  const checklist = c.setupChecklist ?? [];
  const checks = checklist.map((item, i) => {
    const key = `check.${c.id}.${i}`;
    const box = h("input", { type: "checkbox", id: `chk-${i}`, checked: readPref(key) === "1" });
    box.addEventListener("change", () => writePref(key, box.checked ? "1" : "0"));
    return h("li", {}, h("label", { class: "check", for: `chk-${i}` }, box, inlineMd("span", item)));
  });

  const errorEl = h("p", { class: "form-error", role: "alert" });
  const ready = h("button", { type: "button", class: "btn btn-primary btn-lg" }, T().readyStart);
  ready.addEventListener("click", () => {
    ready.disabled = true;
    errorEl.textContent = "";
    setupDone(c.id)
      .then((p) => {
        writePref("briefingRead", "1");
        update(p);
      })
      .catch((err: unknown) => {
        // The day rolled over (or the schedule changed) while reading: show the locked state with its link.
        if (err instanceof ApiError && err.code === "not-today") {
          recheck();
          return;
        }
        errorEl.textContent = errorMessage(err);
        ready.disabled = false;
      });
  });

  return h(
    "div",
    { class: "stage" },
    h("p", { class: "stage-kicker mono" }, T().setupKicker),
    locked ? lockedCard(c, locked) : h("h2", { class: "stage-goal", tabindex: "-1" }, T().setupGoal),
    briefing,
    h(
      "div",
      { class: "block" },
      h("h3", {}, T().downloadHead),
      h("a", { class: "btn btn-lg", href: c.evidenceZip, download: true }, T().downloadBtn),
      h(
        "details",
        { class: "quiet-details" },
        h("summary", {}, T().whatsInside(c.evidence.length)),
        h(
          "ul",
          { class: "file-list" },
          c.evidence.map((f) => h("li", {}, h("code", {}, f.path), " ", h("span", { class: "muted" }, `· ${f.format}`), bidiProse(html("div", { class: "muted small" }, mdInline(f.description))))),
        ),
      ),
    ),
    checks.length > 0 ? h("div", { class: "block" }, h("h3", {}, T().checklistHead), h("ul", { class: "checklist" }, checks)) : null,
    h(
      "div",
      { class: "block" },
      h("h3", {}, T().choosePath(checks.length > 0 ? 3 : 2)),
      h(
        "div",
        { class: "paths" },
        // Both paths are links with the same affordance: the terminal path opens the full command list.
        h(
          "a",
          { class: "path-card path-link", href: `#/case/${c.id}/toolbox` },
          h("h4", {}, T().pathTerminal),
          h("p", { class: "muted" }, T().pathTerminalBody),
        ),
        h(
          "a",
          { class: "path-card path-link", href: `#/case/${c.id}/explorer` },
          h("h4", {}, T().pathExplorer),
          h("p", { class: "muted" }, T().pathExplorerBody),
        ),
      ),
    ),
    scoringRules(player),
    done
      ? h("p", { class: "done-note" }, T().setupComplete)
      : locked
        ? h("div", { class: "primary-action" }, lockedActions(locked))
        : h("div", { class: "primary-action" }, ready, errorEl),
  );
}

/* ---------- answer formats: client-side format check (free) before a guess that costs points ---------- */

type FormatKind = "time" | "integer" | "ipv4" | "sha" | "version" | "change" | "order" | "accessKey" | "other";

/** Recognise the common `answerFormat` texts (EN and HE). Anything unrecognised is "other": never blocked. */
function formatKind(format: string): FormatKind {
  const t = format.toLowerCase();
  if (t.includes("hh:mm:ss")) return "time";
  if (/^(integer|מספר שלם)/.test(t)) return "integer";
  if (t.includes("ipv4")) return "ipv4";
  if (t.includes("sha") && t.includes("7")) return "sha";
  if (t.includes("x.y.z")) return "version";
  if (t.includes("chg-n")) return "change";
  if (t.includes("ord-x")) return "order";
  if (t.includes("asia")) return "accessKey";
  return "other";
}

const FORMAT_PATTERN: Record<Exclude<FormatKind, "other">, RegExp> = {
  time: /^\d{1,2}:\d{2}:\d{2}$/,
  integer: /^\d+$/,
  ipv4: /^\d{1,3}(\.\d{1,3}){3}$/,
  sha: /^[0-9a-f]{7,40}$/i,
  version: /^\d+\.\d+\.\d+$/,
  change: /^chg-\d+$/i,
  order: /^ord-[a-z0-9]+$/i,
  accessKey: /^asia[a-z0-9]{16}$/i,
};

/** True when `answer` fits the stage's format (or the format can't be checked). */
export function matchesFormat(format: string, answer: string): boolean {
  const kind = formatKind(format);
  return kind === "other" ? true : FORMAT_PATTERN[kind].test(answer.trim());
}

/** The placeholder shows the format's shape, never a realistic value that reads as a prefilled answer. */
function formatPlaceholder(kind: FormatKind): string | null {
  const t = TP();
  const map: Record<FormatKind, string | null> = {
    time: t.phTime,
    integer: t.phInteger,
    ipv4: t.phIpv4,
    sha: t.phSha,
    version: t.phVersion,
    change: t.phChange,
    order: t.phOrder,
    accessKey: t.phAccessKey,
    other: null,
  };
  return map[kind];
}

function formatInputMode(kind: FormatKind): string {
  if (kind === "integer") return "numeric";
  if (kind === "ipv4" || kind === "version") return "decimal";
  return "text";
}

/* ---------- Hebrew UI: English-only content keeps its own direction ---------- */

const HEBREW = /[֐-׿]/;

/**
 * Case content is partly translated. In the Hebrew UI every prose block gets dir="auto" (its first strong
 * character decides), and blocks with no Hebrew at all get lang="en", so English punctuation stays at the
 * end of the line and screen readers switch voice.
 */
function bidiProse<E extends HTMLElement>(el: E): E {
  if (getLang() !== "he") return el;
  const blocks: HTMLElement[] = el.matches("p, li, h1, h2, h3, h4, td, th, blockquote, dd, dt") ? [el] : [];
  blocks.push(...el.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, h4, td, th, blockquote, dd, dt"));
  for (const block of blocks) {
    block.setAttribute("dir", "auto");
    if (!HEBREW.test(block.textContent ?? "")) block.setAttribute("lang", "en");
  }
  if (!HEBREW.test(el.textContent ?? "")) {
    el.setAttribute("lang", "en");
    el.setAttribute("dir", "auto");
  }
  return el;
}

/** Trusted build-time markdown, with the Hebrew-UI direction fix applied. */
const prose = (cls: string, markdown: string): HTMLElement => bidiProse(html("div", { class: cls }, md(markdown)));
const inlineMd = <K extends keyof HTMLElementTagNameMap>(tag: K, markdown: string): HTMLElementTagNameMap[K] =>
  bidiProse(html(tag, {}, mdInline(markdown)));
/** Plain content text (stage names, goals) that may be English inside the Hebrew UI. */
const contentText = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string>, text: string): HTMLElementTagNameMap[K] =>
  h(tag, { ...attrs, dir: getLang() === "he" ? "auto" : null, lang: getLang() === "he" && !HEBREW.test(text) ? "en" : null }, text);

/* ================= Question stages ================= */

function renderQuestionStage(
  c: Case,
  player: ProgressView,
  id: QuestionId,
  justSolved: boolean,
  onAnswer: (p: ProgressView, correct: boolean) => void,
  update: (p: ProgressView, view?: StageKey, focus?: FocusTarget) => void,
): HTMLElement {
  const q = questionFor(c, id);
  const s = stageProgress(player, id);
  const index = QUESTION_ORDER.indexOf(id) + 1;
  const kicker = h("p", { class: "stage-kicker mono" }, T().stageOf(index, QUESTION_ORDER.length));
  if (q === undefined || s === undefined) {
    return h("div", { class: "stage" }, kicker, h("h2", { class: "stage-goal", tabindex: "-1" }, T().stageUnavailable));
  }
  const stage = q.stage;
  const nextKey: StageKey = QUESTION_ORDER[index] ?? "debrief";
  const continueBtn = (): HTMLElement =>
    h(
      "button",
      { type: "button", class: "btn btn-primary btn-lg", onclick: () => update(player, currentStage(player), { kind: "heading" }) },
      nextKey === "debrief" ? T().continueDebrief : T().continueStage(index + 1),
    );

  const goal = contentText("h2", { class: "stage-goal", tabindex: "-1" }, stage?.goal ?? q.title);
  const lookFor =
    stage && stage.lookFor.length > 0
      ? h(
          "details",
          // Open on wide screens; a one-line summary on phones, so the answer field is closer to the top.
          { class: "look-for", open: window.matchMedia("(min-width: 641px)").matches },
          h("summary", {}, T().lookFor),
          h("ul", {}, stage.lookFor.map((l) => inlineMd("li", l))),
        )
      : null;

  /* finished stage: read-only */
  if (s.status === "solved" || s.status === "revealed") {
    const solved = s.status === "solved";
    // The hints were paid for, so they stay readable after the stage is over.
    const usedHints = player.unlocked.hints[id] ?? [];
    const answer = s.revealedAnswer;
    return h(
      "div",
      { class: "stage" },
      kicker,
      goal,
      lookFor,
      prose("prose prompt", q.prompt),
      h(
        "div",
        { class: `result-panel ${solved ? "is-solved" : "is-revealed"}${justSolved ? " pop" : ""}` },
        // Focus target after a solve or a reveal; the result itself is announced through the shared region.
        h("p", { class: "result-title", tabindex: "-1" }, solved ? T().solvedPts(s.points) : T().revealedPts),
        solved && s.breakdown !== null ? breakdownTable(s.breakdown) : null,
        !solved && answer !== null
          ? h("p", { class: "answer-line" }, T().answerLabel, h("code", { class: "answer-code" }, answer), copyButton(() => answer))
          : null,
        prose("prose", q.successNote),
        currentStage(player) !== id ? continueBtn() : null,
      ),
      usedHints.length > 0
        ? h(
            "div",
            { class: "block hints hints-used" },
            h("h3", {}, TP().hintsUsedHead),
            h(
              "ol",
              { class: "hint-list" },
              usedHints.map((text, i) =>
                h("li", { class: "hint" }, h("span", { class: "hint-label mono" }, TP().hintLabel(i + 1, q.hints[i]?.cost ?? 0)), prose("prose", text)),
              ),
            ),
          )
        : null,
    );
  }

  if (s.status === "locked") {
    return h("div", { class: "stage" }, kicker, h("h2", { class: "stage-goal", tabindex: "-1" }, T().finishPrevious));
  }

  /* active stage */
  const cleanOpen = isCleanSoFar(s);
  const completionOpen = QUESTION_ORDER.every((qid) => player.stages[qid]?.status !== "revealed");
  const kind = formatKind(q.answerFormat);
  const inputId = `answer-${id}`;
  const input = h("input", {
    id: inputId,
    class: "input input-lg mono",
    type: "text",
    dir: "ltr",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    enterkeyhint: "go",
    inputmode: formatInputMode(kind),
    maxlength: "200",
    placeholder: formatPlaceholder(kind),
    "aria-describedby": `fmt-${id} feedback-${id}`,
  });
  input.value = drafts.get(id) ?? "";
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-lg answer-submit" }, TP().checkAnswer);
  const feedback = h("p", { id: `feedback-${id}`, class: "feedback", role: "status" });
  if (s.wrongAttempts > 0) feedback.textContent = TG().wrongSoFarCost(s.wrongAttempts, wrongPenalty(s.wrongAttempts));
  const setInvalid = (message: string): void => {
    input.setAttribute("aria-invalid", "true");
    feedback.className = "feedback is-wrong";
    feedback.textContent = message;
  };
  input.addEventListener("input", () => {
    drafts.set(id, input.value);
    if (input.getAttribute("aria-invalid") === "true") input.removeAttribute("aria-invalid");
  });

  // Rate-limit cooldown. The end time lives in `cooldowns`, so a redraw (hint, reveal, language) keeps
  // Submit disabled. The live region gets one message with an absolute time; the ticking countdown is on
  // the (non-live) button only, so screen readers aren't told the time every second.
  const cooldownKey = `${c.id}:${id}`;
  let cooldown: number | null = null;
  let busy = false;
  const startCooldown = (until: number): void => {
    cooldowns.set(cooldownKey, until);
    submit.disabled = true;
    const at = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(until));
    feedback.className = "feedback is-wrong";
    if (feedback.textContent !== T().tooManyUntil(at)) feedback.textContent = T().tooManyUntil(at);
    const show = (): boolean => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left > 0) {
        submit.textContent = T().waitBtn(formatElapsed(left * 1000));
        return true;
      }
      if (cooldown !== null) window.clearInterval(cooldown);
      cooldowns.delete(cooldownKey);
      submit.disabled = false;
      submit.textContent = TP().checkAnswer;
      feedback.className = "feedback";
      feedback.textContent = T().canTryAgain;
      return false;
    };
    if (cooldown !== null) window.clearInterval(cooldown);
    if (show()) cooldown = every(1000, show);
  };
  const pendingCooldown = cooldowns.get(cooldownKey);
  if (pendingCooldown !== undefined) {
    if (pendingCooldown > Date.now()) startCooldown(pendingCooldown);
    else cooldowns.delete(cooldownKey);
  }

  const form = h(
    "form",
    { class: "answer-form", id: `form-${id}`, novalidate: true },
    h("label", { class: "answer-label", for: inputId }, T().yourAnswer),
    h("p", { id: `fmt-${id}`, class: "muted small" }, T().format, contentText("bdi", { class: "answer-format" }, q.answerFormat)),
    h("div", { class: "answer-row" }, input, submit),
    feedback,
    h("p", { class: "muted small cost-note" }, TP().costNote(SCORING.WRONG_COST, SCORING.WRONG_CAP, SCORING.CLEAN_BONUS, cleanOpen)),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (busy || submit.disabled) return;
    const answer = input.value.trim();
    if (answer.length === 0) {
      setInvalid(T().typeFirst);
      input.focus();
      return;
    }
    if (!matchesFormat(q.answerFormat, answer)) {
      setInvalid(TP().formatMismatch(q.answerFormat));
      input.focus();
      return;
    }
    busy = true;
    submit.setAttribute("aria-disabled", "true");
    submit.textContent = TP().checking;
    const done = (): void => {
      busy = false;
      submit.removeAttribute("aria-disabled");
      if (!cooldowns.has(cooldownKey)) submit.textContent = TP().checkAnswer;
    };
    submitAnswer(c.id, id, answer)
      .then(({ correct, progress: next }) => {
        if (correct) {
          drafts.delete(id);
          announce(TP().solvedAnnounce(next.stages[id]?.points ?? 0));
          onAnswer(next, true);
          return;
        }
        done();
        const attempts = next.stages[id]?.wrongAttempts ?? 0;
        setInvalid(
          SCORING.WRONG_COST * attempts <= SCORING.WRONG_CAP
            ? TP().wrongValue(attempts, SCORING.WRONG_COST)
            : TP().wrongValueCapped(attempts, SCORING.WRONG_CAP),
        );
        meter.refresh(next.stages[id] ?? s);
        form.classList.remove("shake");
        void form.offsetWidth;
        form.classList.add("shake");
        input.select();
      })
      .catch((err: unknown) => {
        done();
        if (err instanceof ApiError && err.isRateLimited) {
          startCooldown(Date.now() + (err.retryAfterSeconds ?? 60) * 1000);
          return;
        }
        feedback.className = "feedback is-wrong";
        feedback.textContent = errorMessage(err);
      });
  });

  /* useful commands */
  const toolIds = stage?.tools ?? [];
  const tools = c.toolbox.flatMap((sec) => sec.items).filter((it) => it.id !== undefined && toolIds.includes(it.id));

  const commandCtx: CommandContext = { caseId: c.id, progress: player, onProgress: (next) => update(next, id) };

  /* hints: the texts come from the server (paid-for content), never from the bundle */
  const hintTexts = player.unlocked.hints[id] ?? [];
  const hintList = q.hints.slice(0, s.hintsRevealed).map((hint, i) =>
    h(
      "li",
      { class: "hint", tabindex: "-1", "data-hint": String(i) },
      h("span", { class: "hint-label mono" }, TP().hintLabel(i + 1, hint.cost)),
      prose("prose", hintTexts[i] ?? ""),
    ),
  );
  const nextHint = q.hints[s.hintsRevealed];
  const hintError = h("p", { class: "form-error", role: "alert" });
  // A hint costs more than a full command, so it gets the same two-step confirm (Cancel focused, Escape cancels).
  const hintBtn = nextHint
    ? confirmButton({
        label: TP().revealHint(s.hintsRevealed + 1, q.hints.length, nextHint.cost, SCORING.CLEAN_BONUS, cleanOpen),
        prompt: TP().hintPrompt(s.hintsRevealed + 1, nextHint.cost, SCORING.CLEAN_BONUS, cleanOpen),
        confirmLabel: TP().cmdConfirm(nextHint.cost),
        className: "btn btn-ghost hint-trigger",
        tone: "accent",
        onConfirm: () => {
          for (const b of hintBtn?.querySelectorAll("button") ?? []) b.disabled = true;
          hintError.textContent = "";
          revealHint(c.id, id)
            .then((p) => {
              announce(TP().hintAnnounce(s.hintsRevealed + 1, nextHint.cost));
              update(p, id, { kind: "hint", index: s.hintsRevealed });
            })
            .catch((err: unknown) => {
              for (const b of hintBtn?.querySelectorAll("button") ?? []) b.disabled = false;
              hintError.textContent = errorMessage(err);
            });
        },
      })
    : null;

  const revealError = h("p", { class: "form-error", role: "alert" });
  const reveal = confirmButton({
    label: TP().revealAnswer(SCORING.COMPLETION_BONUS, completionOpen),
    prompt: TP().revealPrompt(index, SCORING.COMPLETION_BONUS, completionOpen),
    confirmLabel: TP().revealConfirm,
    cancelLabel: TP().keepTrying,
    className: "btn btn-ghost btn-sm reveal-trigger",
    sizeClass: "btn-sm",
    tone: "neutral",
    onConfirm: () => {
      for (const b of reveal.querySelectorAll("button")) b.disabled = true;
      revealAnswer(c.id, id)
        .then((p) => {
          announce(TP().revealedAnnounce(p.stages[id]?.revealedAnswer ?? ""));
          update(p, id, { kind: "result" });
        })
        .catch((err: unknown) => {
          for (const b of reveal.querySelectorAll("button")) b.disabled = false;
          revealError.textContent = errorMessage(err);
        });
    },
  });

  const meter = stageMeter(c, q, s);
  every(1000, () => meter.tick());

  // Phones: one tap from the top of the stage to the answer field.
  const jump = h(
    "button",
    {
      type: "button",
      class: "btn btn-ghost btn-sm answer-jump",
      onclick: () => {
        form.scrollIntoView({ block: "center", behavior: "auto" });
        input.focus({ preventScroll: true });
      },
    },
    TP().jumpToAnswer,
  );

  return h(
    "div",
    { class: "stage" },
    kicker,
    goal,
    jump,
    lookFor,
    meter.el,
    h("div", { class: "question-box" }, prose("prose prompt", q.prompt), form),
    tools.length > 0
      ? h(
          "div",
          { class: "block" },
          h("h3", {}, T().usefulCommands),
          h("p", { class: "muted small" }, TG().toolboxCostNote(SCORING.COMMAND_COST, index)),
          h("div", { class: "tool-list" }, tools.map((tool) => commandCard(tool, commandCtx))),
        )
      : h("p", { class: "muted small" }, T().needCommands, h("a", { class: "stage-link", href: `#/case/${c.id}/toolbox` }, T().browseCommands), "."),
    stage?.explorerTip
      ? h(
          "div",
          { class: "tip" },
          h("h3", {}, T().inExplorer),
          prose("prose", stage.explorerTip),
          h("a", { class: "stage-link", href: `#/case/${c.id}/explorer` }, T().openExplorer),
        )
      : null,
    h(
      "div",
      { class: "block hints" },
      h("h3", {}, T().hints),
      hintList.length > 0 ? h("ol", { class: "hint-list" }, hintList) : null,
      hintBtn ?? h("p", { class: "muted small" }, T().noMoreHints),
      hintError,
    ),
    h("div", { class: "reveal" }, reveal, revealError),
  );
}

/* ================= Debrief ================= */

function caseElapsed(player: ProgressView): string {
  if (player.setupDoneAt === null) return formatElapsed(0);
  const end = player.completedAt !== null ? Date.parse(player.completedAt) : Date.now();
  return formatElapsed(end - Date.parse(player.setupDoneAt));
}

function totalHints(player: ProgressView): number {
  return QUESTION_ORDER.reduce((n, id) => n + (player.stages[id]?.hintsRevealed ?? 0), 0);
}

/** The copied share text (plain; the clipboard can't carry isolation). */
function shareText(c: Case, player: ProgressView): string {
  return ["IncidentLab", c.title, TP().sharePts(player.score), TP().sharePar(player.maxScore), TP().shareHints(totalHints(player)), caseElapsed(player)].join(" · ");
}

/**
 * The visible share line: a sentence in the UI's direction, with only the LTR parts (brand, an English
 * title, numbers, the clock) isolated in <bdi>, so Hebrew keeps its logical order.
 */
function shareLine(c: Case, player: ProgressView): HTMLElement {
  const sep = " · ";
  return h(
    "p",
    { class: "share-line" },
    h("bdi", { dir: "ltr" }, "IncidentLab"),
    sep,
    h("bdi", { lang: HEBREW.test(c.title) ? null : "en" }, c.title),
    sep,
    h("bdi", {}, TP().sharePts(player.score)),
    sep,
    h("bdi", {}, TP().sharePar(player.maxScore)),
    sep,
    TP().shareHints(totalHints(player)),
    sep,
    h("bdi", { dir: "ltr", class: "mono" }, caseElapsed(player)),
  );
}

function renderDebrief(c: Case, player: ProgressView): HTMLElement {
  const body = h("div", { class: "prose" }, h("p", { class: "muted" }, T().loadingDebrief));
  getDebrief(c.id)
    .then((markdown) => {
      body.replaceChildren(bidiProse(html("div", {}, md(markdown))));
    })
    .catch((err: unknown) => {
      body.replaceChildren(
        h("p", { class: "muted" }, err instanceof ApiError && err.status === 403 ? T().finishAll : errorMessage(err)),
      );
    });
  return h(
    "div",
    { class: "stage" },
    h("p", { class: "stage-kicker mono" }, T().debrief),
    h("h2", { class: "stage-goal", tabindex: "-1" }, T().caseClosed),
    h(
      "div",
      { class: "score-card" },
      h(
        "p",
        { class: "score-big mono" },
        formatNumber(player.score),
        h("span", { class: "muted" }, ` ${TG().ptsUnit} · ${TG().parOf(player.maxScore)}`),
        player.score > player.maxScore ? h("span", { class: "chip chip-completed above-par" }, `▲ ${TG().abovePar}`) : null,
      ),
      stageTotals(c, player),
      shareLine(c, player),
      copyButton(() => shareText(c, player), T().copyResult),
    ),
    // Not a dead end: the leaderboard and the case list are one tap away.
    h(
      "div",
      { class: "row-actions debrief-next" },
      h("a", { class: "btn btn-primary", href: "#/leaderboard" }, TG().homeLeaderboard),
      h("a", { class: "btn", href: "#/" }, T().backToCases),
    ),
    body,
  );
}

/* ================= scoring widgets ================= */

const mmss = (seconds: number): string => formatElapsed(seconds * 1000);

function breakdownTable(b: ScoreBreakdown): HTMLElement {
  const row = (label: string, value: number, detail?: string, extra = ""): HTMLElement =>
    h(
      "tr",
      { class: `${value === 0 ? "is-zero" : value < 0 ? "is-minus" : "is-plus"}${extra}` },
      h("th", { scope: "row" }, label, detail ? h("span", { class: "bd-detail muted" }, detail) : null),
      h("td", { class: "num mono" }, TG().pts(value)),
    );
  return h(
    "table",
    { class: "breakdown" },
    h("caption", {}, TG().breakdownCaption),
    h(
      "tbody",
      {},
      row(TG().bdBase, b.base),
      row(TG().bdHints, b.hints),
      row(TG().bdCommands, b.commands),
      row(TG().bdWrong, b.wrong),
      row(TG().bdTime, b.time, TG().bdTimeDetail(mmss(b.solveSeconds), mmss(b.targetSeconds))),
      // A bonus that scored 0 says why, so the table explains itself.
      row(TG().bdClean, b.clean, b.clean === 0 && (b.hints < 0 || b.commands < 0 || b.wrong < 0) ? TP().cleanLost(b.hints < 0, b.commands < 0, b.wrong < 0) : undefined),
      row(TG().bdFirstBlood, b.firstBlood, b.firstBlood === 0 ? TP().firstTaken : undefined),
    ),
    h("tfoot", {}, h("tr", { class: "is-total" }, h("th", { scope: "row" }, TG().bdTotal), h("td", { class: "num mono" }, formatNumber(b.total)))),
  );
}

/**
 * Live "this stage so far": what the stage can still be worth, base, the time bonus counting down, the
 * clean and first-solver bonuses still on the table (or lost), and the running penalties.
 */
function stageMeter(c: Case, q: Question, initial: StageProgress): { el: HTMLElement; tick: () => void; refresh: (s: StageProgress) => void } {
  let stage = initial;
  const target = targetSeconds(c, q);
  const upTo = h("span", { class: "meter-item meter-upto" });
  const timeText = h("span", { class: "meter-value" });
  const timeSub = h("span", { class: "meter-sub muted" });
  const timeFill = h("span", { class: "meter-fill" });
  const clean = h("span", { class: "meter-item meter-bonus" });
  const first = h(
    "span",
    { class: "meter-item meter-bonus" },
    TP().meterFirst(SCORING.FIRST_BLOOD_BONUS),
    " ",
    h("span", { class: "meter-sub muted" }, TP().meterFirstSub),
  );
  const hints = h("span", { class: "meter-item" });
  const commands = h("span", { class: "meter-item" });
  const wrong = h("span", { class: "meter-item" });
  let penalties = 0;
  const tick = (): void => {
    const started = stage.startedAt === null ? Date.now() : Date.parse(stage.startedAt);
    const elapsed = Math.max(0, (Date.now() - started) / 1000);
    const bonus = timeBonus(elapsed, target);
    timeText.textContent = TP().meterTime(bonus);
    timeSub.textContent = elapsed < target ? TG().meterTimeFull(mmss(Math.ceil(target - elapsed))) : bonus > 0 ? TG().meterTimeFading : TG().meterTimeGone;
    timeFill.style.transform = `scaleX(${bonus / SCORING.TIME_BONUS_MAX})`;
    const possible = Math.max(0, q.points - penalties) + bonus + (isCleanSoFar(stage) ? SCORING.CLEAN_BONUS : 0) + SCORING.FIRST_BLOOD_BONUS;
    upTo.textContent = TP().meterUpTo(possible);
  };
  const refresh = (next: StageProgress): void => {
    stage = next;
    const hp = hintPenalty(q, stage.hintsRevealed);
    const cp = SCORING.COMMAND_COST * stage.commandsRevealed;
    const wp = wrongPenalty(stage.wrongAttempts);
    penalties = hp + cp + wp;
    hints.textContent = TP().meterHints(hp);
    commands.textContent = TP().meterCommands(cp);
    wrong.textContent = TP().meterWrong(wp, wp >= SCORING.WRONG_CAP);
    hints.classList.toggle("is-minus", hp > 0);
    commands.classList.toggle("is-minus", cp > 0);
    wrong.classList.toggle("is-minus", wp > 0);
    const cleanOpen = isCleanSoFar(stage);
    clean.textContent = cleanOpen ? TP().meterClean(SCORING.CLEAN_BONUS) : TP().meterCleanLost(SCORING.CLEAN_BONUS);
    clean.classList.toggle("is-lost", !cleanOpen);
    tick();
  };
  const el = h(
    "div",
    { class: "stage-meter", role: "group", "aria-label": TG().meterLabel },
    upTo,
    h("span", { class: "meter-item meter-base" }, `${TG().bdBase} ${q.points}`),
    h(
      "span",
      { class: "meter-item meter-time" },
      h("span", { "aria-hidden": "true" }, "⏱ "),
      timeText,
      " ",
      timeSub,
      h("span", { class: "meter-track", "aria-hidden": "true" }, timeFill),
    ),
    clean,
    first,
    hints,
    commands,
    wrong,
  );
  refresh(stage);
  return { el, tick, refresh };
}

/** Debrief: points per stage, the completion bonus and the total. */
function stageTotals(c: Case, player: ProgressView): HTMLElement {
  return h(
    "table",
    { class: "breakdown stage-totals" },
    h("caption", {}, TG().perStage),
    h(
      "tbody",
      {},
      QUESTION_ORDER.map((id, i) => {
        const s = player.stages[id];
        const revealed = s?.status === "revealed";
        return h(
          "tr",
          { class: revealed || (s?.points ?? 0) === 0 ? "is-zero" : "is-plus" },
          h(
            "th",
            { scope: "row" },
            h("bdi", {}, `${i + 1}.`),
            " ",
            contentText("bdi", {}, stageLabel(c, id)),
            // Where the points went: revealed, or the help bought on this stage.
            s === undefined
              ? null
              : h("span", { class: "bd-detail muted" }, revealed ? TG().revealedShort : TP().stageCosts(s.hintsRevealed, s.commandsRevealed, s.wrongAttempts)),
          ),
          h("td", { class: "num mono" }, String(s?.points ?? 0)),
        );
      }),
      h(
        "tr",
        { class: player.completionBonus > 0 ? "is-plus" : "is-zero" },
        h("th", { scope: "row" }, player.completionBonus > 0 ? TG().completionBonus : TG().completionNone),
        h("td", { class: "num mono" }, TG().pts(player.completionBonus)),
      ),
    ),
    h("tfoot", {}, h("tr", { class: "is-total" }, h("th", { scope: "row" }, TG().totalLabel), h("td", { class: "num mono" }, formatNumber(player.score)))),
  );
}
