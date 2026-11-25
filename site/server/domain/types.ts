// Server-side domain types: the stored player record, secrets and case config.
import { z } from "zod";
import { QuestionIdSchema, StageProgressSchema } from "../../shared/contract.ts";
import type { QuestionId } from "../../shared/contract.ts";

export const PlayerRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  caseId: z.string(),
  tokenHash: z.string(), // sha256 hex of the full token; the token itself is never stored
  createdAt: z.string(),
  lastSeenAt: z.string(),
  setupDoneAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  stages: z.record(QuestionIdSchema, StageProgressSchema),
  wrongAnswerTimestamps: z.partialRecord(QuestionIdSchema, z.array(z.number())), // epoch ms, pruned to the rate window
});
export type PlayerRecord = z.infer<typeof PlayerRecordSchema>;

export const SecretsSchema = z.object({
  caseId: z.string(),
  answers: z.record(QuestionIdSchema, z.string()),
  debrief: z.string(),
});
export type Secrets = z.infer<typeof SecretsSchema>;

export type QuestionConfig = { readonly points: number; readonly hintCosts: readonly number[] };
export type CaseConfig = { readonly caseId: string; readonly questions: Readonly<Record<QuestionId, QuestionConfig>> };

export class AppError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
