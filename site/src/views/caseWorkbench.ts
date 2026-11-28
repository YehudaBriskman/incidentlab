// The active stage's workspace (#213): a question column beside a tabbed workbench.
//
// Above 1024px the question column (goal, prompt, look-for, answer form, meter, "Need help?") stays in view and
// the workbench beside it has three tabs: Commands, Evidence and Hints. At 1024px and below one segmented tab row
// switches Question, Commands and Evidence; the bought hints sit under the question there. One APG tabs widget
// serves both: the tabs that don't apply at a width are removed (hidden), and the question column is a tab panel
// only on narrow screens. The chosen pane is kept in the URL (`#/case/<id>?pane=commands`, replaceState, so the
// router doesn't redraw), and G then Q/C/E/H switches it unless "Shortcut keys" is off (WCAG 2.1.4).
import { h, type Child } from "../lib/dom";
import { loadSettings } from "../shell/settings";
import { TW } from "../i18n/strings-case";

export type Pane = "question" | "commands" | "evidence" | "hints";
const PANES: readonly Pane[] = ["question", "commands", "evidence", "hints"];
/** The panes each width offers, in tab order. */
const NARROW_PANES: readonly Pane[] = ["question", "commands", "evidence"];
const WIDE_PANES: readonly Pane[] = ["commands", "evidence", "hints"];
const PANE_KEYS: Record<Pane, string> = { question: "Q", commands: "C", evidence: "E", hints: "H" };

export const NARROW_QUERY = "(max-width: 1024px)";
export const isNarrow = (): boolean => window.matchMedia(NARROW_QUERY).matches;

/** The pane named in the URL, or null. */
export function readPane(): Pane | null {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const value = query.get("pane");
  return PANES.find((p) => p === value) ?? null;
}

/** Puts the pane in the URL without a history entry or a route change. */
export function writePane(pane: Pane): void {
  const [path, queryString] = window.location.hash.split("?");
  const query = new URLSearchParams(queryString ?? "");
  if (query.get("pane") === pane) return;
  query.set("pane", pane);
  history.replaceState(history.state, "", `${path ?? "#/"}?${query.toString()}`);
}

/** The pane actually shown at a width: a pane the width doesn't offer falls back to its neighbour there. */
export function effectivePane(pane: Pane | null, narrow: boolean): Pane {
  if (narrow) return pane === "commands" || pane === "evidence" ? pane : "question";
  return pane === "evidence" || pane === "hints" ? pane : "commands";
}

export type WorkbenchParts = {
  /** The question column (`.q-col`): a tab panel on narrow screens. */
  readonly question: HTMLElement;
  readonly commands: Child;
  readonly commandCount: number;
  readonly evidence: Child;
  readonly hints: Child;
  readonly hintsUsed: number;
  readonly hintsTotal: number;
  /** Registers teardown with the host's redraw (the width listener). */
  readonly onCleanup: (stop: () => void) => void;
};

export type Workbench = {
  readonly el: HTMLElement;
  /** Shows a pane (and puts it in the URL); `focusTab` moves focus to its tab. */
  readonly show: (pane: Pane, focusTab?: boolean) => void;
};

let seq = 0;
/** The workbench on screen, for the pane shortcuts. */
let current: Workbench | null = null;

export function workbench(parts: WorkbenchParts): Workbench {
  const uid = `wb${++seq}`;
  const tabId = (p: Pane): string => `${uid}-tab-${p}`;
  const panelId = (p: Pane): string => `${uid}-pane-${p}`;
  const shortcuts = loadSettings().keyShortcuts;

  const label = (p: Pane): Child[] => {
    const t = TW();
    if (p === "question") return [t.paneQuestion];
    if (p === "evidence") return [t.paneEvidence];
    if (p === "commands")
      return [t.paneCommands, " ", h("span", { class: "tab-badge", "aria-hidden": "true" }, String(parts.commandCount)), h("span", { class: "visually-hidden" }, t.commandsCount(parts.commandCount))];
    return [
      t.paneHints,
      " ",
      h("span", { class: "tab-badge", "aria-hidden": "true", dir: "ltr" }, `${parts.hintsUsed}/${parts.hintsTotal}`),
      h("span", { class: "visually-hidden" }, t.hintsCount(parts.hintsUsed, parts.hintsTotal)),
    ];
  };

  const tabs = new Map<Pane, HTMLButtonElement>();
  for (const p of PANES) {
    const tab = h("button", { type: "button", role: "tab", id: tabId(p), class: "wb-tab", "aria-controls": panelId(p), "data-pane": p }, label(p));
    tab.addEventListener("click", () => show(p));
    tabs.set(p, tab);
  }
  // The keys are described to screen readers on the tab row and shown as a quiet hint beside it (wide screens).
  const keysNote = shortcuts ? h("p", { id: `${uid}-keys`, class: "visually-hidden" }, TW().paneKeys) : null;
  const tablist = h(
    "div",
    { role: "tablist", class: "wb-tabs", "aria-label": TW().wbLabel, "aria-describedby": keysNote?.id ?? null },
    [...tabs.values()],
  );
  const keysHint = shortcuts ? h("span", { class: "wb-keys", "aria-hidden": "true" }, TW().paneKeysShort) : null;
  const tabRow = h("div", { class: "wb-tabrow" }, tablist, keysHint);
  tablist.addEventListener("keydown", (ev) => {
    const offered = visiblePanes();
    const at = offered.indexOf(selected);
    const rtl = getComputedStyle(tablist).direction === "rtl";
    const step = ev.key === "ArrowRight" ? (rtl ? -1 : 1) : ev.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
    let next: Pane | undefined;
    if (step !== 0) next = offered[(at + step + offered.length) % offered.length];
    else if (ev.key === "Home") next = offered[0];
    else if (ev.key === "End") next = offered[offered.length - 1];
    if (next === undefined) return;
    ev.preventDefault();
    show(next, true); // automatic activation: the panels are already rendered, so switching is instant
  });

  const question = parts.question;
  question.id = panelId("question");
  const panel = (p: Exclude<Pane, "question">, content: Child, focusable: boolean): HTMLElement =>
    h("section", { id: panelId(p), class: `wb-pane wb-pane-${p}`, tabindex: focusable ? "0" : null }, content);
  const commands = panel("commands", parts.commands, false);
  const evidence = panel("evidence", parts.evidence, false);
  const hints = panel("hints", parts.hints, true);
  const panels: Record<Pane, HTMLElement> = { question, commands, evidence, hints };

  const el = h("div", { class: "case-work" }, tabRow, keysNote, question, hints, commands, evidence);

  let narrow = isNarrow();
  let selected: Pane = effectivePane(readPane(), narrow);
  const visiblePanes = (): readonly Pane[] => (narrow ? NARROW_PANES : WIDE_PANES);

  /** Roles, order and visibility for the current width and pane. */
  const sync = (): void => {
    const offered = visiblePanes();
    el.dataset.mode = narrow ? "narrow" : "wide";
    el.dataset.pane = selected;
    // Reading order follows the layout: the tab row comes first on narrow screens, after the question column on wide.
    if (narrow && el.firstElementChild !== tabRow) el.prepend(tabRow);
    if (!narrow && question.nextElementSibling !== tabRow) question.after(tabRow);
    for (const p of PANES) {
      const tab = tabs.get(p);
      if (tab === undefined) continue;
      const on = offered.includes(p);
      tab.hidden = !on;
      tab.setAttribute("aria-selected", String(p === selected));
      tab.tabIndex = p === selected ? 0 : -1;
      const pane = panels[p];
      // The question column is a tab panel on narrow screens only; the hints are one on wide screens only.
      if (on) {
        pane.setAttribute("role", "tabpanel");
        pane.setAttribute("aria-labelledby", tabId(p));
      } else {
        pane.removeAttribute("role");
        pane.removeAttribute("aria-labelledby");
      }
    }
    // The hints panel has no controls, so it is a tab stop while it is a panel (APG); under the question it isn't.
    hints.tabIndex = narrow ? -1 : 0;
    // What shows: the selected panel; on wide the question column always, on narrow the hints with the question.
    question.hidden = narrow && selected !== "question";
    hints.hidden = narrow ? selected !== "question" : selected !== "hints";
    commands.hidden = selected !== "commands";
    evidence.hidden = selected !== "evidence";
  };

  const show = (p: Pane, focusTab = false): void => {
    selected = effectivePane(p, narrow);
    writePane(selected);
    sync();
    if (focusTab) tabs.get(selected)?.focus();
  };

  const media = window.matchMedia(NARROW_QUERY);
  const onWidth = (): void => {
    narrow = media.matches;
    selected = effectivePane(readPane() ?? selected, narrow);
    sync();
  };
  media.addEventListener("change", onWidth);
  parts.onCleanup(() => {
    media.removeEventListener("change", onWidth);
    if (current === handle) current = null;
  });

  sync();
  const handle: Workbench = { el, show };
  current = handle;
  bindPaneShortcuts();
  return handle;
}

/* ---------- G then Q/C/E/H (#213), off with the ⚙ "Shortcut keys" setting (WCAG 2.1.4) ---------- */

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

let bound = false;
let armedUntil = 0;

function bindPaneShortcuts(): void {
  if (bound) return;
  bound = true;
  document.addEventListener("keydown", (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.defaultPrevented || ev.repeat) return;
    const wb = current;
    if (wb === null || !wb.el.isConnected || !loadSettings().keyShortcuts || isTypingTarget(ev.target)) return;
    if (document.querySelector("dialog[open]") !== null) return;
    const key = ev.key.toLowerCase();
    if (Date.now() < armedUntil) {
      armedUntil = 0;
      const pane = PANES.find((p) => PANE_KEYS[p].toLowerCase() === key);
      if (pane === undefined) return;
      ev.preventDefault();
      // The pane a width doesn't offer lands on its neighbour (H on a phone shows the question with its hints).
      wb.show(pane, true);
      return;
    }
    if (key === "g") armedUntil = Date.now() + 1500;
  });
}
