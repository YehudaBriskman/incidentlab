// The frame never scrolls as a whole: the content area (main.app-content) is the page's scroller, and panels
// scroll inside it. Code that used window.scrollTo / window.scrollY goes through these helpers instead.

/** The content area's scroller (falls back to the document before the frame exists, and in the projector). */
export function contentScroller(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".app-content");
  if (el !== null && el.scrollHeight > 0 && getComputedStyle(el).overflowY !== "visible") return el;
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement;
}

export function contentScrollTop(): number {
  return contentScroller().scrollTop;
}

export function scrollContentTo(top: number): void {
  contentScroller().scrollTop = top;
}

/** The nearest ancestor of `el` that scrolls vertically (or the content scroller). */
export function scrollerOf(el: Element): HTMLElement {
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return contentScroller();
}
