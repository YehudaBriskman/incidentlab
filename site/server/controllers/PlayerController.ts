import { z } from "zod";
import { AnswerRequestSchema, CreatePlayerRequestSchema, HintRequestSchema, RevealRequestSchema } from "../../shared/contract.ts";
import type { PlayerService } from "../services/PlayerService.ts";
import { bearerToken, json, parseBody } from "./http.ts";

const EmptyBodySchema = z.object({}).strict();

export class PlayerController {
  private readonly service: PlayerService;

  constructor(service: PlayerService) {
    this.service = service;
  }

  async create(req: Request, ip: string): Promise<Response> {
    const body = await parseBody(req, CreatePlayerRequestSchema);
    return json(201, await this.service.createPlayer({ name: body.name, caseId: body.caseId, ip }));
  }

  async me(req: Request): Promise<Response> {
    return json(200, { player: await this.service.me(bearerToken(req)) });
  }

  async setupDone(req: Request): Promise<Response> {
    const token = bearerToken(req);
    await parseBody(req, EmptyBodySchema);
    return json(200, { player: await this.service.setupDone(token) });
  }

  async answer(req: Request): Promise<Response> {
    const token = bearerToken(req);
    const body = await parseBody(req, AnswerRequestSchema);
    return json(200, await this.service.answer(token, body.questionId, body.answer));
  }

  async hint(req: Request): Promise<Response> {
    const token = bearerToken(req);
    const body = await parseBody(req, HintRequestSchema);
    return json(200, { player: await this.service.hint(token, body.questionId) });
  }

  async reveal(req: Request): Promise<Response> {
    const token = bearerToken(req);
    const body = await parseBody(req, RevealRequestSchema);
    return json(200, { player: await this.service.reveal(token, body.questionId) });
  }

  async debrief(req: Request): Promise<Response> {
    return json(200, await this.service.debrief(bearerToken(req)));
  }
}
