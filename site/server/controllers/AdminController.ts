import { z } from "zod";
import { AdminResetRequestSchema, CaseIdSchema, ScheduleSchema } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { AccountAdminService } from "../services/AccountAdminService.ts";
import type { AdminAuthService } from "../services/AdminAuthService.ts";
import type { ScheduleService } from "../services/ScheduleService.ts";
import type { StatsService } from "../services/StatsService.ts";
import { json, noContent, parseBody } from "./http.ts";

const EmptyBodySchema = z.object({}).strict();
const ADMIN_CACHE_MS = 2_000;

export class AdminController {
  private readonly accounts: AccountAdminService;
  private readonly schedule: ScheduleService;
  private readonly stats: StatsService;
  private readonly auth: () => AdminAuthService;
  private readonly now: () => Date;
  // Several instructor tabs polling every few seconds share one store scan.
  private accountsCache: { at: number; result: Promise<unknown> } | null = null;

  constructor(deps: { accounts: AccountAdminService; schedule: ScheduleService; stats: StatsService; auth: () => AdminAuthService; now: () => Date }) {
    this.accounts = deps.accounts;
    this.schedule = deps.schedule;
    this.stats = deps.stats;
    this.auth = deps.auth;
    this.now = deps.now;
  }

  private assertAdmin(req: Request): void {
    this.auth().assertAdmin(req.headers.get("x-admin-key"));
  }

  private invalidate(): void {
    this.accountsCache = null;
  }

  async listAccounts(req: Request): Promise<Response> {
    this.assertAdmin(req);
    const nowMs = this.now().getTime();
    if (!this.accountsCache || nowMs - this.accountsCache.at >= ADMIN_CACHE_MS) {
      const result = this.stats.allUsers().then((accounts) => ({ generatedAt: this.now().toISOString(), accounts }));
      result.catch(() => this.invalidate());
      this.accountsCache = { at: nowMs, result };
    }
    return json(200, await this.accountsCache.result);
  }

  async approve(req: Request, accountId: string): Promise<Response> {
    this.assertAdmin(req);
    await parseBody(req, EmptyBodySchema);
    this.invalidate();
    return json(200, { account: await this.accounts.setStatus(accountId, "approved") });
  }

  async reject(req: Request, accountId: string): Promise<Response> {
    this.assertAdmin(req);
    await parseBody(req, EmptyBodySchema);
    this.invalidate();
    return json(200, { account: await this.accounts.setStatus(accountId, "rejected") });
  }

  async deleteAccount(req: Request, accountId: string): Promise<Response> {
    this.assertAdmin(req);
    await this.accounts.delete(accountId);
    this.invalidate();
    return noContent();
  }

  async progress(req: Request): Promise<Response> {
    this.assertAdmin(req);
    const parsed = CaseIdSchema.safeParse(new URL(req.url).searchParams.get("caseId"));
    if (!parsed.success) throw new AppError(400, "caseId query parameter required");
    return json(200, await this.accounts.liveProgress(parsed.data));
  }

  async resetOne(req: Request, accountId: string, caseId: string): Promise<Response> {
    this.assertAdmin(req);
    await this.accounts.resetProgress({ accountId, caseId });
    this.invalidate();
    return noContent();
  }

  async reset(req: Request): Promise<Response> {
    this.assertAdmin(req);
    const body = await parseBody(req, AdminResetRequestSchema);
    await this.accounts.resetProgress(body.caseId === undefined ? {} : { caseId: body.caseId });
    this.invalidate();
    return noContent();
  }

  async getSchedule(req: Request): Promise<Response> {
    this.assertAdmin(req);
    return json(200, { schedule: await this.schedule.get() });
  }

  async putSchedule(req: Request): Promise<Response> {
    this.assertAdmin(req);
    const body = await parseBody(req, ScheduleSchema, 64 * 1024); // a year of daily entries
    return json(200, { schedule: await this.schedule.save(body) });
  }

  async caseStats(req: Request): Promise<Response> {
    this.assertAdmin(req);
    return json(200, { generatedAt: this.now().toISOString(), cases: await this.stats.caseSummaries() });
  }
}
