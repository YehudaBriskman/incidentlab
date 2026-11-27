// Hebrew UI: English-only case content keeps its own direction. Shared by the case stage and the answer form.
import { h } from "./dom";
import { getLang } from "../i18n/i18n";

export const HEBREW = /[֐-׿]/;

/**
 * Case content is partly translated. In the Hebrew UI every prose block gets dir="auto" (its first strong
 * character decides), and blocks with no Hebrew at all get lang="en", so English punctuation stays at the
 * end of the line and screen readers switch voice.
 */
export function bidiProse<E extends HTMLElement>(el: E): E {
  if (getLang() !== "he") return el;
  const blocks: HTMLElement[] = el.matches("p, li, h1, h2, h3, h4, td, th, blockquote, dd, dt") ? [el] : [];
  blocks.push(...el.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, h4, td, th, blockquote, dd, dt"));
  for (const block of blocks) {
    block.setAttribute("dir", "auto");
    if (!HEBREW.test(block.textContent ?? "")) block.setAttribute("lang", "en");
  }
  if (!HEBREW.test(el.textContent ?? "")) {
    el.setAttribute("lang", "en");
    el.setAttribute("dir", "auto");
  }
  return el;
}

/** Plain content text (stage names, goals, answer formats) that may be English inside the Hebrew UI. */
export const contentText = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string>, text: string): HTMLElementTagNameMap[K] =>
  h(tag, { ...attrs, dir: getLang() === "he" ? "auto" : null, lang: getLang() === "he" && !HEBREW.test(text) ? "en" : null }, text);
