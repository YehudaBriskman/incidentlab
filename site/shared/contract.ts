// Shared API contract between the Netlify function (site/server, site/netlify/functions) and the browser (site/src).
// Single source of truth: both sides import these zod schemas. NEVER use `any`.
import { z } from "zod";

export const QuestionIdSchema = z.enum(["q1", "q2", "q3", "q4", "q5", "q6"]);
export type QuestionId = z.infer<typeof QuestionIdSchema>;
export const QUESTION_ORDER: readonly QuestionId[] = ["q1", "q2", "q3", "q4", "q5", "q6"];

// Names: 2–32 chars, unicode letters/digits, space . - _ '   (Hebrew allowed). Rendered ONLY via textContent.
export const PlayerNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[\p{L}\p{N} ._'-]+$/u, "Letters, numbers, spaces and . _ ' - only");

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

export const PlayerViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  caseId: z.string(),
  createdAt: z.string(),
  setupDoneAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  score: z.number().int().min(0),
  maxScore: z.number().int().min(0),
  stages: z.record(QuestionIdSchema, StageProgressSchema),
});
export type PlayerView = z.infer<typeof PlayerViewSchema>;

export const AdminPlayerSchema = PlayerViewSchema.extend({
  lastSeenAt: z.string(),
  currentStage: z.union([QuestionIdSchema, z.literal("setup"), z.literal("done")]),
  stuckMinutes: z.number().min(0), // minutes since current stage started (0 if done)
});
export type AdminPlayer = z.infer<typeof AdminPlayerSchema>;

// ---- Requests / responses -------------------------------------------------
// Auth: player endpoints need header  Authorization: Bearer <token>
//       admin endpoints need header   X-Admin-Key: <ADMIN_KEY env var>
// Errors: non-2xx with body ErrorBody. 400 validation, 401 auth, 403 locked/forbidden, 404, 409, 429 rate limit.

export const ErrorBodySchema = z.object({ error: z.string(), retryAfterSeconds: z.number().optional() });

// POST /api/players
export const CreatePlayerRequestSchema = z.object({ name: PlayerNameSchema, caseId: z.literal("3am-outage") });
export const CreatePlayerResponseSchema = z.object({ token: z.string(), player: PlayerViewSchema });

// GET /api/me
export const MeResponseSchema = z.object({ player: PlayerViewSchema });

// POST /api/setup-done   (body {})  -> marks setup done, q1 becomes active
// POST /api/answer
export const AnswerRequestSchema = z.object({ questionId: QuestionIdSchema, answer: z.string().max(200) });
export const AnswerResponseSchema = z.object({ correct: z.boolean(), player: PlayerViewSchema });

// POST /api/hint   -> reveals the next hint for an ACTIVE stage (hint TEXT lives in client content; server only scores)
export const HintRequestSchema = z.object({ questionId: QuestionIdSchema });
export const PlayerResponseSchema = z.object({ player: PlayerViewSchema });

// POST /api/reveal -> give up on an ACTIVE stage: status=revealed, points=0, revealedAnswer set, next stage active
export const RevealRequestSchema = z.object({ questionId: QuestionIdSchema });

// GET /api/debrief -> 403 until every stage is solved/revealed
export const DebriefResponseSchema = z.object({ markdown: z.string() });

// GET /api/admin/players
export const AdminPlayersResponseSchema = z.object({ generatedAt: z.string(), players: z.array(AdminPlayerSchema) });
// DELETE /api/admin/players/:id   -> 204
// POST /api/admin/reset  body {confirm:"RESET"} -> deletes all players, 204

export const AdminResetRequestSchema = z.object({ confirm: z.literal("RESET") });

// Scoring: solved points = max(0, question.points - sum(cost of the first `hintsRevealed` hints)).
// Rate limit: max 5 wrong answers per player per question per 60s -> 429 with retryAfterSeconds.
// Answer normalization: trim, lowercase, collapse whitespace (same as before).
export const normalizeAnswer = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, " ");
