import { featuredCase, teasers } from "../content/load";
import type { Case, Teaser } from "../content/schema";
import { h, setChildren } from "../lib/dom";
import { computeScore, loadProgress } from "../lib/progress";

const STEPS: ReadonlyArray<{ n: string; title: string; body: string }> = [
  { n: "01", title: "Download the evidence", body: "Logs, metrics, a Slack export and a real git repo, packed in one zip." },
  { n: "02", title: "Investigate with real tools", body: "grep, awk, jq, git log, a terminal and your instincts. No simulator." },
  { n: "03", title: "Submit flags", body: "Each question has one precise answer. Checked locally against a salted hash." },
  { n: "04", title: "Hints cost points", body: "Stuck? Reveal hints one at a time, each one costs a few points." },
  { n: "05", title: "Unseal the debrief", body: "The full RCA is encrypted with the six answers. Capture every flag to unlock it." },
];

function featuredCard(c: Case): HTMLElement {
  const p = loadProgressIfStarted(c);
  const href = `#/case/${c.id}`;
  return h(
    "article",
    { class: "featured-card", "aria-labelledby": "featured-title" },
    h(
      "div",
      { class: "featured-top" },
      h("span", { class: "pill pill-live" }, h("span", { class: "dot", "aria-hidden": "true" }), "INCIDENT ACTIVE"),
      h("span", { class: `pill pill-diff diff-${c.difficulty}` }, c.difficulty),
      h("span", { class: "pill pill-mono" }, `~${c.estMinutes} min`),
    ),
    h("h3", { id: "featured-title", class: "featured-title" }, c.title),
    h("p", { class: "featured-sub" }, c.subtitle),
    h("ul", { class: "tag-list", "aria-label": "Skills" }, c.tags.map((t) => h("li", { class: "tag" }, t))),
    h(
      "div",
      { class: "featured-meta mono" },
      h("span", {}, `${c.questions.length} flags`),
      h("span", {}, `${c.questions.reduce((s, q) => s + q.points, 0)} pts`),
      h("span", {}, `inspired by ${c.inspiredBy.title} (${c.inspiredBy.year})`),
    ),
    h(
      "div",
      { class: "featured-actions" },
      h("a", { class: "btn btn-primary btn-lg", href }, p ? "Resume investigation" : "Start investigation", h("span", { "aria-hidden": "true" }, " →")),
      p ? h("span", { class: "mono muted" }, `${p.solved}/${p.total} solved · ${p.points} pts`) : null,
    ),
  );
}

function loadProgressIfStarted(c: Case): ReturnType<typeof computeScore> | null {
  let started = false;
  try {
    started = window.localStorage.getItem(`incidentlab:progress:${c.id}`) !== null;
  } catch {
    started = false;
  }
  return started ? computeScore(c, loadProgress(c.id)) : null;
}

function teaserCard(t: Teaser): HTMLElement {
  return h(
    "article",
    { class: "teaser-card" },
    h("div", { class: "teaser-head" }, h("span", { class: "pill pill-mono" }, "COMING SOON"), h("span", { class: "redacted", "aria-hidden": "true" })),
    h("h3", { class: "teaser-title" }, t.title),
    h("p", { class: "teaser-tagline" }, t.tagline),
    h("ul", { class: "tag-list" }, t.skills.map((s) => h("li", { class: "tag tag-dim" }, s))),
    h("p", { class: "teaser-inspired mono" }, `inspired by: ${t.inspiredBy}`),
  );
}

export function renderHome(root: HTMLElement): void {
  document.title = "IncidentLab: real incidents, real evidence, your RCA";
  const featured = featuredCase();
  setChildren(
    root,
    h(
      "section",
      { class: "hero" },
      h("p", { class: "eyebrow mono" }, h("span", { class: "prompt-char" }, "$"), " incidentlab --mode=war-room"),
      h(
        "h1",
        { class: "hero-title" },
        h("span", { class: "brand" }, "IncidentLab"),
        h("span", { class: "hero-colon" }, ": "),
        h("span", { class: "hero-line" }, "real incidents, real evidence, ", h("em", {}, "your RCA")),
      ),
      h(
        "p",
        { class: "hero-sub" },
        "CTF-style puzzles rebuilt from real-world outages. You get the logs, the repo and the pager. Find the root cause before the postmortem does.",
      ),
    ),
    h(
      "section",
      { class: "section", "aria-labelledby": "featured-h" },
      h("h2", { id: "featured-h", class: "section-title" }, h("span", { class: "mono accent" }, "// "), "Featured case"),
      featured ? featuredCard(featured) : h("p", { class: "muted" }, "No case content found."),
    ),
    h(
      "section",
      { class: "section", "aria-labelledby": "how-h" },
      h("h2", { id: "how-h", class: "section-title" }, h("span", { class: "mono accent" }, "// "), "How it works"),
      h(
        "ol",
        { class: "steps" },
        STEPS.map((s) =>
          h("li", { class: "step" }, h("span", { class: "step-n mono" }, s.n), h("h3", { class: "step-title" }, s.title), h("p", {}, s.body)),
        ),
      ),
    ),
    teasers.length > 0
      ? h(
          "section",
          { class: "section", "aria-labelledby": "soon-h" },
          h("h2", { id: "soon-h", class: "section-title" }, h("span", { class: "mono accent" }, "// "), "Coming soon"),
          h("div", { class: "teaser-grid" }, teasers.map(teaserCard)),
        )
      : null,
  );
}
