// /api/author/*: case upload, publish, rollback, soft delete and restore (#66). Every route resolves the
// caller with AuthorAuthService (admin key or session, or an approved author), and every mutation except
// the individual chunk and part PUTs is written to the audit log.
import { z } from "zod";
import {
  CreateUploadRequestSchema,
  PublishRequestSchema,
  UPLOAD_LIMITS,
  UploadIdSchema,
  UploadPartNameSchema,
} from "../../shared/author-contract.ts";
import { CaseIdSchema } from "../../shared/contract.ts";
import { Sha256Schema } from "../../shared/case-records.ts";
import { AppError } from "../domain/types.ts";
import type { AuditService } from "../services/AuditService.ts";
import { actorLabel } from "../services/AuthorAuthService.ts";
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
    return this.audit.record({ action, target, detail: `${detail} (by ${actorLabel(actor)})`, via: actor.via });
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
    if (result.changed) {
      const from = result.previousVersion === null ? "first publish" : `was v${result.previousVersion}`;
      const accepted = body.acceptAnswerChanges ? ", answer changes accepted" : "";
      await this.record(actor, result.rollback ? "case.rollback" : "case.publish", id, `v${result.publishedVersion} published (${from})${accepted}`);
      await this.onPublishedChange();
    }
    return json(200, result);
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
