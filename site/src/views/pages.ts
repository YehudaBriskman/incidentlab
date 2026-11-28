// The About and Privacy pages (#225): #/about and #/privacy. Static and bilingual: no API calls, so they cost
// nothing on the function budget. The copy lives in i18n/strings-pages.ts; the privacy statements there name the
// code they describe.
import "../pages.css";
import { h, type Child } from "../lib/dom";
import { likelySignedIn } from "../lib/session";
import { playNow } from "../lib/playNow";
import { TO } from "../i18n/strings-onboard";
import { T } from "../i18n/strings-player";
import { TS } from "../i18n/strings-shell";
import { TPg, privacySections } from "../i18n/strings-pages";
import type { ViewResult } from "../shell/types";

const pageTitle = (title: string): string => `${title} · IncidentLab`;

function section(id: string, title: string, body: Child): HTMLElement {
  return h("section", { class: "info-section", "aria-labelledby": id }, h("h2", { id }, title), body);
}

/** The one primary action: a visitor plays now (a guest, into the start-here case); a player browses the cases. */
function callToAction(): HTMLElement {
  if (likelySignedIn()) return h("a", { class: "btn btn-primary btn-lg", href: "#/cases" }, TPg().browseCases);
  const button = h("button", { type: "button", class: "btn btn-primary btn-lg" }, TO().playNow);
  let busy = false;
  button.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    button.setAttribute("aria-disabled", "true");
    void playNow().finally(() => {
      busy = false;
      button.removeAttribute("aria-disabled");
    });
  });
  return h("div", { class: "info-cta" }, button, h("p", { class: "info-trust" }, TO().ctaNote));
}

function footLinks(here: "about" | "privacy"): HTMLElement {
  return h(
    "p",
    { class: "info-links" },
    here === "about" ? h("a", { href: "#/privacy" }, TS().navPrivacy) : h("a", { href: "#/about" }, TS().navAbout),
    h("span", { "aria-hidden": "true" }, " · "),
    h("a", { href: "/accessibility.html" }, TS().a11yStatement),
  );
}

export function aboutView(): ViewResult {
  document.title = pageTitle(TPg().aboutTitle);
  const learn = [
    [TO().learn1Title, TO().learn1Body],
    [TO().learn2Title, TO().learn2Body],
    [TO().learn3Title, TO().learn3Body],
  ] as const;
  const steps = [
    [T().step1Title, T().step1Body],
    [T().step2Title, T().step2Body],
    [T().step3Title, T().step3Body],
  ] as const;
  const main = h(
    "article",
    { class: "view info-page" },
    h("h1", {}, TPg().aboutTitle),
    h("p", { class: "info-lead" }, TPg().aboutLead),
    callToAction(),
    section("about-learn", TO().learnTitle, h("ul", { class: "info-list" }, learn.map(([title, body]) => h("li", {}, h("strong", {}, title), " ", body)))),
    section("about-how", TPg().howTitle, h("ol", { class: "info-list" }, steps.map(([title, body]) => h("li", {}, h("strong", {}, title), " ", body)))),
    section("about-who", TPg().whoTitle, h("p", {}, TPg().whoBody)),
    section("about-cost", TPg().costTitle, [h("p", {}, TPg().costBody), h("p", {}, h("a", { href: "#/privacy" }, TPg().aboutMore))]),
    footLinks("about"),
  );
  return { main };
}

export function privacyView(): ViewResult {
  document.title = pageTitle(TPg().privacyTitle);
  const main = h(
    "article",
    { class: "view info-page" },
    h("h1", {}, TPg().privacyTitle),
    h("p", { class: "info-lead" }, TPg().privacyLead),
    privacySections().map((s, i) => section(`privacy-${i}`, s.title, h("ul", { class: "info-list" }, s.items.map((item) => h("li", {}, item))))),
    footLinks("privacy"),
  );
  return { main };
}
