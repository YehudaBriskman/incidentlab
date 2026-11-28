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
/** A full account, or a guest playing without signing up (#176). */
export const AccountKindSchema = z.enum(["user", "guest"]);
export type AccountKind = z.infer<typeof AccountKindSchema>;
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
  /** additive (#172): user or guest, and whether the player shows on the global leaderboard */
  kind: AccountKindSchema.default("user"),
  showOnGlobalBoard: z.boolean().default(false),
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
  /**
   * Additive (#133): the player's own correct answer as they typed it (trimmed), set when solved. Null before that,
   * on revealed stages and on stages solved before #133. Sent only to that player: admin views blank it, and no
   * public or CDN-cached response carries stage records.
   */
  solvedAnswer: z.string().nullable().default(null),
});
export type StageProgress = z.infer<typeof StageProgressSchema>;

/** One account's progress on one case. A case the account never opened is returned with every stage locked. */
/**
 * Which record a play route reads and writes (#253): left out, the player's own run (`progress:`); with a class id,
 * that class's live event run (`eventprogress:`), which counts on that class's board only.
 */
export const PlayRunSchema = z.object({ classId: z.string().regex(/^[0-9A-Za-z]{12}$/, "invalid class id") }).strict();
export type PlayRun = z.infer<typeof PlayRunSchema>;
/** The run a progress view belongs to: null = the player's own run; else the class and its event occurrence. */
export const ProgressRunSchema = z.object({ classId: z.string(), className: z.string(), eventKey: z.string() });
export type ProgressRun = z.infer<typeof ProgressRunSchema>;

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
  /** additive (#253): the event run this view is, or null for the player's own run (older servers omit it) */
  run: ProgressRunSchema.nullable().default(null),
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
  /**
   * /api/me/stats: the place on the live overall public board (#175), null when not on it (not opted in, or
   * nothing solved yet). /api/admin/accounts: among every approved account. Ties share a rank.
   */
  rank: z.number().int().min(1).nullable(),
  /** additive (#175): the account opted in to the public global leaderboard (and may be listed there) */
  onGlobalBoard: z.boolean().default(false),
  /** additive (#185): a full account or a guest, and the account's own class limit (null = the site default) */
  kind: AccountKindSchema.default("user"),
  classLimit: z.number().int().min(0).nullable().default(null),
  commandsRevealed: z.number().int().min(0),
  achievements: z.array(z.object({ id: z.string(), earnedAt: z.string() })),
  /** `activeToday`: a stage was solved today (schedule time zone), so the streak is safe (#212); older servers omit it */
  streak: z.object({ current: z.number().int().min(0), best: z.number().int().min(0), activeToday: z.boolean().default(false) }),
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
  /** Deprecated (#180): stored and returned, but no longer enforced. Every published case can always be played. */
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
  /** Deprecated (#180): stored, but no longer enforced. Gameplay never blocks on an event window. */
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
// GET /api/leaderboard?caseId=<id>   (public; omit caseId for overall). Only approved, non-guest accounts that
// opted in (PUT /api/me/board) and solved at least one stage are listed.
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
  /**
   * additive (#185): who did it: "admin" (the ADMIN_KEY owner, by key or session, see `via`) or the acting
   * account's id (a class admin, an author, a player joining a class). Null on entries written before it.
   */
  actor: z.string().nullable().default(null),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
/** The audit actor of the site owner (the ADMIN_KEY), by key or session. */
export const AUDIT_ADMIN_ACTOR = "admin";

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
  /**
   * Additive (#202, #203): a 409 `stale` from a play route carries the player's current progress, so a tab that
   * acted on old state redraws from the server's instead of guessing.
   */
  progress: ProgressViewSchema.optional(),
});

// POST /api/auth/register  -> 201 {account, recoveryCode, class?} + cookie (approved at once since #173; the plain recovery
//                             code is in this response only). 409 code "reserved" / "username-taken". 400 (no code
//                             the UI acts on) when the bot checks fail: `website` filled, or `elapsedMs` under 2 s.
//                             `inviteCode` (optional, #204) is a class join code: the new account joins that class
//                             (or asks to, in approval mode) and `class` is its summary. 400 "bad-class-code" when no
//                             class has it (and it isn't the legacy site invite code), 409 "class-full"; either way
//                             no account is created.
// POST /api/auth/login     -> 200 {account, recoveryCode?} + cookie (403 code "rejected" for rejected accounts).
//                             `recoveryCode` only when this sign-in issued the account's first code (#174).
//                             username "admin" + the ADMIN_KEY -> an admin session (account.role "admin", 12 h).
// POST /api/auth/recover {username, recoveryCode, newPassword} -> 200 {recoveryCode}  (no cookie: sign in after it)
//                             401 code "bad-recovery-code"; every session of the account ends; the old code is spent.
// POST /api/me/recovery-code {currentPassword} -> 200 {recoveryCode}  (replaces the code; 400 "bad-credentials")
export const CredentialsSchema = z.object({ username: UsernameSchema, password: PasswordSchema });
/** Sign-up form: how long the form was open before submit; below this the server refuses it as a bot. */
export const MIN_SIGNUP_FORM_MS = 2_000;
export const RegisterRequestSchema = CredentialsSchema.extend({
  inviteCode: z.string().trim().max(40).optional(),
  // Bot checks (#173), additive: older clients send neither. `website` is a hidden field people never see.
  website: z.string().max(200).optional(),
  elapsedMs: z.number().int().min(0).max(86_400_000 * 30).optional(),
});
// POST /api/me/password {currentPassword, newPassword} -> {account, recoveryCode?}  (also clears mustChangePassword;
//                             when it was set, a new recovery code is issued and returned once, #254)
export const ChangePasswordRequestSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: PasswordSchema });
export const LoginRequestSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(128) });
export const AccountResponseSchema = z.object({ account: AccountViewSchema });
/** Recovery codes (#174): 4 groups of 5 from an alphabet without 0/O, 1/I/L, so they read back unambiguously. */
export const RECOVERY_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const RECOVERY_CODE_GROUPS = 4;
export const RECOVERY_CODE_GROUP_LENGTH = 5;
/** Canonical form of a typed code: case, spaces and dashes don't matter. */
export const normalizeRecoveryCode = (code: string): string => code.toUpperCase().replace(/[\s-]+/g, "");
/** Register and login: the account, plus a freshly issued recovery code when there is one (shown once). */
export const AuthResponseSchema = AccountResponseSchema.extend({ recoveryCode: z.string().optional() });
export const RecoverRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  recoveryCode: z.string().trim().min(1).max(64),
  newPassword: PasswordSchema,
});
export const RegenerateRecoveryCodeRequestSchema = z.object({ currentPassword: z.string().min(1).max(128) });
export const RecoveryCodeResponseSchema = z.object({ recoveryCode: z.string() });

// ---- teacher-vouched password reset (#254) ------------------------------------------
// For a player who lost both the password and the recovery code. Nobody but the site owner ever sets a password:
// a class admin only vouches ("I know this student"), the owner approves and gets a one-time temporary password.
// POST /api/auth/reset-request {username, website?} -> 202 RESET_REQUEST_ACCEPTED, always the same body, whether or
//      not the name exists (rate-limited per IP and per name like recovery). Opens `resetrequest:<accountId>` for an
//      existing user account (status open, expires after RESET_REQUEST_TTL_DAYS); a repeat refreshes the expiry.
// GET  /api/classes/:id/reset-requests            -> {requests: ClassResetRequest[]}  (class admins: open requests of
//      the class's active members)
// POST /api/classes/:id/reset-requests/:accountId/vouch {} -> {request: ClassResetRequest}  (an active class admin of
//      an active class the player is an active member of; 404 otherwise; never changes credentials)
// GET  /api/admin/reset-requests                   -> {requests: AdminPasswordResetRequest[]}  (site admin: open,
//      unexpired requests with at least one valid vouch)
// POST /api/admin/reset-requests/:accountId/approve {} -> {temporaryPassword}  (409 "no-vouch" without a valid vouch,
//      404 when no open request; sets the password, forces a change, ends every session; shown once)
// POST /api/admin/reset-requests/:accountId/reject {}  -> 204
export const RESET_REQUEST_TTL_DAYS = 7;
export const ResetRequestCreateSchema = z.object({
  username: z.string().trim().min(1).max(64),
  /** the hidden honeypot field: people leave it empty (a filled one gets the same 202 and does nothing) */
  website: z.string().max(200).optional(),
});
export const RESET_REQUEST_ACCEPTED = { status: "received" } as const;
export const ResetRequestAcceptedSchema = z.object({ status: z.literal("received") });
export const ClassResetRequestSchema = z.object({
  accountId: z.string(),
  username: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** this class admin already vouched for it */
  vouchedByMe: z.boolean(),
});
export type ClassResetRequest = z.infer<typeof ClassResetRequestSchema>;
export const ClassResetRequestsResponseSchema = z.object({ requests: z.array(ClassResetRequestSchema) });
export const ClassResetRequestResponseSchema = z.object({ request: ClassResetRequestSchema });
export const ResetVouchViewSchema = z.object({
  classId: z.string(),
  className: z.string(),
  byAccountId: z.string(),
  byUsername: z.string(),
  at: z.string(),
  /** when the player joined that class: a membership younger than the request deserves a closer look */
  memberSince: z.string(),
});
export type ResetVouchView = z.infer<typeof ResetVouchViewSchema>;
export const AdminPasswordResetRequestSchema = z.object({
  accountId: z.string(),
  username: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** only the vouches that still count: the voucher is an active admin and the player an active member */
  vouches: z.array(ResetVouchViewSchema),
});
export type AdminPasswordResetRequest = z.infer<typeof AdminPasswordResetRequestSchema>;
export const AdminPasswordResetRequestsResponseSchema = z.object({ requests: z.array(AdminPasswordResetRequestSchema) });
// POST /api/auth/logout (body {}) -> 204, clears the cookie
// GET  /api/me -> {account}   (401 when not signed in)
// GET  /api/session -> {account | null}   (always 200: the signed-out probe the browser uses, so a visitor's console stays clean)
export const SessionResponseSchema = z.object({
  account: AccountViewSchema.nullable(),
  /** additive (#184): true when the account may have private cases to play; the browser then asks GET /api/me/cases */
  privateCases: z.boolean().default(false),
});

// ---- guests (#176) --------------------------------------------------------
// POST /api/guest {} -> 201 {account} + cookie: a new guest (kind "guest", approved, username "guest-<id>", which
//                        is never claimed and can't sign in). 200 {account} when the cookie already holds a
//                        session (no new account). 429 "rate-limited" past GUEST_LIMIT per IP.
// POST /api/auth/upgrade {username, password} -> 200 {account, recoveryCode} + a new cookie: the signed-in guest
//                        becomes a user with the SAME id (progress stays) and gets its one-time recovery code
//                        (#174), like register. 409 "username-taken" / "reserved" / "not-guest".
/** Usernames of guests: never claimed, and nobody may sign up or upgrade with one. */
export const GUEST_USERNAME_PREFIX = "guest-";
export const UpgradeRequestSchema = CredentialsSchema;
export type UpgradeRequest = z.infer<typeof UpgradeRequestSchema>;

// ---- DB-stored case content (public, cacheable: Cache-Control public, max-age=60, stale-while-revalidate=600) ----
// GET /api/cases                          -> {cases: CatalogEntry[]}   (published DB cases only; ETag, 304)
// GET /api/cases/:caseId/content?lang=en|he -> {id, version, lang, content: CaseContent}
//                                            (lang is the one served: he falls back to en; ETag, 304; 404 unless published)
//     CaseContentResponseSchema is in ./case-records.ts (server-side schemas).
// Evidence: /evidence/db/<id>/v<n>/files/<path> and /evidence/db/<id>/v<n>.zip (Edge Function; Range, immutable).
// Private cases (#184): never in GET /api/cases. Their content answers no-store and only to the author, the
//   site admin and active members of an assigned class (404 otherwise); its evidence location is
//   /evidence/db/<id>/v<n>~<key>/... with a 128-bit key that no public response carries.
// GET /api/me/cases -> {cases: CatalogEntry[]}   personalised, no-store: the private cases this session may play
export const CasesResponseSchema = z.object({ cases: z.array(CatalogEntrySchema) });

// GET /api/today -> public
export const TodayResponseSchema = z.object({
  date: IsoDateSchema,
  timezone: z.string(),
  caseId: z.string().nullable(),
  /** deprecated (#180): the stored flag, no longer enforced */
  lockToToday: z.boolean(),
  /** case ids with a server-side answer key (playable) */
  releasedCaseIds: z.array(z.string()),
});
export type TodayResponse = z.infer<typeof TodayResponseSchema>;

// Every /api/cases/:caseId/* route needs an APPROVED player account (403 code "pending" / "rejected" /
// "admin" / "password-change-required" otherwise). Every route accepts ?lang=en|he for `unlocked` content.
// Every published case can always be played (#180): no schedule or event window refuses a start or an action.
// GET  /api/cases/:caseId/progress           -> {progress}
// POST /api/cases/:caseId/setup-done  {}     -> {progress}  (q1 becomes active)
// POST /api/cases/:caseId/answer             -> {correct, progress}
// POST /api/cases/:caseId/hint {questionId, expectedHint?} -> {progress}
// POST /api/cases/:caseId/reveal             -> {progress}
// POST /api/cases/:caseId/reveal-command {toolId, expectedStage?} -> {progress}  (−5 on the active stage; free if
//                                             already revealed or the case is completed; 403 "locked" before setup)
// The optional `expected*` fields (#202, #203) name what the client believes it is buying. When the server's state
// differs (another tab bought it, a retried request already did), the route charges nothing and answers 409 code
// "stale" with the current `progress` in the error body. Clients that leave them out keep the old behaviour.
// GET  /api/cases/:caseId/debrief?lang=en|he -> {markdown}  (403 until every stage is finished)
// Event runs (#253): every route above takes an optional run, `run: {classId}` in a POST body and `?run=<classId>`
// on a GET. It plays that class's live event run instead of the player's own record: a separate record that counts
// on the class board only (never on `score:`, `firstblood:`, the global board, achievements or streaks). Refused
// with 403 "not-a-member" (not an active member) or 409 "event-not-live" (the class has no event live now, or the
// case is not assigned to it), never by falling back to the player's own run. The view's `run` names it.
export const ProgressResponseSchema = z.object({ progress: ProgressViewSchema });
export const SetupDoneRequestSchema = z.object({ run: PlayRunSchema.optional() }).strict();
export const AnswerRequestSchema = z.object({ questionId: QuestionIdSchema, answer: z.string().max(200), run: PlayRunSchema.optional() });
export const AnswerResponseSchema = z.object({ correct: z.boolean(), progress: ProgressViewSchema });
export const QuestionRequestSchema = z.object({ questionId: QuestionIdSchema, run: PlayRunSchema.optional() });
/** `expectedHint`: the 0-based index of the hint being bought, i.e. how many hints the client shows as bought. */
export const HintRequestSchema = QuestionRequestSchema.extend({ expectedHint: z.number().int().min(0).max(99).optional() });
/** `expectedStage`: the stage the client shows as active, the one the command is charged to. */
export const RevealCommandRequestSchema = z.object({ toolId: z.string().min(1).max(80), expectedStage: QuestionIdSchema.optional(), run: PlayRunSchema.optional() });
export const DebriefResponseSchema = z.object({ markdown: z.string() });

// GET /api/me/stats -> UserStats
export const UserStatsResponseSchema = z.object({ stats: UserStatsSchema });
// PUT /api/me/board {show} -> {account}   (#175: opt in to / out of the public global leaderboard; approved
//                                          full accounts only, 403 code "guest" for guests; off by default)
export const BoardVisibilityRequestSchema = z.object({ show: z.boolean() }).strict();

// ---- admin ----------------------------------------------------------------
// GET    /api/admin/accounts                    -> {accounts: UserStats[]}   (every account, with stats: a full scan
//                                                  of accounts and progress; scripts only, the console pages below)
// GET    /api/admin/users?q=&kind=&role=&status=&sort=&offset=&limit=  -> AdminUsersResponse  (#185: one page of the
//                                                  filtered accounts, on demand; see AdminUsersQuerySchema)
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
// GET    /api/admin/audit?limit=100             -> {entries: AuditEntry[], names}  (newest first; names: actor and
//                                                  target ids -> username or class name)
// Admin auth: header X-Admin-Key, OR the session cookie of `admin` signed in with the ADMIN_KEY.
export const AdminAccountsResponseSchema = z.object({ generatedAt: z.string(), accounts: z.array(UserStatsSchema) });

/** The console's users list (#185): filtered and sorted on the server, then one page of it. */
export const ADMIN_USERS_PAGE = { DEFAULT_LIMIT: 50, MAX_LIMIT: 200, PENDING_LIMIT: 50 } as const;
export const AdminUserSortSchema = z.enum(["rank", "newest", "seen", "name"]);
export type AdminUserSort = z.infer<typeof AdminUserSortSchema>;
export const AdminUsersQuerySchema = z.object({
  /** a case-insensitive part of the username; empty = everyone */
  q: z.string().trim().max(64).default(""),
  kind: AccountKindSchema.nullable().default(null),
  role: AccountRecordRoleSchema.nullable().default(null),
  status: AccountStatusSchema.nullable().default(null),
  sort: AdminUserSortSchema.default("rank"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(ADMIN_USERS_PAGE.MAX_LIMIT).default(ADMIN_USERS_PAGE.DEFAULT_LIMIT),
});
export type AdminUsersQuery = z.infer<typeof AdminUsersQuerySchema>;
export const AdminUsersResponseSchema = z.object({
  generatedAt: z.string(),
  /** every account in the store, and how many match the filters */
  total: z.number().int().min(0),
  matched: z.number().int().min(0),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
  /** over every account (not just the page): the console's tiles and the pending badge */
  counts: z.object({
    users: z.number().int().min(0),
    guests: z.number().int().min(0),
    authors: z.number().int().min(0),
    pending: z.number().int().min(0),
    approved: z.number().int().min(0),
    rejected: z.number().int().min(0),
    active24h: z.number().int().min(0),
  }),
  /** this page of the matching accounts, in `sort` order */
  accounts: z.array(UserStatsSchema),
  /** the oldest pending sign-ups (at most PENDING_LIMIT), whatever the filters: "Waiting for approval" */
  pending: z.array(UserStatsSchema),
});
export type AdminUsersResponse = z.infer<typeof AdminUsersResponseSchema>;
export const AdminProgressResponseSchema = z.object({ generatedAt: z.string(), caseId: z.string(), players: z.array(AdminProgressSchema) });
export const AdminResetRequestSchema = z.object({ confirm: z.literal("RESET"), caseId: CaseIdSchema.optional() });
export const ScheduleResponseSchema = z.object({ schedule: ScheduleSchema });
export const AdminStatsResponseSchema = z.object({ generatedAt: z.string(), cases: z.array(CaseSummarySchema) });
export const ResetPasswordResponseSchema = z.object({ temporaryPassword: z.string() });
export const ApproveAllResponseSchema = z.object({ approved: z.number().int().min(0) });
export const SettingsResponseSchema = z.object({ settings: SettingsSchema });
export const AuditResponseSchema = z.object({
  entries: z.array(AuditEntrySchema),
  /** additive (#185): display names for the account and class ids among the entries' actors and targets */
  names: z.record(z.string(), z.string()).default({}),
});

// ---- classes (#179) ---------------------------------------------------------
// Any approved full account may own up to CLASS_DEFAULTS.OWNED_LIMIT classes (account.classLimit overrides it) of
// up to CLASS_DEFAULTS.MEMBER_LIMIT members (class.memberLimit, set by the site admin). Personalised: no-store.
// Every class route answers 404 to non-members (never 403), so a class id reveals nothing. Errors:
// 403 "guest" (guests can't create or join), "not-class-admin", "not-class-owner"; 409 "class-limit",
// "class-full", "class-archived", "owner-locked"; 404 for an unknown or archived join code.
// POST /api/classes {name}                          -> 201 {class: ClassDetail}  (creator = owner, active admin member)
// GET  /api/classes                                 -> {classes: ClassSummary[]}  (mine, from memberof:)
// POST /api/classes/join {code}                     -> {class: ClassSummary}  (code: active at once; approval: pending)
// GET  /api/classes/:id                             -> {class: ClassDetail}  (sections by role, see ClassDetailSchema)
// PATCH /api/classes/:id {name?, joinMode?, schedule?, event?, caseIds?} -> {class}   (class admins)
// POST /api/classes/:id/archive {} | /restore {}    -> {class}   (owner or site admin)
// POST /api/classes/:id/join-code/rotate {}         -> {class}   (class admins; the old code stops working)
// POST /api/classes/:id/board-token/rotate {}       -> {class}   (class admins; old board links stop working)
// GET  /api/classes/:id/members                     -> {members: ClassMember[]}  (class admins)
// POST /api/classes/:id/members/:accountId/approve {} | /role {role} -> {member}; .../remove {} -> 204  (docs/API.md)
// POST /api/classes/:id/leave {}                    -> 204  (the owner can't leave: archive instead)
// GET  /api/classes/:id/progress?caseId=<id>       -> {generatedAt, caseId, players: AdminProgress[]}  (class admins,
//                                                     #181: the active members' progress on that case, like the Live tab)
// GET  /api/classboard/:boardToken?caseId=<id>      -> ClassBoardResponse  (#181: public, no cookie, CDN-cached; the
//                                                     token is the capability. Unknown, rotated or archived: 404)
// GET  /api/admin/classes                           -> {classes: AdminClass[]}
// PUT  /api/admin/classes/:id/limits {memberLimit}  -> {class}
// PUT  /api/admin/accounts/:id/class-limit {classLimit} -> {accountId, classLimit}
export const CLASS_DEFAULTS = { OWNED_LIMIT: 3, MEMBER_LIMIT: 60, MAX_MEMBER_LIMIT: 1000, MAX_CLASS_LIMIT: 100 } as const;
export const ClassIdSchema = z.string().regex(/^[0-9A-Za-z]{12}$/, "invalid class id");
export const ClassNameSchema = z.string().trim().min(1, "Name the class").max(60, "Class names are at most 60 characters");
export const ClassStatusSchema = z.enum(["active", "archived"]);
export const ClassJoinModeSchema = z.enum(["code", "approval"]);
export const ClassRoleSchema = z.enum(["member", "admin"]);
export type ClassRole = z.infer<typeof ClassRoleSchema>;
export const ClassMemberStatusSchema = z.enum(["pending", "active"]);
/** Join codes: 2 groups of 5 from the recovery-code alphabet (31^10, about 49 bits); typed case, spaces and dashes don't matter. */
export const CLASS_CODE_GROUPS = 2;
export const normalizeClassCode = (code: string): string => code.toUpperCase().replace(/[\s-]+/g, "");
/** "Our case of the day": like the site schedule, without the lock (gameplay never blocks on a class). */
export const ClassScheduleSchema = z.object({
  timezone: z.string().min(1).max(64),
  defaultCaseId: CaseIdSchema.nullable(),
  days: z.record(IsoDateSchema, CaseIdSchema),
});
export type ClassSchedule = z.infer<typeof ClassScheduleSchema>;
/** The class event night: window, leaderboard freeze and announcement. */
export const ClassEventSchema = EventSchema.omit({ enforceWindow: true });
export type ClassEvent = z.infer<typeof ClassEventSchema>;

export const CreateClassRequestSchema = z.object({ name: ClassNameSchema }).strict();
export const UpdateClassRequestSchema = z
  .object({
    name: ClassNameSchema.optional(),
    joinMode: ClassJoinModeSchema.optional(),
    schedule: ClassScheduleSchema.optional(),
    event: ClassEventSchema.optional(),
    /** assigned cases; [] = any public case */
    caseIds: z.array(CaseIdSchema).max(200).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "nothing to change");
export type UpdateClassRequest = z.infer<typeof UpdateClassRequestSchema>;
export const JoinClassRequestSchema = z.object({ code: z.string().trim().min(1).max(64) }).strict();
export const SetClassRoleRequestSchema = z.object({ role: ClassRoleSchema }).strict();
export const ClassLimitsRequestSchema = z.object({ memberLimit: z.number().int().min(1).max(CLASS_DEFAULTS.MAX_MEMBER_LIMIT) }).strict();
export const AccountClassLimitRequestSchema = z.object({ classLimit: z.number().int().min(0).max(CLASS_DEFAULTS.MAX_CLASS_LIMIT).nullable() }).strict();

/** The caller's place in a class. Null for the site admin, who passes every check without being a member. */
export const ClassMembershipSchema = z.object({ role: ClassRoleSchema, status: ClassMemberStatusSchema, isOwner: z.boolean() });
export type ClassMembership = z.infer<typeof ClassMembershipSchema>;

export const ClassSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: ClassStatusSchema,
  membership: ClassMembershipSchema.nullable(),
});
export type ClassSummary = z.infer<typeof ClassSummarySchema>;

/**
 * Pending members see the summary only. Active members also get `schedule`, `event`, `caseIds` and `boardToken`.
 * Class admins and the site admin also get `admin` (settings and the join code).
 */
export const ClassDetailSchema = ClassSummarySchema.extend({
  schedule: ClassScheduleSchema.optional(),
  event: ClassEventSchema.optional(),
  caseIds: z.array(z.string()).optional(),
  boardToken: z.string().optional(),
  admin: z
    .object({
      ownerId: z.string(),
      joinMode: ClassJoinModeSchema,
      joinCode: z.string(),
      memberLimit: z.number().int().min(1),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .optional(),
});
export type ClassDetail = z.infer<typeof ClassDetailSchema>;

/** What a class admin sees of a member: the username and the membership, nothing else of the account. */
export const ClassMemberSchema = z.object({
  accountId: z.string(),
  username: z.string(),
  role: ClassRoleSchema,
  status: ClassMemberStatusSchema,
  isOwner: z.boolean(),
  joinedAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type ClassMember = z.infer<typeof ClassMemberSchema>;

export const AdminClassSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: ClassStatusSchema,
  ownerId: z.string(),
  joinMode: ClassJoinModeSchema,
  memberLimit: z.number().int().min(1),
  members: z.number().int().min(0),
  createdAt: z.string(),
  /** additive (#185): the owner's username (null when the owner is `admin` or the account is gone) */
  ownerName: z.string().nullable().default(null),
  /** additive (#185): the class's event night (window, freeze, announcement) */
  event: ClassEventSchema.nullable().default(null),
});
export type AdminClass = z.infer<typeof AdminClassSchema>;

export const ClassesResponseSchema = z.object({ classes: z.array(ClassSummarySchema) });
export const ClassResponseSchema = z.object({ class: ClassDetailSchema });
export const ClassJoinResponseSchema = z.object({ class: ClassSummarySchema });
/** POST /api/auth/register: the sign-in answer, plus the class a class code joined (#204). */
export const RegisterResponseSchema = AuthResponseSchema.extend({ class: ClassSummarySchema.optional() });
export const ClassMembersResponseSchema = z.object({ members: z.array(ClassMemberSchema) });
export const ClassMemberResponseSchema = z.object({ member: ClassMemberSchema });
export const AdminClassesResponseSchema = z.object({ classes: z.array(AdminClassSchema) });
export const AccountClassLimitResponseSchema = z.object({ accountId: z.string(), classLimit: z.number().int().min(0).nullable() });

/**
 * The class board (#181): the leaderboard's shape, so the client reuses the leaderboard view, plus the class's
 * name, event and assigned cases. Only the class's active members are listed, and only what counts by the
 * class's window rules (server/domain/class-board.ts). `frozen`/`frozenAt` are the class event's freeze.
 */
export const ClassBoardResponseSchema = LeaderboardResponseSchema.extend({
  classId: z.string(),
  className: z.string(),
  event: ClassEventSchema,
  caseIds: z.array(z.string()),
});
export type ClassBoardResponse = z.infer<typeof ClassBoardResponseSchema>;

// Scoring: solved points = max(0, question.points - sum(cost of the first `hintsRevealed` hints)).
// Rate limit: max 5 wrong answers per account per question per 60s -> 429 with retryAfterSeconds.
// Answer normalization: trim, lowercase, collapse whitespace (one implementation, in ./normalize.ts).
export { normalizeAnswer } from "./normalize.ts";
