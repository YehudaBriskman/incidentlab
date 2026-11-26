import { z } from "zod";

/*
 * The case catalog: the few fields the home page, leaderboard and stats need for every case, generated at
 * build time by the `case-catalog` plugin in vite.config.ts (virtual:case-catalog). A case's full content
 * (questions, toolbox, evidence, debrief) is a separate chunk that loads only when its route opens.
 * The catalog entry and `summarize` live in shared/catalog.ts, which the server's GET /api/cases also uses.
 */
export { CaseSummarySchema, CatalogEntrySchema, CatalogSchema, summarize } from "../../shared/catalog";
export type { CaseSummary, CatalogEntry } from "../../shared/catalog";

/** English evidence format labels per case id (virtual:case-evidence-formats, Explorer only). */
export const EvidenceFormatsSchema = z.record(z.string(), z.array(z.object({ path: z.string(), format: z.string() })));

/** Coming-soon cards on the home page (content/teasers.json). */
export const TeaserSchema = z.object({
  id: z.string(),
  title: z.string(),
  tagline: z.string(),
  skills: z.array(z.string()),
  inspiredBy: z.string(),
});
export const TeasersSchema = z.array(TeaserSchema);

export type EvidenceFormats = z.infer<typeof EvidenceFormatsSchema>;
export type Teaser = z.infer<typeof TeaserSchema>;
