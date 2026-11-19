import { featuredCase, teasers } from "../content/load";
import type { Case, Teaser } from "../content/schema";
import { getToken } from "../lib/api";
import { h, setChildren } from "../lib/dom";
import { T } from "../i18n/strings-player";

const steps = (): ReadonlyArray<{ title: string; body: string }> => [
  { title: T().step1Title, body: T().step1Body },
  { title: T().step2Title, body: T().step2Body },
  { title: T().step3Title, body: T().step3Body },
];

function featuredCard(c: Case): HTMLElement {
  const started = getToken() !== null;
  return h(
    "article",
    { class: "featured-card", "aria-labelledby": "featured-title" },
    h("p", { class: "featured-meta mono" }, T().featuredMeta(c.difficulty, c.estMinutes, c.questions.length)),
    h("h3", { id: "featured-title", class: "featured-title" }, c.title),
    h("p", { class: "featured-sub" }, c.subtitle),
    h("a", { class: "btn btn-primary btn-lg", href: `#/case/${c.id}` }, started ? T().resumeInvestigation : T().startInvestigation),
  );
}

function teaserCard(t: Teaser): HTMLElement {
  return h("article", { class: "teaser-card" }, h("h3", { class: "teaser-title" }, t.title), h("p", { class: "muted" }, t.tagline));
}

export function renderHome(root: HTMLElement): void {
  document.title = T().homeTitle;
  const featured = featuredCase();
  setChildren(
    root,
    h(
      "section",
      { class: "hero" },
      h("h1", { class: "hero-title" }, T().heroA, h("span", { class: "accent" }, T().heroB)),
      h("p", { class: "hero-sub" }, T().heroSub),
    ),
    h("section", { class: "section", "aria-label": T().featuredCase }, featured ? featuredCard(featured) : h("p", { class: "muted" }, T().noCases)),
    h(
      "section",
      { class: "section", "aria-labelledby": "how-h" },
      h("h2", { id: "how-h", class: "section-title" }, T().howItWorks),
      h("ol", { class: "how" }, steps().map((s, i) => h("li", {}, h("span", { class: "how-n mono" }, String(i + 1)), h("div", {}, h("h3", {}, s.title), h("p", { class: "muted" }, s.body))))),
    ),
    teasers.length > 0
      ? h(
          "section",
          { class: "section", "aria-labelledby": "soon-h" },
          h("h2", { id: "soon-h", class: "section-title" }, T().comingSoon),
          h("div", { class: "teaser-grid" }, teasers.map(teaserCard)),
        )
      : null,
  );
}
