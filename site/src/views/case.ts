import { QUESTION_ORDER, SCORING, type ProgressView, type QuestionId, type ScoreBreakdown, type StageProgress } from "../../shared/contract";
import type { Case, Question } from "../content/schema";
import { ApiError, getDebrief, getProgress, revealAnswer, revealHint, setupDone, submitAnswer } from "../lib/api";
import { playErrorText } from "../lib/errors";
import { loadAccount, loadToday, setAccount, signOut } from "../lib/session";
import { caseSummary } from "../content/load";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { withApprovedAccount } from "./auth";
import { confirmButton, copyButton, h, html, setChildren, type Child } from "../lib/dom";
import { md, mdInline } from "../lib/markdown";
import { formatElapsed } from "../lib/time";
import { formatNumber, isRelabel, locale } from "../i18n/i18n";
import { commandCard, lockedToday, type CommandContext, type LockedToday } from "./toolbox";
import { T } from "../i18n/strings-player";

type StageKey = "setup" | QuestionId | "debrief";
type StepState = "locked" | "active" | "solved" | "revealed";

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

  const update = (next: ProgressView, view?: StageKey): void => {
    player = next;
    viewing = view ?? currentStage(player);
    draw();
  };

  const switchPlayer = (): void => {
    drafts.clear();
    void signOut().finally(() => renderCase(root, c));
  };

  const elStats = h("span", { class: "progress-stats mono" });
  const elFill = h("span", { class: "progress-fill" });
  const tick = (): void => {
    const solved = QUESTION_ORDER.filter((id) => isDone(stageProgress(player, id))).length;
    const start = Date.parse(player.setupDoneAt ?? player.startedAt ?? new Date().toISOString());
    const end = player.completedAt !== null ? Date.parse(player.completedAt) : Date.now();
    elStats.textContent = T().progressStats(solved, QUESTION_ORDER.length, TG().scorePar(player.score, player.maxScore), formatElapsed(end - start));
    elFill.style.width = `${(solved / QUESTION_ORDER.length) * 100}%`;
  };

  const stepper = (): HTMLElement =>
    h(
      "ol",
      { class: "stepper", "aria-label": T().stagesLabel },
      STAGE_KEYS.map((key, i) => {
        const state = stepState(player, key);
        const label = key === "setup" ? T().setup : key === "debrief" ? T().debrief : stageLabel(c, key);
        const num = key === "setup" ? "0" : key === "debrief" ? "★" : String(i);
        const icon = state === "solved" ? "✓" : state === "revealed" ? "👁" : num;
        const stateText = { locked: T().stLocked, active: T().stCurrent, solved: T().stSolved, revealed: T().stRevealed }[state];
        const btn = h(
          "button",
          {
            type: "button",
            class: `step step-${state}${key === viewing ? " is-viewing" : ""}`,
            disabled: state === "locked",
            "aria-current": key === viewing ? "step" : null,
            "aria-label": `${key === "setup" || key === "debrief" ? "" : T().stageN(i)}${label} (${stateText})`,
            title: label,
            onclick: () => {
              viewing = key;
              justSolved = null;
              draw();
              document.getElementById("stage")?.focus({ preventScroll: true });
            },
          },
          h("span", { class: "step-icon", "aria-hidden": "true" }, icon),
          h("span", { class: "step-label" }, label),
        );
        return h("li", {}, btn);
      }),
    );

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
      h("div", { class: "progress" }, h("div", { class: "progress-track", "aria-hidden": "true" }, elFill), elStats),
    );

    const main = h("section", { class: "stage-wrap", id: "stage", tabindex: "-1" });
    if (viewing === "setup") main.append(renderSetup(c, player, update, locked, () => loadProgress(root, c, true)));
    else if (viewing === "debrief") main.append(renderDebrief(c, player));
    else main.append(renderQuestionStage(c, player, viewing, justSolved === viewing, (next, correct) => {
      if (correct) justSolved = viewing === "setup" || viewing === "debrief" ? null : viewing;
      update(next, viewing);
    }, update));

    setChildren(root, header, main);
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

function renderSetup(c: Case, player: ProgressView, update: (p: ProgressView) => void, locked: LockedToday | null, recheck: () => void): HTMLElement {
  const done = player.setupDoneAt !== null;
  const briefing = h(
    "details",
    { class: "briefing", open: readPref("briefingRead") === null },
    h("summary", {}, T().briefing),
    html("div", { class: "prose" }, md(c.briefing)),
  );
  briefing.addEventListener("toggle", () => {
    if (!briefing.open) writePref("briefingRead", "1");
  });

  const checklist = c.setupChecklist ?? [];
  const checks = checklist.map((item, i) => {
    const key = `check.${c.id}.${i}`;
    const box = h("input", { type: "checkbox", id: `chk-${i}`, checked: readPref(key) === "1" });
    box.addEventListener("change", () => writePref(key, box.checked ? "1" : "0"));
    return h("li", {}, h("label", { class: "check", for: `chk-${i}` }, box, html("span", {}, mdInline(item))));
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
    locked ? lockedCard(c, locked) : h("h2", { class: "stage-goal" }, T().setupGoal),
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
          c.evidence.map((f) => h("li", {}, h("code", {}, f.path), " ", h("span", { class: "muted" }, `· ${f.format}`), html("div", { class: "muted small" }, mdInline(f.description)))),
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
        h(
          "div",
          { class: "path-card" },
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
    done
      ? h("p", { class: "done-note" }, T().setupComplete)
      : locked
        ? h("div", { class: "primary-action" }, lockedActions(locked))
        : h("div", { class: "primary-action" }, ready, errorEl),
  );
}

/* ================= Question stages ================= */

function renderQuestionStage(
  c: Case,
  player: ProgressView,
  id: QuestionId,
  justSolved: boolean,
  onAnswer: (p: ProgressView, correct: boolean) => void,
  update: (p: ProgressView, view?: StageKey) => void,
): HTMLElement {
  const q = questionFor(c, id);
  const s = stageProgress(player, id);
  const index = QUESTION_ORDER.indexOf(id) + 1;
  const kicker = h("p", { class: "stage-kicker mono" }, T().stageOf(index, QUESTION_ORDER.length));
  if (q === undefined || s === undefined) {
    return h("div", { class: "stage" }, kicker, h("p", { class: "muted" }, T().stageUnavailable));
  }
  const stage = q.stage;
  const nextKey: StageKey = QUESTION_ORDER[index] ?? "debrief";
  const continueBtn = (): HTMLElement =>
    h(
      "button",
      { type: "button", class: "btn btn-primary btn-lg", onclick: () => update(player, currentStage(player)) },
      nextKey === "debrief" ? T().continueDebrief : T().continueStage(index + 1),
    );

  const head: Child[] = [
    kicker,
    h("h2", { class: "stage-goal" }, stage?.goal ?? q.title),
    stage && stage.lookFor.length > 0
      ? h("div", { class: "look-for" }, h("h3", {}, T().lookFor), h("ul", {}, stage.lookFor.map((l) => html("li", {}, mdInline(l)))))
      : null,
  ];

  /* finished stage: read-only */
  if (s.status === "solved" || s.status === "revealed") {
    const solved = s.status === "solved";
    return h(
      "div",
      { class: "stage" },
      head,
      html("div", { class: "prose prompt" }, md(q.prompt)),
      h(
        "div",
        { class: `result-panel ${solved ? "is-solved" : "is-revealed"}${justSolved ? " pop" : ""}`, role: justSolved ? "status" : null },
        h("p", { class: "result-title" }, solved ? T().solvedPts(s.points) : T().revealedPts),
        solved && s.breakdown !== null ? breakdownTable(s.breakdown) : null,
        !solved && s.revealedAnswer !== null ? h("p", {}, T().answerLabel, h("code", { class: "answer-code" }, s.revealedAnswer)) : null,
        html("div", { class: "prose" }, md(q.successNote)),
        currentStage(player) !== id ? continueBtn() : null,
      ),
    );
  }

  if (s.status === "locked") {
    return h("div", { class: "stage" }, kicker, h("p", { class: "muted" }, T().finishPrevious));
  }

  /* active stage */
  const input = h("input", {
    id: `answer-${id}`,
    class: "input input-lg mono",
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: "200",
    placeholder: q.placeholder,
    "aria-describedby": `fmt-${id} feedback-${id}`,
  });
  input.value = drafts.get(id) ?? "";
  input.addEventListener("input", () => drafts.set(id, input.value));
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-lg" }, T().submit);
  const feedback = h("p", { id: `feedback-${id}`, class: "feedback", role: "status" });
  if (s.wrongAttempts > 0) feedback.textContent = TG().wrongSoFarCost(s.wrongAttempts, wrongPenalty(s.wrongAttempts));

  // Rate-limit cooldown. The end time lives in `cooldowns`, so a redraw (hint, reveal, language) keeps
  // Submit disabled. The live region gets one message with an absolute time; the ticking countdown is on
  // the (non-live) button only, so screen readers aren't told the time every second.
  const cooldownKey = `${c.id}:${id}`;
  let cooldown: number | null = null;
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
      submit.textContent = T().submit;
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
    { class: "answer-form", novalidate: true },
    h("label", { class: "answer-label", for: `answer-${id}` }, T().yourAnswer),
    h("p", { id: `fmt-${id}`, class: "muted small" }, T().format, h("code", {}, q.answerFormat)),
    h("div", { class: "answer-row" }, input, submit),
    feedback,
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const answer = input.value.trim();
    if (answer.length === 0) {
      feedback.className = "feedback is-wrong";
      feedback.textContent = T().typeFirst;
      input.focus();
      return;
    }
    submit.disabled = true;
    submitAnswer(c.id, id, answer)
      .then(({ correct, progress: next }) => {
        if (correct) {
          drafts.delete(id);
          onAnswer(next, true);
          return;
        }
        submit.disabled = false;
        const attempts = next.stages[id]?.wrongAttempts ?? 0;
        feedback.className = "feedback is-wrong";
        feedback.textContent =
          SCORING.WRONG_COST * attempts <= SCORING.WRONG_CAP
            ? TG().notQuiteCost(attempts, SCORING.WRONG_COST)
            : TG().notQuiteCapped(attempts, SCORING.WRONG_CAP);
        meter.refresh(next.stages[id] ?? s);
        form.classList.remove("shake");
        void form.offsetWidth;
        form.classList.add("shake");
        input.select();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.isRateLimited) {
          startCooldown(Date.now() + (err.retryAfterSeconds ?? 60) * 1000);
          return;
        }
        submit.disabled = false;
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
      { class: "hint" },
      h("span", { class: "hint-label mono" }, T().hintLabel(i + 1, hint.cost)),
      html("div", { class: "prose" }, md(hintTexts[i] ?? "")),
    ),
  );
  const nextHint = q.hints[s.hintsRevealed];
  const hintError = h("p", { class: "form-error", role: "alert" });
  const hintBtn = nextHint
    ? h("button", { type: "button", class: "btn btn-ghost" }, T().revealHint(s.hintsRevealed + 1, q.hints.length, nextHint.cost))
    : null;
  hintBtn?.addEventListener("click", () => {
    hintBtn.disabled = true;
    revealHint(c.id, id)
      .then((p) => update(p, id))
      .catch((err: unknown) => {
        hintError.textContent = errorMessage(err);
        hintBtn.disabled = false;
      });
  });

  const revealError = h("p", { class: "form-error", role: "alert" });
  const reveal = confirmButton({
    label: T().revealAnswer,
    confirmLabel: T().revealConfirm,
    className: "link-btn muted",
    onConfirm: () => {
      for (const b of reveal.querySelectorAll("button")) b.disabled = true;
      revealAnswer(c.id, id)
        .then((p) => update(p, id))
        .catch((err: unknown) => {
          for (const b of reveal.querySelectorAll("button")) b.disabled = false;
          revealError.textContent = errorMessage(err);
        });
    },
  });

  const meter = stageMeter(c, q, s);
  every(1000, () => meter.tick());

  return h(
    "div",
    { class: "stage" },
    head,
    meter.el,
    h("div", { class: "question-box" }, html("div", { class: "prose prompt" }, md(q.prompt)), form),
    tools.length > 0
      ? h(
          "div",
          { class: "block" },
          h("h3", {}, T().usefulCommands),
          h("p", { class: "muted small" }, TG().toolboxCostNote(SCORING.COMMAND_COST, index)),
          h("div", { class: "tool-list" }, tools.map((tool) => commandCard(tool, commandCtx))),
        )
      : h("p", { class: "muted small" }, T().needCommands, h("a", { href: `#/case/${c.id}/toolbox` }, T().browseCommands), "."),
    stage?.explorerTip
      ? h(
          "div",
          { class: "tip" },
          h("h3", {}, T().inExplorer),
          html("div", { class: "prose" }, md(stage.explorerTip)),
          h("a", { href: `#/case/${c.id}/explorer` }, T().openExplorer),
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

function shareText(c: Case, player: ProgressView): string {
  const hints = QUESTION_ORDER.reduce((n, id) => n + (player.stages[id]?.hintsRevealed ?? 0), 0);
  const end = player.completedAt !== null ? Date.parse(player.completedAt) : Date.now();
  return T().shareText(c.title, TG().scorePar(player.score, player.maxScore), hints, formatElapsed(end - Date.parse(player.setupDoneAt ?? player.startedAt ?? new Date().toISOString())));
}

function renderDebrief(c: Case, player: ProgressView): HTMLElement {
  const body = h("div", { class: "prose" }, h("p", { class: "muted" }, T().loadingDebrief));
  getDebrief(c.id)
    .then((markdown) => {
      body.replaceChildren(html("div", {}, md(markdown)));
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
    h("h2", { class: "stage-goal" }, T().caseClosed),
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
      h("code", { class: "share-text" }, shareText(c, player)),
      copyButton(() => shareText(c, player), T().copyResult),
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
      row(TG().bdClean, b.clean),
      row(TG().bdFirstBlood, b.firstBlood),
    ),
    h("tfoot", {}, h("tr", { class: "is-total" }, h("th", { scope: "row" }, TG().bdTotal), h("td", { class: "num mono" }, formatNumber(b.total)))),
  );
}

/** Live "this stage so far": base, the time bonus counting down, and the running penalties. */
function stageMeter(c: Case, q: Question, initial: StageProgress): { el: HTMLElement; tick: () => void; refresh: (s: StageProgress) => void } {
  let stage = initial;
  const target = targetSeconds(c, q);
  const timeText = h("span", { class: "meter-value" });
  const timeSub = h("span", { class: "meter-sub muted" });
  const timeFill = h("span", { class: "meter-fill" });
  const hints = h("span", { class: "meter-item" });
  const commands = h("span", { class: "meter-item" });
  const wrong = h("span", { class: "meter-item" });
  const tick = (): void => {
    const started = stage.startedAt === null ? Date.now() : Date.parse(stage.startedAt);
    const elapsed = Math.max(0, (Date.now() - started) / 1000);
    const bonus = timeBonus(elapsed, target);
    timeText.textContent = TG().meterTime(bonus);
    timeSub.textContent = elapsed < target ? TG().meterTimeFull(mmss(Math.ceil(target - elapsed))) : bonus > 0 ? TG().meterTimeFading : TG().meterTimeGone;
    timeFill.style.width = `${(bonus / SCORING.TIME_BONUS_MAX) * 100}%`;
  };
  const refresh = (next: StageProgress): void => {
    stage = next;
    const hp = hintPenalty(q, stage.hintsRevealed);
    const cp = SCORING.COMMAND_COST * stage.commandsRevealed;
    const wp = wrongPenalty(stage.wrongAttempts);
    hints.textContent = TG().meterHints(hp);
    commands.textContent = TG().meterCommands(cp);
    wrong.textContent = TG().meterWrong(wp, wp >= SCORING.WRONG_CAP);
    hints.classList.toggle("is-minus", hp > 0);
    commands.classList.toggle("is-minus", cp > 0);
    wrong.classList.toggle("is-minus", wp > 0);
    tick();
  };
  const el = h(
    "div",
    { class: "stage-meter", role: "group", "aria-label": TG().meterLabel },
    h("span", { class: "meter-item meter-base mono" }, `${TG().bdBase} ${q.points}`),
    h(
      "span",
      { class: "meter-item meter-time" },
      h("span", { "aria-hidden": "true" }, "⏱ "),
      timeText,
      " ",
      timeSub,
      h("span", { class: "meter-track", "aria-hidden": "true" }, timeFill),
    ),
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
          h("th", { scope: "row" }, `${i + 1}. ${stageLabel(c, id)}`, revealed ? h("span", { class: "bd-detail muted" }, TG().revealedShort) : null),
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
