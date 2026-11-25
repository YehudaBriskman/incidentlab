import { AdminResetRequestSchema } from "../../shared/contract.ts";
import type { AdminAuthService } from "../services/AdminAuthService.ts";
import type { PlayerService } from "../services/PlayerService.ts";
import { json, noContent, parseBody } from "./http.ts";

export class AdminController {
  private readonly service: PlayerService;
  private readonly auth: AdminAuthService;

  constructor(service: PlayerService, auth: AdminAuthService) {
    this.service = service;
    this.auth = auth;
  }

  async listPlayers(req: Request): Promise<Response> {
    this.auth.assertAdmin(req.headers.get("x-admin-key"));
    return json(200, await this.service.listForAdmin());
  }

  async deletePlayer(req: Request, playerId: string): Promise<Response> {
    this.auth.assertAdmin(req.headers.get("x-admin-key"));
    await this.service.deletePlayer(playerId);
    return noContent();
  }

  async reset(req: Request): Promise<Response> {
    this.auth.assertAdmin(req.headers.get("x-admin-key"));
    await parseBody(req, AdminResetRequestSchema);
    await this.service.resetAll();
    return noContent();
  }
}
