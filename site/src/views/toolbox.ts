// Command cards and the per-case Toolbox page.
// The free part of a command is its `syntax` (a template with <placeholders>). The runnable command is paid
// for (SCORING.COMMAND_COST on the active stage) and comes from `progress.unlocked.commands`, never from the
// bundled content: production builds strip `command` / `powershell` from the case JSON.
import { QUESTION_ORDER, SCORING, type ProgressView, type TodayResponse } from "../../shared/contract";
import type { Case } from "../content/schema";
import { getProgress, revealCommand } from "../lib/api";
import { confirmButton, copyButton, h, html, setChildren, type Child } from "../lib/dom";
import { playErrorText } from "../lib/errors";
import { md } from "../lib/markdown";
import { isAdmin, loadAccount, loadToday } from "../lib/session";
import { caseSummary } from "../content/load";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { T } from "../i18n/strings-player";
import { withApprovedAccount } from "./auth";

type ToolItem = Case["toolbox"][number]["items"][number];
type Shell = "bash" | "powershell";

/** What a command card needs to know about the player. `progress: null` = signed out (or the admin). */
export type CommandContext = {
  readonly caseId: string;
  readonly progress: ProgressView | null;
  readonly onProgress: (next: ProgressView) => void;
  /** The case can't be started today: no reveal actions (they would fail), the page explains why. */
  readonly locked?: boolean;
};

function readShell(): Shell {
  try {
    return window.localStorage.getItem("il.pref.shell") === "powershell" ? "powershell" : "bash";
  } catch {
    return "bash";
  }
}
function writeShell(shell: Shell): void {
  try {
    window.localStorage.setItem("il.pref.shell", shell);
  } catch {
    /* ignore */
  }
}

/** 1-based number of the stage that is active right now (the one a reveal is charged to), or null. */
export function activeStageNumber(progress: ProgressView | null): number | null {
  if (progress === null || progress.setupDoneAt === null || progress.completedAt !== null) return null;
  const i = QUESTION_ORDER.findIndex((q) => progress.stages[q]?.status === "active");
  return i === -1 ? null : i + 1;
}

/** Today's case when `c` can't be started today (lock-to-today, not today's case, never started), else null. */
export type LockedToday = { todayCaseId: string | null };

/**
 * The server returns a view-only progress (`startedAt: null`, nothing stored) for a case that can't be
 * started today; `/api/today` says why. Both must agree, so a stale schedule never locks a playable case.
 */
export function lockedToday(progress: ProgressView, today: TodayResponse | null, caseId: string): LockedToday | null {
  if (progress.startedAt !== null || today === null || !today.lockToToday || today.caseId === caseId) return null;
  return { todayCaseId: today.caseId };
}

/* ---------- screen-reader announcements that survive re-renders ---------- */
let announcer: HTMLElement | null = null;
function announce(message: string): void {
  if (announcer === null) {
    announcer = h("p", { class: "visually-hidden", "aria-live": "polite", role: "status" });
    document.body.append(announcer);
  }
  const el = announcer;
  el.textContent = "";
  window.setTimeout(() => (el.textContent = message), 50);
}

const PLACEHOLDER = /(<[\p{L}\p{N}_][\p{L}\p{N}_ .,:/|=+-]*>)/u;

/** The syntax template, with every <placeholder> wrapped in a highlighted span (text nodes only). */
function syntaxNodes(text: string): Child[] {
  return text
    .split(PLACEHOLDER)
    .filter((part) => part.length > 0)
    .map((part) => (PLACEHOLDER.test(part) && part.startsWith("<") ? h("span", { class: "ph" }, part) : part));
}

let cardSeq = 0;

/** One command: syntax (free) with Bash | PowerShell tabs, or the full command once revealed. */
export function commandCard(item: ToolItem, ctx: CommandContext): HTMLElement {
  const uid = `cmd-${++cardSeq}`;
  const progress = ctx.progress;
  const toolId = item.id;
  const full = toolId !== undefined ? progress?.unlocked.commands[toolId] : undefined;
  const paidOn = toolId !== undefined ? progress?.commandsRevealed[toolId] : undefined;

  const bashText = full?.command ?? item.syntax ?? "";
  const psText = full ? full.powershell : (item.syntaxPowershell ?? null);
  let shell: Shell = psText !== null ? readShell() : "bash";

  const code = h("code", {});
  const pre = h("pre", {
    class: full ? "code-block" : "code-block syntax-block",
    id: `${uid}-panel`,
    role: psText !== null ? "tabpanel" : null,
    "aria-label": full ? null : TG().syntaxLabel,
  });
  pre.append(code);
  const current = (): string => (shell === "powershell" && psText !== null ? psText : bashText);
  const tabs = new Map<Shell, HTMLButtonElement>();
  const sync = (): void => {
    if (full) code.textContent = current();
    else setChildren(code, syntaxNodes(current()));
    for (const [k, btn] of tabs) {
      btn.setAttribute("aria-selected", String(k === shell));
      btn.tabIndex = k === shell ? 0 : -1;
    }
  };
  const tab = (k: Shell, label: string): HTMLButtonElement => {
    const btn = h("button", { type: "button", role: "tab", class: "shell-tab", "aria-controls": `${uid}-panel` }, label);
    btn.addEventListener("click", () => {
      shell = k;
      writeShell(k);
      sync();
    });
    btn.addEventListener("keydown", (ev) => {
      if (!(ev instanceof KeyboardEvent) || (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight")) return;
      ev.preventDefault();
      shell = shell === "bash" ? "powershell" : "bash";
      writeShell(shell);
      sync();
      tabs.get(shell)?.focus();
    });
    tabs.set(k, btn);
    return btn;
  };
  const tabBar = psText !== null ? h("div", { class: "shell-tabs", role: "tablist", "aria-label": T().shell }, tab("bash", "Bash"), tab("powershell", "PowerShell")) : null;
  sync();

  const tag = full
    ? h(
        "span",
        { class: "chip chip-completed cmd-tag" },
        paidOn !== undefined ? TG().revealedTag(TG().stageShort(QUESTION_ORDER.indexOf(paidOn) + 1)) : TG().unlockedTag,
      )
    : null;

  /* reveal action */
  const errorEl = h("p", { class: "form-error", role: "alert" });
  let action: Child = null;
  if (!full && toolId !== undefined && ctx.locked !== true) {
    const stageNo = activeStageNumber(progress);
    if (progress === null) action = h("p", { class: "muted small cmd-note" }, TG().signInToReveal);
    else if (progress.setupDoneAt === null) action = h("p", { class: "muted small cmd-note" }, TG().startToReveal);
    else if (stageNo !== null) {
      const reveal = confirmButton({
        label: TG().revealCommand(SCORING.COMMAND_COST),
        confirmLabel: TG().revealCommandConfirm(SCORING.COMMAND_COST, stageNo),
        className: "btn btn-sm btn-reveal",
        onConfirm: () => {
          for (const b of reveal.querySelectorAll("button")) b.disabled = true;
          errorEl.textContent = "";
          revealCommand(ctx.caseId, toolId)
            .then((next) => {
              ctx.onProgress(next);
              announce(TG().commandRevealedAnnounce(item.title));
              window.requestAnimationFrame(() => {
                const card = document.querySelector(`[data-tool="${CSS.escape(toolId)}"]`);
                const target = card?.querySelector<HTMLElement>(".btn-copy") ?? null;
                target?.focus({ preventScroll: true });
              });
            })
            .catch((err: unknown) => {
              for (const b of reveal.querySelectorAll("button")) b.disabled = false;
              errorEl.textContent = playErrorText(err);
            });
        },
      });
      action = reveal;
    }
  }

  return h(
    "div",
    { class: `cmd${full ? " is-revealed" : ""}`, "data-tool": toolId ?? null },
    h("div", { class: "cmd-head" }, h("h4", {}, item.title), tag, tabBar),
    full ? null : h("p", { class: "syntax-label mono" }, TG().syntaxLabel),
    h("div", { class: "code-wrap" }, pre, full ? copyButton(current, T().copy) : null),
    html("div", { class: "prose small" }, md(item.explain)),
    action !== null ? h("div", { class: "cmd-actions" }, action, errorEl) : null,
  );
}

/* ================= Toolbox page ================= */

type PageState =
  | { kind: "signed-out" }
  | { kind: "admin" }
  | { kind: "player"; progress: ProgressView; locked: LockedToday | null }
  | { kind: "error"; message: string };

export function renderToolbox(root: HTMLElement, c: Case): void {
  document.title = T().allCommandsTitle(c.title);
  const hash = window.location.hash;
  const stillHere = (): boolean => window.location.hash === hash;
  setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted mono" }, T().loading)));
  loadAccount()
    .then((account) => {
      if (!stillHere()) return;
      if (account === null) drawToolbox(root, c, { kind: "signed-out" });
      else if (isAdmin(account)) drawToolbox(root, c, { kind: "admin" });
      else
        withApprovedAccount(root, c.title, () => {
          const today = loadToday().catch(() => null);
          getProgress(c.id)
            .then(async (progress) => {
              const locked = lockedToday(progress, await today, c.id);
              if (stillHere()) drawToolbox(root, c, { kind: "player", progress, locked });
            })
            .catch((err: unknown) => {
              if (stillHere()) drawToolbox(root, c, { kind: "error", message: playErrorText(err) });
            });
        });
    })
    .catch(() => {
      if (stillHere()) drawToolbox(root, c, { kind: "signed-out" });
    });
}

function toolboxNote(c: Case, root: HTMLElement, state: PageState): HTMLElement | null {
  if (state.kind === "signed-out") {
    return h(
      "div",
      { class: "notice" },
      h("p", { class: "notice-title" }, TG().toolboxSignedOutTitle),
      h("p", { class: "muted" }, TG().toolboxSignedOutBody),
      h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => withApprovedAccount(root, c.title, () => renderToolbox(root, c)) }, TA().signInBtn),
    );
  }
  if (state.kind === "admin") return h("p", { class: "notice muted" }, TG().toolboxAdmin);
  if (state.kind === "error") return h("p", { class: "notice form-error", role: "alert" }, state.message);
  const p = state.progress;
  if (state.locked !== null) {
    const todayCase = state.locked.todayCaseId !== null ? caseSummary(state.locked.todayCaseId) : undefined;
    return h(
      "div",
      { class: "notice", role: "status" },
      h("p", { class: "notice-title" }, TA().lockedTitle(c.title)),
      h("p", { class: "muted" }, TA().lockedToolbox),
      todayCase ? h("a", { class: "btn btn-primary btn-sm", href: `#/case/${todayCase.id}` }, TA().lockedGoToday) : null,
    );
  }
  if (p.completedAt !== null) return h("p", { class: "notice notice-ok" }, TG().toolboxCompleted);
  if (p.setupDoneAt === null) return h("p", { class: "notice muted" }, TG().toolboxNotStarted);
  const stageNo = activeStageNumber(p);
  return stageNo !== null ? h("p", { class: "notice muted" }, TG().toolboxCostNote(SCORING.COMMAND_COST, stageNo)) : null;
}

function drawToolbox(root: HTMLElement, c: Case, state: PageState): void {
  const ctx: CommandContext = {
    caseId: c.id,
    progress: state.kind === "player" ? state.progress : null,
    locked: state.kind === "player" && state.locked !== null,
    onProgress: (next) => {
      const y = window.scrollY;
      drawToolbox(root, c, { kind: "player", progress: next, locked: null });
      window.scrollTo(0, y);
    },
  };
  setChildren(
    root,
    h(
      "section",
      { class: "stage-wrap" },
      h("a", { class: "back-link", href: `#/case/${c.id}` }, T().backToCase),
      h("h1", {}, T().allCommands),
      h("p", { class: "muted" }, T().allCommandsSub),
      toolboxNote(c, root, state),
      h(
        "nav",
        { class: "toc", "aria-label": T().sections },
        c.toolbox.map((sec, i) =>
          h(
            "a",
            {
              href: `#/case/${c.id}/toolbox`,
              "data-target": `tb-${i}`,
              onclick: (ev: Event) => {
                ev.preventDefault();
                document.getElementById(`tb-${i}`)?.scrollIntoView({ behavior: "smooth" });
              },
            },
            sec.category,
          ),
        ),
      ),
      c.toolbox.map((sec, i) =>
        h("section", { class: "block", id: `tb-${i}` }, h("h2", {}, sec.category), h("div", { class: "tool-list" }, sec.items.map((item) => commandCard(item, ctx)))),
      ),
    ),
  );
}
