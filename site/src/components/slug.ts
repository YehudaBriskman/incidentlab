// DOM-free: anchor ids for headings (tested in slug.test.ts).

/** A stable, readable anchor id for a heading (keeps Hebrew letters; dedupes with -2, -3…). */
export function headingSlug(text: string, taken: Set<string>): string {
  const base =
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section";
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

