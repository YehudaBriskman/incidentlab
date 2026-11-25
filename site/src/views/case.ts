import { PlayerNameSchema, QUESTION_ORDER, type PlayerView, type QuestionId, type StageProgress } from "../../shared/contract";
import type { Case, Question } from "../content/schema";
import { ApiError, clearToken, createPlayer, getDebrief, getMe, getToken, revealAnswer, revealHint, setupDone, submitAnswer } from "../lib/api";
import { confirmButton, copyButton, h, html, setChildren, type Child } from "../lib/dom";
import { md, mdInline } from "../lib/markdown";
import { formatElapsed } from "../lib/time";
import { commandCard } from "./toolbox";
import { T } from "../i18n/strings-player";

type StageKey = "setup" | QuestionId | "debrief";
type StepState = "locked" | "active" | "solved" | "revealed";

const timers = new Set<number>();
const drafts = new Map<QuestionId, string>();

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

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return T().genericError;
}

/* ================= entry ================= */

export function renderCase(root: HTMLElement, c: Case): void {
  stopCaseTimers();
  document.title = `${c.title} · IncidentLab`;
  if (getToken() === null) {
    renderGate(root, c);
    return;
  }
  setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted mono" }, T().loadingInvestigation)));
  getMe()
    .then((player) => renderStaged(root, c, player))
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.isUnauthorized) {
        clearToken();
        renderGate(root, c);
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

/* ================= name gate ================= */

function renderGate(root: HTMLElement, c: Case): void {
  const input = h("input", {
    id: "player-name",
    class: "input input-lg",
    type: "text",
    autocomplete: "nickname",
    maxlength: "32",
    required: true,
    placeholder: T().namePlaceholder,
    "aria-describedby": "name-help name-error",
  });
  const errorEl = h("p", { id: "name-error", class: "form-error", role: "alert" });
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-lg btn-block" }, T().startInvestigating);

  const form = h(
    "form",
    { class: "center-card gate", novalidate: true },
    h("p", { class: "eyebrow mono" }, c.title),
    h("h1", {}, T().whoInvestigating),
    h("p", { id: "name-help", class: "muted" }, T().nameHelp),
    h("label", { class: "visually-hidden", for: "player-name" }, T().yourName),
    input,
    errorEl,
    submit,
  );

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const parsed = PlayerNameSchema.safeParse(input.value);
    if (!parsed.success) {
      errorEl.textContent = parsed.error.issues[0]?.message.includes("only")
        ? (parsed.error.issues[0]?.message ?? "")
        : T().nameLength;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    input.removeAttribute("aria-invalid");
    errorEl.textContent = "";
    submit.disabled = true;
    submit.textContent = T().starting;
    createPlayer(parsed.data)
      .then((player) => renderStaged(root, c, player))
      .catch((err: unknown) => {
        errorEl.textContent = errorMessage(err);
        submit.disabled = false;
        submit.textContent = T().startInvestigating;
      });
  });

  setChildren(root, form);
  input.focus();
}

/* ================= staged view ================= */

function questionFor(c: Case, id: QuestionId): Question | undefined {
  return c.questions.find((q) => q.id === id);
}

function stageLabel(c: Case, id: QuestionId): string {
  const q = questionFor(c, id);
  return q?.stage?.name ?? q?.title ?? id.toUpperCase();
}

function stageProgress(player: PlayerView, id: QuestionId): StageProgress | undefined {
  return player.stages[id];
}

function isDone(s: StageProgress | undefined): boolean {
  return s !== undefined && (s.status === "solved" || s.status === "revealed");
}

function currentStage(player: PlayerView): StageKey {
  if (player.setupDoneAt === null) return "setup";
  for (const id of QUESTION_ORDER) {
    if (!isDone(stageProgress(player, id))) return id;
  }
  return "debrief";
}

function stepState(player: PlayerView, key: StageKey): StepState {
  if (key === "setup") return player.setupDoneAt === null ? "active" : "solved";
  if (key === "debrief") return currentStage(player) === "debrief" ? "active" : "locked";
  const s = stageProgress(player, key);
  if (s === undefined) return "locked";
  return s.status;
}

const STAGE_KEYS: readonly StageKey[] = ["setup", ...QUESTION_ORDER, "debrief"];

function renderStaged(root: HTMLElement, c: Case, initialPlayer: PlayerView): void {
  stopCaseTimers();
  let player = initialPlayer;
  let viewing: StageKey = currentStage(player);
  let justSolved: QuestionId | null = null;

  const update = (next: PlayerView, view?: StageKey): void => {
    player = next;
    viewing = view ?? currentStage(player);
    draw();
  };

  const switchPlayer = (): void => {
    clearToken();
    drafts.clear();
    renderGate(root, c);
  };

  const elStats = h("span", { class: "progress-stats mono" });
  const elFill = h("span", { class: "progress-fill" });
  const tick = (): void => {
    const solved = QUESTION_ORDER.filter((id) => isDone(stageProgress(player, id))).length;
    const start = Date.parse(player.createdAt);
    const end = player.completedAt !== null ? Date.parse(player.completedAt) : Date.now();
    elStats.textContent = T().progressStats(solved, QUESTION_ORDER.length, player.score, formatElapsed(end - start));
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
          h("strong", {}, player.name), // textContent only
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
    if (viewing === "setup") main.append(renderSetup(c, player, update));
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
  window.scrollTo(0, 0);
}

/* ================= Stage 0: setup ================= */

function renderSetup(c: Case, player: PlayerView, update: (p: PlayerView) => void): HTMLElement {
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
    setupDone()
      .then((p) => {
        writePref("briefingRead", "1");
        update(p);
      })
      .catch((err: unknown) => {
        errorEl.textContent = errorMessage(err);
        ready.disabled = false;
      });
  });

  return h(
    "div",
    { class: "stage" },
    h("p", { class: "stage-kicker mono" }, T().setupKicker),
    h("h2", { class: "stage-goal" }, T().setupGoal),
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
      : h("div", { class: "primary-action" }, ready, errorEl),
  );
}

/* ================= Question stages ================= */

function renderQuestionStage(
  c: Case,
  player: PlayerView,
  id: QuestionId,
  justSolved: boolean,
  onAnswer: (p: PlayerView, correct: boolean) => void,
  update: (p: PlayerView, view?: StageKey) => void,
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
  if (s.wrongAttempts > 0) feedback.textContent = T().wrongSoFar(s.wrongAttempts);

  let cooldown: number | null = null;
  const startCooldown = (seconds: number): void => {
    let left = Math.ceil(seconds);
    submit.disabled = true;
    const show = (): void => {
      feedback.className = "feedback is-wrong";
      feedback.textContent = T().tooMany(left);
    };
    show();
    if (cooldown !== null) window.clearInterval(cooldown);
    cooldown = every(1000, () => {
      left -= 1;
      if (left <= 0) {
        if (cooldown !== null) window.clearInterval(cooldown);
        submit.disabled = false;
        feedback.className = "feedback";
        feedback.textContent = T().canTryAgain;
        return;
      }
      show();
    });
  };

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
    submitAnswer(id, answer)
      .then(({ correct, player: next }) => {
        if (correct) {
          drafts.delete(id);
          onAnswer(next, true);
          return;
        }
        submit.disabled = false;
        const attempts = next.stages[id]?.wrongAttempts ?? 0;
        feedback.className = "feedback is-wrong";
        feedback.textContent = T().notQuite(attempts);
        form.classList.remove("shake");
        void form.offsetWidth;
        form.classList.add("shake");
        input.select();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.isRateLimited) {
          startCooldown(err.retryAfterSeconds ?? 60);
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

  /* hints */
  const hintList = q.hints.slice(0, s.hintsRevealed).map((hint, i) =>
    h("li", { class: "hint" }, h("span", { class: "hint-label mono" }, T().hintLabel(i + 1, hint.cost)), html("div", { class: "prose" }, md(hint.text))),
  );
  const nextHint = q.hints[s.hintsRevealed];
  const hintError = h("p", { class: "form-error", role: "alert" });
  const hintBtn = nextHint
    ? h("button", { type: "button", class: "btn btn-ghost" }, T().revealHint(s.hintsRevealed + 1, q.hints.length, nextHint.cost))
    : null;
  hintBtn?.addEventListener("click", () => {
    hintBtn.disabled = true;
    revealHint(id)
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
      revealAnswer(id)
        .then((p) => update(p, id))
        .catch((err: unknown) => {
          for (const b of reveal.querySelectorAll("button")) b.disabled = false;
          revealError.textContent = errorMessage(err);
        });
    },
  });

  return h(
    "div",
    { class: "stage" },
    head,
    h("div", { class: "question-box" }, html("div", { class: "prose prompt" }, md(q.prompt)), form),
    tools.length > 0
      ? h("div", { class: "block" }, h("h3", {}, T().usefulCommands), h("div", { class: "tool-list" }, tools.map(commandCard)))
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

function shareText(c: Case, player: PlayerView): string {
  const hints = QUESTION_ORDER.reduce((n, id) => n + (player.stages[id]?.hintsRevealed ?? 0), 0);
  const end = player.completedAt !== null ? Date.parse(player.completedAt) : Date.now();
  return T().shareText(c.title, player.score, player.maxScore, hints, formatElapsed(end - Date.parse(player.createdAt)));
}

function renderDebrief(c: Case, player: PlayerView): HTMLElement {
  const body = h("div", { class: "prose" }, h("p", { class: "muted" }, T().loadingDebrief));
  getDebrief()
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
      h("p", { class: "score-big mono" }, `${player.score}`, h("span", { class: "muted" }, T().ptsOf(player.maxScore))),
      h("code", { class: "share-text" }, shareText(c, player)),
      copyButton(() => shareText(c, player), T().copyResult),
    ),
    body,
  );
}
