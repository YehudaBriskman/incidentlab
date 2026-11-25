import { z } from "zod";
import { AnswerRequestSchema, QuestionRequestSchema, RevealCommandRequestSchema } from "../../shared/contract.ts";
import type { AuthService } from "../services/AuthService.ts";
import type { GameService, PlayContext } from "../services/GameService.ts";
import { json, parseBody, sessionToken } from "./http.ts";

const EmptyBodySchema = z.object({}).strict();

/** /api/cases/:caseId/* — every route needs an approved player account. */
export class GameController {
  private readonly auth: AuthService;
  private readonly game: GameService;

  constructor(deps: { auth: AuthService; game: GameService }) {
    this.auth = deps.auth;
    this.game = deps.game;
  }

  private async context(req: Request, caseId: string): Promise<PlayContext> {
    const player = await this.auth.requirePlayer(sessionToken(req));
    const lang = new URL(req.url).searchParams.get("lang") === "he" ? "he" : "en";
    return { player, caseId, lang };
  }

  async progress(req: Request, caseId: string): Promise<Response> {
    return json(200, { progress: await this.game.progress(await this.context(req, caseId)) });
  }

  async setupDone(req: Request, caseId: string): Promise<Response> {
    const ctx = await this.context(req, caseId);
    await parseBody(req, EmptyBodySchema);
    return json(200, { progress: await this.game.setupDone(ctx) });
  }

  async answer(req: Request, caseId: string): Promise<Response> {
    const ctx = await this.context(req, caseId);
    const body = await parseBody(req, AnswerRequestSchema);
    return json(200, await this.game.answer(ctx, body));
  }

  async hint(req: Request, caseId: string): Promise<Response> {
    const ctx = await this.context(req, caseId);
    const body = await parseBody(req, QuestionRequestSchema);
    return json(200, { progress: await this.game.hint(ctx, body.questionId) });
  }

  async revealCommand(req: Request, caseId: string): Promise<Response> {
    const ctx = await this.context(req, caseId);
    const body = await parseBody(req, RevealCommandRequestSchema);
    return json(200, { progress: await this.game.revealCommand(ctx, body.toolId) });
  }

  async reveal(req: Request, caseId: string): Promise<Response> {
    const ctx = await this.context(req, caseId);
    const body = await parseBody(req, QuestionRequestSchema);
    return json(200, { progress: await this.game.reveal(ctx, body.questionId) });
  }

  async debrief(req: Request, caseId: string): Promise<Response> {
    return json(200, await this.game.debrief(await this.context(req, caseId)));
  }
}
