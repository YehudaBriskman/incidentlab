// Server-side domain types: stored records, secrets and case config.
import { z } from "zod";
import { AccountStatusSchema, QuestionIdSchema, StageProgressSchema } from "../../shared/contract.ts";
import type { QuestionId } from "../../shared/contract.ts";

export const AccountRecordSchema = z.object({
  id: z.string(),
  username: z.string(),      // as the player typed it (display)
  usernameKey: z.string(),   // canonical, unique
  passwordHash: z.string(),  // scrypt$N$r$p$salt$hash
  status: AccountStatusSchema,
  sessionEpoch: z.number().int().min(0), // bump to invalidate every session of the account
  createdAt: z.string(),
  decidedAt: z.string().nullable(),      // when the admin approved/rejected
  lastSeenAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
});
export type AccountRecord = z.infer<typeof AccountRecordSchema>;

export const SessionRecordSchema = z.object({
  accountId: z.string(),
  epoch: z.number().int().min(0),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const ProgressRecordSchema = z.object({
  accountId: z.string(),
  caseId: z.string(),
  startedAt: z.string(),
  lastSeenAt: z.string(),
  setupDoneAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  stages: z.record(QuestionIdSchema, StageProgressSchema),
  wrongAnswerTimestamps: z.partialRecord(QuestionIdSchema, z.array(z.number())), // epoch ms, pruned to the rate window
});
export type ProgressRecord = z.infer<typeof ProgressRecordSchema>;

const QuestionConfigSchema = z.object({ points: z.number().int().positive(), hintCosts: z.array(z.number().int().min(0)) });

export const CaseSecretsSchema = z.object({
  title: z.string(),
  answers: z.record(QuestionIdSchema, z.string()),
  debrief: z.string(),
  debriefHe: z.string().nullable(),
  questions: z.record(QuestionIdSchema, QuestionConfigSchema),
});
export type CaseSecrets = z.infer<typeof CaseSecretsSchema>;

export const SecretsSchema = z.object({ cases: z.record(z.string(), CaseSecretsSchema) });
export type Secrets = z.infer<typeof SecretsSchema>;

export type QuestionConfig = { readonly points: number; readonly hintCosts: readonly number[] };
export type CaseConfig = { readonly caseId: string; readonly questions: Readonly<Record<QuestionId, QuestionConfig>> };

export class AppError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  constructor(status: number, message: string, options: { code?: string; retryAfterSeconds?: number } = {}) {
    super(message);
    this.status = status;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
