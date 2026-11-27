// Command rows and the per-case Toolbox page.
// The free part of a command is its `syntax` (a template with <placeholders>). The runnable command is paid
// for (SCORING.COMMAND_COST on the active stage) and comes from `progress.unlocked.commands`, never from the
// bundled content: production builds strip `command` / `powershell` / `lab` from the case JSON.
// A command has up to three shells: Bash (always), PowerShell and Lab (the lab image, lab/README.md, #149), each
// shown only when the item has that variant. One switch per list picks the shell for every row (#214).
import { QUESTION_ORDER, SCORING, type ProgressView, type StageProgress } from "../../shared/contract";
import type { Case } from "../../shared/case";
import { getProgress, revealCommand } from "../lib/api";
import { recordVisit } from "../lib/recent";
import { announce, copyButton, ensureAnnouncer, h, html, setChildren, type Child } from "../lib/dom";
import { confirm, tooltip } from "../lib/overlay";
import "../player.css";
import { playErrorText, recoverFromWrite } from "../lib/errors";
import { handleAuthLoss, onAuthLoss } from "../lib/auth-loss";
import { followProgress, type ProgressFollower } from "../lib/progress-bus";
import { md } from "../lib/markdown";
import { isAdmin, loadAccount } from "../lib/session";
import { loadSettings } from "../shell/settings";
import { caseVersion } from "../content/load";
import { labRunCommand, labTemplate } from "../lib/labs";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { T } from "../i18n/strings-player";
import { TP } from "../i18n/strings-play";
import { TS } from "../i18n/strings-shell";
import type { ViewResult } from "../shell/types";
import { contentScrollTop, scrollContentTo } from "../shell/scroll";
import { createCaseNav } from "./caseNav";
import { withApprovedAccount } from "./auth";
import { TGu } from "../i18n/strings-guest";
import { playAsGuest } from "./guest";

type ToolItem = Case["toolbox"][number]["items"][number];
type Shell = "bash" | "powershell" | "lab";
const SHELLS: readonly Shell[] = ["bash", "powershell", "lab"];
const shellLabel = (k: Shell): string => (k === "bash" ? "Bash" : k === "powershell" ? "PowerShell" : TG().labTab);

/** What a command card needs to know about the player. `progress: null` = signed out (or the admin). */
export type CommandContext = {
  readonly caseId: string;
  readonly progress: ProgressView | null;
  /** `revealedTool`: the command just bought, so the page can keep the player at that card (#210). */
  readonly onProgress: (next: ProgressView, revealedTool?: string) => void;
};

function readShell(): Shell {
  try {
    const stored = window.localStorage.getItem("il.pref.shell");
    return SHELLS.find((k) => k === stored) ?? "bash";
  } catch {
    return "bash";
  }
}

/**
 * Everything that shows the shell choice (command rows and shell switches) registers here, so one switch
 * updates every row on the page in place. Entries whose element has left the page are dropped.
 */
const shellListeners = new Set<{ readonly el: HTMLElement; readonly sync: (shell: Shell) => void }>();

function onShell(el: HTMLElement, sync: (shell: Shell) => void): void {
  shellListeners.add({ el, sync });
}

function writeShell(shell: Shell): void {
  try {
    window.localStorage.setItem("il.pref.shell", shell);
  } catch {
    /* ignore */
  }
  for (const entry of [...shellListeners]) {
    if (entry.el.isConnected) entry.sync(shell);
    else shellListeners.delete(entry);
  }
}

/** 1-based number of the stage that is active right now (the one a reveal is charged to), or null. */
export function activeStageNumber(progress: ProgressView | null): number | null {
  if (progress === null || progress.setupDoneAt === null || progress.completedAt !== null) return null;
  const i = QUESTION_ORDER.findIndex((q) => progress.stages[q]?.status === "active");
  return i === -1 ? null : i + 1;
}

/** True while a stage still qualifies for the clean bonus: no hint, command or wrong answer yet. */
export function isCleanSoFar(s: StageProgress): boolean {
  return s.hintsRevealed === 0 && s.commandsRevealed === 0 && s.wrongAttempts === 0;
}

const PLACEHOLDER = /(<[\p{L}\p{N}_][\p{L}\p{N}_ .,:/|=+-]*>)/u;

/** The syntax template, with every <placeholder> wrapped in a highlighted span (text nodes only). */
function syntaxNodes(text: string): Child[] {
  return text
    .split(PLACEHOLDER)
    .filter((part) => part.length > 0)
    .map((part) => (PLACEHOLDER.test(part) && part.startsWith("<") ? h("span", { class: "ph" }, part) : part));
}

/** The shells a set of items offers (Bash always), counting variants the player has already unlocked. */
function offeredShells(items: readonly ToolItem[], progress: ProgressView | null): Shell[] {
  const unlocked = (it: ToolItem) => (it.id !== undefined ? progress?.unlocked.commands[it.id] : undefined);
  const hasPowershell = items.some((it) => it.syntaxPowershell !== undefined || (unlocked(it)?.powershell ?? null) !== null);
  const hasLab = items.some((it) => it.syntaxLab !== undefined || (unlocked(it)?.lab ?? null) !== null);
  return SHELLS.filter((k) => k === "bash" || (k === "powershell" && hasPowershell) || (k === "lab" && hasLab));
}

let switchSeq = 0;

/**
 * One compact Bash | PowerShell | Lab switch for a list of command rows (#214): native radios in a segmented
 * track, so arrow keys work. Null when the items offer Bash only. Every row on the page follows it.
 */
export function commandShellSwitch(items: readonly ToolItem[], progress: ProgressView | null): HTMLElement | null {
  const offered = offeredShells(items, progress);
  if (offered.length < 2) return null;
  const name = `cmd-shell-${++switchSeq}`;
  const current = readShell();
  const radios = offered.map((value) => {
    const input = h("input", { type: "radio", name, value, checked: current === value || (value === "bash" && !offered.includes(current)) });
    input.addEventListener("change", () => {
      if (input.checked) writeShell(value);
    });
    return { value, input, el: h("label", { class: "cmd-shell-opt" }, input, h("span", {}, shellLabel(value))) };
  });
  const el = h(
    "fieldset",
    { class: "cmd-shells" },
    h("legend", { class: "cmd-shells-legend" }, TS().tbShellLegend),
    h("div", { class: "cmd-shells-track" }, radios.map((r) => r.el)),
  );
  onShell(el, (shell) => {
    for (const r of radios) r.input.checked = r.value === shell;
  });
  return el;
}

/** Rows the player opened, per case and command, so a redraw (a reveal, another tab's progress) keeps them open. */
const openRows = new Set<string>();

let cardSeq = 0;

/**
 * One command as a disclosure row (#214). The summary is the title, the free syntax on one line and a cost or
 * "revealed" tag; opening it shows the full text in the chosen shell, the explanation, Reveal (paid) and Copy.
 * The runnable command exists on the page only once the server has returned it in `progress.unlocked`.
 */
export function commandCard(item: ToolItem, ctx: CommandContext): HTMLElement {
  const uid = `cmd-${++cardSeq}`;
  const progress = ctx.progress;
  const toolId = item.id;
  const full = toolId !== undefined ? progress?.unlocked.commands[toolId] : undefined;
  const paidOn = toolId !== undefined ? progress?.commandsRevealed[toolId] : undefined;
  const rowKey = `${ctx.caseId}:${toolId ?? item.title}`;

  const texts = new Map<Shell, string>([["bash", full?.command ?? item.syntax ?? ""]]);
  const psText = full ? full.powershell : (item.syntaxPowershell ?? null);
  const labText = full ? full.lab : (item.syntaxLab ?? null);
  if (psText !== null) texts.set("powershell", psText);
  if (labText !== null) texts.set("lab", labText);
  // The summary line is always the free template; the body shows the command once it is revealed.
  const freeTexts = new Map<Shell, string>([["bash", item.syntax ?? ""]]);
  if (item.syntaxPowershell !== undefined) freeTexts.set("powershell", item.syntaxPowershell);
  if (item.syntaxLab !== undefined) freeTexts.set("lab", item.syntaxLab);

  let shell: Shell = "bash";
  const line = h("bdi", { class: "cmd-line mono", dir: "ltr" });
  const code = h("code", {});
  const pre = h("pre", { class: full ? "code-block" : "code-block syntax-block", "aria-label": full ? null : TG().syntaxLabel }, code);
  const current = (): string => texts.get(shell) ?? texts.get("bash") ?? "";
  const labNote = labText !== null ? h("p", { class: "muted small lab-note", id: `${uid}-lab` }, TG().labNote) : null;
  const fallback = h("p", { class: "muted small cmd-shell-note" });
  const sync = (preferred: Shell): void => {
    shell = texts.has(preferred) ? preferred : "bash";
    if (full) code.textContent = current();
    else setChildren(code, syntaxNodes(current()));
    setChildren(line, syntaxNodes(freeTexts.get(shell) ?? freeTexts.get("bash") ?? ""));
    fallback.textContent = shell === preferred ? "" : TG().shellFallback(shellLabel(preferred));
    fallback.hidden = shell === preferred;
    if (labNote !== null) labNote.hidden = shell !== "lab";
    if (shell === "lab" && labNote !== null) pre.setAttribute("aria-describedby", labNote.id);
    else pre.removeAttribute("aria-describedby");
  };
  sync(readShell());

  const tag = full
    ? h(
        "span",
        { class: "chip chip-completed cmd-tag" },
        paidOn !== undefined ? TG().revealedTag(TG().stageShort(QUESTION_ORDER.indexOf(paidOn) + 1)) : TG().unlockedTag,
      )
    : toolId !== undefined
      ? h(
          "span",
          { class: "cmd-cost" },
          h("span", { "aria-hidden": "true", dir: "ltr" }, `−${SCORING.COMMAND_COST}`),
          h("span", { class: "visually-hidden" }, TG().costTagSr(SCORING.COMMAND_COST)),
        )
      : null;

  /* reveal action */
  const errorEl = h("p", { class: "form-error", role: "alert" });
  let action: Child = null;
  // Signed out / not started: the page notice says it once; rows don't repeat it.
  if (!full && toolId !== undefined && progress !== null && progress.setupDoneAt !== null) {
    const stageNo = activeStageNumber(progress);
    const activeId = stageNo !== null ? QUESTION_ORDER[stageNo - 1] : undefined;
    const active = activeId !== undefined ? progress.stages[activeId] : undefined;
    if (stageNo !== null && activeId !== undefined && active !== undefined) {
      // The confirm states the full cost; the row re-renders with the command once the server has charged it.
      const reveal = h("button", { type: "button", class: "btn btn-sm btn-reveal" }, TG().revealCommand(SCORING.COMMAND_COST));
      reveal.addEventListener("click", () => {
        errorEl.textContent = "";
        const charged: { progress: ProgressView | null } = { progress: null };
        confirm({
          title: TP().cmdTitle,
          body: TP().cmdPrompt(SCORING.COMMAND_COST, stageNo, SCORING.CLEAN_BONUS, isCleanSoFar(active)),
          confirmLabel: TP().cmdConfirm(SCORING.COMMAND_COST),
          run: async () => {
            // Charged only to the stage this page shows as active, or refused as stale (#203).
            charged.progress = await revealCommand(ctx.caseId, toolId, activeId);
          },
        })
          .then((ok) => {
            const next = charged.progress;
            if (!ok || next === null) return;
            // The redraw keeps this row open, and the page moves focus to its Copy button (#210).
            openRows.add(rowKey);
            ctx.onProgress(next, toolId);
            announce(TG().commandRevealedAnnounce(item.title));
          })
          .catch((err: unknown) => {
            if (handleAuthLoss(err)) return;
            const server = recoverFromWrite(err);
            if (server !== null) return ctx.onProgress(server);
            errorEl.textContent = playErrorText(err);
          });
      });
      action = reveal;
    }
  }

  const row = h(
    "details",
    { class: `cmd${full ? " is-revealed" : ""}`, "data-tool": toolId ?? null, open: openRows.has(rowKey) },
    h("summary", { class: "cmd-sum" }, h("span", { class: "cmd-title" }, item.title), line, tag),
    h(
      "div",
      { class: "cmd-body" },
      h("div", { class: "code-wrap" }, pre, full ? copyButton(current, T().copy) : null),
      fallback,
      labNote,
      html("div", { class: "prose small" }, md(item.explain)),
      action !== null ? h("div", { class: "cmd-actions" }, action, errorEl) : null,
    ),
  );
  row.addEventListener("toggle", () => {
    if (row.open) openRows.add(rowKey);
    else openRows.delete(rowKey);
  });
  onShell(row, sync);
  return row;
}

/** Focuses the Copy button of a command row just revealed, keeping it on screen without jumping (#210). */
export function focusRevealedCommand(scope: ParentNode, toolId: string): boolean {
  const target = scope.querySelector(`[data-tool="${CSS.escape(toolId)}"]`)?.querySelector<HTMLElement>(".btn-copy") ?? null;
  if (target === null) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest", behavior: "auto" });
  return true;
}

/* ================= Toolbox page ================= */

type PageState =
  | { kind: "signed-out" }
  | { kind: "admin" }
  | { kind: "player"; progress: ProgressView }
  | { kind: "error"; message: string };

/** The toolbox page's panel content (contents, shell switch, filter), set by toolboxView. */
let sideEl: HTMLElement | null = null;

/** The toolbox as a frame view: commands in main; contents, the Bash/PowerShell/Lab switch and the filter in the page panel. */
export function toolboxView(c: Case): ViewResult {
  const main = h("div", { class: "view" });
  const side = h("div", { class: "side-stack tb-side" });
  sideEl = side;
  const start = (): void => {
    recordVisit({ kind: "toolbox", caseId: c.id }); // the home page's "Continue" card
    renderToolbox(main, c);
  };
  return { main, nav: createCaseNav(c, "toolbox").section, aside: { label: TS().tbSide, trigger: TS().tbSideTrigger, content: side }, start };
}

/** Keeps the toolbox page's progress in step with the case in other tabs (#203), so its prices stay right. */
let follower: ProgressFollower | null = null;

export function renderToolbox(root: HTMLElement, c: Case): void {
  document.title = T().allCommandsTitle(c.title);
  onAuthLoss(() => renderToolbox(root, c)); // a 401 on a command reveal re-runs the gate
  const hash = window.location.hash;
  const stillHere = (): boolean => window.location.hash === hash;
  follower?.stop();
  follower = null;
  const follow = (progress: ProgressView): void => {
    follower = followProgress({
      initial: progress,
      load: () => getProgress(c.id),
      alive: () => root.isConnected && stillHere(),
      apply: (next) => {
        const y = contentScrollTop();
        drawToolbox(root, c, { kind: "player", progress: next });
        scrollContentTo(y);
      },
    });
  };
  setChildren(root, h("section", { class: "center-card" }, h("p", { class: "muted" }, T().loading)));
  loadAccount()
    .then((account) => {
      if (!stillHere()) return;
      if (account === null) drawToolbox(root, c, { kind: "signed-out" });
      else if (isAdmin(account)) drawToolbox(root, c, { kind: "admin" });
      else
        withApprovedAccount(root, c.title, () => {
          getProgress(c.id)
            .then((progress) => {
              if (!stillHere()) return;
              drawToolbox(root, c, { kind: "player", progress });
              follow(progress);
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
      h(
        "div",
        { class: "row-actions" },
        h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => withApprovedAccount(root, c.title, () => renderToolbox(root, c)) }, TA().signInBtn),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => void playAsGuest().then((ok) => ok && renderToolbox(root, c)) }, TGu().playAsGuest),
      ),
    );
  }
  if (state.kind === "admin") return h("p", { class: "notice muted" }, TG().toolboxAdmin);
  if (state.kind === "error") {
    // The progress load failed (offline, server error): say why and let the player try again in place.
    return h(
      "div",
      { class: "notice", role: "alert" },
      h("p", { class: "form-error" }, state.message),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => renderToolbox(root, c) }, TG().toolboxRetry),
    );
  }
  const p = state.progress;
  if (p.completedAt !== null) return h("p", { class: "notice notice-ok" }, TG().toolboxCompleted);
  if (p.setupDoneAt === null) return h("p", { class: "notice muted" }, TG().toolboxNotStarted);
  const stageNo = activeStageNumber(p);
  return stageNo !== null ? h("p", { class: "notice muted" }, TG().toolboxCostNote(SCORING.COMMAND_COST, stageNo)) : null;
}

/** The toolbox filter text per case, so a reveal (which redraws the page) keeps what the player typed. */
const filters = new Map<string, string>();
/** Cases whose toolbox shows only the active stage's commands ("This stage" chip, #214). */
const stageOnly = new Set<string>();

/** True when a key press goes to something the player types in, so a single-key shortcut must not fire. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

let slashBound = false;

/**
 * `/` focuses the toolbox filter (#214). It never fires while typing in a field, with a modifier or with a dialog
 * open, and the ⚙ "Shortcut keys" setting turns it off (WCAG 2.1.4).
 */
function bindSlashToFilter(): void {
  if (slashBound) return;
  slashBound = true;
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "/" || ev.ctrlKey || ev.metaKey || ev.altKey || ev.defaultPrevented) return;
    if (!loadSettings().keyShortcuts || isTypingTarget(ev.target)) return;
    if (document.querySelector("dialog[open]") !== null) return;
    const filter = document.querySelector<HTMLInputElement>(".tb-filter input[type=search]");
    if (filter === null || filter.getClientRects().length === 0) return; // not on the toolbox, or in a closed panel
    ev.preventDefault();
    filter.focus();
    filter.select();
  });
}

const prefersReducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function drawToolbox(root: HTMLElement, c: Case, state: PageState): void {
  ensureAnnouncer();
  const ctx: CommandContext = {
    caseId: c.id,
    progress: state.kind === "player" ? state.progress : null,
    onProgress: (next, revealedTool) => {
      const y = contentScrollTop();
      drawToolbox(root, c, { kind: "player", progress: next });
      scrollContentTo(y);
      if (revealedTool !== undefined) focusRevealedCommand(root, revealedTool);
    },
  };
  bindSlashToFilter();
  const activeNo = state.kind === "player" ? activeStageNumber(state.progress) : null;
  const activeQ = activeNo !== null ? QUESTION_ORDER[activeNo - 1] : undefined;
  const stageTools = activeQ !== undefined ? (c.questions.find((q) => q.id === activeQ)?.stage?.tools ?? []) : [];

  const total = c.toolbox.reduce((n, sec) => n + sec.items.length, 0);
  const sections = c.toolbox.map((sec, i) => {
    const heading = h("h2", { id: `tb-${i}-h`, tabindex: "-1" }, sec.category);
    const cards = sec.items.map((item) => {
      const card = commandCard(item, ctx);
      card.dataset.search = [item.title, item.syntax ?? "", item.syntaxPowershell ?? "", item.syntaxLab ?? "", item.explain, sec.category].join(" ").toLowerCase();
      if (item.id !== undefined && stageTools.includes(item.id)) card.dataset.stage = "true";
      return card;
    });
    const el = h("section", { class: "block tb-section", id: `tb-${i}`, "aria-labelledby": `tb-${i}-h` }, heading, h("div", { class: "tool-list" }, cards));
    return { el, heading, cards };
  });

  const tocLinks = c.toolbox.map((sec, i) =>
    h(
      "a",
      {
        href: `#/case/${c.id}/toolbox`,
        "data-target": `tb-${i}`,
        onclick: (ev: Event) => {
          ev.preventDefault();
          const target = sections[i];
          if (target === undefined) return;
          for (const link of tocLinks) link.removeAttribute("aria-current");
          tocLinks[i]?.setAttribute("aria-current", "location");
          target.el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
          target.heading.focus({ preventScroll: true });
        },
      },
      sec.category,
    ),
  );

  const filterId = `tb-filter-${c.id}`;
  const filter = h("input", {
    id: filterId,
    class: "input",
    type: "search",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    enterkeyhint: "search",
    dir: "auto",
    "aria-describedby": `${filterId}-hint ${filterId}-count`,
  });
  filter.value = filters.get(c.id) ?? "";
  const shortcuts = loadSettings().keyShortcuts;
  if (shortcuts) filter.setAttribute("aria-keyshortcuts", "/");
  tooltip(filter, () => (loadSettings().keyShortcuts ? `${TP().filterHint} ${TP().filterShortcut}` : TP().filterHint));
  const stageCount = sections.reduce((n, sec) => n + sec.cards.filter((card) => card.dataset.stage === "true").length, 0);
  const stageChip =
    stageCount > 0
      ? h("button", { type: "button", class: "tb-chip", "aria-pressed": String(stageOnly.has(c.id)) }, TP().stageChip(stageCount))
      : null;
  const count = h("p", { id: `${filterId}-count`, class: "muted small tb-count" });
  const none = h("p", { class: "muted tb-none", hidden: true }, TP().filterNone);
  let announceTimer: number | null = null;
  const applyFilter = (speak: boolean): void => {
    const words = filter.value.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    let shown = 0;
    sections.forEach((sec, i) => {
      let inSection = 0;
      for (const card of sec.cards) {
        const text = card.dataset.search ?? "";
        const match = words.every((w) => text.includes(w)) && (stageChip === null || !stageOnly.has(c.id) || card.dataset.stage === "true");
        card.hidden = !match;
        if (match) inSection += 1;
      }
      sec.el.hidden = inSection === 0;
      const link = tocLinks[i];
      // In the page panel each link sits in an <li>: hide the item, not only the link.
      if (link !== undefined) (link.parentElement instanceof HTMLLIElement ? link.parentElement : link).hidden = inSection === 0;
      shown += inSection;
    });
    count.textContent = TP().filterCount(shown, total);
    none.hidden = shown > 0;
    if (!speak) return;
    if (announceTimer !== null) window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => announce(shown > 0 ? TP().filterCount(shown, total) : TP().filterNone), 600);
  };
  filter.addEventListener("input", () => {
    filters.set(c.id, filter.value);
    applyFilter(true);
  });
  stageChip?.addEventListener("click", () => {
    const on = !stageOnly.has(c.id);
    if (on) stageOnly.add(c.id);
    else stageOnly.delete(c.id);
    stageChip.setAttribute("aria-pressed", String(on));
    applyFilter(true);
  });

  const filterBox = h(
    "div",
    { class: "tb-filter", role: "search" },
    h("label", { class: "answer-label", for: filterId }, TP().filterLabel),
    h("p", { id: `${filterId}-hint`, class: "visually-hidden" }, TP().filterHint, shortcuts ? ` ${TP().filterShortcut}` : null),
    filter,
    stageChip,
    count,
  );
  // Without the page panel (never on the toolbox route today) the controls stay above the commands.
  const side = sideEl !== null && sideEl.isConnected ? sideEl : null;
  const toc =
    side === null
      ? h("nav", { class: "toc tb-toc", "aria-label": TP().jumpTo }, tocLinks)
      : h("nav", { class: "side-group", "aria-labelledby": "tb-toc-h" }, h("h2", { class: "side-h", id: "tb-toc-h" }, TP().jumpTo), h("ul", { class: "side-links" }, tocLinks.map((a) => h("li", {}, a))));
  if (side !== null) {
    for (const a of tocLinks) a.classList.add("side-link");
    setChildren(side, shellSwitch(c, state), filterBox, toc);
  }
  applyFilter(false);

  setChildren(
    root,
    h(
      "section",
      { class: "stage-wrap toolbox-page" },
      h("a", { class: "back-link", href: `#/case/${c.id}` }, T().backToCase),
      h("h1", {}, T().allCommands),
      h("p", { class: "muted" }, T().allCommandsSub),
      toolboxNote(c, root, state),
      side === null ? [filterBox, toc] : null,
      none,
      sections.map((sec) => sec.el),
    ),
  );
}

/**
 * The page-wide switch: Bash, PowerShell or Lab, each offered when some item has it. It is the only shell
 * control on the page (#214) and updates every row in place; a row without the chosen variant shows Bash.
 */
function shellSwitch(c: Case, state: PageState): HTMLElement | null {
  const offered = offeredShells(
    c.toolbox.flatMap((sec) => sec.items),
    state.kind === "player" ? state.progress : null,
  );
  if (offered.length < 2) return null;
  const hasLab = offered.includes("lab");
  const radios = offered.map((value) => {
    const input = h("input", { type: "radio", name: "tb-shell", value, checked: readShell() === value });
    input.addEventListener("change", () => {
      if (input.checked) writeShell(value);
    });
    return { value, input, el: h("label", { class: "side-option" }, input, h("span", {}, shellLabel(value))) };
  });
  const el = h(
    "fieldset",
    { class: "side-group" },
    h("legend", { class: "side-h" }, TS().tbShellLegend),
    h("div", { class: "side-options" }, radios.map((r) => r.el)),
    hasLab ? h("p", { class: "muted small" }, TG().labNote) : null,
    hasLab ? labOpenBox(c) : null,
  );
  onShell(el, (shell) => {
    for (const r of radios) r.input.checked = r.value === shell;
  });
  return el;
}

/** How to open this case's lab (#146): the docker command, and the Codespaces template when the case has one. */
function labOpenBox(c: Case): HTMLElement {
  const command = labRunCommand(c.id, caseVersion(c.id) ?? 1);
  const template = labTemplate(c.id);
  return h(
    "div",
    { class: "lab-open" },
    h("p", { class: "side-h" }, TG().labOpenTitle),
    h("p", { class: "muted small" }, TG().labOpenDocker),
    h("div", { class: "lab-open-cmd" }, h("code", { class: "mono", dir: "ltr" }, command), copyButton(() => command)),
    template === null
      ? null
      : h(
          "p",
          { class: "muted small" },
          TG().labOpenCodespaces,
          " ",
          h("a", { href: template, target: "_blank", rel: "noopener noreferrer" }, TG().labOpenTemplate),
        ),
  );
}
