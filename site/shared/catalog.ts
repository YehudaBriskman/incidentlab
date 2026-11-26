// The case catalog entry: the few fields the home page, leaderboard and stats need for every case.
// Built by the server's GET /api/cases from the published DB cases; the browser validates it with the same
// schema. Zod only: the browser imports this module.
import { z } from "zod";
import type { Case } from "./case.ts";

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
  /** the case id (the field predates #68, when it named a bundled file) */
  file: z.string(),
  /** the published version (#68): the browser caches a case's content per version */
  version: z.number().int().min(1).optional(),
  en: CaseSummarySchema,
  he: CaseSummarySchema.optional(),
});

export const CatalogSchema = z.array(CatalogEntrySchema);

export type CaseSummary = z.infer<typeof CaseSummarySchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

/** What `summarize` reads: satisfied by an authored `Case` and by its public `CaseContent` alike. */
export type SummarizableCase = Pick<Case, "id" | "title" | "subtitle" | "difficulty" | "estMinutes" | "tags"> & {
  readonly questions: readonly unknown[];
};

export function summarize(c: SummarizableCase): CaseSummary {
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
