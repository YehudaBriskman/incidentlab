// The instructor's view of a case. Two parts:
//  - the case preview (#/case/<id> as admin): story, evidence and stage goals, with links to present the case,
//    its live board and the Explorer;
//  - presentation mode (#/case/<id>/present): the same public content as large slides for a projector, moved
//    through with buttons or the arrow keys, with links to the live board and back to the preview.
// Only public content is shown (what any player sees before stage 1): no answers, hints or debrief.
import "../player.css";
import type { Case } from "../../shared/case";
import { h, html, setChildren } from "../lib/dom";
import { md, mdInline } from "../lib/markdown";
import { tooltip } from "../lib/overlay";
import { isAdmin, loadAccount } from "../lib/session";
import { TO } from "../i18n/strings-onboard";
import { TR } from "../i18n/strings-present";
import type { ViewResult } from "../shell/types";
import { createCaseNav } from "./caseNav";

const caseHref = (c: Case): string => `#/case/${encodeURIComponent(c.id)}`;
const presentHref = (c: Case): string => `${caseHref(c)}/present`;
const boardHref = (c: Case): string => `#/leaderboard?case=${encodeURIComponent(c.id)}&projector=1`;

function liveBoardLink(c: Case, cls: string): HTMLAnchorElement {
  const link = h("a", { class: cls, href: boardHref(c) }, TR().liveBoard);
  tooltip(link, TR().liveBoardTip);
  return link;
}

function metaLine(c: Case): HTMLElement {
  return h("p", { class: "page-meta" }, [TO().difficulty(c.difficulty), TO().minutes(c.estMinutes), TR().stagesCount(c.questions.length)].join(" · "));
}

function stageList(c: Case, cls: string): HTMLElement {
  return h(
    "ol",
    { class: cls },
    c.questions.map((q, i) =>
      h(
        "li",
        { class: "present-stage" },
        h("p", { class: "present-stage-n" }, TR().stageN(i + 1)),
        h("p", { class: "present-stage-name", dir: "auto" }, q.stage?.name ?? q.title),
        q.stage?.goal ? html("p", { class: "present-stage-goal" }, mdInline(q.stage.goal)) : null,
      ),
    ),
  );
}

function evidenceList(files: Case["evidence"], cls: string): HTMLElement {
  // One grid for every row (rows are display: contents), so the path and description columns line up.
  return h(
    "ul",
    { class: cls },
    files.map((f) => h("li", { class: "present-file" }, h("code", { class: "present-file-path", dir: "ltr" }, f.path), html("span", { class: "present-file-desc" }, mdInline(f.description)))),
  );
}

function section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  return h("section", { class: "present-card" }, h("h2", {}, title), ...children);
}

/** The instructor's case preview: drawn into the case page in place of the "sign in as a player" card. */
export function renderInstructorPreview(root: HTMLElement, c: Case): void {
  document.title = `${c.title} · IncidentLab`;
  setChildren(
    root,
    h(
      "div",
      { class: "present-preview" },
      h(
        "header",
        { class: "present-head" },
        h(
          "div",
          { class: "present-head-title" },
          h("p", { class: "eyebrow" }, TR().eyebrow),
          h("h1", { dir: "auto" }, c.title),
          h("p", { class: "present-subtitle", dir: "auto" }, c.subtitle),
          metaLine(c),
        ),
        h(
          "div",
          { class: "present-actions" },
          h("a", { class: "btn btn-primary", href: presentHref(c) }, TR().present),
          liveBoardLink(c, "btn"),
          h("a", { class: "btn btn-ghost", href: `${caseHref(c)}/explorer` }, TR().openExplorer),
        ),
      ),
      h("p", { class: "muted small" }, TR().previewNote),
      section(TR().story, html("div", { class: "prose present-prose" }, md(c.briefing))),
      section(
        TR().inspired,
        h("p", { class: "present-inspired-title", dir: "auto" }, `${c.inspiredBy.title} (${c.inspiredBy.year})`),
        html("p", { class: "present-prose" }, mdInline(c.inspiredBy.summary)),
      ),
      section(`${TR().evidence} · ${TR().evidenceCount(c.evidence.length)}`, evidenceList(c.evidence, "present-files")),
      section(TR().stages, stageList(c, "present-stages")),
    ),
  );
}

type Slide = { title: string; body: HTMLElement | null; kicker?: string };

function slidesFor(c: Case): Slide[] {
  return [
    { title: c.title, kicker: TR().eyebrow, body: h("div", {}, h("p", { class: "slide-lead" }, c.subtitle), metaLine(c)) },
    { title: TR().story, body: html("div", { class: "prose slide-prose" }, md(c.briefing)) },
    { title: TR().inspired, body: h("div", {}, h("p", { class: "slide-lead" }, `${c.inspiredBy.title} (${c.inspiredBy.year})`), html("p", { class: "slide-prose" }, mdInline(c.inspiredBy.summary))) },
    { title: TR().evidence, kicker: TR().evidenceCount(c.evidence.length), body: evidenceList(c.evidence, "present-files slide-files") },
    ...c.questions.map((q, i): Slide => ({
      kicker: TR().stageN(i + 1),
      title: q.stage?.name ?? q.title,
      body: q.stage?.goal ? html("p", { class: "slide-lead" }, mdInline(q.stage.goal)) : null,
    })),
    { title: TR().goSlideTitle, body: h("div", {}, h("p", { class: "slide-lead" }, TR().goSlideBody), metaLine(c)) },
  ];
}

/** Keys that move a scroll region one step: a few lines, or most of a page. */
const SCROLL_STEP = { line: 64, pageShare: 0.85 } as const;

/**
 * Presentation mode: one slide at a time, sized for a projector. The slide title and the deck's controls stay
 * on screen; a long slide body scrolls inside itself. Instructor only; others go to the case.
 * Keys: ←/→ slides (mirrored in Hebrew), Home/End first/last, ↑/↓ and PageUp/PageDown scroll the body, Esc
 * back to the preview. Modified keys (Alt+← = browser Back) and keys typed into fields are left alone.
 */
export function presentView(c: Case): ViewResult {
  const main = h("div", { class: "view" });
  const nav = createCaseNav(c, "present");
  let onKey: ((ev: KeyboardEvent) => void) | null = null;
  const start = (): void => {
    document.title = `${TR().slides} · ${c.title} · IncidentLab`;
    void loadAccount().then((account) => {
      if (!isAdmin(account)) {
        window.location.hash = caseHref(c);
        return;
      }
      const slides = slidesFor(c);
      let at = 0;
      const head = h("div", { class: "slide-head" });
      // focusable, so keyboard and screen-reader users can scroll it too; named by the slide title
      const body = h("div", { class: "slide-body", tabindex: "0", role: "region", "aria-labelledby": "slide-title" });
      const stage = h("section", { class: "slide", "aria-live": "polite" }, head, body);
      const pos = h("p", { class: "slide-pos" });
      const prev = h("button", { type: "button", class: "btn" }, TR().prev);
      const next = h("button", { type: "button", class: "btn btn-primary" }, TR().next);
      const syncMore = (): void => {
        const more = body.scrollHeight - body.clientHeight - body.scrollTop > 1;
        const scrolls = body.scrollHeight - body.clientHeight > 1;
        body.classList.toggle("has-more", more);
        body.classList.toggle("is-scrolled", body.scrollTop > 1);
        body.tabIndex = scrolls ? 0 : -1;
      };
      body.addEventListener("scroll", syncMore, { passive: true });
      new ResizeObserver(syncMore).observe(body);
      const draw = (): void => {
        const s = slides[at];
        if (s === undefined) return;
        setChildren(head, s.kicker ? h("p", { class: "slide-kicker" }, s.kicker) : null, h("h1", { class: "slide-title", id: "slide-title" }, s.title));
        setChildren(body, s.body);
        body.scrollTop = 0;
        syncMore();
        pos.textContent = TR().slideOf(at + 1, slides.length);
        prev.disabled = at === 0;
        next.disabled = at === slides.length - 1;
      };
      const go = (to: number): void => {
        const target = Math.max(0, Math.min(slides.length - 1, to));
        if (target === at) return;
        at = target;
        draw();
      };
      const scrollBody = (delta: number): void => body.scrollBy({ top: delta, behavior: "auto" });
      prev.addEventListener("click", () => go(at - 1));
      next.addEventListener("click", () => go(at + 1));
      onKey = (ev: KeyboardEvent): void => {
        if (!main.isConnected) {
          if (onKey) document.removeEventListener("keydown", onKey);
          return;
        }
        if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.defaultPrevented) return;
        const t = ev.target;
        if (t instanceof HTMLElement && t.closest("input, textarea, select, [contenteditable]")) return;
        const rtl = document.documentElement.dir === "rtl";
        const fwd = rtl ? "ArrowLeft" : "ArrowRight";
        const back = rtl ? "ArrowRight" : "ArrowLeft";
        if (ev.key === fwd) go(at + 1);
        else if (ev.key === back) go(at - 1);
        else if (ev.key === "Home") go(0);
        else if (ev.key === "End") go(slides.length - 1);
        else if (ev.key === "ArrowDown") scrollBody(SCROLL_STEP.line);
        else if (ev.key === "ArrowUp") scrollBody(-SCROLL_STEP.line);
        else if (ev.key === "PageDown") scrollBody(body.clientHeight * SCROLL_STEP.pageShare);
        else if (ev.key === "PageUp") scrollBody(-body.clientHeight * SCROLL_STEP.pageShare);
        else if (ev.key === "Escape") window.location.hash = caseHref(c);
        else return;
        ev.preventDefault();
      };
      document.addEventListener("keydown", onKey);
      setChildren(
        main,
        h(
          "div",
          { class: "present-deck" },
          h(
            "header",
            { class: "present-deck-bar" },
            h("a", { class: "btn btn-ghost", href: caseHref(c) }, TR().backToPreview),
            liveBoardLink(c, "btn"),
          ),
          stage,
          h("footer", { class: "present-deck-foot" }, prev, h("div", { class: "slide-pos-wrap" }, pos, h("p", { class: "muted small" }, TR().keysHint)), next),
        ),
      );
      draw();
    });
  };
  return { main, nav: nav.section, start, layout: "fit" };
}
