import { z } from "zod";
import { AnswerRequestSchema, QuestionRequestSchema, RevealCommandRequestSchema } from "../../shared/contract.ts";
import type { AuthService } from "../services/AuthService.ts";
import type { CaseAccessService } from "../services/CaseAccessService.ts";
import type { GameService, PlayContext } from "../services/GameService.ts";
import { json, parseBody, sessionToken } from "./http.ts";

const EmptyBodySchema = z.object({}).strict();

/**
 * /api/cases/:caseId/* — every route needs an approved player account. A private case (#184) answers 404 unless
 * the player is its author or an active member of an assigned class.
 */
export class GameController {
  private readonly auth: AuthService;
  private readonly game: GameService;
  private readonly access: CaseAccessService | null;

  constructor(deps: { auth: AuthService; game: GameService; access?: CaseAccessService }) {
    this.auth = deps.auth;
    this.game = deps.game;
    this.access = deps.access ?? null;
  }

  private async context(req: Request, caseId: string): Promise<PlayContext> {
    const player = await this.auth.requirePlayer(sessionToken(req));
    await this.access?.assertPlayable(player, caseId);
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
