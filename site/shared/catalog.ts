// The case catalog entry: the few fields the home page, leaderboard and stats need for every case.
// Shared by the build-time catalog (vite.config.ts, virtual:case-catalog) and the server's
// GET /api/cases, so both produce the same shape. Zod only: the browser imports this module.
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
  /** file stem under content/cases (`3am-outage`, `_dev-sample`); the Hebrew file is `<file>.he.json`.
   *  For a DB-stored case (GET /api/cases) it is the case id. */
  file: z.string(),
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
