import { z } from "zod";
import {
  BoardVisibilityRequestSchema,
  CaseIdSchema,
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  RecoverRequestSchema,
  RegenerateRecoveryCodeRequestSchema,
  RegisterRequestSchema,
} from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { AuthService } from "../services/AuthService.ts";
import type { CaseAccessService, CaseViewer } from "../services/CaseAccessService.ts";
import type { EventService } from "../services/EventService.ts";
import type { GlobalBoardService } from "../services/GlobalBoardService.ts";
import type { ScheduleService } from "../services/ScheduleService.ts";
import type { StatsService } from "../services/StatsService.ts";
import { json, noContent, parseBody, publicJson, sessionCookie, sessionToken, withCookie } from "./http.ts";

/**
 * CDN windows for the public GETs (seconds). Every open tab polls /api/event and the leaderboard, so each cached
 * window costs one function call however many players are watching. Instructor writes purge by tag at once;
 * these bounds only apply to changes nobody purges (answers moving the leaderboard, a case being published).
 */
export const PUBLIC_CACHE = {
  event: { maxAgeSeconds: 10, staleSeconds: 20 },
  leaderboard: { maxAgeSeconds: 10, staleSeconds: 20 },
  /** a class board (#181): like the leaderboard; class edits purge its `class:<id>` tag, solves don't */
  classBoard: { maxAgeSeconds: 10, staleSeconds: 20 },
  today: { maxAgeSeconds: 60, staleSeconds: 60 },
} as const;

const EmptyBodySchema = z.object({}).strict();

/** Accounts, sessions and the public read-only endpoints (today, event, leaderboard). */
export class AuthController {
  private readonly auth: AuthService;
  private readonly schedule: ScheduleService;
  private readonly stats: StatsService;
  private readonly events: EventService;
  private readonly board: GlobalBoardService;
  private readonly access: CaseAccessService | null;

  constructor(deps: { auth: AuthService; schedule: ScheduleService; stats: StatsService; events: EventService; board: GlobalBoardService; access?: CaseAccessService }) {
    this.access = deps.access ?? null;
    this.auth = deps.auth;
    this.schedule = deps.schedule;
    this.stats = deps.stats;
    this.events = deps.events;
    this.board = deps.board;
  }

  async register(req: Request, ip: string): Promise<Response> {
    const body = await parseBody(req, RegisterRequestSchema);
    const { account, session, recoveryCode, joinedClass } = await this.auth.register({ ...body, ip });
    const body201 = { account, ...(recoveryCode === null ? {} : { recoveryCode }), ...(joinedClass === null ? {} : { class: joinedClass }) };
    return withCookie(json(201, body201), sessionCookie(req, session));
  }

  async login(req: Request, ip: string): Promise<Response> {
    const body = await parseBody(req, LoginRequestSchema);
    const { account, session, recoveryCode } = await this.auth.login({ ...body, ip });
    return withCookie(json(200, { account, ...(recoveryCode === null ? {} : { recoveryCode }) }), sessionCookie(req, session));
  }

  /** Forgotten password: a recovery code sets a new one. No cookie: the player signs in afterwards. */
  async recover(req: Request, ip: string): Promise<Response> {
    const body = await parseBody(req, RecoverRequestSchema);
    return json(200, await this.auth.recover({ ...body, ip }));
  }

  async regenerateRecoveryCode(req: Request): Promise<Response> {
    const body = await parseBody(req, RegenerateRecoveryCodeRequestSchema);
    return json(200, await this.auth.regenerateRecoveryCode(sessionToken(req), body));
  }

  async logout(req: Request): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    await this.auth.logout(sessionToken(req));
    return withCookie(noContent(), sessionCookie(req, null));
  }

  async me(req: Request): Promise<Response> {
    const { view, renewed } = await this.auth.authenticate(sessionToken(req));
    const res = json(200, { account: view });
    return renewed ? withCookie(res, sessionCookie(req, renewed)) : res;
  }

  /**
   * Like `me`, but a missing, expired or revoked session is `{account: null}` with 200 instead of a 401.
   * `privateCases` (#184) tells the browser whether to ask GET /api/me/cases for private cases it may play.
   */
  async session(req: Request): Promise<Response> {
    try {
      const { principal, view, renewed } = await this.auth.authenticate(sessionToken(req));
      const viewer: CaseViewer = principal.kind === "admin" ? { kind: "admin" } : { kind: "account", accountId: principal.account.id };
      const privateCases = this.access !== null && (await this.access.hasPrivateCases(viewer));
      const res = json(200, { account: view, privateCases });
      return renewed ? withCookie(res, sessionCookie(req, renewed)) : res;
    } catch (error: unknown) {
      if (error instanceof AppError && error.status === 401) return json(200, { account: null });
      throw error;
    }
  }

  async changePassword(req: Request): Promise<Response> {
    const body = await parseBody(req, ChangePasswordRequestSchema);
    const { account, session } = await this.auth.changePassword(sessionToken(req), body);
    return withCookie(json(200, { account }), sessionCookie(req, session));
  }

  async myStats(req: Request): Promise<Response> {
    const { principal } = await this.auth.authenticate(sessionToken(req));
    if (principal.kind === "admin") throw new AppError(403, "the admin account has no player stats", { code: "admin" });
    return json(200, { stats: await this.stats.forAccount(principal.account) });
  }

  /** PUT /api/me/board {show}: opt in to or out of the public global leaderboard (personalised: no-store). */
  async setBoard(req: Request): Promise<Response> {
    const player = await this.auth.requirePlayer(sessionToken(req));
    const body = await parseBody(req, BoardVisibilityRequestSchema);
    return json(200, { account: await this.board.setShown(player, body.show) });
  }

  // The three public GETs below never read the session: the CDN may serve them to everyone (publicJson).
  async today(): Promise<Response> {
    const today = await this.schedule.today();
    // Never let a cached "today" outlive its day: cap both windows at the seconds left until midnight there.
    const left = this.schedule.secondsUntilNextDay(today.timezone);
    const maxAgeSeconds = Math.min(PUBLIC_CACHE.today.maxAgeSeconds, left);
    const staleSeconds = Math.min(PUBLIC_CACHE.today.staleSeconds, Math.max(0, left - maxAgeSeconds));
    return publicJson(today, { maxAgeSeconds, staleSeconds, tags: ["today"] });
  }

  async event(): Promise<Response> {
    return publicJson(await this.events.get(), { ...PUBLIC_CACHE.event, tags: ["event"] });
  }

  async leaderboard(req: Request): Promise<Response> {
    const raw = new URL(req.url).searchParams.get("caseId");
    const parsed = raw === null || raw === "" ? null : CaseIdSchema.safeParse(raw);
    if (parsed && !parsed.success) throw new AppError(400, "invalid caseId");
    const board = await this.stats.leaderboard({ caseId: parsed ? parsed.data : null, frozenAt: await this.events.freezeMoment() });
    return publicJson(board, { ...PUBLIC_CACHE.leaderboard, tags: ["leaderboard"] });
  }
}
