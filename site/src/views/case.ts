import { QUESTION_ORDER, SCORING, type ProgressView, type QuestionId, type ScoreBreakdown, type StageProgress } from "../../shared/contract";
import type { Case, Question } from "../../shared/case";
import { ApiError, getDebrief, getProgress, revealAnswer, revealHint, setupDone } from "../lib/api";
import { recordVisit } from "../lib/recent";
import { playErrorText, recoverFromWrite } from "../lib/errors";
import { handleAuthLoss, onAuthLoss } from "../lib/auth-loss";
import { followProgress, type ProgressFollower } from "../lib/progress-bus";
import { cachedAccount, isGuest, signOut } from "../lib/session";
import { TGu } from "../i18n/strings-guest";
import { confirmGuestSignOut } from "../shell/frame";
import { TG } from "../i18n/strings-game";
import { withApprovedAccount } from "./auth";
import { renderInstructorPreview } from "./present";
import { announce, copyButton, ensureAnnouncer, h, html, setChildren, type Child } from "../lib/dom";
import { ICONS, type IconName } from "../shell/icons";
import { confirm, popover } from "../lib/overlay";
import { caseClassEvent, eventStatus } from "../components/classEventStatus";
import { HEBREW, bidiProse, contentText } from "../lib/bidi";
import { answerForm, clearAnswerDrafts } from "./answerForm";
import { isNarrow, workbench, writePane } from "./caseWorkbench";
import { TW } from "../i18n/strings-case";
import "../player.css";
import { md, mdInline } from "../lib/markdown";
import { readingLayout } from "../components/readingLayout";
import { formatElapsed } from "../lib/time";
import { formatNumber, isRelabel } from "../i18n/i18n";
import { commandCard, commandShellSwitch, isCleanSoFar, type CommandContext } from "./toolbox";
import { T } from "../i18n/strings-player";
import { TP } from "../i18n/strings-play";
import type { ViewResult } from "../shell/types";
import { scrollContentTo } from "../shell/scroll";
import { createCaseNav, type CaseNav } from "./caseNav";

type StageKey = "setup" | QuestionId | "debrief";
type StepState = "locked" | "active" | "solved" | "revealed";
/**
 * Where focus goes after the next redraw. Every action that redraws the stage names one, so focus never
 * falls back to <body>: the stage heading (stepper, Continue, I'm ready), the result title (solve, reveal)
 * or the hint that was just bought.
 */
type FocusTarget = { kind: "heading" } | { kind: "result" } | { kind: "hint"; index: number } | { kind: "command"; toolId: string };

const timers = new Set<number>();
/** The stage last shown, so a language switch (which re-renders the route) keeps the player where they were. */
let lastView: { caseId: string; stage: StageKey } | null = null;

/** Observers of the stage on screen (the sticky answer bar): disconnected with the timers on every redraw. */
const cleanups = new Set<() => void>();

/** Keeps the case on screen in step with the player's other tabs and the server (#203): one per case page. */
let follower: ProgressFollower | null = null;

/** Leaving the case page (main.ts) or rendering it again: the stage's timers and the progress follower stop. */
export function stopCaseTimers(): void {
  stopStageTimers();
  follower?.stop();
  follower = null;
}

/** Every redraw of the stage: its timers and observers only. */
function stopStageTimers(): void {
  for (const t of timers) window.clearInterval(t);
  timers.clear();
  for (const stop of cleanups) stop();
  cleanups.clear();
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

/** A decorative stroke icon (shell/icons.ts) before a text label, which carries the meaning (#137). */
const inlineIcon = (name: IconName): HTMLElement => html("span", { class: "inline-icon", "aria-hidden": "true" }, ICONS[name]);

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

/** The case page's nested nav items (stages, Toolbox, Explorer), set by caseView. */
let caseNav: CaseNav | null = null;

/** The case as a frame view: the stage in main; the stages, Toolbox and Explorer under Cases in the global nav. */
export function caseView(c: Case): ViewResult {
  const main = h("div", { class: "view" });
  const nav = createCaseNav(c, "case");
  caseNav = nav;
  const start = (): void => {
    recordVisit({ kind: "case", caseId: c.id }); // the home page's "Continue" card
    renderCase(main, c);
  };
  return { main, nav: nav.section, start };
}

export function renderCase(root: HTMLElement, c: Case): void {
  stopCaseTimers();
  document.title = `${c.title} · IncidentLab`;
  ensureAnnouncer();
  onAuthLoss(() => renderCase(root, c)); // a 401 mid-play re-runs the gate; the answer drafts survive it
  withApprovedAccount(root, c.title, () => loadProgress(root, c), { onAdmin: () => renderInstructorPreview(root, c), allowGuest: true });
}

function loadProgress(root: HTMLElement, c: Case): void {
  setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted" }, T().loadingInvestigation)));
  getProgress(c.id)
    .then((progress) => renderStaged(root, c, progress))
    .catch((err: unknown) => {
      // Session expired or approval revoked since the page loaded: re-run the gate with fresh state.
      if (handleAuthLoss(err)) return;
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

function renderStaged(root: HTMLElement, c: Case, initialPlayer: ProgressView): void {
  stopCaseTimers();
  let player = initialPlayer;
  const kept = isRelabel() && lastView !== null && lastView.caseId === c.id ? lastView.stage : null;
  let viewing: StageKey = kept !== null && stepState(player, kept) !== "locked" ? kept : currentStage(player);
  let justSolved: QuestionId | null = null;
  let focusNext: FocusTarget | null = null;

  /** `focus: null` (a sync from another tab): focus stays where it was, or on the same field once redrawn. */
  const update = (next: ProgressView, view?: StageKey, focus: FocusTarget | null = { kind: "heading" }): void => {
    player = next;
    // A stage the server's progress says is locked (after a reset seen in a stale-write reply) is never shown.
    viewing = view !== undefined && stepState(player, view) !== "locked" ? view : currentStage(player);
    focusNext = focus;
    const typing = focus === null && document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.id : "";
    draw();
    if (typing !== "") document.getElementById(typing)?.focus({ preventScroll: true });
  };

  // Progress bought or answered in another tab, or changed while this one was hidden (#203). The player keeps
  // the stage they were reading unless it was the current one and has moved on.
  follower = followProgress({
    initial: player,
    load: () => getProgress(c.id),
    alive: () => root.isConnected,
    apply: (next) => update(next, viewing === currentStage(player) ? undefined : viewing, null),
  });

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
          : target.kind === "command"
            ? (stage.querySelector(`[data-tool="${CSS.escape(target.toolId)}"]`)?.querySelector<HTMLElement>(".btn-copy") ?? null)
            : null;
    const heading = el ?? stage.querySelector<HTMLElement>(".stage-goal") ?? stage;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "nearest", behavior: "auto" });
  };

  // On a shared lab computer this is the quickest way to hand over, so it stays next to the name, but it asks
  // first: signing out clears the unchecked answer drafts. Then straight to sign-in (the local session clears
  // even if logout fails). A guest can never sign back in, so a guest gets the account menu's warning, with
  // "Create an account first" (#206), instead of "your progress is saved".
  const switchPlayer = (): void => {
    const asked = isGuest(cachedAccount())
      ? confirmGuestSignOut()
      : confirm({ title: T().switchTitle, body: T().switchBody, confirmLabel: T().switchConfirm });
    void asked.then((ok) => {
      if (!ok) return;
      clearAnswerDrafts();
      void signOut()
        .catch(() => undefined)
        .finally(() => {
          location.hash = "#/login";
        });
    });
  };

  // The one-line case status (#216): stage, score and par, the case clock, the class event and "Costs so far".
  const elScore = h("span", { class: "cs-item cs-score" });
  const elTime = h("span", { class: "cs-item cs-time" });
  const elFill = h("span", { class: "progress-fill" });
  const tick = (): void => {
    const solved = QUESTION_ORDER.filter((id) => isDone(stageProgress(player, id))).length;
    setChildren(
      elScore,
      h("bdi", { class: "tnum" }, TW().statusScore(formatNumber(player.score), formatNumber(player.maxScore))),
    );
    // The clock starts at "I'm ready" (setupDoneAt), not while the player reads the briefing.
    if (player.setupDoneAt === null) {
      elTime.textContent = TW().statusClock;
    } else {
      const start = Date.parse(player.setupDoneAt);
      const end = player.completedAt !== null ? Date.parse(player.completedAt) : Date.now();
      const clock = formatElapsed(end - start);
      if (elTime.dataset.clock !== clock) {
        elTime.dataset.clock = clock;
        setChildren(elTime, h("span", { "aria-hidden": "true" }, "⏱ "), h("span", { class: "visually-hidden" }, `${TW().statusTimeSr} `), h("bdi", { class: "tnum", dir: "ltr" }, clock));
      }
    }
    elFill.style.width = `${(solved / QUESTION_ORDER.length) * 100}%`;
  };

  // The class event on this case (live, or starting soon): looked up once per page load, then ticking on its own.
  const eventSlot = h("span", { class: "cs-item cs-event", hidden: true });
  void caseClassEvent(c.id).then((picked) => {
    if (picked === null || !root.isConnected) return;
    setChildren(eventSlot, h("span", { class: "visually-hidden" }, `${TW().classEventSr}: `), h("bdi", { class: "cs-class" }, picked.className), eventStatus(picked.event));
    eventSlot.hidden = false;
  });

  const stepName = (key: StageKey): string => (key === "setup" ? T().setup : key === "debrief" ? T().debrief : stageLabel(c, key));

  /** "list": the labelled steps in the global nav (icons only in its rail); "row": the phone row in the case header. */
  const stepper = (variant: "row" | "list"): HTMLElement => {
    const current = currentStage(player);
    const inNav = variant === "list";
    return h(
      "ol",
      { class: `stepper${inNav ? " nav-steps" : " is-phone-row"}`, "aria-label": T().stagesLabel },
      STAGE_KEYS.map((key, i) => {
        const state = stepState(player, key);
        const label = stepName(key);
        const num = key === "setup" ? "0" : key === "debrief" ? "★" : String(i);
        const icon = state === "solved" ? "✓" : state === "revealed" ? "–" : num;
        const stateText = { locked: T().stLocked, active: T().stCurrent, solved: T().stSolved, revealed: T().stRevealed }[state];
        const isViewing = key === viewing;
        const locked = state === "locked";
        // aria-current marks the stage the player is on; the one on screen is named "viewing" and underlined.
        // Locked steps stay focusable (aria-disabled), so their names can be read ahead.
        const btn = h(
          "button",
          {
            type: "button",
            class: `step step-${state}${isViewing ? " is-viewing" : ""}${key === current ? " is-current" : ""}${inNav ? " nav-sub-link" : ""}`,
            "aria-disabled": locked ? "true" : null,
            "aria-current": key === current ? "step" : null,
            "aria-label": `${key === "setup" || key === "debrief" ? "" : T().stageN(i)}${label} (${stateText})${isViewing ? `, ${TP().viewing}` : ""}`,
            title: inNav ? null : label,
            "data-nav-tip": inNav ? label : null,
            "data-nav-close": locked ? null : "",
            onclick: () => {
              if (locked) return;
              viewing = key;
              justSolved = null;
              focusNext = { kind: "heading" };
              draw();
            },
          },
          // The glyph is drawn by CSS (attr(data-glyph)) so it is not text: the button's name is its label and
          // state, and the visible text is the label alone (Label in Name, WCAG 2.5.3).
          h("span", { class: `step-icon${inNav ? " nav-sub-icon is-glyph" : ""}`, "aria-hidden": "true", "data-glyph": icon }),
          h("span", { class: `step-label${inNav ? " nav-label" : ""}` }, label),
        );
        return h("li", {}, btn);
      }),
    );
  };

  /** The stages under the case in the global nav (false before the frame has the case's nav on screen). */
  const navStages = (): boolean => {
    const nav = caseNav;
    if (nav === null || !nav.section.content.isConnected) return false;
    nav.setStages(stepper("list"));
    return true;
  };

  /** "Stage 2 of 6: What changed?" for the stage on screen (the number shortens to "2/6" on phones). */
  const stageItem = (): HTMLElement => {
    if (viewing === "setup" || viewing === "debrief")
      return h("span", { class: "cs-item cs-stage" }, h("span", { class: "cs-n" }, viewing === "setup" ? TW().statusSetup : TW().statusDebrief));
    const n = QUESTION_ORDER.indexOf(viewing) + 1;
    const total = QUESTION_ORDER.length;
    return h(
      "span",
      { class: "cs-item cs-stage" },
      h("span", { class: "cs-n cs-n-long" }, `${TW().statusStage(n, total)}:`),
      h("span", { class: "cs-n cs-n-short", "aria-hidden": "true", dir: "ltr" }, TW().statusStageShort(n, total)),
      " ",
      contentText("bdi", { class: "cs-name" }, stepName(viewing)),
    );
  };

  /** One sticky line: the case title (the page's only h1), the stage, score and par, time, the class event, costs. */
  const statusLine = (): HTMLElement => {
    const costsBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm cs-costs" }, TW().costs);
    const costsPanel = costsPopover(c, player);
    popover(costsBtn, costsPanel, { align: "end", onOpen: () => costsPanel.focus() });
    return h(
      "header",
      { class: "case-head case-status", "aria-label": TW().statusLabel },
      h("div", { class: "cs-line" }, contentText("h1", { class: "cs-title" }, c.title), stageItem(), elScore, elTime, eventSlot, costsBtn, costsPanel),
      h("span", { class: "cs-progress", "aria-hidden": "true" }, elFill),
    );
  };

  /** "Playing as … · not you? switch", under the stage (moved out of the header in #216). */
  const playerTag = (): HTMLElement =>
    h(
      "p",
      { class: "player-tag" },
      T().playingAs,
      // textContent only; a guest's generated name (guest-<id>) means nothing to them, so "Guest" (#206)
      h("strong", { dir: "auto" }, isGuest(cachedAccount()) ? TGu().guestName : player.username),
      " · ",
      h("button", { type: "button", class: "link-btn", onclick: switchPlayer }, T().switchPlayer),
    );

  const draw = (): void => {
    stopStageTimers();
    lastView = { caseId: c.id, stage: viewing };
    // On narrow screens the question is one pane among three: a move that lands on the heading, the result or a
    // bought hint shows the Question pane, so focus never goes to a hidden element.
    if (focusNext !== null && focusNext.kind !== "command" && isNarrow()) writePane("question");
    navStages();
    const header = statusLine();
    const main = h("section", { class: "stage-wrap", id: "stage", tabindex: "-1" });
    if (viewing === "setup") main.append(renderSetup(c, player, update));
    else if (viewing === "debrief") main.append(renderDebrief(c, player));
    else main.append(renderQuestionStage(c, player, viewing, justSolved === viewing, (next, correct) => {
      if (correct) justSolved = viewing === "setup" || viewing === "debrief" ? null : viewing;
      update(next, viewing, { kind: "result" });
    }, update));

    // The nav carries the labelled stages; phones (nav in a drawer) keep the compact dot row under the status line.
    setChildren(root, header, stepper("row"), main, playerTag());
    applyFocus();
    tick();
    if (player.completedAt === null) every(1000, tick);
  };

  draw();
  if (!isRelabel()) scrollContentTo(0);
}

/**
 * "Costs so far" (#216): every penalty of the case in one popover from the status line, so the meter only shows
 * the ones the stage on screen has paid. Hints, commands and wrong answers with their points, revealed answers,
 * and what the active stage has left in hints.
 */
function costsPopover(c: Case, player: ProgressView): HTMLElement {
  let used = 0;
  let total = 0;
  let hintPts = 0;
  let commands = 0;
  let wrong = 0;
  let wrongPts = 0;
  let revealed = 0;
  for (const id of QUESTION_ORDER) {
    const q = questionFor(c, id);
    const s = stageProgress(player, id);
    if (q === undefined) continue;
    const hints = s?.hintsRevealed ?? 0;
    total += q.hints.length;
    used += hints;
    hintPts += hintPenalty(q, hints);
    commands += s?.commandsRevealed ?? 0;
    wrong += s?.wrongAttempts ?? 0;
    wrongPts += wrongPenalty(s?.wrongAttempts ?? 0);
    if (s?.status === "revealed") revealed += 1;
  }
  const commandPts = commands * SCORING.COMMAND_COST;
  const now = currentStage(player);
  const q = now === "setup" || now === "debrief" ? undefined : questionFor(c, now);
  const revealedNow = now === "setup" || now === "debrief" ? 0 : (stageProgress(player, now)?.hintsRevealed ?? 0);
  const next = q?.hints[revealedNow];
  const spent = hintPts + commandPts + wrongPts;
  const titleId = `costs-h-${c.id}`;
  return h(
    "div",
    { class: "costs-panel", role: "dialog", "aria-labelledby": titleId, tabindex: "-1" },
    h("h2", { class: "costs-h", id: titleId }, TW().costs),
    used + commands + wrong + revealed === 0
      ? h("p", { class: "costs-none" }, TW().costsNone)
      : h(
          "ul",
          { class: "costs-list" },
          h("li", {}, TW().costsHints(used, total, hintPts)),
          commands > 0 ? h("li", {}, TW().costsCommands(commands, commandPts)) : null,
          wrong > 0 ? h("li", {}, TW().costsWrong(wrong, wrongPts)) : null,
          revealed > 0 ? h("li", {}, TW().costsRevealed(revealed)) : null,
          spent > 0 ? h("li", { class: "costs-total" }, TW().costsTotal(spent)) : null,
        ),
    q === undefined ? null : h("p", { class: "costs-stage" }, next !== undefined ? TW().costsStageHints(q.hints.length - revealedNow, next.cost) : TW().costsStageNoHints),
  );
}

/* ================= Stage 0: setup ================= */

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

function renderSetup(c: Case, player: ProgressView, update: (p: ProgressView) => void): HTMLElement {
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
        if (handleAuthLoss(err)) return;
        const server = recoverFromWrite(err);
        if (server !== null) return update(server);
        errorEl.textContent = errorMessage(err);
        ready.disabled = false;
      });
  });

  // "I'm ready" sits in the top block beside the download (#213), so starting never needs a long scroll; the
  // briefing, checklist, paths and scoring follow for whoever wants them first.
  return h(
    "div",
    { class: "stage" },
    h("p", { class: "stage-kicker" }, T().setupKicker),
    h("h2", { class: "stage-goal", tabindex: "-1" }, T().setupGoal),
    h(
      "div",
      { class: "block setup-top" },
      h("h3", {}, T().downloadHead),
      h(
        "div",
        { class: "setup-actions" },
        h("a", { class: "btn btn-lg", href: c.evidenceZip, download: true }, T().downloadBtn),
        done ? h("p", { class: "done-note" }, T().setupComplete) : h("div", { class: "primary-action" }, ready),
      ),
      done ? null : errorEl,
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
    briefing,
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
  );
}

/** Trusted build-time markdown, with the Hebrew-UI direction fix applied. */
const prose = (cls: string, markdown: string): HTMLElement => bidiProse(html("div", { class: cls }, md(markdown)));
const inlineMd = <K extends keyof HTMLElementTagNameMap>(tag: K, markdown: string): HTMLElementTagNameMap[K] =>
  bidiProse(html(tag, {}, mdInline(markdown)));

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
  const kicker = h("p", { class: "stage-kicker" }, T().stageOf(index, QUESTION_ORDER.length));
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
  // A one-line summary until the player opens it (remembered), so the answer field stays near the top (#213).
  const lookFor =
    stage && stage.lookFor.length > 0
      ? h(
          "details",
          { class: "look-for", open: readPref("lookForOpen") === "1" },
          h("summary", {}, T().lookFor),
          h("ul", {}, stage.lookFor.map((l) => inlineMd("li", l))),
        )
      : null;
  lookFor?.addEventListener("toggle", () => writePref("lookForOpen", lookFor.open ? "1" : "0"));

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
        h("p", { class: "result-title with-icon", tabindex: "-1" }, solved ? null : inlineIcon("eye"), solved ? T().solvedPts(s.points) : T().revealedPts),
        // The player's own answer (#133): only in their own progress; stages solved before it have none.
        solved && s.solvedAnswer !== null
          ? h("p", { class: "answer-line own-answer" }, T().yourAnswerLabel, h("code", { class: "answer-code", dir: "ltr" }, s.solvedAnswer))
          : null,
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
                h("li", { class: "hint" }, h("span", { class: "hint-label" }, TP().hintLabel(i + 1, q.hints[i]?.cost ?? 0)), prose("prose", text)),
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
  const meterRef: { current: ReturnType<typeof stageMeter> | null } = { current: null };
  const af = answerForm({
    caseId: c.id,
    questionId: id,
    question: q,
    stage: s,
    index,
    cleanOpen,
    withBar: true,
    onSolved: (next) => onAnswer(next, true),
    onWrong: (next) => meterRef.current?.refresh(next),
    onServerProgress: (server) => update(server, id),
  });
  cleanups.add(af.dispose);
  const form = af.form;
  const bar = af.bar;

  /* useful commands */
  const toolIds = stage?.tools ?? [];
  const tools = c.toolbox.flatMap((sec) => sec.items).filter((it) => it.id !== undefined && toolIds.includes(it.id));

  // After a command reveal the redraw keeps the player at that card's Copy button, not the stage heading (#210).
  const commandCtx: CommandContext = {
    caseId: c.id,
    progress: player,
    onProgress: (next, revealedTool) => update(next, id, revealedTool === undefined ? { kind: "heading" } : { kind: "command", toolId: revealedTool }),
  };

  /* hints: the texts come from the server (paid-for content), never from the bundle */
  const hintTexts = player.unlocked.hints[id] ?? [];
  const hintList = q.hints.slice(0, s.hintsRevealed).map((hint, i) =>
    h(
      "li",
      { class: "hint", tabindex: "-1", "data-hint": String(i) },
      h("span", { class: "hint-label" }, TP().hintLabel(i + 1, hint.cost)),
      prose("prose", hintTexts[i] ?? ""),
    ),
  );
  const nextHint = q.hints[s.hintsRevealed];
  const hintError = h("p", { class: "form-error", role: "alert" });
  // A hint costs more than a full command, so it gets the same confirm (Cancel focused, Escape cancels).
  const hintBtn = nextHint
    ? h("button", { type: "button", class: "btn btn-ghost hint-trigger" }, TP().revealHint(s.hintsRevealed + 1, q.hints.length, nextHint.cost, SCORING.CLEAN_BONUS, cleanOpen))
    : null;
  hintBtn?.addEventListener("click", () => {
    if (nextHint === undefined) return;
    hintError.textContent = "";
    const charged: { progress: ProgressView | null } = { progress: null };
    confirm({
      title: TP().hintTitle,
      body: TP().hintPrompt(s.hintsRevealed + 1, nextHint.cost, SCORING.CLEAN_BONUS, cleanOpen),
      confirmLabel: TP().cmdConfirm(nextHint.cost),
      run: async () => {
        // Names the hint this page shows as next: if another tab (or a lost reply) already bought it, the
        // server charges nothing and sends the current progress back (#202, #203).
        charged.progress = await revealHint(c.id, id, s.hintsRevealed);
      },
    })
      .then((ok) => {
        const next = charged.progress;
        if (!ok || next === null) return;
        announce(TP().hintAnnounce(s.hintsRevealed + 1, nextHint.cost));
        // Wide screens show the bought hint in the Hints tab; narrow ones under the question, where the player is.
        if (!isNarrow()) writePane("hints");
        update(next, id, { kind: "hint", index: s.hintsRevealed });
      })
      .catch((err: unknown) => {
        if (handleAuthLoss(err)) return;
        const server = recoverFromWrite(err);
        if (server !== null) {
          // Already bought (another tab, a lost reply): show the hints, as a purchase would.
          if (!isNarrow()) writePane("hints");
          return update(server, id, { kind: "hint", index: s.hintsRevealed });
        }
        hintError.textContent = errorMessage(err);
      });
  });

  const revealError = h("p", { class: "form-error", role: "alert" });
  // The confirm states the full cost; the stage re-renders once the server has charged it.
  const reveal = h("button", { type: "button", class: "btn btn-ghost btn-sm reveal-trigger" }, TP().revealAnswer(SCORING.COMPLETION_BONUS, completionOpen));
  reveal.addEventListener("click", () => {
    revealError.textContent = "";
    const charged: { progress: ProgressView | null } = { progress: null };
    confirm({
      title: TP().revealTitle,
      body: TP().revealPrompt(index, SCORING.COMPLETION_BONUS, completionOpen),
      confirmLabel: TP().revealConfirm,
      cancelLabel: TP().keepTrying,
      run: async () => {
        charged.progress = await revealAnswer(c.id, id);
      },
    })
      .then((ok) => {
        const next = charged.progress;
        if (!ok || next === null) return;
        announce(TP().revealedAnnounce(next.stages[id]?.revealedAnswer ?? ""));
        update(next, id, { kind: "result" });
      })
      .catch((err: unknown) => {
        if (handleAuthLoss(err)) return;
        const server = recoverFromWrite(err);
        if (server !== null) return update(server, id);
        revealError.textContent = errorMessage(err);
      });
  });

  const meter = stageMeter(c, q, s);
  meterRef.current = meter;
  every(1000, () => meter.tick());

  // The question column: what to find, the answer, what it is worth and the paid help, in one place (#213).
  const helpLabelId = `need-help-${id}`;
  const questionCol = h(
    "div",
    { class: "q-col" },
    kicker,
    goal,
    prose("prose prompt", q.prompt),
    lookFor,
    form,
    meter.el,
    h(
      "div",
      { class: "need-help", role: "group", "aria-labelledby": helpLabelId },
      h("p", { class: "need-help-label", id: helpLabelId }, TW().needHelp),
      h("div", { class: "need-help-actions" }, hintBtn ?? h("p", { class: "muted small" }, T().noMoreHints), reveal),
      hintError,
      revealError,
    ),
  );

  const commandsPane: Child =
    tools.length > 0
      ? [
          h("h3", { class: "visually-hidden" }, T().usefulCommands),
          h("p", { class: "muted small" }, TG().toolboxCostNote(SCORING.COMMAND_COST, index)),
          commandShellSwitch(tools, player),
          h("div", { class: "tool-list" }, tools.map((tool) => commandCard(tool, commandCtx))),
          h("p", { class: "wb-more" }, h("a", { class: "stage-link", href: `#/case/${c.id}/toolbox` }, TW().commandsMore)),
        ]
      : h("p", { class: "muted small" }, T().needCommands, h("a", { class: "stage-link", href: `#/case/${c.id}/toolbox` }, T().browseCommands), ".");

  // The Evidence tab is the Explorer's way in: this stage's tip, then every file, each opening in the Explorer.
  const evidencePane: Child = [
    stage?.explorerTip
      ? h("div", { class: "tip" }, h("h3", {}, T().inExplorer), prose("prose", stage.explorerTip), h("a", { class: "stage-link", href: `#/case/${c.id}/explorer` }, T().openExplorer))
      : h("p", {}, h("a", { class: "stage-link", href: `#/case/${c.id}/explorer` }, T().openExplorer)),
    h("h3", { class: "wb-h" }, TW().evidenceHead),
    h(
      "ul",
      { class: "ev-list" },
      c.evidence.map((f) =>
        h(
          "li",
          { class: "ev-item" },
          h(
            "a",
            { class: "ev-link", href: `#/case/${c.id}/explorer?${new URLSearchParams({ f: f.path }).toString()}`, "aria-label": TW().evidenceOpen(f.path) },
            h("code", { dir: "ltr" }, f.path),
            h("span", { class: "muted small" }, ` · ${f.format}`),
          ),
          bidiProse(html("div", { class: "muted small" }, mdInline(f.description))),
        ),
      ),
    ),
    h("a", { class: "btn btn-sm", href: c.evidenceZip, download: true }, T().downloadBtn),
  ];

  const hintsPane: Child = [
    h("h3", { class: "wb-h" }, T().hints),
    hintList.length > 0 ? h("ol", { class: "hint-list" }, hintList) : h("p", { class: "muted small" }, TW().hintsNone),
  ];

  const bench = workbench({
    question: questionCol,
    commands: commandsPane,
    commandCount: tools.length,
    evidence: evidencePane,
    hints: hintsPane,
    hintsUsed: s.hintsRevealed,
    hintsTotal: q.hints.length,
    onCleanup: (stop) => cleanups.add(stop),
  });

  return h("div", { class: "stage is-active" }, bench.el, bar?.el ?? null);
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
    h("bdi", { dir: "ltr", class: "tnum" }, caseElapsed(player)),
  );
}

function renderDebrief(c: Case, player: ProgressView): HTMLElement {
  const body = h("div", { class: "prose" }, h("p", { class: "muted" }, T().loadingDebrief));
  // The debrief is long: an "On this page" contents list appears once it has enough headings.
  const reading = readingLayout({ content: body, tocLabel: TP().onThisPage, idPrefix: "debrief" });
  getDebrief(c.id)
    .then((markdown) => {
      body.replaceChildren(bidiProse(html("div", {}, md(markdown))));
      reading.refresh();
    })
    .catch((err: unknown) => {
      body.replaceChildren(
        h("p", { class: "muted" }, err instanceof ApiError && err.status === 403 ? T().finishAll : errorMessage(err)),
      );
    });
  return h(
    "div",
    { class: "stage" },
    h("p", { class: "stage-kicker" }, T().debrief),
    h("h2", { class: "stage-goal", tabindex: "-1" }, T().caseClosed),
    h(
      "div",
      { class: "score-card" },
      h(
        "p",
        { class: "score-big" },
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
    reading.element,
  );
}

/* ================= scoring widgets ================= */

const mmss = (seconds: number): string => formatElapsed(seconds * 1000);

function breakdownTable(b: ScoreBreakdown): HTMLElement {
  const row = (label: Child, value: number, detail?: string, extra = ""): HTMLElement =>
    h(
      "tr",
      { class: `${value === 0 ? "is-zero" : value < 0 ? "is-minus" : "is-plus"}${extra}` },
      h("th", { scope: "row" }, label, detail ? h("span", { class: "bd-detail muted" }, detail) : null),
      h("td", { class: "num" }, TG().pts(value)),
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
      row(h("span", { class: "with-icon" }, inlineIcon("drop"), TG().bdFirstBlood), b.firstBlood, b.firstBlood === 0 ? TP().firstTaken : undefined),
    ),
    h("tfoot", {}, h("tr", { class: "is-total" }, h("th", { scope: "row" }, TG().bdTotal), h("td", { class: "num" }, formatNumber(b.total)))),
  );
}

/**
 * Live "this stage so far": what the stage can still be worth, the time bonus counting down, the clean and
 * first-solver bonuses still on the table (or lost), and the penalties once there are any.
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
    // Penalties show only once they cost something; all of them are in the status line's "Costs so far" (#216).
    hints.hidden = hp === 0;
    commands.hidden = cp === 0;
    wrong.hidden = wp === 0;
    const cleanOpen = isCleanSoFar(stage);
    clean.textContent = cleanOpen ? TP().meterClean(SCORING.CLEAN_BONUS) : TP().meterCleanLost(SCORING.CLEAN_BONUS);
    clean.classList.toggle("is-lost", !cleanOpen);
    tick();
  };
  const el = h(
    "div",
    { class: "stage-meter", role: "group", "aria-label": TG().meterLabel },
    upTo,
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
          h("td", { class: "num" }, String(s?.points ?? 0)),
        );
      }),
      h(
        "tr",
        { class: player.completionBonus > 0 ? "is-plus" : "is-zero" },
        h("th", { scope: "row" }, player.completionBonus > 0 ? TG().completionBonus : TG().completionNone),
        h("td", { class: "num" }, TG().pts(player.completionBonus)),
      ),
    ),
    h("tfoot", {}, h("tr", { class: "is-total" }, h("th", { scope: "row" }, TG().totalLabel), h("td", { class: "num" }, formatNumber(player.score)))),
  );
}
