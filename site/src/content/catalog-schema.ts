import { z } from "zod";

/*
 * The case catalog: the few fields the home page, leaderboard and stats need for every case, from
 * GET /api/cases (content/load.ts). A case's full content (questions, toolbox, evidence) loads only when
 * its route opens. The catalog entry and `summarize` live in shared/catalog.ts, shared with the server.
 */
export { CaseSummarySchema, CatalogEntrySchema, CatalogSchema, summarize } from "../../shared/catalog";
export type { CaseSummary, CatalogEntry } from "../../shared/catalog";

/** Coming-soon cards on the home page (content/teasers.json). */
export const TeaserSchema = z.object({
  id: z.string(),
  title: z.string(),
  tagline: z.string(),
  skills: z.array(z.string()),
  inspiredBy: z.string(),
});
export const TeasersSchema = z.array(TeaserSchema);

export type Teaser = z.infer<typeof TeaserSchema>;
