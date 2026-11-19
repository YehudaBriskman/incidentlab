import { Marked } from "marked";

// Content is authored by us and bundled at build time, so it is trusted.
const marked = new Marked({ gfm: true, breaks: false, async: false });

export function md(source: string): string {
  const out = marked.parse(source);
  return typeof out === "string" ? out : "";
}

export function mdInline(source: string): string {
  const out = marked.parseInline(source);
  return typeof out === "string" ? out : "";
}
