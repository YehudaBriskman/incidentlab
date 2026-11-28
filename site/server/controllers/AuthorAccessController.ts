// "Request author access" (#234): the player's own request (/api/me/author-request) and the owner's queue
// (/api/admin/author-requests). Personalised and admin routes: every answer is no-store. Every write is audited.
import { z } from "zod";
import { AUDIT_ADMIN_ACTOR, AuthorAccessRequestCreateSchema } from "../../shared/contract.ts";
import type { AccountAdminService } from "../services/AccountAdminService.ts";
import type { AdminAuthService } from "../services/AdminAuthService.ts";
import type { AuditService } from "../services/AuditService.ts";
import type { AuthorAccessService } from "../services/AuthorAccessService.ts";
import type { AuthService } from "../services/AuthService.ts";
import { json, noContent, parseBody, sessionToken } from "./http.ts";

const EmptyBodySchema = z.object({}).strict();

export class AuthorAccessController {
  private readonly auth: AuthService;
  private readonly access: AuthorAccessService;
  private readonly accounts: AccountAdminService;
  private readonly guard: AdminAuthService;
  private readonly audit: AuditService;

  constructor(deps: { auth: AuthService; access: AuthorAccessService; accounts: AccountAdminService; guard: AdminAuthService; audit: AuditService }) {
    this.auth = deps.auth;
    this.access = deps.access;
    this.accounts = deps.accounts;
    this.guard = deps.guard;
    this.audit = deps.audit;
  }

  /** POST /api/me/author-request {note?} */
  async create(req: Request): Promise<Response> {
    const account = await this.auth.requirePlayer(sessionToken(req));
    const { note } = await parseBody(req, AuthorAccessRequestCreateSchema);
    const request = await this.access.request(account, note ?? null);
    await this.audit.record({ action: "author.request", target: account.id, detail: null, via: "session", actor: account.id });
    return json(201, { request });
  }

  /** GET /api/me/author-request */
  async mine(req: Request): Promise<Response> {
    const account = await this.auth.requirePlayer(sessionToken(req));
    return json(200, { request: await this.access.mine(account) });
  }

  private assertAdmin(req: Request) {
    return this.guard.assertAdmin({ headerKey: req.headers.get("x-admin-key"), sessionToken: sessionToken(req) });
  }

  /** GET /api/admin/author-requests */
  async list(req: Request): Promise<Response> {
    await this.assertAdmin(req);
    return json(200, { requests: await this.access.list() });
  }

  /** POST /api/admin/author-requests/:accountId/approve: grants the author role and closes the request. */
  async approve(req: Request, accountId: string): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    const via = await this.assertAdmin(req);
    await this.access.assertOpen(accountId);
    const account = await this.accounts.setRole(accountId, "author");
    await this.access.close(accountId);
    await this.audit.record({ action: "account.role", target: accountId, detail: "author (request granted)", via, actor: AUDIT_ADMIN_ACTOR });
    return json(200, { account });
  }

  /** POST /api/admin/author-requests/:accountId/reject */
  async reject(req: Request, accountId: string): Promise<Response> {
    await parseBody(req, EmptyBodySchema);
    const via = await this.assertAdmin(req);
    await this.access.close(accountId);
    await this.audit.record({ action: "author.request-decline", target: accountId, detail: null, via, actor: AUDIT_ADMIN_ACTOR });
    return noContent();
  }
}
