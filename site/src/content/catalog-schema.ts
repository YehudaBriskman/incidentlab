import { z } from "zod";
import type { Case } from "./schema";

/*
 * The case catalog: the few fields the home page, leaderboard and stats need for every case, generated at
 * build time by the `case-catalog` plugin in vite.config.ts (virtual:case-catalog). A case's full content
 * (questions, toolbox, evidence, debrief) is a separate chunk that loads only when its route opens.
 */

export const CaseSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  estMinutes: z.number().int().positive(),
  tags: z.array(z.string()),
  questionCount: z.number().int().positive(),
});

export const CatalogEntrySchema = z.object({
  /** file stem under content/cases (`3am-outage`, `_dev-sample`); the Hebrew file is `<file>.he.json` */
  file: z.string(),
  en: CaseSummarySchema,
  he: CaseSummarySchema.optional(),
});

export const CatalogSchema = z.array(CatalogEntrySchema);

/** English evidence format labels per case id (virtual:case-evidence-formats, Explorer only). */
export const EvidenceFormatsSchema = z.record(z.string(), z.array(z.object({ path: z.string(), format: z.string() })));

export type CaseSummary = z.infer<typeof CaseSummarySchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type EvidenceFormats = z.infer<typeof EvidenceFormatsSchema>;

export function summarize(c: Case): CaseSummary {
  return {
    id: c.id,
    title: c.title,
    subtitle: c.subtitle,
    difficulty: c.difficulty,
    estMinutes: c.estMinutes,
    tags: c.tags,
    questionCount: c.questions.length,
  };
}
