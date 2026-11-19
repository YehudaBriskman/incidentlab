import { featuredCase, teasers } from "../content/load";
import type { Case, Teaser } from "../content/schema";
import { getToken } from "../lib/api";
import { h, setChildren } from "../lib/dom";

const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  { title: "Get the evidence", body: "Logs, metrics, chat and a git repo in one zip." },
  { title: "Work stage by stage", body: "Six short questions, each with the commands you need." },
  { title: "Read the debrief", body: "See the full root cause and your score." },
];

function featuredCard(c: Case): HTMLElement {
  const started = getToken() !== null;
  return h(
    "article",
    { class: "featured-card", "aria-labelledby": "featured-title" },
    h("p", { class: "featured-meta mono" }, `${c.difficulty} · ~${c.estMinutes} min · ${c.questions.length} stages`),
    h("h3", { id: "featured-title", class: "featured-title" }, c.title),
    h("p", { class: "featured-sub" }, c.subtitle),
    h("a", { class: "btn btn-primary btn-lg", href: `#/case/${c.id}` }, started ? "Resume investigation →" : "Start investigation →"),
  );
}

function teaserCard(t: Teaser): HTMLElement {
  return h("article", { class: "teaser-card" }, h("h3", { class: "teaser-title" }, t.title), h("p", { class: "muted" }, t.tagline));
}

export function renderHome(root: HTMLElement): void {
  document.title = "IncidentLab: real incidents, real evidence, your RCA";
  const featured = featuredCase();
  setChildren(
    root,
    h(
      "section",
      { class: "hero" },
      h("h1", { class: "hero-title" }, "Real incidents. Real evidence. ", h("span", { class: "accent" }, "Your RCA.")),
      h("p", { class: "hero-sub" }, "Puzzles rebuilt from real outages. Dig through the evidence and find the root cause."),
    ),
    h("section", { class: "section", "aria-label": "Featured case" }, featured ? featuredCard(featured) : h("p", { class: "muted" }, "No case content found.")),
    h(
      "section",
      { class: "section", "aria-labelledby": "how-h" },
      h("h2", { id: "how-h", class: "section-title" }, "How it works"),
      h("ol", { class: "how" }, STEPS.map((s, i) => h("li", {}, h("span", { class: "how-n mono" }, String(i + 1)), h("div", {}, h("h3", {}, s.title), h("p", { class: "muted" }, s.body))))),
    ),
    teasers.length > 0
      ? h(
          "section",
          { class: "section", "aria-labelledby": "soon-h" },
          h("h2", { id: "soon-h", class: "section-title" }, "Coming soon"),
          h("div", { class: "teaser-grid" }, teasers.map(teaserCard)),
        )
      : null,
  );
}
