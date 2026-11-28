// The docked "Current question" strip (#215): the Explorer and the Toolbox show the active stage's goal and the
// shared answer form, so a player who finds the value in the log answers without leaving the page. It uses the
// case page's `answerForm`, so the draft, the format check and the rate-limit cooldown are the same ones; every
// answer goes through `submitAnswer`, which shares the server's progress with this tab and the player's other
// tabs (lib/progress-bus.ts). It never shows answers or paid content: only the goal, the prompt and the field.
//
//   const strip = questionStrip({ c, place: "explorer" });
//   host.append(strip.el);
//   strip.set({ kind: "player", progress });   // or "signed-out", "loading", "none", "error"
//   strip.dispose();                           // on leaving the page
import { QUESTION_ORDER, type ProgressView, type QuestionId } from "../../shared/contract";
import type { Case } from "../../shared/case";
import { getProgress } from "../lib/api";
import { followProgress, type ProgressFollower } from "../lib/progress-bus";
import { onAuthLoss } from "../lib/auth-loss";
import { isAdmin, loadAccount } from "../lib/session";
import { contentText, bidiProse } from "../lib/bidi";
import { md } from "../lib/markdown";
import { h, html, setChildren } from "../lib/dom";
import { TQ } from "../i18n/strings-strip";
import { T } from "../i18n/strings-player";
import { TGu } from "../i18n/strings-guest";
import { answerForm, type AnswerFormHandle } from "./answerForm";
import { isCleanSoFar } from "./toolbox";
import { playAsGuest } from "./guest";
import "../player.css";

export type StripState =
  | { readonly kind: "loading" }
  | { readonly kind: "signed-out" }
  /** The admin, or an account that still has to pass the gate on the case page: nothing to answer here. */
  | { readonly kind: "none" }
  | { readonly kind: "error" }
  | { readonly kind: "player"; readonly progress: ProgressView };

export type QuestionStrip = {
  readonly el: HTMLElement;
  readonly set: (state: StripState) => void;
  readonly dispose: () => void;
};

export type QuestionStripOptions = {
  readonly c: Case;
  /** Which page docks it: each remembers whether its prompt is open (both start as one line). */
  readonly place: "explorer" | "toolbox";
  /** A write from this strip (a solve, a charged wrong answer, a stale reply): the host redraws its own parts. */
  readonly onProgress?: (next: ProgressView) => void;
  /** "Try again" after a failed load, or a guest session just started: the host loads the state again. */
  readonly onReload: () => void;
  /** The page already says "start the case" / "case complete" itself (the Toolbox): no strip for those states. */
  readonly quietWhenIdle?: boolean;
};

const prefKey = (place: QuestionStripOptions["place"]): string => `il.pref.qStrip.${place}`;

function readOpen(place: QuestionStripOptions["place"]): boolean {
  try {
    return window.localStorage.getItem(prefKey(place)) === "1";
  } catch {
    return false; // storage blocked: one line
  }
}

function writeOpen(place: QuestionStripOptions["place"], open: boolean): void {
  try {
    window.localStorage.setItem(prefKey(place), open ? "1" : "0");
  } catch {
    /* storage blocked: the toggle still works for this visit */
  }
}

function activeStage(progress: ProgressView): QuestionId | null {
  if (progress.setupDoneAt === null) return null;
  return QUESTION_ORDER.find((id) => progress.stages[id]?.status === "active") ?? null;
}

export function questionStrip(opts: QuestionStripOptions): QuestionStrip {
  const { c, place } = opts;
  const el = h("section", { class: "q-strip", "aria-labelledby": `q-strip-h-${place}`, "data-place": place });
  let form: AnswerFormHandle | null = null;
  let open = readOpen(place);
  /** The stage this strip just solved: its "Next stage" panel stays until the player moves on. */
  let solved: { index: number; points: number; next: ProgressView } | null = null;

  const heading = (...children: (Node | string)[]): HTMLElement =>
    h("h2", { class: "q-strip-h", id: `q-strip-h-${place}` }, h("span", { class: "q-strip-kicker" }, TQ().stripLabel), ...children);
  const caseLink = (label: string, primary = false): HTMLElement =>
    h("a", { class: `btn btn-sm${primary ? " btn-primary" : ""}`, href: `#/case/${c.id}` }, label);

  const disposeForm = (): void => {
    form?.dispose();
    form = null;
  };

  const drawNote = (text: string, ...actions: HTMLElement[]): void => {
    setChildren(el, h("div", { class: "q-strip-line" }, heading(), h("p", { class: "q-strip-note" }, text), actions.length > 0 ? h("div", { class: "q-strip-actions" }, actions) : null));
  };

  const drawSolved = (s: { index: number; points: number; next: ProgressView }): void => {
    const more = activeStage(s.next);
    const nextIndex = more === null ? null : QUESTION_ORDER.indexOf(more) + 1;
    const answerHere =
      nextIndex === null
        ? null
        : h(
            "button",
            {
              type: "button",
              class: "btn btn-sm btn-ghost",
              onclick: () => {
                solved = null;
                draw({ kind: "player", progress: s.next }, true);
              },
            },
            TQ().answerNext(nextIndex),
          );
    const done = h("p", { class: "q-strip-done", tabindex: "-1" }, h("span", { class: "q-strip-tick", "aria-hidden": "true" }, "✓ "), TQ().solved(s.index, s.points));
    setChildren(
      el,
      h("div", { class: "q-strip-line is-solved" }, heading(), done, h("div", { class: "q-strip-actions" }, caseLink(nextIndex === null ? TQ().toDebrief : TQ().nextStage, true), answerHere)),
    );
    done.focus({ preventScroll: true });
  };

  /** `focusField`: put the caret in the new field (moving on from a solve). Otherwise focus stays where it was. */
  const draw = (state: StripState, focusField = false): void => {
    // A redraw from another tab while the player types here keeps the caret in the (rebuilt) field.
    const typing = form !== null && (form.form.contains(document.activeElement) || form.bar?.el.contains(document.activeElement) === true);
    disposeForm();
    el.dataset.state = state.kind;
    if (state.kind === "loading") return drawNote(TQ().loading);
    if (state.kind === "none") {
      el.hidden = true;
      setChildren(el);
      return;
    }
    el.hidden = false;
    if (state.kind === "error") return drawNote(TQ().loadFailed, h("button", { type: "button", class: "btn btn-sm", onclick: opts.onReload }, TQ().retry));
    if (state.kind === "signed-out") {
      // The account gate lives on the case page; a guest session starts right here and the strip loads again.
      const guest = h("button", { type: "button", class: "btn btn-sm", onclick: () => void playAsGuest().then((ok) => ok && opts.onReload()) }, TGu().playAsGuest);
      setChildren(
        el,
        h(
          "div",
          { class: "q-strip-line" },
          heading(),
          h("p", { class: "q-strip-note" }, h("span", { class: "q-strip-gate" }, TQ().signedOutTitle), " ", h("span", { class: "muted" }, TQ().signedOutBody)),
          h("div", { class: "q-strip-actions" }, caseLink(TQ().signIn, true), guest),
        ),
      );
      return;
    }
    if (solved !== null) return drawSolved(solved);
    const progress = state.progress;
    const idle = (): void => {
      el.hidden = true;
      setChildren(el);
    };
    if (progress.setupDoneAt === null) return opts.quietWhenIdle === true ? idle() : drawNote(TQ().notStarted, caseLink(TQ().openCase, true));
    const id = activeStage(progress);
    const q = id === null ? undefined : c.questions.find((x) => x.id === id);
    const s = id === null ? undefined : progress.stages[id];
    if (id === null || q === undefined || s === undefined) return opts.quietWhenIdle === true ? idle() : drawNote(TQ().complete, caseLink(TQ().readDebrief, true));

    const index = QUESTION_ORDER.indexOf(id) + 1;
    const af = answerForm({
      caseId: c.id,
      questionId: id,
      question: q,
      stage: s,
      index,
      cleanOpen: isCleanSoFar(s),
      withBar: true,
      onSolved: (next) => {
        solved = { index, points: next.stages[id]?.points ?? 0, next };
        disposeForm();
        drawSolved(solved);
        opts.onProgress?.(next);
      },
      onWrong: () => undefined,
      onServerProgress: (server) => {
        draw({ kind: "player", progress: server });
        opts.onProgress?.(server);
      },
    });
    form = af;
    const promptId = `q-strip-prompt-${place}`;
    const prompt = bidiProse(html("div", { class: "prose q-strip-prompt", id: promptId, hidden: !open }, md(q.prompt)));
    // The stage line is the disclosure (APG): one line until opened, then the whole goal and the prompt.
    const toggle = h(
      "button",
      { type: "button", class: "q-strip-toggle", "aria-expanded": String(open), "aria-controls": promptId },
      h("span", { class: "q-strip-chev", "aria-hidden": "true" }),
      h("span", { class: "q-strip-stage" }, T().stageOf(index, QUESTION_ORDER.length)),
      h("span", { class: "q-strip-sep", "aria-hidden": "true" }, " · "),
      contentText("span", { class: "q-strip-goal" }, q.stage?.goal ?? q.title),
    );
    toggle.addEventListener("click", () => {
      open = !open;
      writeOpen(place, open);
      prompt.hidden = !open;
      el.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
    });
    el.classList.toggle("is-open", open);
    setChildren(el, h("div", { class: "q-strip-line is-question" }, heading(toggle), af.form), prompt, af.bar?.el ?? null);
    if (focusField || typing) af.input.focus({ preventScroll: true });
  };

  return {
    el,
    set: (state) => {
      // A newer progress that has left the solved stage behind (another tab moved on) ends the "Next stage" panel.
      if (solved !== null && state.kind === "player" && activeStage(state.progress) !== activeStage(solved.next)) solved = null;
      if (solved !== null && state.kind === "player") solved = { ...solved, next: state.progress };
      draw(state);
    },
    dispose: disposeForm,
  };
}

/**
 * The strip's state for a page that has no progress of its own (the Explorer): the account, then the progress,
 * then it follows the progress across tabs until `alive()` turns false.
 */
export function runQuestionStrip(c: Case, place: QuestionStripOptions["place"], alive: () => boolean): QuestionStrip {
  let follower: ProgressFollower | null = null;
  const stop = (): void => {
    follower?.stop();
    follower = null;
  };
  const load = (): void => {
    stop();
    strip.set({ kind: "loading" });
    loadAccount()
      .then((account) => {
        if (!alive()) return;
        if (account === null) return strip.set({ kind: "signed-out" });
        if (isAdmin(account) || account.status !== "approved" || account.mustChangePassword) return strip.set({ kind: "none" });
        return getProgress(c.id).then((progress) => {
          if (!alive()) return;
          strip.set({ kind: "player", progress });
          follower = followProgress({ initial: progress, load: () => getProgress(c.id), alive, apply: (next) => strip.set({ kind: "player", progress: next }) });
        });
      })
      .catch(() => {
        if (alive()) strip.set({ kind: "error" });
      });
  };
  const strip = questionStrip({ c, place, onReload: load });
  // A 401 or 403 on an answer sent from here: load the session and the strip again (the draft survives).
  onAuthLoss(load);
  load();
  return {
    el: strip.el,
    set: strip.set,
    dispose: () => {
      stop();
      strip.dispose();
    },
  };
}
