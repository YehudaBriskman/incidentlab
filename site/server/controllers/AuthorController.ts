// /api/author/*: case upload, publish, rollback, soft delete and restore (#66). Every route resolves the
// caller with AuthorAuthService (admin key or session, or an approved author), and every mutation except
// the individual chunk and part PUTs is written to the audit log.
import { z } from "zod";
import {
  CreateUploadRequestSchema,
  PublishRequestSchema,
  ReviewDecisionRequestSchema,
  SetCaseClassesRequestSchema,
  SubmitReviewRequestSchema,
  UPLOAD_LIMITS,
  UploadIdSchema,
  UploadPartNameSchema,
} from "../../shared/author-contract.ts";
import { CaseIdSchema } from "../../shared/contract.ts";
import { Sha256Schema } from "../../shared/case-records.ts";
import { AppError } from "../domain/types.ts";
import type { AuditService } from "../services/AuditService.ts";
import { actorLabel, ownerId } from "../services/AuthorAuthService.ts";
import type { Actor, AuthorAuthService } from "../services/AuthorAuthService.ts";
import type { CaseAuthoringService } from "../services/CaseAuthoringService.ts";
import type { CaseUploadService } from "../services/CaseUploadService.ts";
import { json, parseBody, readBytes, sessionToken } from "./http.ts";

const EmptyBodySchema = z.object({}).strict();
const ChunkIndexSchema = z.string().regex(/^(0|[1-9][0-9]{0,6})$/, "invalid chunk index").transform(Number);

const valid = <T>(schema: z.ZodType<T>, value: string, what: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(404, `${what} not found`, { code: "not-found" });
  return parsed.data;
};

export class AuthorController {
  private readonly guard: AuthorAuthService;
  private readonly uploads: CaseUploadService;
  private readonly authoring: CaseAuthoringService;
  private readonly audit: AuditService;
  private readonly onPublishedChange: () => Promise<void>;

  constructor(deps: {
    guard: AuthorAuthService;
    uploads: CaseUploadService;
    authoring: CaseAuthoringService;
    audit: AuditService;
    /** called after a publish, rollback, delete or restore: reloads the answer keys the game reads */
    onPublishedChange?: () => Promise<void>;
  }) {
    this.guard = deps.guard;
    this.uploads = deps.uploads;
    this.authoring = deps.authoring;
    this.audit = deps.audit;
    this.onPublishedChange = deps.onPublishedChange ?? (() => Promise.resolve());
  }

  private actor(req: Request): Promise<Actor> {
    return this.guard.resolve({ headerKey: req.headers.get("x-admin-key"), sessionToken: sessionToken(req) });
  }

  private record(actor: Actor, action: string, target: string, detail: string): Promise<void> {
    return this.audit.record({ action, target, detail: `${detail} (by ${actorLabel(actor)})`, via: actor.via, actor: ownerId(actor) });
  }

  /** POST /api/author/uploads */
  async createUpload(req: Request): Promise<Response> {
    const actor = await this.actor(req);
    const body = await parseBody(req, CreateUploadRequestSchema, UPLOAD_LIMITS.maxCreateBodyBytes);
    const result = await this.uploads.create(actor, body);
    await this.record(actor, "case.upload", result.caseId, `upload ${result.uploadId} started, ${result.missingChunks.length} chunk(s) to send`);
    return json(201, result);
  }

  /** PUT /api/author/uploads/:uploadId/chunks/:sha256/:index */
  async putChunk(req: Request, uploadId: string, sha256: string, index: string): Promise<Response> {
    const actor = await this.actor(req);
    const id = valid(UploadIdSchema, uploadId, "upload");
    const sha = valid(Sha256Schema, sha256, "file");
    const n = valid(ChunkIndexSchema, index, "chunk");
    const bytes = await readBytes(req, UPLOAD_LIMITS.chunkBytes);
    return json(200, await this.uploads.putChunk(actor, id, sha, n, bytes));
  }

  /** PUT /api/author/uploads/:uploadId/parts/:name */
  async putPart(req: Request, uploadId: string, name: string): Promise<Response> {
    const actor = await this.actor(req);
    const id = valid(UploadIdSchema, uploadId, "upload");
    const part = UploadPartNameSchema.safeParse(name);
    if (!part.success) throw new AppError(400, `unknown part ${name}; allowed: ${UploadPartNameSchema.options.join(", ")}`, { code: "part-not-allowed" });
    const bytes = await readBytes(req, UPLOAD_LIMITS.maxPartBytes);
    return json(200, await this.uploads.putPart(actor, id, part.data, bytes));
  }

  /** POST /api/author/uploads/:uploadId/finalize */
  async finalize(req: Request, uploadId: string): Promise<Response> {
    const actor = await this.actor(req);
    const id = valid(UploadIdSchema, uploadId, "upload");
    await parseBody(req, EmptyBodySchema);
    const result = await this.uploads.finalize(actor, id);
    const drift = result.diff.answerFingerprintChanged === true ? ", answer key changed" : "";
    await this.record(actor, "case.draft", result.caseId, `draft v${result.version} stored from upload ${id}${drift}`);
    return json(200, result);
  }

  /** GET /api/author/cases */
  async listCases(req: Request): Promise<Response> {
    const actor = await this.actor(req);
    return json(200, { cases: await this.authoring.list(actor) });
  }

  /** POST /api/author/cases/:caseId/publish */
  async publish(req: Request, caseId: string): Promise<Response> {
    const actor = await this.actor(req);
    const id = valid(CaseIdSchema, caseId, "case");
    const body = await parseBody(req, PublishRequestSchema);
    const result = await this.authoring.publish(actor, id, body);
    if (result.changed && result.pendingReview) {
      await this.record(actor, "case.review-submit", id, "v" + String(body.version) + " submitted for review (the public version stays live)");
    } else if (result.changed) {
      const from = result.previousVersion === null ? "first publish" : `was v${result.previousVersion}`;
      const accepted = body.acceptAnswerChanges ? ", answer changes accepted" : "";
      const privately = result.visibility === "private" ? ", private" : "";
      await this.record(actor, result.rollback ? "case.rollback" : "case.publish", id, `v${result.publishedVersion} published (${from})${accepted}${privately}`);
      await this.onPublishedChange();
    }
    return json(200, result);
  }

  /** POST /api/author/cases/:caseId/submit-review (#184) */
  async submitReview(req: Request, caseId: string): Promise<Response> {
    const actor = await this.actor(req);
    const id = valid(CaseIdSchema, caseId, "case");
    await parseBody(req, SubmitReviewRequestSchema);
    const result = await this.authoring.submitReview(actor, id);
    await this.record(actor, "case.review-submit", id, "submitted for review");
    return json(200, { case: result });
  }

  /** PUT /api/author/cases/:caseId/classes {classIds} (#184) */
  async setClasses(req: Request, caseId: string): Promise<Response> {
    const actor = await this.actor(req);
    const id = valid(CaseIdSchema, caseId, "case");
    const body = await parseBody(req, SetCaseClassesRequestSchema);
    const result = await this.authoring.setClasses(actor, id, body.classIds);
    await this.record(actor, "case.classes", id, result.classIds.length === 0 ? "no classes" : `classes ${result.classIds.join(", ")}`);
    await this.onPublishedChange(); // the private-case list the session hint reads
    return json(200, { case: result });
  }

  /** GET /api/admin/reviews (#184): the owner's review queue. */
  async reviews(req: Request): Promise<Response> {
    await this.requireAdmin(req);
    return json(200, { reviews: await this.authoring.reviewQueue() });
  }

  /** POST /api/admin/cases/:caseId/review {decision, note?, acceptAnswerChanges?} (#184) */
  async review(req: Request, caseId: string): Promise<Response> {
    const actor = await this.requireAdmin(req);
    const id = valid(CaseIdSchema, caseId, "case");
    const body = await parseBody(req, ReviewDecisionRequestSchema);
    const result = await this.authoring.decide(id, body);
    const note = body.note === null ? "" : `: ${body.note}`;
    await this.record(actor, body.decision === "approve" ? "case.review-approve" : "case.review-reject", id, `${body.decision === "approve" ? "approved, now public" : "rejected"}${note}`);
    await this.onPublishedChange();
    return json(200, { case: result });
  }

  private async requireAdmin(req: Request): Promise<Actor> {
    const actor = await this.actor(req);
    if (actor.kind !== "admin") throw new AppError(403, "only the site owner reviews cases", { code: "not-admin" });
    return actor;
  }

  /** DELETE /api/author/cases/:caseId */
  async remove(req: Request, caseId: string): Promise<Response> {
    const actor = await this.actor(req);
    const id = valid(CaseIdSchema, caseId, "case");
    const result = await this.authoring.remove(actor, id);
    await this.record(actor, "case.delete", id, `moved to trash ${result.trashId}`);
    await this.onPublishedChange();
    return json(200, result);
  }

  /** POST /api/author/cases/:caseId/restore */
  async restore(req: Request, caseId: string): Promise<Response> {
    const actor = await this.actor(req);
    const id = valid(CaseIdSchema, caseId, "case");
    await parseBody(req, EmptyBodySchema);
    const result = await this.authoring.restore(actor, id);
    await this.record(actor, "case.restore", id, `restored as ${result.status}`);
    await this.onPublishedChange();
    return json(200, result);
  }
}
