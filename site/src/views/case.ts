import { flags, sealedDebriefFor } from "../content/load";
import { normalizeAnswer } from "../content/schema";
import type { Case, Question } from "../content/schema";
import { confirmButton, copyButton, h, html, setChildren } from "../lib/dom";
import { checkAnswer } from "../lib/flags";
import { md, mdInline } from "../lib/markdown";
import {
  computeScore,
  elapsedMs,
  hintsUsedFor,
  loadProgress,
  potentialPoints,
  resetProgress,
  saveProgress,
  solvedAnswers,
  type Progress,
} from "../lib/progress";
import { unsealDebrief } from "../lib/seal";
import { formatElapsed, formatMinutes } from "../lib/time";

export const TABS = ["briefing", "evidence", "questions", "toolbox", "debrief"] as const;
export type Tab = (typeof TABS)[number];

export function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value);
}

const TAB_LABELS: Record<Tab, string> = {
  briefing: "Briefing",
  evidence: "Evidence",
  questions: "Questions",
  toolbox: "Toolbox",
  debrief: "Debrief",
};

let timerHandle: number | undefined;

export function stopCaseTimers(): void {
  if (timerHandle !== undefined) window.clearInterval(timerHandle);
  timerHandle = undefined;
}

export function shareText(c: Case, p: Progress): string {
  const s = computeScore(c, p);
  const hints = `${s.hintsUsed} hint${s.hintsUsed === 1 ? "" : "s"}`;
  const title = c.title.replace(/\s*\(DEV SAMPLE\)\s*$/, "");
  return `IncidentLab · ${title} · ${s.points}/${s.maxPoints} · ${hints} · ${formatMinutes(elapsedMs(p))}`;
}

export function renderCase(root: HTMLElement, c: Case, tab: Tab): void {
  stopCaseTimers();
  document.title = `${c.title} · IncidentLab`;
  let progress = loadProgress(c.id); // first visit starts the clock

  const persist = (): void => {
    const s = computeScore(c, progress);
    if (s.debriefUnlocked && progress.finishedAt === null) progress.finishedAt = Date.now();
    saveProgress(c.id, progress);
    updateScore();
    updateTabs();
  };

  /* ---------- score panel ---------- */
  const elPoints = h("span", { class: "stat-value" });
  const elHints = h("span", { class: "stat-value" });
  const elSolved = h("span", { class: "stat-value" });
  const elTimer = h("span", { class: "stat-value", "aria-live": "off" });
  const elBar = h("span", { class: "progress-fill" });
  const elShare = h("code", { class: "share-text" });

  const updateScore = (): void => {
    const s = computeScore(c, progress);
    elPoints.textContent = `${s.points}`;
    elPoints.dataset["max"] = `/${s.maxPoints}`;
    elHints.textContent = `${s.hintsUsed}`;
    elSolved.textContent = `${s.solved}/${s.total}`;
    elBar.style.width = `${(s.solved / Math.max(1, s.total)) * 100}%`;
    elShare.textContent = shareText(c, progress);
    tickTimer();
  };
  const tickTimer = (): void => {
    elTimer.textContent = formatElapsed(elapsedMs(progress));
  };

  const scorePanel = h(
    "aside",
    { class: "score-panel", "aria-label": "Score" },
    h("div", { class: "score-head mono" }, h("span", {}, "SCOREBOARD"), h("span", { class: "score-case" }, c.id)),
    h(
      "dl",
      { class: "stats" },
      h("div", { class: "stat stat-points" }, h("dt", {}, "Points"), h("dd", {}, elPoints)),
      h("div", { class: "stat" }, h("dt", {}, "Solved"), h("dd", {}, elSolved)),
      h("div", { class: "stat" }, h("dt", {}, "Hints used"), h("dd", {}, elHints)),
      h("div", { class: "stat" }, h("dt", {}, "Elapsed"), h("dd", {}, elTimer)),
    ),
    h("div", { class: "progress-track", "aria-hidden": "true" }, elBar),
    h(
      "div",
      { class: "share" },
      h("span", { class: "share-label mono" }, "Share my result"),
      elShare,
      copyButton(() => shareText(c, progress), "Copy result"),
    ),
    h(
      "div",
      { class: "score-actions" },
      confirmButton({
        label: "Reset progress",
        confirmLabel: "Yes, wipe it",
        className: "btn btn-ghost btn-sm",
        onConfirm: () => {
          progress = resetProgress(c.id);
          renderCase(root, c, tab);
        },
      }),
    ),
  );

  /* ---------- tabs ---------- */
  const tabLinks = new Map<Tab, HTMLAnchorElement>();
  const tabNav = h(
    "nav",
    { class: "tabs", "aria-label": "Case sections" },
    TABS.map((t) => {
      const a = h("a", { class: "tab", href: `#/case/${c.id}/${t}` }, TAB_LABELS[t]);
      if (t === tab) a.setAttribute("aria-current", "page");
      tabLinks.set(t, a);
      return a;
    }),
  );
  const updateTabs = (): void => {
    const s = computeScore(c, progress);
    const q = tabLinks.get("questions");
    if (q) q.dataset["badge"] = `${s.solved}/${s.total}`;
    const d = tabLinks.get("debrief");
    if (d) d.classList.toggle("is-locked", !s.debriefUnlocked);
  };

  /* ---------- panels ---------- */
  const panel = h("section", { class: "panel", id: "panel", tabindex: "-1" });
  switch (tab) {
    case "briefing":
      panel.append(renderBriefing(c));
      break;
    case "evidence":
      panel.append(renderEvidence(c));
      break;
    case "questions":
      panel.append(renderQuestions(c, () => progress, persist));
      break;
    case "toolbox":
      panel.append(renderToolbox(c));
      break;
    case "debrief":
      panel.append(renderDebrief(c, progress));
      break;
  }

  const firstOpen = computeScore(c, progress).solved === 0;
  root.replaceChildren(
    h(
      "div",
      { class: "pager", role: "status" },
      h("span", { class: "pager-icon mono", "aria-hidden": "true" }, "▲ PAGE"),
      h(
        "span",
        { class: "pager-text mono" },
        h("strong", {}, "SEV-1"),
        ` · ${c.title.toUpperCase()} · triggered `,
        h("span", { class: "pager-time" }, new Date(progress.startedAt).toISOString().slice(11, 19) + "Z"),
        " · assigned to ",
        h("strong", {}, "you"),
      ),
      h("span", { class: "pill pill-live" }, h("span", { class: "dot", "aria-hidden": "true" }), firstOpen ? "INCIDENT ACTIVE" : "INVESTIGATING"),
    ),
    h(
      "header",
      { class: "case-header" },
      h("a", { class: "back-link mono", href: "#/" }, "← all cases"),
      h("h1", { class: "case-title" }, c.title),
      h("p", { class: "case-sub" }, c.subtitle),
      h(
        "div",
        { class: "case-pills" },
        h("span", { class: `pill pill-diff diff-${c.difficulty}` }, c.difficulty),
        h("span", { class: "pill pill-mono" }, `~${c.estMinutes} min`),
        c.tags.map((t) => h("span", { class: "tag" }, t)),
      ),
    ),
    h("div", { class: "case-layout" }, h("div", { class: "case-main" }, tabNav, panel), scorePanel),
  );

  updateScore();
  updateTabs();
  timerHandle = window.setInterval(tickTimer, 1000);
}

/* ================= Briefing ================= */

function renderBriefing(c: Case): HTMLElement {
  return h(
    "div",
    { class: "briefing" },
    html("div", { class: "prose" }, md(c.briefing)),
    h(
      "div",
      { class: "inspired" },
      h("span", { class: "inspired-label mono" }, "INSPIRED BY"),
      h("h3", {}, `${c.inspiredBy.title} `, h("span", { class: "mono muted" }, `(${c.inspiredBy.year})`)),
      html("div", { class: "prose" }, md(c.inspiredBy.summary)),
    ),
    h(
      "div",
      { class: "rules" },
      h("h3", { class: "mono" }, "Rules of engagement"),
      h("ol", {}, c.rules.map((r) => html("li", {}, mdInline(r)))),
    ),
    h(
      "div",
      { class: "next-step" },
      h("a", { class: "btn btn-primary", href: `#/case/${c.id}/evidence` }, "Grab the evidence →"),
    ),
  );
}

/* ================= Evidence ================= */

function renderEvidence(c: Case): HTMLElement {
  const fileName = c.evidenceZip.split("/").pop() ?? "evidence.zip";
  return h(
    "div",
    { class: "evidence" },
    h(
      "div",
      { class: "download-box" },
      h(
        "div",
        {},
        h("p", { class: "mono accent download-label" }, "EVIDENCE PACK"),
        h("p", { class: "download-name mono" }, fileName),
        h("p", { class: "muted" }, `${c.evidence.length} artifacts. Unzip it anywhere and open a terminal in the folder.`),
      ),
      h("a", { class: "btn btn-primary btn-lg", href: c.evidenceZip, download: fileName }, "⇩ Download evidence"),
    ),
    h(
      "pre",
      { class: "code-block small" },
      h("code", {}, `unzip ${fileName} -d ${c.id}\ncd ${c.id} && ls -R | head -50`),
    ),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "evidence-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Path"), h("th", { scope: "col" }, "Format"), h("th", { scope: "col" }, "What it is"))),
        h(
          "tbody",
          {},
          c.evidence.map((e) =>
            h(
              "tr",
              {},
              h("td", { class: "mono path" }, e.path),
              h("td", {}, h("span", { class: "format" }, e.format)),
              html("td", {}, mdInline(e.description)),
            ),
          ),
        ),
      ),
    ),
  );
}

/* ================= Questions ================= */

function renderQuestions(c: Case, getProgress: () => Progress, persist: () => void): HTMLElement {
  const list = h("ol", { class: "question-list" });
  c.questions.forEach((q, i) => list.append(questionCard(q, i, getProgress, persist)));
  return h(
    "div",
    { class: "questions" },
    h(
      "p",
      { class: "suggested mono" },
      "All questions are unlocked. Suggested order: ",
      c.questions.map((q, i) => (i === 0 ? q.id : ` → ${q.id}`)),
      ". Wrong answers are free, hints are not.",
    ),
    list,
  );
}

function questionCard(q: Question, index: number, getProgress: () => Progress, persist: () => void): HTMLElement {
  const li = h("li", { class: "q-card", id: `q-${q.id}` });

  const render = (): void => {
    const p = getProgress();
    const solved = p.solved[q.id];
    const used = hintsUsedFor(p, q);
    const attempts = p.attempts[q.id] ?? 0;
    li.className = `q-card${solved ? " is-solved" : ""}`;

    const feedback = h("p", { class: "q-feedback", "aria-live": "polite", role: "status" });
    const input = h("input", {
      class: "q-input mono",
      type: "text",
      id: `in-${q.id}`,
      name: q.id,
      placeholder: q.placeholder,
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      "aria-describedby": `fmt-${q.id}`,
      required: true,
    });
    const submit = h("button", { class: "btn btn-primary", type: "submit" }, "Submit");
    const attemptsEl = h("p", { class: "q-attempts mono muted" }, attempts > 0 ? `Attempts: ${attempts}` : "");

    const form = h(
      "form",
      {
        class: "q-form",
        novalidate: true,
        onsubmit: (ev: Event) => {
          ev.preventDefault();
          const value = input.value;
          if (value.trim() === "") {
            feedback.textContent = "Enter an answer first.";
            input.focus();
            return;
          }
          submit.disabled = true;
          void checkAnswer(flags, q.id, value).then((ok) => {
            const cur = getProgress();
            if (ok) {
              cur.solved[q.id] = { at: Date.now(), points: potentialPoints(cur, q), answer: normalizeAnswer(value) };
              persist();
              render();
              const heading = li.querySelector<HTMLElement>(".q-title");
              heading?.focus();
            } else {
              cur.attempts[q.id] = (cur.attempts[q.id] ?? 0) + 1;
              persist();
              submit.disabled = false;
              feedback.textContent = `Not quite (attempt ${cur.attempts[q.id] ?? 0}). Check the answer format and try again.`;
              attemptsEl.textContent = `Attempts: ${cur.attempts[q.id] ?? 0}`;
              feedback.className = "q-feedback is-wrong";
              li.classList.remove("shake");
              void li.offsetWidth; // restart the animation
              li.classList.add("shake");
              input.select();
            }
          });
        },
      },
      h("label", { class: "visually-hidden", for: `in-${q.id}` }, `Answer for ${q.title}`),
      input,
      submit,
    );

    const hintsBox = h("div", { class: "hints" });
    q.hints.slice(0, used).forEach((hint, hi) =>
      hintsBox.append(
        h(
          "div",
          { class: "hint" },
          h("span", { class: "hint-label mono" }, `HINT ${hi + 1} · −${hint.cost}`),
          html("div", { class: "prose" }, md(hint.text)),
        ),
      ),
    );
    const nextHint = q.hints[used];
    if (!solved && nextHint) {
      hintsBox.append(
        confirmButton({
          label: `Reveal hint ${used + 1}/${q.hints.length} (−${nextHint.cost} pts)`,
          confirmLabel: `Spend ${nextHint.cost} pts`,
          className: "btn btn-hint",
          onConfirm: () => {
            const cur = getProgress();
            cur.hintsRevealed[q.id] = used + 1;
            persist();
            render();
            li.querySelector<HTMLElement>(".hint:last-of-type")?.focus();
          },
        }),
      );
    }
    hintsBox.querySelectorAll<HTMLElement>(".hint").forEach((el) => el.setAttribute("tabindex", "-1"));

    const potential = potentialPoints(p, q);
    setChildren(
      li,
      h(
        "div",
        { class: "q-head" },
        h("span", { class: "q-num mono", "aria-hidden": "true" }, String(index + 1).padStart(2, "0")),
        h("h3", { class: "q-title", tabindex: "-1" }, q.title),
        h(
          "span",
          { class: "q-points mono" },
          solved ? `+${solved.points} pts` : potential < q.points ? `${potential}/${q.points} pts` : `${q.points} pts`,
        ),
        solved ? h("span", { class: "pill pill-solved" }, "✓ SOLVED") : null,
      ),
      html("div", { class: "prose q-prompt" }, md(q.prompt)),
      h("p", { class: "q-format mono", id: `fmt-${q.id}` }, h("span", { class: "muted" }, "answer format: "), q.answerFormat),
      solved
        ? h("div", { class: "success-note" }, h("span", { class: "success-label mono" }, "WHY THIS MATTERS"), html("div", { class: "prose" }, md(q.successNote)))
        : h("div", { class: "q-answer" }, form, h("div", { class: "q-status" }, feedback, attemptsEl)),
      solved && used === 0 ? null : hintsBox.childElementCount > 0 ? hintsBox : null,
    );
  };

  render();
  return li;
}

/* ================= Toolbox ================= */

function renderToolbox(c: Case): HTMLElement {
  return h(
    "div",
    { class: "toolbox" },
    h(
      "div",
      { class: "setup-note" },
      h("span", { class: "setup-label mono" }, "SETUP"),
      h(
        "p",
        {},
        "Everything works on Linux, macOS or Windows via WSL. You need a POSIX shell with ",
        ["grep", "awk", "sort", "uniq", "jq", "git"].map((t, i) => [i > 0 ? ", " : "", h("code", {}, t)]),
        " and either ",
        h("code", {}, "python3"),
        " or ",
        h("code", {}, "node"),
        ". Run commands from the root of the unzipped evidence folder.",
      ),
      h(
        "p",
        { class: "muted small" },
        "macOS ships BSD versions of some tools; the commands below stick to flags both flavours support unless noted. Install jq with ",
        h("code", {}, "brew install jq"),
        " or ",
        h("code", {}, "apt install jq"),
        ".",
      ),
    ),
    c.toolbox.map((section) =>
      h(
        "section",
        { class: "tool-section" },
        h("h2", { class: "tool-category mono" }, h("span", { class: "accent" }, "## "), section.category),
        section.items.map((item) => {
          const code = h("code", {}, item.command);
          return h(
            "article",
            { class: "tool-item" },
            h("h3", { class: "tool-title" }, item.title),
            h(
              "div",
              { class: "code-wrap" },
              h("pre", { class: "code-block" }, h("span", { class: "code-prompt", "aria-hidden": "true" }, "$ "), code),
              copyButton(() => item.command),
            ),
            html("div", { class: "prose tool-explain" }, md(item.explain)),
          );
        }),
      ),
    ),
  );
}

/* ================= Debrief ================= */

function renderDebrief(c: Case, p: Progress): HTMLElement {
  const s = computeScore(c, p);
  if (!s.debriefUnlocked) {
    return h(
      "div",
      { class: "locked" },
      h("div", { class: "lock-icon mono", "aria-hidden": "true" }, "[ SEALED ]"),
      h("h2", {}, "Debrief sealed"),
      h(
        "p",
        {},
        `The debrief is encrypted with your answers, so there is no shortcut. You're at ${s.solved}/${s.total} flags.`,
      ),
      h("div", { class: "locked-actions" }, h("a", { class: "btn btn-primary", href: `#/case/${c.id}/questions` }, "Back to questions")),
      h(
        "p",
        { class: "give-up muted small" },
        `Stuck? Ask your instructor. The debrief unlocks when all ${s.total} flags are captured.`,
      ),
    );
  }

  const body = h("div", { class: "debrief-body", "aria-live": "polite", "aria-busy": "true" }, h("p", { class: "mono muted" }, "Decrypting debrief…"));
  const sealed = sealedDebriefFor(c.id);
  const fail = (detail: string): void => {
    body.setAttribute("aria-busy", "false");
    setChildren(
      body,
      h(
        "div",
        { class: "debrief-error" },
        h("p", { class: "mono" }, "Could not unseal the debrief."),
        h("p", { class: "muted small" }, detail),
      ),
    );
  };
  if (!sealed) {
    fail("No sealed debrief is bundled for this case. Tell the organizer.");
  } else {
    unsealDebrief(sealed, solvedAnswers(p)).then(
      (markdown) => {
        body.setAttribute("aria-busy", "false");
        setChildren(body, html("div", { class: "prose" }, md(markdown)));
      },
      (err: unknown) => {
        console.error("[debrief] unseal failed", err);
        fail(
          "Your saved answers don't match the sealed debrief (the case may have been updated since you solved it). Try Reset progress and re-submitting your answers, or ask your instructor.",
        );
      },
    );
  }

  return h(
    "div",
    { class: "debrief" },
    h(
      "div",
      { class: "debrief-banner is-complete" },
      h("span", { class: "mono" }, "INCIDENT RESOLVED"),
      h("strong", { class: "mono" }, `${s.points}/${s.maxPoints} pts · ${s.hintsUsed} hints · ${formatMinutes(elapsedMs(p))}`),
    ),
    body,
  );
}
