// "Needs help": the players stuck on a stage, with too many wrong answers on it, or idle, most urgent first.
// The first thing on the live panel; "Jump" takes the instructor to the player's row in the grid.
import { T } from "../../i18n/strings-tools";
import { getLang } from "../../i18n/i18n";
import { h, setChildren } from "../../lib/dom";
import type { AdminProgress } from "../../../shared/contract";
import { fmtInt, formatMinutes } from "./format";
import { HELP_PREVIEW, STUCK_WARN_MIN, WRONG_ALERT_MIN, WRONG_HELP_MIN, stageLongLabel, stuckLevel, type HelpEntry } from "./progressMetrics";

export type LiveHelpOptions = {
  /** Show the player's row in the grid (clearing filters that hide it). */
  onJump(accountId: string): void;
  /** Re-renders the live panel ("Show all" / "Show fewer"). */
  rerender(): void;
};

export type LiveHelp = {
  /** The panel element (kept across renders). */
  readonly el: HTMLElement;
  /** null while the case's progress is loading. */
  render(help: readonly HelpEntry[] | null, caseId: string): void;
  /** Forget the last render, so the next one redraws (the panel was put back on the page). */
  reset(): void;
};

export function createLiveHelp(opts: LiveHelpOptions): LiveHelp {
  const helpEl = h("section", { class: "help-panel", "aria-labelledby": "admin-help-title" });
  /** the list shows the most urgent HELP_PREVIEW players until "Show all" */
  let showAll = false;

  function stuckBadge(p: AdminProgress): HTMLElement | null {
    const level = stuckLevel(p);
    if (level === "none") return null;
    return h(
      "span",
      { class: `stuck-badge is-${level}`, title: T().admStuckTip(Math.floor(p.stuckMinutes)) },
      T().admStuckBadge(formatMinutes(p.stuckMinutes)),
    );
  }

  /** The reasons a player is on the "Needs help" list, as text chips (never colour alone). */
  function helpReasons(e: HelpEntry): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (e.stuck) out.push(stuckBadge(e.p) ?? h("span", {}));
    if (e.wrong >= WRONG_HELP_MIN) {
      out.push(h("span", { class: `help-chip is-${e.wrong >= WRONG_ALERT_MIN ? "alert" : "warn"}` }, T().admWrongChip(fmtInt(e.wrong))));
    }
    if (e.idleMin !== null) out.push(h("span", { class: "help-chip is-idle" }, T().admIdleChip(formatMinutes(e.idleMin))));
    return out;
  }

  let helpSig = "";
  function render(help: readonly HelpEntry[] | null, caseId: string): void {
    const sig = JSON.stringify([getLang(), caseId, showAll, help === null ? null : help.map((e) => [e.p.accountId, e.p.username, e.level, e.p.currentStage, Math.floor(e.p.stuckMinutes), e.wrong, e.idleMin === null ? null : Math.floor(e.idleMin)])]);
    if (sig === helpSig) return;
    helpSig = sig;
    if (help === null) {
      helpEl.className = "help-panel is-empty";
      setChildren(helpEl, h("h2", { class: "visually-hidden", id: "admin-help-title" }, T().admNeedsHelp), h("p", { class: "help-ok muted" }, T().admLoading));
      return;
    }
    if (help.length === 0) {
      // Nobody needs help: one quiet line, not an empty card.
      helpEl.className = "help-panel is-empty";
      setChildren(
        helpEl,
        h("h2", { class: "visually-hidden", id: "admin-help-title" }, T().admNeedsHelp),
        h(
          "p",
          { class: "help-ok" },
          h("span", { class: "help-ok-mark", "aria-hidden": "true" }, "✓"),
          h("strong", {}, T().admEveryoneMoving),
          h("span", { class: "muted small" }, T().admHelpThresholds(formatMinutes(STUCK_WARN_MIN), fmtInt(WRONG_HELP_MIN))),
        ),
      );
      return;
    }
    helpEl.className = "help-panel panel admin-panel";
    setChildren(
      helpEl,
      h(
        "div",
        { class: "help-head" },
        h("h2", { class: "admin-h2", id: "admin-help-title" }, T().admNeedsHelp, " ", h("span", { class: "count-badge is-warn" }, fmtInt(help.length))),
        h("span", { class: "muted small" }, T().admHelpThresholds(formatMinutes(STUCK_WARN_MIN), fmtInt(WRONG_HELP_MIN))),
      ),
      h(
        "ol",
        { class: "help-list", id: "admin-help-list" },
        (showAll ? help : help.slice(0, HELP_PREVIEW)).map((e) => {
          const p = e.p;
          const stage = stageLongLabel(caseId, p.currentStage);
          return h(
            "li",
            { class: `help-item is-${e.level}`, "data-help": p.accountId },
            h("span", { class: "help-name", dir: "auto", title: p.username }, p.username),
            h("span", { class: "help-stage", title: stage }, stage),
            h("span", { class: "help-reasons" }, helpReasons(e)),
            h(
              "button",
              { type: "button", class: "btn btn-ghost btn-sm help-jump", "aria-label": T().admJumpLabel(p.username), onclick: () => opts.onJump(p.accountId) },
              T().admJump,
            ),
          );
        }),
      ),
      help.length > HELP_PREVIEW
        ? h(
            "button",
            {
              type: "button",
              class: "btn btn-ghost btn-sm help-more",
              "aria-expanded": String(showAll),
              "aria-controls": "admin-help-list",
              onclick: () => {
                showAll = !showAll;
                opts.rerender();
                helpEl.querySelector<HTMLButtonElement>(".help-more")?.focus();
              },
            },
            showAll ? T().admHelpFewer : T().admHelpAll(fmtInt(help.length)),
          )
        : null,
    );
  }

  return {
    el: helpEl,
    render,
    reset: () => {
      helpSig = "";
    },
  };
}
