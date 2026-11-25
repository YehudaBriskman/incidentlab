// Shared API contract between the Netlify function (site/server, site/netlify/functions) and the browser (site/src).
// Single source of truth: both sides import these zod schemas. NEVER use `any`.
import { z } from "zod";

export const QuestionIdSchema = z.enum(["q1", "q2", "q3", "q4", "q5", "q6"]);
export type QuestionId = z.infer<typeof QuestionIdSchema>;
export const QUESTION_ORDER: readonly QuestionId[] = ["q1", "q2", "q3", "q4", "q5", "q6"];

export const CaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "invalid case id");

// ---- accounts -------------------------------------------------------------

// Usernames: 3–24 chars, unicode letters/digits and . _ -  (Hebrew allowed, no spaces). Rendered ONLY via textContent.
// Uniqueness is case-insensitive (see usernameKey), so "Dana" and "dana" can't both exist.
export const UsernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be 3–24 characters")
  .max(24, "Username must be 3–24 characters")
  .regex(/^[\p{L}\p{N}._-]+$/u, "Letters, numbers and . _ - only (no spaces)");

export const PasswordSchema = z.string().min(8, "Password must be at least 8 characters").max(128, "Password is too long");

/** Canonical form used for uniqueness and login lookup. */
export const usernameKey = (username: string): string => username.trim().normalize("NFKC").toLowerCase();

export const AccountStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountViewSchema = z.object({
  id: z.string(),
  username: z.string(),
  status: AccountStatusSchema,
  createdAt: z.string(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

// ---- progress -------------------------------------------------------------

// Stage status. Stages are SEQUENTIAL: setup -> q1 -> ... -> q6 -> debrief.
// "revealed" = player gave up on that stage and got the answer for 0 points.
export const StageStatusSchema = z.enum(["locked", "active", "solved", "revealed"]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const StageProgressSchema = z.object({
  status: StageStatusSchema,
  startedAt: z.string().nullable(),   // ISO, when it became active
  finishedAt: z.string().nullable(),  // ISO, when solved/revealed
  hintsRevealed: z.number().int().min(0),
  wrongAttempts: z.number().int().min(0),
  points: z.number().int().min(0),    // awarded points (0 until solved)
  revealedAnswer: z.string().nullable(), // only set when status === "revealed"
});
export type StageProgress = z.infer<typeof StageProgressSchema>;

/** One account's progress on one case. A case the account never opened is returned with every stage locked. */
export const ProgressViewSchema = z.object({
  accountId: z.string(),
  username: z.string(),
  caseId: z.string(),
  startedAt: z.string().nullable(),   // first time the account opened the case (null = never)
  setupDoneAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  score: z.number().int().min(0),
  maxScore: z.number().int().min(0),
  stages: z.record(QuestionIdSchema, StageProgressSchema),
});
export type ProgressView = z.infer<typeof ProgressViewSchema>;

export const LiveStageSchema = z.union([QuestionIdSchema, z.literal("setup"), z.literal("done")]);

export const AdminProgressSchema = ProgressViewSchema.extend({
  lastSeenAt: z.string(),
  currentStage: LiveStageSchema,
  stuckMinutes: z.number().min(0), // minutes since current stage started (0 if done)
});
export type AdminProgress = z.infer<typeof AdminProgressSchema>;

// ---- stats ----------------------------------------------------------------

export const CaseStatsSchema = z.object({
  caseId: z.string(),
  status: z.enum(["not-started", "in-progress", "completed"]),
  score: z.number().int().min(0),
  maxScore: z.number().int().min(0),
  solved: z.number().int().min(0),
  revealed: z.number().int().min(0),
  hintsUsed: z.number().int().min(0),
  wrongAttempts: z.number().int().min(0),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** setup-done -> completed (or -> now while in progress); null before setup. */
  durationSeconds: z.number().int().min(0).nullable(),
});
export type CaseStats = z.infer<typeof CaseStatsSchema>;

export const UserStatsSchema = z.object({
  accountId: z.string(),
  username: z.string(),
  status: AccountStatusSchema,
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  totalScore: z.number().int().min(0),
  casesStarted: z.number().int().min(0),
  casesCompleted: z.number().int().min(0),
  stagesSolved: z.number().int().min(0),
  stagesRevealed: z.number().int().min(0),
  hintsUsed: z.number().int().min(0),
  wrongAttempts: z.number().int().min(0),
  /** solved / (solved + wrong attempts), 0..1; null when nothing was attempted. */
  accuracy: z.number().min(0).max(1).nullable(),
  rank: z.number().int().min(1).nullable(), // among approved accounts by totalScore (ties share a rank)
  cases: z.array(CaseStatsSchema),
});
export type UserStats = z.infer<typeof UserStatsSchema>;

export const CaseSummarySchema = z.object({
  caseId: z.string(),
  title: z.string(),
  maxScore: z.number().int().min(0),
  players: z.number().int().min(0),
  completed: z.number().int().min(0),
  avgScore: z.number().min(0).nullable(),
  avgDurationSeconds: z.number().min(0).nullable(),
  /** per question, over players who reached it: how many solved / revealed, average wrong attempts and hints */
  questions: z.record(
    QuestionIdSchema,
    z.object({ solved: z.number().int().min(0), revealed: z.number().int().min(0), avgWrong: z.number().min(0), avgHints: z.number().min(0) }),
  ),
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

// ---- schedule -------------------------------------------------------------

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export const ScheduleSchema = z.object({
  /** IANA zone that decides when "today" starts, e.g. Asia/Jerusalem */
  timezone: z.string().min(1).max(64),
  /** case shown when the date has no entry (null = none) */
  defaultCaseId: CaseIdSchema.nullable(),
  /** YYYY-MM-DD -> case id */
  days: z.record(IsoDateSchema, CaseIdSchema),
  /** true: only today's case can be started (cases already started stay playable) */
  lockToToday: z.boolean(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

// ---- requests / responses -------------------------------------------------
// Player auth: HttpOnly session cookie `il_session` (set by register/login, cleared by logout).
// Admin auth: header X-Admin-Key: <ADMIN_KEY env var>.
// Errors: non-2xx with body ErrorBody. 400 validation, 401 auth, 403 forbidden/locked/not approved, 404, 409, 429 rate limit.

export const ErrorBodySchema = z.object({ error: z.string(), code: z.string().optional(), retryAfterSeconds: z.number().optional() });

// POST /api/auth/register  -> 201 {account} + cookie (status "pending" until the admin approves)
// POST /api/auth/login     -> 200 {account} + cookie (403 code "rejected" for rejected accounts)
export const CredentialsSchema = z.object({ username: UsernameSchema, password: PasswordSchema });
export const LoginRequestSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(128) });
export const AccountResponseSchema = z.object({ account: AccountViewSchema });
// POST /api/auth/logout (body {}) -> 204, clears the cookie
// GET  /api/me -> {account}   (401 when not signed in)

// GET /api/today -> public
export const TodayResponseSchema = z.object({
  date: IsoDateSchema,
  timezone: z.string(),
  caseId: z.string().nullable(),
  lockToToday: z.boolean(),
  /** case ids with a server-side answer key (playable) */
  releasedCaseIds: z.array(z.string()),
});
export type TodayResponse = z.infer<typeof TodayResponseSchema>;

// Every /api/cases/:caseId/* route needs an APPROVED account (403 code "pending" / "rejected" otherwise).
// GET  /api/cases/:caseId/progress           -> {progress}
// POST /api/cases/:caseId/setup-done  {}     -> {progress}  (q1 becomes active)
// POST /api/cases/:caseId/answer             -> {correct, progress}
// POST /api/cases/:caseId/hint               -> {progress}
// POST /api/cases/:caseId/reveal             -> {progress}
// GET  /api/cases/:caseId/debrief?lang=en|he -> {markdown}  (403 until every stage is finished)
export const ProgressResponseSchema = z.object({ progress: ProgressViewSchema });
export const AnswerRequestSchema = z.object({ questionId: QuestionIdSchema, answer: z.string().max(200) });
export const AnswerResponseSchema = z.object({ correct: z.boolean(), progress: ProgressViewSchema });
export const QuestionRequestSchema = z.object({ questionId: QuestionIdSchema });
export const DebriefResponseSchema = z.object({ markdown: z.string() });

// GET /api/me/stats -> UserStats
export const UserStatsResponseSchema = z.object({ stats: UserStatsSchema });

// ---- admin ----------------------------------------------------------------
// GET    /api/admin/accounts                    -> {accounts: UserStats[]}   (every account, with stats)
// POST   /api/admin/accounts/:id/approve  {}    -> {account}
// POST   /api/admin/accounts/:id/reject   {}    -> {account}   (also signs the account out)
// DELETE /api/admin/accounts/:id                -> 204         (account, sessions and progress)
// GET    /api/admin/progress?caseId=<id>        -> {generatedAt, caseId, players: AdminProgress[]}
// DELETE /api/admin/progress/:accountId/:caseId -> 204         (restart that player's case)
// POST   /api/admin/reset {confirm:"RESET", caseId?} -> 204    (wipe progress: one case, or all; accounts stay)
// GET    /api/admin/schedule                    -> {schedule}
// PUT    /api/admin/schedule  Schedule          -> {schedule}
// GET    /api/admin/stats                       -> {generatedAt, cases: CaseSummary[]}
export const AdminAccountsResponseSchema = z.object({ generatedAt: z.string(), accounts: z.array(UserStatsSchema) });
export const AdminProgressResponseSchema = z.object({ generatedAt: z.string(), caseId: z.string(), players: z.array(AdminProgressSchema) });
export const AdminResetRequestSchema = z.object({ confirm: z.literal("RESET"), caseId: CaseIdSchema.optional() });
export const ScheduleResponseSchema = z.object({ schedule: ScheduleSchema });
export const AdminStatsResponseSchema = z.object({ generatedAt: z.string(), cases: z.array(CaseSummarySchema) });

// Scoring: solved points = max(0, question.points - sum(cost of the first `hintsRevealed` hints)).
// Rate limit: max 5 wrong answers per account per question per 60s -> 429 with retryAfterSeconds.
// Answer normalization: trim, lowercase, collapse whitespace.
export const normalizeAnswer = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, " ");
