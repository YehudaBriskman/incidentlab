// Class routes (#179). Every response is personalised (no-store, the json() default) except the class board (#181),
// which is public and CDN-cached behind its capability token. Every write is audited.
import { z } from "zod";
import {
  AUDIT_ADMIN_ACTOR,
  CaseIdSchema,
  ClassLimitsRequestSchema,
  CreateClassRequestSchema,
  JoinClassRequestSchema,
  SetClassRoleRequestSchema,
  UpdateClassRequestSchema,
} from "../../shared/contract.ts";
import type { AdminClass } from "../../shared/contract.ts";
import { AppError } from "../domain/types.ts";
import type { AdminAuthService } from "../services/AdminAuthService.ts";
import type { AuditService } from "../services/AuditService.ts";
import type { AuthService } from "../services/AuthService.ts";
import type { ClassBoardService } from "../services/ClassBoardService.ts";
import { classBoardTag } from "../services/CachePurger.ts";
import type { ClassActor, ClassService } from "../services/ClassService.ts";
import { PUBLIC_CACHE } from "./AuthController.ts";
import { json, noContent, parseBody, publicJson, sessionToken } from "./http.ts";

const EmptyBodySchema = z.object({}).strict();
/** A year of daily schedule entries, like PUT /api/admin/schedule. */
const MAX_PATCH_BYTES = 64 * 1024;

/** `?caseId=`: null when absent or empty, 400 when it can't be a case id. */
const caseIdParam = (req: Request): string | null => {
  const raw = new URL(req.url).searchParams.get("caseId");
  if (raw === null || raw === "") return null;
  const parsed = CaseIdSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "invalid caseId");
  return parsed.data;
};

export class ClassController {
  private readonly classes: ClassService;
  private readonly boards: ClassBoardService;
  private readonly auth: AuthService;
  private readonly guard: AdminAuthService;
  private readonly audit: AuditService;

  constructor(deps: { classes: ClassService; boards: ClassBoardService; auth: AuthService; guard: AdminAuthService; audit: AuditService }) {
    this.classes = deps.classes;
    this.boards = deps.boards;
    this.auth = deps.auth;
    this.guard = deps.guard;
    this.audit = deps.audit;
  }

  /** The X-Admin-Key header or the admin session make the site admin; anyone else must be an approved player. */
  private async actor(req: Request): Promise<ClassActor> {
    const headerKey = req.headers.get("x-admin-key");
    if (headerKey) return { kind: "site-admin", via: await this.guard.assertAdmin({ headerKey, sessionToken: null }) };
    const principal = await this.auth.requirePlayerOrAdmin(sessionToken(req));
    return principal.kind === "admin" ? { kind: "site-admin", via: "session" } : { kind: "player", account: principal.account };
  }

  private async record(actor: ClassActor, audit: { action: string; target: string | null; detail?: string }): Promise<void> {
    const by = actor.kind === "site-admin" ? "by admin" : `by ${actor.account.username}`;
    await this.audit.record({ action: audit.action, target: audit.target, detail: audit.detail === undefined ? by : `${audit.detail} ${by}`, via: actor.kind === "site-admin" ? actor.via : "session", actor: actor.kind === "site-admin" ? AUDIT_ADMIN_ACTOR : actor.account.id });
  }

  /** Runs a write and audits it once it succeeded. */
  private async write<T>(actor: ClassActor, audit: { action: string; target: string | null; detail?: string }, run: () => Promise<T>): Promise<T> {
    const result = await run();
    await this.record(actor, audit);
    return result;
  }

  async create(req: Request): Promise<Response> {
    const actor = await this.actor(req);
    const { name } = await parseBody(req, CreateClassRequestSchema);
    const created = await this.classes.create(actor, name);
    await this.record(actor, { action: "class.create", target: created.id });
    return json(201, { class: created });
  }

  async mine(req: Request): Promise<Response> {
    return json(200, { classes: await this.classes.mine(await this.actor(req)) });
  }

  async join(req: Request, ip: string): Promise<Response> {
    const actor = await this.actor(req);
    const { code } = await parseBody(req, JoinClassRequestSchema);
    const joined = await this.classes.join(actor, code, ip);
    await this.record(actor, { action: "class.join", target: joined.id, detail: joined.membership?.status ?? "joined" });
    return json(200, { class: joined });
  }

  async detail(req: Request, classId: string): Promise<Response> {
    return json(200, { class: await this.classes.detail(await this.actor(req), classId) });
  }

  async update(req: Request, classId: string): Promise<Response> {
    const actor = await this.actor(req);
    const patch = await parseBody(req, UpdateClassRequestSchema, MAX_PATCH_BYTES);
    const fields = Object.keys(patch).join(",");
    return json(200, { class: await this.write(actor, { action: "class.update", target: classId, detail: fields }, () => this.classes.update(actor, classId, patch)) });
  }

  async archive(req: Request, classId: string): Promise<Response> {
    const actor = await this.actor(req);
    await parseBody(req, EmptyBodySchema);
    return json(200, { class: await this.write(actor, { action: "class.archive", target: classId }, () => this.classes.archive(actor, classId)) });
  }

  async restore(req: Request, classId: string): Promise<Response> {
    const actor = await this.actor(req);
    await parseBody(req, EmptyBodySchema);
    return json(200, { class: await this.write(actor, { action: "class.restore", target: classId }, () => this.classes.restore(actor, classId)) });
  }

  async rotateJoinCode(req: Request, classId: string): Promise<Response> {
    const actor = await this.actor(req);
    await parseBody(req, EmptyBodySchema);
    return json(200, { class: await this.write(actor, { action: "class.join-code.rotate", target: classId }, () => this.classes.rotateJoinCode(actor, classId)) });
  }

  async rotateBoardToken(req: Request, classId: string): Promise<Response> {
    const actor = await this.actor(req);
    await parseBody(req, EmptyBodySchema);
    return json(200, { class: await this.write(actor, { action: "class.board-token.rotate", target: classId }, () => this.classes.rotateBoardToken(actor, classId)) });
  }

  async leave(req: Request, classId: string): Promise<Response> {
    const actor = await this.actor(req);
    await parseBody(req, EmptyBodySchema);
    await this.write(actor, { action: "class.leave", target: classId }, () => this.classes.leave(actor, classId));
    return noContent();
  }

  async members(req: Request, classId: string): Promise<Response> {
    return json(200, { members: await this.classes.members(await this.actor(req), classId) });
  }

  async approve(req: Request, classId: string, accountId: string): Promise<Response> {
    const actor = await this.actor(req);
    await parseBody(req, EmptyBodySchema);
    const member = await this.write(actor, { action: "class.member.approve", target: classId, detail: accountId }, () => this.classes.approve(actor, classId, accountId));
    return json(200, { member });
  }

  async remove(req: Request, classId: string, accountId: string): Promise<Response> {
    const actor = await this.actor(req);
    await parseBody(req, EmptyBodySchema);
    await this.write(actor, { action: "class.member.remove", target: classId, detail: accountId }, () => this.classes.remove(actor, classId, accountId));
    return noContent();
  }

  async setRole(req: Request, classId: string, accountId: string): Promise<Response> {
    const actor = await this.actor(req);
    const { role } = await parseBody(req, SetClassRoleRequestSchema);
    const member = await this.write(actor, { action: "class.member.role", target: classId, detail: `${accountId}=${role}` }, () => this.classes.setRole(actor, classId, accountId, role));
    return json(200, { member });
  }

  /** GET /api/classes/:id/progress?caseId=: class admins' live view of their active members on one case (no-store). */
  async progress(req: Request, classId: string): Promise<Response> {
    const actor = await this.actor(req);
    const caseId = caseIdParam(req);
    const record = await this.classes.requireClassAdmin(actor, classId);
    if (caseId === null) throw new AppError(400, "caseId is required");
    return json(200, await this.boards.liveProgress(record, caseId));
  }

  /**
   * GET /api/classboard/:boardToken?caseId=: public, never reads or sets the session, so the CDN may serve it to
   * every member and the projector (one function call per cache window per URL). Unknown tokens are a no-store 404.
   */
  async board(req: Request, token: string): Promise<Response> {
    const caseId = caseIdParam(req);
    const board = await this.boards.board(token, caseId);
    return publicJson(board, { ...PUBLIC_CACHE.classBoard, tags: [classBoardTag(board.classId)] });
  }

  // ---- site admin only ---------------------------------------------------------

  private async siteAdmin(req: Request): Promise<ClassActor> {
    return { kind: "site-admin", via: await this.guard.assertAdmin({ headerKey: req.headers.get("x-admin-key"), sessionToken: sessionToken(req) }) };
  }

  async adminList(req: Request): Promise<Response> {
    await this.siteAdmin(req);
    const classes: AdminClass[] = (await this.classes.adminList()).map(({ record, members, ownerName }) => ({
      id: record.id, name: record.name, status: record.status, ownerId: record.ownerId, joinMode: record.joinMode,
      memberLimit: record.memberLimit, members, createdAt: record.createdAt, ownerName, event: record.event,
    }));
    return json(200, { classes });
  }

  async setLimits(req: Request, classId: string): Promise<Response> {
    const actor = await this.siteAdmin(req);
    const { memberLimit } = await parseBody(req, ClassLimitsRequestSchema);
    const detail = await this.write(actor, { action: "class.limits", target: classId, detail: `memberLimit=${memberLimit}` }, () => this.classes.setMemberLimit(actor, classId, memberLimit));
    return json(200, { class: detail });
  }
}
