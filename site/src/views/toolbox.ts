import type { Case } from "../content/schema";
import { copyButton, h, html, setChildren } from "../lib/dom";
import { md } from "../lib/markdown";

type ToolItem = Case["toolbox"][number]["items"][number];
type Shell = "bash" | "powershell";

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

let cardSeq = 0;

/** A command with optional Bash | PowerShell tabs and a copy button. */
export function commandCard(item: ToolItem): HTMLElement {
  const uid = `cmd-${++cardSeq}`;
  const ps = item.powershell;
  let shell: Shell = ps !== undefined ? readShell() : "bash";
  const code = h("code", {});
  const pre = h("pre", { class: "code-block", id: `${uid}-panel`, role: ps !== undefined ? "tabpanel" : null });
  pre.append(code);
  const current = (): string => (shell === "powershell" && ps !== undefined ? ps : item.command);
  const tabs = new Map<Shell, HTMLButtonElement>();
  const sync = (): void => {
    code.textContent = current();
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
    tabs.set(k, btn);
    return btn;
  };
  const tabBar = ps !== undefined ? h("div", { class: "shell-tabs", role: "tablist", "aria-label": "Shell" }, tab("bash", "Bash"), tab("powershell", "PowerShell")) : null;
  sync();
  return h(
    "div",
    { class: "cmd" },
    h("div", { class: "cmd-head" }, h("h4", {}, item.title), tabBar),
    h("div", { class: "code-wrap" }, pre, copyButton(current, "Copy")),
    html("div", { class: "prose small" }, md(item.explain)),
  );
}

export function renderToolbox(root: HTMLElement, c: Case): void {
  document.title = `All commands · ${c.title} · IncidentLab`;
  setChildren(
    root,
    h(
      "section",
      { class: "stage-wrap" },
      h("a", { class: "back-link", href: `#/case/${c.id}` }, "← Back to the case"),
      h("h1", {}, "All commands"),
      h("p", { class: "muted" }, "Every command for this case. Each stage already shows the ones it needs."),
      h("nav", { class: "toc", "aria-label": "Sections" }, c.toolbox.map((sec, i) => h("a", { href: `#/case/${c.id}/toolbox`, "data-target": `tb-${i}`, onclick: (ev: Event) => { ev.preventDefault(); document.getElementById(`tb-${i}`)?.scrollIntoView({ behavior: "smooth" }); } }, sec.category))),
      c.toolbox.map((sec, i) =>
        h("section", { class: "block", id: `tb-${i}` }, h("h2", {}, sec.category), h("div", { class: "tool-list" }, sec.items.map(commandCard))),
      ),
    ),
  );
}
