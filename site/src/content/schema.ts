// Canonical content schema. The site agent copies this verbatim into site/src/content/schema.ts.
// The content agent writes JSON that validates against it.
import { z } from "zod";

export const HintSchema = z.object({
  cost: z.number().int().nonnegative(), // points deducted when revealed
  // markdown. Authored in the JSON, but STRIPPED from the browser bundle (vite.config.ts) and served by
  // the API only after the hint is paid for.
  text: z.string().optional(),
});

export const StageSchema = z.object({
  name: z.string(),                     // short stage name, e.g. "When did it start?"
  goal: z.string(),                     // ONE sentence: what to find
  lookFor: z.array(z.string()).max(4),  // 2–4 short bullet pointers (no answers)
  tools: z.array(z.string()),           // toolbox item ids relevant to this stage
  explorerTip: z.string(),              // how to do it in the in-browser Evidence Explorer
});

export const QuestionSchema = z.object({
  stage: StageSchema.optional(),
  id: z.string(),                       // "q1".."q6" — must match flags.json keys
  title: z.string(),
  prompt: z.string(),                   // markdown
  answerFormat: z.string(),             // e.g. "HH:MM:SS (UTC)"
  placeholder: z.string(),
  points: z.number().int().positive(),
  targetMinutes: z.number().positive().optional(), // time-bonus target for this stage (default estMinutes / 6)
  hints: z.array(HintSchema).min(1).max(4), // ordered, revealed one at a time
  successNote: z.string(),              // markdown shown after correct answer ("why this matters")
});

export const ToolItemSchema = z.object({
  id: z.string().optional(),            // referenced by QuestionSchema.stage.tools
  title: z.string(),
  // Free to view: the command's shape with <placeholders> instead of the concrete pattern/field/file.
  syntax: z.string().optional(),
  syntaxPowershell: z.string().optional(),
  // The runnable commands. Authored in the JSON, STRIPPED from the browser bundle, and served by the
  // API only after the player pays (5 points) or finishes the case.
  command: z.string().optional(),
  powershell: z.string().optional(),    // Windows PowerShell equivalent (no installs needed)
  explain: z.string(),                  // markdown
});

export const ToolboxSectionSchema = z.object({
  category: z.string(),                 // e.g. "grep & friends", "jq", "Time zones", "git"
  items: z.array(ToolItemSchema).min(1),
});

export const EvidenceFileSchema = z.object({
  path: z.string(),                     // path inside the zip
  format: z.string(),                   // short label, e.g. "nginx log (UTC)"
  description: z.string(),
});

export const CaseSchema = z.object({
  setupChecklist: z.array(z.string()).optional(), // stage 0 checklist items (markdown inline)
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  estMinutes: z.number().int().positive(),
  tags: z.array(z.string()),
  inspiredBy: z.object({ title: z.string(), year: z.number().int(), summary: z.string() }),
  briefing: z.string(),                 // markdown
  evidenceZip: z.string(),              // "/evidence/3am-outage-evidence.zip"
  evidence: z.array(EvidenceFileSchema),
  rules: z.array(z.string()),
  questions: z.array(QuestionSchema).min(1),
  toolbox: z.array(ToolboxSectionSchema).min(1),
  debrief: z.string(),                  // markdown, unlocked after all questions solved
});

export const TeaserSchema = z.object({
  id: z.string(),
  title: z.string(),
  tagline: z.string(),
  skills: z.array(z.string()),
  inspiredBy: z.string(),
});
export const TeasersSchema = z.array(TeaserSchema);

export const FlagsSchema = z.object({
  caseId: z.string(),
  flags: z.record(z.string(), z.object({ salt: z.string(), sha256: z.string() })),
});

export type Case = z.infer<typeof CaseSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Teaser = z.infer<typeof TeaserSchema>;
export type Flags = z.infer<typeof FlagsSchema>;

// Answer normalization (must match scripts/make_flags.py):
export const normalizeAnswer = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\s+/g, " ");
