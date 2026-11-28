import { AnswerRequestSchema, HintRequestSchema, PlayRunSchema, QuestionRequestSchema, RevealCommandRequestSchema, SetupDoneRequestSchema } from "../../shared/contract.ts";
import type { PlayRun } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { AuthService } from "../services/AuthService.ts";
import type { CaseAccessService } from "../services/CaseAccessService.ts";
import type { EventRunService } from "../services/EventRunService.ts";
import type { GameService, PlayContext } from "../services/GameService.ts";
import { json, parseBody, sessionToken } from "./http.ts";

/** `?run=<classId>` on a GET play route (#253); the POST routes carry `run: {classId}` in the body. */
const runOfQuery = (req: Request): PlayRun | undefined => {
  const classId = new URL(req.url).searchParams.get("run");
  if (classId === null) return undefined;
  const parsed = PlayRunSchema.safeParse({ classId });
  if (!parsed.success) throw new AppError(400, "invalid run");
  return parsed.data;
};

/**
 * /api/cases/:caseId/* — every route needs an approved player account. A private case (#184) answers 404 unless
 * the player is its author or an active member of an assigned class. A route that names an event run (#253) plays
 * it only when EventRunService accepts it.
 */
export class GameController {
  private readonly auth: AuthService;
  private readonly game: GameService;
  private readonly access: CaseAccessService | null;
  private readonly runs: EventRunService | null;

  constructor(deps: { auth: AuthService; game: GameService; access?: CaseAccessService; runs?: EventRunService }) {
    this.auth = deps.auth;
    this.game = deps.game;
    this.access = deps.access ?? null;
    this.runs = deps.runs ?? null;
  }

  /** The context with the event run it names, once EventRunService has accepted it (#253). */
  private async withRun(ctx: PlayContext, run: PlayRun | undefined): Promise<PlayContext> {
    if (run === undefined) return ctx;
    if (!this.runs) throw new AppError(409, "event runs are not available", { code: "event-not-live" });
    return { ...ctx, run: await this.runs.resolve(ctx.player, ctx.caseId, run.classId) };
  }

  private async context(req: Request, caseId: string): Promise<PlayContext> {
    const player = await this.auth.requirePlayer(sessionToken(req));
    await this.access?.assertPlayable(player, caseId);
    const lang = new URL(req.url).searchParams.get("lang") === "he" ? "he" : "en";
    return { player, caseId, lang };
  }

  async progress(req: Request, caseId: string): Promise<Response> {
    const run = runOfQuery(req);
    const ctx = await this.withRun(await this.context(req, caseId), run);
    return json(200, { progress: await this.game.progress(ctx) });
  }

  async setupDone(req: Request, caseId: string): Promise<Response> {
    const base = await this.context(req, caseId);
    const body = await parseBody(req, SetupDoneRequestSchema);
    const ctx = await this.withRun(base, body.run);
    return json(200, { progress: await this.game.setupDone(ctx) });
  }

  async answer(req: Request, caseId: string): Promise<Response> {
    const base = await this.context(req, caseId);
    const body = await parseBody(req, AnswerRequestSchema);
    const ctx = await this.withRun(base, body.run);
    return json(200, await this.game.answer(ctx, body));
  }

  async hint(req: Request, caseId: string): Promise<Response> {
    const base = await this.context(req, caseId);
    const body = await parseBody(req, HintRequestSchema);
    const ctx = await this.withRun(base, body.run);
    return json(200, { progress: await this.game.hint(ctx, body) });
  }

  async revealCommand(req: Request, caseId: string): Promise<Response> {
    const base = await this.context(req, caseId);
    const body = await parseBody(req, RevealCommandRequestSchema);
    const ctx = await this.withRun(base, body.run);
    return json(200, { progress: await this.game.revealCommand(ctx, body) });
  }

  async reveal(req: Request, caseId: string): Promise<Response> {
    const base = await this.context(req, caseId);
    const body = await parseBody(req, QuestionRequestSchema);
    const ctx = await this.withRun(base, body.run);
    return json(200, { progress: await this.game.reveal(ctx, body.questionId) });
  }

  async debrief(req: Request, caseId: string): Promise<Response> {
    const run = runOfQuery(req);
    return json(200, await this.game.debrief(await this.withRun(await this.context(req, caseId), run)));
  }
}
