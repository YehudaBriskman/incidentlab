// Shared API contract between the Netlify function (site/server, site/netlify/functions) and the browser (site/src).
// Single source of truth: both sides import these zod schemas. NEVER use `any`.
import { z } from "zod";
import { CatalogEntrySchema } from "./catalog.ts";

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

/** Usernames nobody can register. Signing in as `admin` with the ADMIN_KEY opens the instructor dashboard. */
export const ADMIN_USERNAME = "admin";
export const RESERVED_USERNAMES: readonly string[] = ["admin", "administrator", "root", "instructor", "system"];

/** Canonical form used for uniqueness and login lookup. */
export const usernameKey = (username: string): string => username.trim().normalize("NFKC").toLowerCase();

export const AccountStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

/** "admin" is the ADMIN_KEY session only; stored accounts are "player" or "author" (authors may upload cases). */
export const AccountRoleSchema = z.enum(["player", "author", "admin"]);
export type AccountRole = z.infer<typeof AccountRoleSchema>;
/** The roles an admin can give a stored account. */
export const AccountRecordRoleSchema = z.enum(["player", "author"]);
export type AccountRecordRole = z.infer<typeof AccountRecordRoleSchema>;

export const AccountViewSchema = z.object({
  id: z.string(),
  username: z.string(),
  status: AccountStatusSchema,
  createdAt: z.string(),
  role: AccountRoleSchema,
  /** true after an admin password reset: the player must set a new password before playing */
  mustChangePassword: z.boolean(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

// ---- scoring --------------------------------------------------------------
// Per stage:  max(0, base − hints − COMMAND_COST×commands − min(WRONG_CAP, WRONG_COST×wrong))
//             + time bonus (TIME_BONUS_MAX when solved within the target time, fading to 0 at 3× target)
//             + CLEAN_BONUS (no hints, commands or wrong answers) + FIRST_BLOOD_BONUS (first solver of the stage).
// Per case:   + COMPLETION_BONUS when all six stages are solved without revealing an answer.
// A revealed stage scores 0.
export const SCORING = {
  COMMAND_COST: 5,
  WRONG_COST: 2,
  WRONG_CAP: 20,
  TIME_BONUS_MAX: 30,
  CLEAN_BONUS: 10,
  FIRST_BLOOD_BONUS: 15,
  COMPLETION_BONUS: 50,
} as const;

export const ScoreBreakdownSchema = z.object({
  base: z.number().int(),
  hints: z.number().int(),      // negative or 0
  commands: z.number().int(),   // negative or 0
  wrong: z.number().int(),      // negative or 0
  time: z.number().int(),       // 0..TIME_BONUS_MAX
  clean: z.number().int(),
  firstBlood: z.number().int(),
  total: z.number().int(),
  solveSeconds: z.number().int().min(0),
  targetSeconds: z.number().int().min(1),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

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
  points: z.number().int().min(0),    // awarded points (0 until solved) = breakdown.total
  revealedAnswer: z.string().nullable(), // only set when status === "revealed"
  commandsRevealed: z.number().int().min(0).default(0), // full commands paid for while this stage was active
  breakdown: ScoreBreakdownSchema.nullable().default(null), // set when solved (null for stages scored before v2)
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
  score: z.number().int().min(0),     // sum of stage points + completionBonus
  maxScore: z.number().int().min(0),  // par: every stage at base + full time bonus + clean, plus completion (first blood is extra)
  completionBonus: z.number().int().min(0),
  stages: z.record(QuestionIdSchema, StageProgressSchema),
  /** toolId -> the stage it was paid for on */
  commandsRevealed: z.record(z.string(), QuestionIdSchema),
  /** Paid-for content in the requested language. Everything is unlocked once the case is completed. */
  unlocked: z.object({
    hints: z.partialRecord(QuestionIdSchema, z.array(z.string())),
    /** `lab`: the lab image variant (#149), null when the item has none; older servers omit it */
    commands: z.record(z.string(), z.object({ command: z.string(), powershell: z.string().nullable(), lab: z.string().nullable().default(null) })),
  }),
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
  commandsRevealed: z.number().int().min(0),
  wrongAttempts: z.number().int().min(0),
  firstBloods: z.number().int().min(0),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** setup-done -> completed (or -> now while in progress); null before setup. */
  durationSeconds: z.number().int().min(0).nullable(),
});
export type CaseStats = z.infer<typeof CaseStatsSchema>;

/** Achievement ids (labels live in the client). */
export const ACHIEVEMENT_IDS = ["first-blood", "clean-case", "speedrun", "no-hints-5", "all-cases", "streak-3", "streak-7"] as const;

export const UserStatsSchema = z.object({
  accountId: z.string(),
  username: z.string(),
  status: AccountStatusSchema,
  /** added with the author role; older payloads parse as "player" */
  role: AccountRecordRoleSchema.default("player"),
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
  commandsRevealed: z.number().int().min(0),
  achievements: z.array(z.object({ id: z.string(), earnedAt: z.string() })),
  /** consecutive incident-of-the-day dates completed on that date */
  streak: z.object({ current: z.number().int().min(0), best: z.number().int().min(0) }),
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

// ---- live event -------------------------------------------------------------

export const AnnouncementSchema = z.object({ text: z.string().trim().min(1).max(280), level: z.enum(["info", "warning"]) });

export const EventSchema = z.object({
  name: z.string().trim().max(80),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime().nullable(),
  /** after this moment the public leaderboard shows the standings as of freezeAt */
  freezeAt: z.string().datetime().nullable(),
  /** true: answers, hints and command reveals are refused outside [startsAt, endsAt] */
  enforceWindow: z.boolean(),
  announcement: AnnouncementSchema.nullable(),
});
export type LiveEvent = z.infer<typeof EventSchema>;

// GET /api/event (public)
export const EventResponseSchema = z.object({ event: EventSchema, serverTime: z.string() });

// ---- settings ---------------------------------------------------------------

export const SettingsSchema = z.object({
  /** sign-ups with this code are approved immediately (null = off). Compared case-insensitively. */
  inviteCode: z.string().trim().min(4).max(40).nullable(),
});
export type Settings = z.infer<typeof SettingsSchema>;

// ---- leaderboard -----------------------------------------------------------

export const LeaderboardEntrySchema = z.object({
  rank: z.number().int().min(1),
  username: z.string(),
  score: z.number().int().min(0),
  stagesSolved: z.number().int().min(0),
  casesCompleted: z.number().int().min(0),
  firstBloods: z.number().int().min(0),
  lastSolveAt: z.string().nullable(),
});
// GET /api/leaderboard?caseId=<id>   (public; omit caseId for overall)
export const LeaderboardResponseSchema = z.object({
  caseId: z.string().nullable(),
  frozen: z.boolean(),
  frozenAt: z.string().nullable(),
  generatedAt: z.string(),
  entries: z.array(LeaderboardEntrySchema),
});
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

// ---- audit -----------------------------------------------------------------

export const AuditEntrySchema = z.object({
  at: z.string(),
  action: z.string(),
  target: z.string().nullable(),
  detail: z.string().nullable(),
  via: z.enum(["key", "session"]),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ---- trash (soft deletes) ---------------------------------------------------
// Deleting an account or a case, or resetting progress, moves the data to the trash first. Entries can be restored
// for TRASH_RETENTION_DAYS; restore never overwrites newer data (409 or "skipped").

export const TRASH_RETENTION_DAYS = 7;

export const TrashEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(["account", "progress", "case"]),
  /** what was removed, for humans: "account dana_k", "progress of 3am-outage (12 players)", "case my-case" */
  label: z.string(),
  deletedAt: z.string(),
  expiresAt: z.string(),
  /** how many progress records the entry holds */
  records: z.number().int().min(0),
});
export type TrashEntry = z.infer<typeof TrashEntrySchema>;
// GET  /api/admin/trash                 -> {entries: TrashEntry[]}   (newest first; expired entries are purged)
// POST /api/admin/trash/:id/restore {}  -> {restored: number, skipped: number}  (409 code "conflict" if the
//                                           account id or username was taken again since)
export const TrashResponseSchema = z.object({ entries: z.array(TrashEntrySchema) });
export const TrashRestoreResponseSchema = z.object({ restored: z.number().int().min(0), skipped: z.number().int().min(0) });

// ---- requests / responses -------------------------------------------------
// Player auth: HttpOnly session cookie `il_session` (set by register/login, cleared by logout).
// Admin auth: header X-Admin-Key: <ADMIN_KEY env var>.
// Errors: non-2xx with body ErrorBody. 400 validation, 401 auth, 403 forbidden/locked/not approved, 404, 409, 429 rate limit.

export const ErrorBodySchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
  /** itemized problems (a rejected case upload lists every failed check) */
  details: z.array(z.string()).optional(),
});

// POST /api/auth/register  -> 201 {account} + cookie (status "pending" until the admin approves,
//                             "approved" right away with a valid inviteCode). 409 code "reserved" / "username-taken".
// POST /api/auth/login     -> 200 {account} + cookie (403 code "rejected" for rejected accounts).
//                             username "admin" + the ADMIN_KEY -> an admin session (account.role "admin", 12 h).
export const CredentialsSchema = z.object({ username: UsernameSchema, password: PasswordSchema });
export const RegisterRequestSchema = CredentialsSchema.extend({ inviteCode: z.string().trim().max(40).optional() });
// POST /api/me/password {currentPassword, newPassword} -> {account}  (also clears mustChangePassword)
export const ChangePasswordRequestSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: PasswordSchema });
export const LoginRequestSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(128) });
export const AccountResponseSchema = z.object({ account: AccountViewSchema });
// POST /api/auth/logout (body {}) -> 204, clears the cookie
// GET  /api/me -> {account}   (401 when not signed in)
// GET  /api/session -> {account | null}   (always 200: the signed-out probe the browser uses, so a visitor's console stays clean)
export const SessionResponseSchema = z.object({ account: AccountViewSchema.nullable() });

// ---- DB-stored case content (public, cacheable: Cache-Control public, max-age=60, stale-while-revalidate=600) ----
// GET /api/cases                          -> {cases: CatalogEntry[]}   (published DB cases only; ETag, 304)
// GET /api/cases/:caseId/content?lang=en|he -> {id, version, lang, content: CaseContent}
//                                            (lang is the one served: he falls back to en; ETag, 304; 404 unless published)
//     CaseContentResponseSchema is in ./case-records.ts (server-side schemas).
// Evidence: /evidence/db/<id>/v<n>/files/<path> and /evidence/db/<id>/v<n>.zip (Edge Function; Range, immutable).
export const CasesResponseSchema = z.object({ cases: z.array(CatalogEntrySchema) });

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

// Every /api/cases/:caseId/* route needs an APPROVED player account (403 code "pending" / "rejected" /
// "admin" / "password-change-required" otherwise). Every route accepts ?lang=en|he for `unlocked` content.
// During an event with enforceWindow, mutations outside the window get 403 code "event-closed".
// GET  /api/cases/:caseId/progress           -> {progress}
// POST /api/cases/:caseId/setup-done  {}     -> {progress}  (q1 becomes active)
// POST /api/cases/:caseId/answer             -> {correct, progress}
// POST /api/cases/:caseId/hint               -> {progress}
// POST /api/cases/:caseId/reveal             -> {progress}
// POST /api/cases/:caseId/reveal-command {toolId} -> {progress}  (−5 on the active stage; free if already
//                                             revealed or the case is completed; 403 "locked" before setup)
// GET  /api/cases/:caseId/debrief?lang=en|he -> {markdown}  (403 until every stage is finished)
export const ProgressResponseSchema = z.object({ progress: ProgressViewSchema });
export const AnswerRequestSchema = z.object({ questionId: QuestionIdSchema, answer: z.string().max(200) });
export const AnswerResponseSchema = z.object({ correct: z.boolean(), progress: ProgressViewSchema });
export const QuestionRequestSchema = z.object({ questionId: QuestionIdSchema });
export const RevealCommandRequestSchema = z.object({ toolId: z.string().min(1).max(80) });
export const DebriefResponseSchema = z.object({ markdown: z.string() });

// GET /api/me/stats -> UserStats
export const UserStatsResponseSchema = z.object({ stats: UserStatsSchema });

// ---- admin ----------------------------------------------------------------
// GET    /api/admin/accounts                    -> {accounts: UserStats[]}   (every account, with stats)
// PUT    /api/admin/accounts/:id/role {role: "player"|"author"} -> {account}   (audited as account.role)
export const SetAccountRoleRequestSchema = z.object({ role: AccountRecordRoleSchema });
// POST   /api/admin/accounts/:id/approve  {}    -> {account}
// POST   /api/admin/accounts/:id/reject   {}    -> {account}   (the player sees the "not approved" screen)
// DELETE /api/admin/accounts/:id                -> 204         (moves account + progress to the trash; sessions end)
// GET    /api/admin/progress?caseId=<id>        -> {generatedAt, caseId, players: AdminProgress[]}
// DELETE /api/admin/progress/:accountId/:caseId -> 204         (restart that player's case)
// POST   /api/admin/reset {confirm:"RESET", caseId?} -> 204    (wipe progress: one case, or all; accounts stay)
// GET    /api/admin/schedule                    -> {schedule}
// PUT    /api/admin/schedule  Schedule          -> {schedule}
// GET    /api/admin/stats                       -> {generatedAt, cases: CaseSummary[]}
// POST   /api/admin/accounts/:id/reset-password {} -> {temporaryPassword}  (signs the player out; forces a change)
// POST   /api/admin/accounts/approve-all  {}    -> {approved: number}
// GET    /api/admin/settings                    -> {settings}
// PUT    /api/admin/settings   Settings         -> {settings}
// GET    /api/admin/event                       -> {event, serverTime}
// PUT    /api/admin/event      LiveEvent        -> {event, serverTime}
// GET    /api/admin/export.csv                  -> text/csv (one row per account per case)
// GET    /api/admin/audit?limit=100             -> {entries: AuditEntry[]}  (newest first)
// Admin auth: header X-Admin-Key, OR the session cookie of `admin` signed in with the ADMIN_KEY.
export const AdminAccountsResponseSchema = z.object({ generatedAt: z.string(), accounts: z.array(UserStatsSchema) });
export const AdminProgressResponseSchema = z.object({ generatedAt: z.string(), caseId: z.string(), players: z.array(AdminProgressSchema) });
export const AdminResetRequestSchema = z.object({ confirm: z.literal("RESET"), caseId: CaseIdSchema.optional() });
export const ScheduleResponseSchema = z.object({ schedule: ScheduleSchema });
export const AdminStatsResponseSchema = z.object({ generatedAt: z.string(), cases: z.array(CaseSummarySchema) });
export const ResetPasswordResponseSchema = z.object({ temporaryPassword: z.string() });
export const ApproveAllResponseSchema = z.object({ approved: z.number().int().min(0) });
export const SettingsResponseSchema = z.object({ settings: SettingsSchema });
export const AuditResponseSchema = z.object({ entries: z.array(AuditEntrySchema) });

// Scoring: solved points = max(0, question.points - sum(cost of the first `hintsRevealed` hints)).
// Rate limit: max 5 wrong answers per account per question per 60s -> 429 with retryAfterSeconds.
// Answer normalization: trim, lowercase, collapse whitespace (one implementation, in ./normalize.ts).
export { normalizeAnswer } from "./normalize.ts";
