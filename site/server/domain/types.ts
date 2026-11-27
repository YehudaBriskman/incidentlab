// Server-side domain types: stored records, secrets and case config.
import { z } from "zod";
import { AccountKindSchema, AccountRecordRoleSchema, AccountStatusSchema, QuestionIdSchema, StageProgressSchema } from "../../shared/contract.ts";
import type { QuestionId } from "../../shared/contract.ts";
import { CaseSealedSchema } from "../../shared/case-records.ts";

/**
 * Data-safety rules (see docs/DATA.md): record changes are additive with defaults, so old records still parse;
 * a change that needs rewriting stored data ships as a numbered migration in server/migrations, and
 * bumps the version below.
 */
export const ACCOUNT_SCHEMA_VERSION = 1;
export const PROGRESS_SCHEMA_VERSION = 1;

export const AccountRecordSchema = z.object({
  schemaVersion: z.number().int().min(1).default(1),
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
  mustChangePassword: z.boolean().default(false),
  /** additive (author role): accounts saved before it are players */
  role: AccountRecordRoleSchema.default("player"),
  // Open access (#171, #172), all additive: accounts saved before them parse with these defaults.
  /** a guest plays without signing up (#176) and can be upgraded to a user, keeping the same id */
  kind: AccountKindSchema.default("user"),
  /** opt-in to the public global leaderboard (#175); off by default for privacy */
  showOnGlobalBoard: z.boolean().default(false),
  /** scrypt hash of the one-time recovery code (#174); null until one is issued */
  recoveryCodeHash: z.string().nullable().default(null),
  /** how many classes this account may own (#179); null means the site default */
  classLimit: z.number().int().min(0).nullable().default(null),
});
export type AccountRecord = z.infer<typeof AccountRecordSchema>;

export const SessionRecordSchema = z.object({
  role: z.enum(["player", "admin"]).default("player"),
  /** admin sessions only: first 16 hex of sha256(ADMIN_KEY), so rotating the key ends them */
  adminKeyFingerprint: z.string().optional(),
  accountId: z.string(),
  epoch: z.number().int().min(0),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const ProgressRecordSchema = z.object({
  schemaVersion: z.number().int().min(1).default(1),
  accountId: z.string(),
  caseId: z.string(),
  startedAt: z.string(),
  lastSeenAt: z.string(),
  setupDoneAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  stages: z.record(QuestionIdSchema, StageProgressSchema),
  wrongAnswerTimestamps: z.partialRecord(QuestionIdSchema, z.array(z.number())), // epoch ms, pruned to the rate window
  commandsRevealed: z.record(z.string(), QuestionIdSchema).default({}), // toolId -> stage it was paid on
  completionBonus: z.number().int().min(0).default(0),
});
export type ProgressRecord = z.infer<typeof ProgressRecordSchema>;

/** Per-case answer key and paid content (generated/secrets.json). The shape is shared: see shared/case-records.ts. */
export const CaseSecretsSchema = CaseSealedSchema;
export type CaseSecrets = z.infer<typeof CaseSecretsSchema>;

export const SecretsSchema = z.object({ cases: z.record(z.string(), CaseSecretsSchema) });
export type Secrets = z.infer<typeof SecretsSchema>;

export type QuestionConfig = { readonly points: number; readonly hintCosts: readonly number[] };
export type CaseConfig = { readonly caseId: string; readonly questions: Readonly<Record<QuestionId, QuestionConfig>> };

export class AppError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  /** itemized problems, e.g. every check a case upload failed */
  readonly details: readonly string[] | undefined;
  constructor(status: number, message: string, options: { code?: string; retryAfterSeconds?: number; details?: readonly string[] } = {}) {
    super(message);
    this.status = status;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }
}
