import { z } from "zod";
import { AnswerRequestSchema, QuestionRequestSchema } from "../../shared/contract.ts";
import type { AuthService } from "../services/AuthService.ts";
import type { GameService } from "../services/GameService.ts";
import { json, parseBody, sessionToken } from "./http.ts";

const EmptyBodySchema = z.object({}).strict();

/** /api/cases/:caseId/* — every route needs an approved account. */
export class GameController {
  private readonly auth: AuthService;
  private readonly game: GameService;

  constructor(deps: { auth: AuthService; game: GameService }) {
    this.auth = deps.auth;
    this.game = deps.game;
  }

  async progress(req: Request, caseId: string): Promise<Response> {
    const player = await this.auth.requireApproved(sessionToken(req));
    return json(200, { progress: await this.game.progress(player, caseId) });
  }

  async setupDone(req: Request, caseId: string): Promise<Response> {
    const player = await this.auth.requireApproved(sessionToken(req));
    await parseBody(req, EmptyBodySchema);
    return json(200, { progress: await this.game.setupDone(player, caseId) });
  }

  async answer(req: Request, caseId: string): Promise<Response> {
    const player = await this.auth.requireApproved(sessionToken(req));
    const body = await parseBody(req, AnswerRequestSchema);
    return json(200, await this.game.answer(player, caseId, body));
  }

  async hint(req: Request, caseId: string): Promise<Response> {
    const player = await this.auth.requireApproved(sessionToken(req));
    const body = await parseBody(req, QuestionRequestSchema);
    return json(200, { progress: await this.game.hint(player, caseId, body.questionId) });
  }

  async reveal(req: Request, caseId: string): Promise<Response> {
    const player = await this.auth.requireApproved(sessionToken(req));
    const body = await parseBody(req, QuestionRequestSchema);
    return json(200, { progress: await this.game.reveal(player, caseId, body.questionId) });
  }

  async debrief(req: Request, caseId: string): Promise<Response> {
    const player = await this.auth.requireApproved(sessionToken(req));
    const lang = new URL(req.url).searchParams.get("lang") === "he" ? "he" : "en";
    return json(200, await this.game.debrief(player, caseId, lang));
  }
}
