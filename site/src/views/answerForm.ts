// The answer form of an active stage: the field with its free format check, the cooldown after a rate limit, the
// draft kept across redraws, and the submit that charges a wrong answer. The case stage uses it today; the
// Explorer and the Toolbox can dock the same form (#215), so it owns no layout and knows nothing about the page
// around it: the host gets callbacks and disposes it on every redraw.
//
//   const af = answerForm({ caseId, questionId, question, stage, index, cleanOpen, onSolved, onWrong, onServerProgress });
//   container.append(af.form);         // and, on narrow screens, af.bar?.el
//   cleanups.add(af.dispose);          // on redraw: stops the cooldown ticker and the bar's observers
import { SCORING, type ProgressView, type QuestionId, type StageProgress } from "../../shared/contract";
import type { Question } from "../../shared/case";
import { canonicalAnswer, formatKind, matchesFormat, type FormatKind } from "../lib/answer-format";
import { ApiError, submitAnswer } from "../lib/api";
import { playErrorText, recoverFromWrite } from "../lib/errors";
import { handleAuthLoss } from "../lib/auth-loss";
import { announce, h } from "../lib/dom";
import { tooltip } from "../lib/overlay";
import { bidiProse, contentText } from "../lib/bidi";
import { getLang } from "../i18n/i18n";
import { formatElapsed } from "../lib/time";
import { locale } from "../i18n/i18n";
import { TG } from "../i18n/strings-game";
import { T } from "../i18n/strings-player";
import { TP } from "../i18n/strings-play";

/** Unchecked answers per "caseId:questionId": they survive redraws (hint, reveal, language) and the auth gate. */
const drafts = new Map<string, string>();
/** Answer cooldown end (epoch ms) per "caseId:questionId": survives redraws (hint, reveal, language). */
const cooldowns = new Map<string, number>();

/** Signing out (or switching player) drops every unchecked draft. */
export function clearAnswerDrafts(): void {
  drafts.clear();
}

export type AnswerFormOptions = {
  readonly caseId: string;
  readonly questionId: QuestionId;
  readonly question: Question;
  /** The stage's progress as this page last saw it (wrong attempts so far). */
  readonly stage: StageProgress;
  /** 1-based stage number, for the answer bar's name. */
  readonly index: number;
  /** The clean bonus is still open on this stage (the cost note says what a wrong answer ends). */
  readonly cleanOpen: boolean;
  /** Also build the phone answer bar, a second way into this form (see `AnswerBar`). */
  readonly withBar?: boolean;
  /** The server accepted the answer: `next` has the stage solved. The form has announced it. */
  readonly onSolved: (next: ProgressView) => void;
  /** A wrong answer was charged: the stage's new progress (the host refreshes its meter). */
  readonly onWrong?: (stage: StageProgress) => void;
  /** A stale or unconfirmed write (#202, #203): what the server has. The draft stays for the player to resend. */
  readonly onServerProgress: (server: ProgressView) => void;
};

export type AnswerBar = { readonly el: HTMLFormElement; readonly input: HTMLInputElement };

export type AnswerFormHandle = {
  readonly form: HTMLFormElement;
  readonly input: HTMLInputElement;
  /** The phone bar, when `withBar` was set. */
  readonly bar: AnswerBar | null;
  /** Stops the cooldown ticker and the bar's observers. Call it before the form leaves the page. */
  readonly dispose: () => void;
};

/**
 * The answer format in the reader's language. In Hebrew its paths and English terms are isolated runs inside a
 * right-to-left isolate (#286), so "(למשל /page.html)" keeps its slash; in English it is plain text.
 */
function formatText(text: string): HTMLElement {
  return getLang() === "he" ? bidiProse(h("bdi", { class: "answer-format" }, text)) : contentText("bdi", { class: "answer-format" }, text);
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
    // a free-form answer has no fixed shape: a neutral prompt, never an example that reads as a value (#286)
    other: t.phOther,
  };
  return map[kind];
}

function formatInputMode(kind: FormatKind): string {
  if (kind === "integer") return "numeric";
  if (kind === "ipv4" || kind === "version") return "decimal";
  return "text";
}

function wrongPenalty(wrong: number): number {
  return Math.min(SCORING.WRONG_CAP, SCORING.WRONG_COST * wrong);
}

export function answerForm(opts: AnswerFormOptions): AnswerFormHandle {
  const { caseId, questionId: id, question: q, stage: s } = opts;
  const key = `${caseId}:${id}`;
  const intervals = new Set<number>();
  const stops = new Set<() => void>();
  const every = (ms: number, fn: () => void): number => {
    const t = window.setInterval(fn, ms);
    intervals.add(t);
    return t;
  };

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
  input.value = drafts.get(key) ?? "";
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-lg answer-submit" }, TP().checkAnswer);
  const feedback = h("p", { id: `feedback-${id}`, class: "feedback", role: "status" });
  if (s.wrongAttempts > 0) feedback.textContent = TG().wrongSoFarCost(s.wrongAttempts, wrongPenalty(s.wrongAttempts));
  const setInvalid = (message: string): void => {
    input.setAttribute("aria-invalid", "true");
    feedback.className = "feedback is-wrong";
    feedback.textContent = message;
  };
  input.addEventListener("input", () => {
    drafts.set(key, input.value);
    if (input.getAttribute("aria-invalid") === "true") input.removeAttribute("aria-invalid");
  });

  // Rate-limit cooldown. The end time lives in `cooldowns`, so a redraw (hint, reveal, language) keeps
  // Submit disabled. The live region gets one message with an absolute time; the ticking countdown is on
  // the (non-live) button only, so screen readers aren't told the time every second.
  let cooldown: number | null = null;
  let busy = false;
  const startCooldown = (until: number): void => {
    cooldowns.set(key, until);
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
      cooldowns.delete(key);
      submit.disabled = false;
      submit.textContent = TP().checkAnswer;
      feedback.className = "feedback";
      feedback.textContent = T().canTryAgain;
      return false;
    };
    if (cooldown !== null) window.clearInterval(cooldown);
    if (show()) cooldown = every(1000, show);
  };
  const pendingCooldown = cooldowns.get(key);
  if (pendingCooldown !== undefined) {
    if (pendingCooldown > Date.now()) startCooldown(pendingCooldown);
    else cooldowns.delete(key);
  }

  // Scoring fine print: read by screen readers in place, shown to sighted players on the ⓘ beside the format.
  const costText = TP().costNote(SCORING.WRONG_COST, SCORING.WRONG_CAP, SCORING.CLEAN_BONUS, opts.cleanOpen);
  const costNote = h("p", { class: "visually-hidden cost-note" }, costText);
  const costInfo = h("button", { type: "button", class: "info-dot", "aria-label": costText }, "i");
  tooltip(costInfo, costText);
  const form = h(
    "form",
    { class: "answer-form", id: `form-${id}`, novalidate: true },
    h("label", { class: "answer-label", for: inputId }, T().yourAnswer),
    h("p", { id: `fmt-${id}`, class: "muted small answer-format-line" }, T().format, " ", formatText(q.answerFormat), costInfo),
    h("div", { class: "answer-row" }, input, submit),
    feedback,
    costNote,
  );
  const bar = opts.withBar === true ? answerBar(opts.index, form, input, submit, feedback, stops) : null;
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (busy || submit.disabled) return;
    // Sent from the phone's answer bar: errors keep focus there instead of scrolling to the field.
    const field = bar !== null && bar.el.contains(document.activeElement) ? bar.input : input;
    const answer = canonicalAnswer(q.answerFormat, input.value);
    if (answer.length === 0) {
      setInvalid(T().typeFirst);
      field.focus();
      return;
    }
    if (!matchesFormat(q.answerFormat, answer)) {
      setInvalid(TP().formatMismatch(q.answerFormat));
      field.focus();
      return;
    }
    busy = true;
    submit.setAttribute("aria-disabled", "true");
    submit.textContent = TP().checking;
    const done = (): void => {
      busy = false;
      submit.removeAttribute("aria-disabled");
      if (!cooldowns.has(key)) submit.textContent = TP().checkAnswer;
    };
    submitAnswer(caseId, id, answer)
      .then(({ correct, progress: next }) => {
        if (correct) {
          drafts.delete(key);
          announce(TP().solvedAnnounce(next.stages[id]?.points ?? 0));
          opts.onSolved(next);
          return;
        }
        done();
        const attempts = next.stages[id]?.wrongAttempts ?? 0;
        setInvalid(
          SCORING.WRONG_COST * attempts <= SCORING.WRONG_CAP
            ? TP().wrongValue(attempts, SCORING.WRONG_COST)
            : TP().wrongValueCapped(attempts, SCORING.WRONG_CAP),
        );
        opts.onWrong?.(next.stages[id] ?? s);
        form.classList.remove("shake");
        void form.offsetWidth;
        form.classList.add("shake");
        field.select();
      })
      .catch((err: unknown) => {
        done();
        if (handleAuthLoss(err)) return; // the draft is kept: the stage re-renders with it after the gate
        // Stale or unconfirmed (#202, #203): show what the server has; the draft stays for the player to resend.
        const server = recoverFromWrite(err);
        if (server !== null) return opts.onServerProgress(server);
        if (err instanceof ApiError && err.isRateLimited) {
          startCooldown(Date.now() + (err.retryAfterSeconds ?? 60) * 1000);
          return;
        }
        feedback.className = "feedback is-wrong";
        feedback.textContent = playErrorText(err);
      });
  });

  const dispose = (): void => {
    for (const t of intervals) window.clearInterval(t);
    intervals.clear();
    for (const stop of stops) stop();
    stops.clear();
  };
  return { form, input, bar, dispose };
}

/* ---------- phones (#132, #218): the pinned answer bar ---------- */

/**
 * A `[input][Check]` bar pinned to the bottom edge on narrow screens, shown while the real answer field is off
 * screen (an IntersectionObserver on the form; a field in a hidden pane counts as off screen). It is a second
 * way into the same form: typing fills the same draft, Check submits the real form, and the form's feedback
 * and button state are copied in. The copy is aria-hidden, because the form's own status region already
 * announces them. CSS removes it above 1024px.
 */
function answerBar(index: number, form: HTMLFormElement, input: HTMLInputElement, submit: HTMLButtonElement, feedback: HTMLElement, stops: Set<() => void>): AnswerBar {
  const barInput = h("input", {
    class: "input mono answer-bar-input",
    type: "text",
    dir: "ltr",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    enterkeyhint: "go",
    inputmode: input.inputMode || "text",
    maxlength: "200",
    placeholder: input.placeholder || null,
    "aria-label": TP().answerBarInput(index),
  });
  barInput.value = input.value;
  const barSubmit = h("button", { type: "submit", class: "btn btn-primary answer-bar-submit" }, TP().answerBarCheck);
  const note = h("p", { class: "answer-bar-note", "aria-hidden": "true" });
  const el = h(
    "form",
    { class: "answer-bar", "aria-label": TP().answerBarLabel, novalidate: true, "data-shown": "false" },
    h("div", { class: "answer-bar-row" }, barInput, barSubmit),
    note,
  );

  barInput.addEventListener("input", () => {
    input.value = barInput.value;
    input.dispatchEvent(new Event("input")); // the real field's listener keeps the draft and clears the error mark
  });
  input.addEventListener("input", () => {
    if (barInput.value !== input.value) barInput.value = input.value;
  });
  el.addEventListener("submit", (ev) => {
    ev.preventDefault();
    input.value = barInput.value;
    form.requestSubmit();
  });

  // Mirror the form's state: feedback text and tone, the error mark, the button's label and disabled state.
  const mirror = (): void => {
    note.textContent = feedback.textContent ?? "";
    note.classList.toggle("is-wrong", feedback.classList.contains("is-wrong"));
    if (input.getAttribute("aria-invalid") === "true") barInput.setAttribute("aria-invalid", "true");
    else barInput.removeAttribute("aria-invalid");
    barSubmit.disabled = submit.disabled;
    if (submit.getAttribute("aria-disabled") === "true") barSubmit.setAttribute("aria-disabled", "true");
    else barSubmit.removeAttribute("aria-disabled");
    const label = submit.textContent ?? "";
    barSubmit.textContent = label === TP().checkAnswer ? TP().answerBarCheck : label;
  };
  const watcher = new MutationObserver(mirror);
  for (const target of [feedback, submit, input]) watcher.observe(target, { childList: true, characterData: true, subtree: true, attributes: true });
  mirror();
  stops.add(() => watcher.disconnect());

  // Shown while the real field is off screen; never hidden under the player's fingers (focus inside the bar).
  let formOnScreen = true;
  const sync = (): void => {
    const show = !formOnScreen || el.contains(document.activeElement);
    el.dataset.shown = String(show);
    el.inert = !show;
  };
  el.addEventListener("focusout", () => window.requestAnimationFrame(sync));
  if (typeof IntersectionObserver === "function") {
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      formOnScreen = entry.isIntersecting;
      sync();
    });
    io.observe(form);
    stops.add(() => io.disconnect());
  }
  sync();
  return { el, input: barInput };
}
