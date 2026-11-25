import { z } from "zod";
import { CredentialsSchema, LoginRequestSchema } from "../../shared/contract.ts";
import type { AuthService } from "../services/AuthService.ts";
import type { ScheduleService } from "../services/ScheduleService.ts";
import type { StatsService } from "../services/StatsService.ts";
import { toAccountView } from "../services/AuthService.ts";
import { json, noContent, parseBody, sessionCookie, sessionToken, withCookie } from "./http.ts";

const EmptyBodySchema = z.object({}).strict();

export class AuthController {
  private readonly auth: AuthService;
  private readonly schedule: ScheduleService;
  private readonly stats: StatsService;

  constructor(deps: { auth: AuthService; schedule: ScheduleService; stats: StatsService }) {
    this.auth = deps.auth;
    this.schedule = deps.schedule;
    this.stats = deps.stats;
  }

  async register(req: Request, ip: string): Promise<Response> {
    const body = await parseBody(req, CredentialsSchema);
    const { account, session } = await this.auth.register({ ...body, ip });
    return withCookie(json(201, { account }), sessionCookie(req, session));
  }

  async login(req: Request, ip: string): Promise<Response> {
    const body = await parseBody(req, LoginRequestSchema);
    const { account, session } = await this.auth.login({ ...body, ip });
    return withCookie(json(200, { account }), sessionCookie(req, session));
  }

  async logout(req: Request): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    await this.auth.logout(sessionToken(req));
    return withCookie(noContent(), sessionCookie(req, null));
  }

  async me(req: Request): Promise<Response> {
    const { account, renewed } = await this.auth.authenticate(sessionToken(req));
    const res = json(200, { account: toAccountView(account) });
    return renewed ? withCookie(res, sessionCookie(req, renewed)) : res;
  }

  async myStats(req: Request): Promise<Response> {
    const { account } = await this.auth.authenticate(sessionToken(req));
    return json(200, { stats: await this.stats.forAccount(account) });
  }

  async today(): Promise<Response> {
    return json(200, await this.schedule.today());
  }
}
