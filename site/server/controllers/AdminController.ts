import { z } from "zod";
import { AUDIT_ADMIN_ACTOR, AccountClassLimitRequestSchema, AdminResetRequestSchema, AdminUsersQuerySchema, CaseIdSchema, EventSchema, ScheduleSchema, SetAccountRoleRequestSchema, SettingsSchema } from "../../shared/contract.ts";
import type { AuditEntry } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { AccountAdminService } from "../services/AccountAdminService.ts";
import type { AdminAuthService } from "../services/AdminAuthService.ts";
import type { AuditService } from "../services/AuditService.ts";
import type { EventService } from "../services/EventService.ts";
import type { ScheduleService } from "../services/ScheduleService.ts";
import type { AccountDirectory, StatsService } from "../services/StatsService.ts";
import type { TrashService } from "../services/TrashService.ts";
import type { PasswordResetService } from "../services/PasswordResetService.ts";
import { json, noContent, parseBody, sessionToken } from "./http.ts";

const EmptyBodySchema = z.object({}).strict();
const ADMIN_CACHE_MS = 2_000;

export type AdminControllerDeps = {
  readonly accounts: AccountAdminService;
  readonly schedule: ScheduleService;
  readonly stats: StatsService;
  readonly events: EventService;
  readonly audit: AuditService;
  readonly trash: TrashService;
  readonly guard: AdminAuthService;
  readonly now: () => Date;
  /** the teacher-vouched reset queue (#254); without it its routes are a 404 */
  readonly resets?: PasswordResetService;
};

export class AdminController {
  private readonly deps: AdminControllerDeps;
  // Several instructor tabs polling every few seconds share one store scan.
  private accountsCache: { at: number; result: Promise<unknown> } | null = null;
  // The console's searches and pages within a moment share one directory read (#185); writes drop it.
  private directoryCache: { at: number; result: Promise<AccountDirectory> } | null = null;

  constructor(deps: AdminControllerDeps) {
    this.deps = deps;
  }

  private assertAdmin(req: Request): Promise<AuditEntry["via"]> {
    return this.deps.guard.assertAdmin({ headerKey: req.headers.get("x-admin-key"), sessionToken: sessionToken(req) });
  }

  /** Authenticates, runs the action, and records it in the audit log. */
  private async mutation<T>(req: Request, audit: { action: string; target?: string | null; detail?: string | null }, run: () => Promise<T>): Promise<T> {
    const via = await this.assertAdmin(req);
    const result = await run();
    this.accountsCache = null;
    this.directoryCache = null;
    await this.deps.audit.record({ ...audit, via, actor: AUDIT_ADMIN_ACTOR });
    return result;
  }

  async listAccounts(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    const nowMs = this.deps.now().getTime();
    if (!this.accountsCache || nowMs - this.accountsCache.at >= ADMIN_CACHE_MS) {
      const result = this.deps.stats.allUsers().then((accounts) => ({ generatedAt: this.deps.now().toISOString(), accounts }));
      result.catch(() => (this.accountsCache = null));
      this.accountsCache = { at: nowMs, result };
    }
    return json(200, await this.accountsCache.result);
  }

  /** GET /api/admin/users (#185): one filtered, sorted page of accounts; the console fetches it on demand. */
  async listUsers(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    const params = new URL(req.url).searchParams;
    // Empty parameters mean "no filter" (the console sends every field).
    const raw = Object.fromEntries([...params.entries()].filter(([, v]) => v !== ""));
    const parsed = AdminUsersQuerySchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0]?.message ?? "invalid query");
    const nowMs = this.deps.now().getTime();
    if (!this.directoryCache || nowMs - this.directoryCache.at >= ADMIN_CACHE_MS) {
      const result = this.deps.stats.directory();
      result.catch(() => (this.directoryCache = null));
      this.directoryCache = { at: nowMs, result };
    }
    return json(200, await this.deps.stats.userPage(await this.directoryCache.result, parsed.data));
  }

  async approve(req: Request, accountId: string): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    const account = await this.mutation(req, { action: "account.approve", target: accountId }, () => this.deps.accounts.setStatus(accountId, "approved"));
    return json(200, { account });
  }

  async setRole(req: Request, accountId: string): Promise<Response> {
    const { role } = await parseBody(req, SetAccountRoleRequestSchema);
    const account = await this.mutation(req, { action: "account.role", target: accountId, detail: role }, () => this.deps.accounts.setRole(accountId, role));
    return json(200, { account });
  }

  async setClassLimit(req: Request, accountId: string): Promise<Response> {
    const { classLimit } = await parseBody(req, AccountClassLimitRequestSchema);
    const result = await this.mutation(req, { action: "account.class-limit", target: accountId, detail: classLimit === null ? "default" : String(classLimit) }, () =>
      this.deps.accounts.setClassLimit(accountId, classLimit),
    );
    return json(200, result);
  }

  async reject(req: Request, accountId: string): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    const account = await this.mutation(req, { action: "account.reject", target: accountId }, () => this.deps.accounts.setStatus(accountId, "rejected"));
    return json(200, { account });
  }

  async approveAll(req: Request): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    let approved = 0;
    await this.mutation(req, { action: "account.approve-all" }, async () => {
      approved = await this.deps.accounts.approveAll();
    });
    return json(200, { approved });
  }

  async resetPassword(req: Request, accountId: string): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    // The console's direct reset skips the vouch queue (#254): the audit says so.
    const temporaryPassword = await this.mutation(req, { action: "account.reset-password", target: accountId, detail: "unvouched" }, () => this.deps.accounts.resetPassword(accountId));
    return json(200, { temporaryPassword });
  }

  // ---- teacher-vouched password resets (#254) ----------------------------------

  private resets(): PasswordResetService {
    if (this.deps.resets === undefined) throw new AppError(404, "not found");
    return this.deps.resets;
  }

  /** GET /api/admin/reset-requests: live requests with at least one valid vouch. */
  async listResetRequests(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    return json(200, { requests: await this.resets().forOwner() });
  }

  /**
   * POST /api/admin/reset-requests/:accountId/approve: the temporary password is in this response only. The audit
   * names who vouched, never the password.
   */
  async approveResetRequest(req: Request, accountId: string): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    const via = await this.assertAdmin(req);
    const { temporaryPassword, vouchedBy } = await this.resets().approve(accountId);
    this.accountsCache = null;
    this.directoryCache = null;
    await this.deps.audit.record({ action: "account.reset-approve", target: accountId, detail: `vouched by ${vouchedBy.join(", ")}`, via, actor: AUDIT_ADMIN_ACTOR });
    return json(200, { temporaryPassword });
  }

  async rejectResetRequest(req: Request, accountId: string): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    await this.mutation(req, { action: "account.reset-reject", target: accountId }, () => this.resets().reject(accountId));
    return noContent();
  }

  async deleteAccount(req: Request, accountId: string): Promise<Response> {
    await this.mutation(req, { action: "account.delete", target: accountId }, () => this.deps.accounts.delete(accountId));
    return noContent();
  }

  async progress(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    const parsed = CaseIdSchema.safeParse(new URL(req.url).searchParams.get("caseId"));
    if (!parsed.success) throw new AppError(400, "caseId query parameter required");
    return json(200, await this.deps.accounts.liveProgress(parsed.data));
  }

  async resetOne(req: Request, accountId: string, caseId: string): Promise<Response> {
    await this.mutation(req, { action: "progress.restart", target: accountId, detail: caseId }, () => this.deps.accounts.resetProgress({ accountId, caseId }));
    return noContent();
  }

  async reset(req: Request): Promise<Response> {
    const body = await parseBody(req, AdminResetRequestSchema);
    await this.mutation(req, { action: "progress.reset", detail: body.caseId ?? "all cases" }, () =>
      this.deps.accounts.resetProgress(body.caseId === undefined ? {} : { caseId: body.caseId }),
    );
    return noContent();
  }

  async getSchedule(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    return json(200, { schedule: await this.deps.schedule.get() });
  }

  async putSchedule(req: Request): Promise<Response> {
    const body = await parseBody(req, ScheduleSchema, 64 * 1024); // a year of daily entries
    const schedule = await this.mutation(req, { action: "schedule.save", detail: `default=${body.defaultCaseId ?? "none"} lock=${body.lockToToday}` }, () =>
      this.deps.schedule.save(body),
    );
    return json(200, { schedule });
  }

  async caseStats(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    return json(200, { generatedAt: this.deps.now().toISOString(), cases: await this.deps.stats.caseSummaries() });
  }

  async getSettings(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    return json(200, { settings: await this.deps.events.settings() });
  }

  async putSettings(req: Request): Promise<Response> {
    const body = await parseBody(req, SettingsSchema);
    const settings = await this.mutation(req, { action: "settings.save", detail: body.inviteCode === null ? "invite code off" : "invite code set" }, () =>
      this.deps.events.saveSettings(body),
    );
    return json(200, { settings });
  }

  async getEvent(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    return json(200, await this.deps.events.get());
  }

  async putEvent(req: Request): Promise<Response> {
    const body = await parseBody(req, EventSchema);
    const result = await this.mutation(req, { action: "event.save", detail: body.name || null }, () => this.deps.events.save(body));
    return json(200, result);
  }

  async exportCsv(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    const csv = await this.deps.accounts.exportCsv();
    const day = this.deps.now().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="incidentlab-results-${day}.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  async listTrash(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    return json(200, { entries: await this.deps.trash.list() });
  }

  async restoreTrash(req: Request, id: string): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    let result = { restored: 0, skipped: 0, label: "" };
    await this.mutation(req, { action: "trash.restore", target: id }, async () => {
      result = await this.deps.trash.restore(id);
    });
    return json(200, { restored: result.restored, skipped: result.skipped });
  }

  async auditLog(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? "100");
    return json(200, await this.deps.audit.page(Number.isFinite(limit) ? limit : 100));
  }
}
