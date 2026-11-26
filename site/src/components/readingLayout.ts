// Reading layout (DESIGN.md "Reading layout"): long markdown (a debrief, a briefing) at a readable measure,
// with an "On this page" table of contents built from its h2/h3 headings once there are enough of them.
// Content that arrives later (the debrief is fetched) calls refresh() to rebuild the contents.
import { h, setChildren } from "../lib/dom";
import { headingSlug } from "./slug";

export const TOC_MIN_HEADINGS = 3;

export type ReadingLayout = { readonly element: HTMLElement; refresh(): void };

export function readingLayout(opts: { content: HTMLElement; tocLabel: string; idPrefix: string }): ReadingLayout {
  const list = h("ol", { class: "toc-list" });
  const toc = h("details", { class: "toc", hidden: true }, h("summary", { class: "toc-summary" }, opts.tocLabel), h("nav", { "aria-label": opts.tocLabel }, list));
  const element = h("div", { class: "reading" }, toc, opts.content);

  const refresh = (): void => {
    const headings = [...opts.content.querySelectorAll<HTMLHeadingElement>("h2, h3")];
    if (headings.length < TOC_MIN_HEADINGS) {
      toc.hidden = true;
      setChildren(list);
      return;
    }
    const taken = new Set<string>();
    setChildren(
      list,
      headings.map((heading) => {
        if (!heading.id) heading.id = `${opts.idPrefix}-${headingSlug(heading.textContent ?? "", taken)}`;
        heading.tabIndex = -1; // focus follows the jump, so screen readers continue reading from there
        const link = h("a", { href: `#${heading.id}`, dir: "auto" }, heading.textContent ?? "");
        // Hash routing owns location.hash: scroll and focus by hand instead of navigating.
        link.addEventListener("click", (ev) => {
          ev.preventDefault();
          heading.scrollIntoView({ block: "start" });
          heading.focus({ preventScroll: true });
        });
        return h("li", { class: heading.tagName === "H3" ? "toc-sub" : undefined }, link);
      }),
    );
    toc.hidden = false;
  };
  refresh();
  return { element, refresh };
}
