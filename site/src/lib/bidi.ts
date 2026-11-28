// Hebrew UI: direction for case content, names and mixed strings (#248). The pure splitting lives in bidi-core.ts.
import { h } from "./dom";
import { getLang } from "../i18n/i18n";
import { HEBREW, dateTimeZoneParts, listParts, ltrRuns, nameParts } from "./bidi-core";

export { HEBREW } from "./bidi-core";

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd, dt";
/** Lists and tables: their items and cells share one direction. */
const GROUPS = "ul, ol, table";
const BLOCK_TAGS = new Set(["P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "BLOCKQUOTE", "DL", "DD", "DT", "PRE", "DIV", "HR", "DETAILS", "SECTION"]);
/** Elements whose text already has its own direction: code is LTR (styles.css), bdi and [dir] isolate themselves. */
const OWN_DIRECTION = "code, pre, kbd, samp, bdi, [dir], .ltr, .mono";

const isBlock = (n: Node): boolean => n instanceof Element && BLOCK_TAGS.has(n.tagName);

/** Wraps each LTR run of `node`'s text in <bdi dir="ltr">. */
function isolateTextNode(node: Text): void {
  const segs = ltrRuns(node.data);
  if (!segs.some((s) => s.ltr)) return;
  node.replaceWith(...segs.map((s) => (s.ltr ? h("bdi", { dir: "ltr" }, s.text) : s.text)));
}

/** The text nodes that belong to `block` itself: not inside a nested block (it is handled on its own) or an element with its own direction. */
function ownTextNodes(block: Element): Text[] {
  const out: Text[] = [];
  const walk = (parent: Node): void => {
    for (const child of [...parent.childNodes]) {
      if (child instanceof Text) out.push(child);
      else if (child instanceof Element && !isBlock(child) && !child.matches(OWN_DIRECTION)) walk(child);
    }
  };
  walk(block);
  return out;
}

/** Puts each stretch of inline children of an all-English block into one LTR isolate, so its words and punctuation keep their order. */
function isolateInlineRuns(block: Element): void {
  let run: Node[] = [];
  const flush = (): void => {
    if (run.length > 0 && run.some((n) => (n.textContent ?? "").trim() !== "")) {
      const wrap = h("bdi", { dir: "ltr" });
      run[0]?.parentNode?.insertBefore(wrap, run[0]);
      wrap.append(...run);
    }
    run = [];
  };
  for (const child of [...block.childNodes]) {
    if (isBlock(child)) flush();
    else run.push(child);
  }
  flush();
}

/**
 * Case markdown in the Hebrew UI (#248). A block with Hebrew reads right to left, and inside it the runs that must
 * read left to right (paths, commands, field names, IPs, timestamps, usernames, signed numbers, English phrases)
 * are isolated in <bdi dir="ltr">. A block with no Hebrew (an untranslated debrief) reads left to right with
 * lang="en". List items and table cells follow their list or table instead of their own first word, so bullets
 * and columns stay on one side: an English item in a Hebrew list is right to left around one LTR isolate, and an
 * item rendered on its own (the "Look for" list builds its items one by one) takes the UI direction. In English
 * this does nothing.
 */
export function bidiProse<E extends HTMLElement>(el: E): E {
  if (getLang() !== "he") return el;
  const hebrew = (n: Element): boolean => HEBREW.test(n.textContent ?? "");
  for (const group of [...(el.matches(GROUPS) ? [el] : []), ...el.querySelectorAll<HTMLElement>(GROUPS)]) {
    group.setAttribute("dir", hebrew(group) ? "rtl" : "ltr");
  }
  const blocks: HTMLElement[] = el.matches(BLOCKS) ? [el] : [];
  blocks.push(...el.querySelectorAll<HTMLElement>(BLOCKS));
  // inline-only markdown in a wrapper (a <div> or <span> from mdInline) is one block itself
  if (blocks.length === 0) blocks.push(el);
  for (const block of blocks) {
    const own = hebrew(block);
    if (!own) block.setAttribute("lang", "en");
    if (block.matches("li, td, th")) {
      const group = block.parentElement?.closest(GROUPS) ?? null;
      const rtl = group === null || !el.contains(group) ? true : hebrew(group);
      block.setAttribute("dir", rtl ? "rtl" : "ltr");
      if (rtl && !own) {
        isolateInlineRuns(block);
        continue;
      }
    } else {
      block.setAttribute("dir", own ? "rtl" : "ltr");
    }
    if (own) for (const node of ownTextNodes(block)) isolateTextNode(node);
  }
  if (!hebrew(el)) {
    el.setAttribute("lang", "en");
    if (!el.matches("li, td, th")) el.setAttribute("dir", "ltr");
  }
  return el;
}

/** Plain content text (stage names, goals, answer formats, names) that may be English inside the Hebrew UI. */
export const contentText = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string>, text: string): HTMLElementTagNameMap[K] =>
  h(tag, { ...attrs, dir: getLang() === "he" ? "auto" : null, lang: getLang() === "he" && !HEBREW.test(text) ? "en" : null }, text);

/**
 * A case or class name for a card, table cell, heading or crumb, as one element (so a flex parent sees one item).
 * A bilingual title ("The Insider Commit – ה-commit של איש הפנים") becomes one isolate per language inside a span
 * that follows the page direction; a one-language name is a single <bdi dir="auto">.
 */
export function nameNode(name: string, cls?: string): HTMLElement {
  const parts = nameParts(name);
  const part = (text: string, extra: string | null): HTMLElement => h("bdi", { class: extra, dir: "auto", lang: HEBREW.test(text) ? null : "en" }, text);
  const only = parts[0];
  if (parts.length === 1 && only !== undefined) return part(only, cls ?? null);
  return h("span", { class: cls ?? null }, parts.map((p, i) => (i === 0 ? part(p, null) : [" \u2013 ", part(p, null)])));
}

const listLocale = (): string => (getLang() === "he" ? "he-IL" : "en-GB");

/**
 * Items as a locale-formatted list ("a, b, c" through Intl.ListFormat), each item in its own <bdi>. A list of
 * English-only items (topics such as "tcpdump, wireshark") reads left to right as a whole, so its commas follow
 * each item the English way; a list with Hebrew follows the UI direction.
 */
export function listNode(items: readonly string[], type: Intl.ListFormatType = "unit"): HTMLElement {
  const english = items.every((t) => !HEBREW.test(t));
  return h(
    "bdi",
    { dir: english ? "ltr" : getLang() === "he" ? "rtl" : "ltr", lang: english ? "en" : null },
    listParts(listLocale(), items, type).map((s) => (s.ltr ? h("bdi", {}, s.text) : s.text)),
  );
}

/** A list as plain text (for a title attribute or a select option): items wrapped in FSI…PDI isolates. */
export function listText(items: readonly string[], type: Intl.ListFormatType = "unit"): string {
  return listParts(listLocale(), items, type)
    .map((s) => (s.ltr ? `⁨${s.text}⁩` : s.text))
    .join("");
}

/**
 * A date and time with its zone name ("שבת, 28 בנוב׳ 2026, 10:07 GMT+2"): the time and zone stay together on one
 * line (.dt-time), and the zone is an LTR isolate, so "GMT+2" never wraps away or reorders.
 */
export function dateTimeZoneNode(fmt: Intl.DateTimeFormat, at: number | Date): HTMLElement {
  const { date, time, zone } = dateTimeZoneParts(fmt, at);
  const tail = [time, zone === "" ? null : h("bdi", { dir: "ltr" }, zone)].filter((x) => x !== null && x !== "");
  return h(
    "span",
    { class: "dt-zone" },
    date === "" ? null : h("bdi", {}, date.trimEnd()),
    date !== "" && tail.length > 0 ? date.slice(date.trimEnd().length) || " " : null,
    tail.length > 0 ? h("span", { class: "dt-time" }, tail.flatMap((x, i) => (i === 0 ? [x] : [" ", x]))) : null,
  );
}

/** Text in an attribute or other plain-text place: wrapped in FSI…PDI so it keeps its own direction. */
export const isolateText = (text: string): string => `⁨${text}⁩`;
