// Managing stored cases (#66): list the cases an author may manage, publish a version (rollback is
// publishing an older one), soft delete and restore. Uploads are CaseUploadService.
import type { AuthorCase, PublishResponse } from "../../shared/author-contract.ts";
import { composeCaseMeta } from "../../shared/case-records.ts";
import type { CaseMeta } from "../../shared/case-records.ts";
import type { CaseStatus } from "../../shared/case-records.ts";
import { AppError } from "../domain/types.ts";
import type { CaseRepository } from "../repositories/case-repository.ts";
import type { Versioned } from "../repositories/KvStore.ts";
import type { ProgressRepository } from "../repositories/repositories.ts";
import { assertOwner, ownerId } from "./AuthorAuthService.ts";
import type { Actor } from "./AuthorAuthService.ts";
import type { TrashService } from "./TrashService.ts";

const notFound = (): AppError => new AppError(404, "case not found", { code: "not-found" });

const versionState = (meta: CaseMeta, version: number): AuthorCase["versions"][number]["state"] => {
  if (meta.publishedVersion === version) return "published";
  return meta.publishedVersion === null || version > meta.publishedVersion ? "draft" : "previous";
};

export const toAuthorCase = (meta: CaseMeta): AuthorCase => ({
  id: meta.id,
  title: meta.title,
  status: meta.status,
  publishedVersion: meta.publishedVersion,
  latestVersion: meta.latestVersion,
  langs: meta.langs,
  createdBy: meta.createdBy,
  createdAt: meta.createdAt,
  updatedAt: meta.updatedAt,
  versions: meta.versions.map((v) => ({ ...v, state: versionState(meta, v.version) })),
});

export class CaseAuthoringService {
  private readonly cases: CaseRepository;
  private readonly progress: ProgressRepository;
  private readonly trash: TrashService;
  private readonly bundledFingerprint: (caseId: string) => Promise<string | null>;
  private readonly now: () => Date;

  constructor(deps: {
    cases: CaseRepository;
    progress: ProgressRepository;
    trash: TrashService;
    /** the answer fingerprint of a bundled (pre-DB) case, the drift baseline before a case's first publish */
    bundledFingerprint: (caseId: string) => Promise<string | null>;
    now: () => Date;
  }) {
    this.cases = deps.cases;
    this.progress = deps.progress;
    this.trash = deps.trash;
    this.bundledFingerprint = deps.bundledFingerprint;
    this.now = deps.now;
  }

  private async owned(actor: Actor, caseId: string): Promise<Versioned<CaseMeta>> {
    const found = await this.cases.getMeta(caseId);
    if (!found) throw notFound();
    assertOwner(actor, found.data.createdBy);
    return found;
  }

  /** The cases the actor may manage (the admin: every case), trashed ones included so they can be restored. */
  async list(actor: Actor): Promise<AuthorCase[]> {
    const metas = await this.cases.listMetas();
    const mine = actor.kind === "admin" ? metas : metas.filter((m) => m.createdBy === ownerId(actor));
    return mine.map(toAuthorCase);
  }

  /** True when every record a version needs is stored (finalize writes them after claiming the version). */
  private async isComplete(meta: CaseMeta, version: number): Promise<boolean> {
    const info = meta.versions.find((v) => v.version === version);
    if (!info) return false;
    const [sealed, index, zip, ...content] = await Promise.all([
      this.cases.getSealed(meta.id, version),
      this.cases.getEvidenceIndex(meta.id, version),
      this.cases.getEvidenceZip(meta.id, version),
      ...info.langs.map((lang) => this.cases.getContent(meta.id, version, lang)),
    ]);
    return sealed !== null && index !== null && zip !== null && content.every((c) => c !== null);
  }

  async publish(actor: Actor, caseId: string, input: { version: number; acceptAnswerChanges: boolean }): Promise<PublishResponse> {
    const { data: meta, etag } = await this.owned(actor, caseId);
    if (meta.status === "trashed") throw new AppError(409, "this case is deleted; restore it first", { code: "trashed" });
    const target = meta.versions.find((v) => v.version === input.version);
    if (!target) throw new AppError(404, `version ${input.version} does not exist`, { code: "not-found" });
    const previousVersion = meta.publishedVersion;
    if (previousVersion === input.version && meta.status === "published") {
      return { caseId, publishedVersion: input.version, previousVersion, rollback: false, changed: false };
    }
    if (!(await this.isComplete(meta, input.version))) {
      throw new AppError(409, `version ${input.version} is incomplete (its upload did not finish); upload it again`, { code: "incomplete-version" });
    }

    // The deploy.sh rule: never change what scoring depends on under players who are mid-case, unless told to.
    const baseline = previousVersion === null
      ? await this.bundledFingerprint(caseId)
      : (meta.versions.find((v) => v.version === previousVersion)?.answerFingerprint ?? null);
    if (baseline !== null && baseline !== target.answerFingerprint && !input.acceptAnswerChanges && (await this.progress.hasAny(caseId))) {
      throw new AppError(409, "the answer key, points or hint costs changed and players have progress on this case; reset the case or accept the answer changes", { code: "answer-drift" });
    }

    const next = composeCaseMeta({ ...meta, publishedVersion: input.version, status: "published", updatedAt: this.now().toISOString() });
    if (!(await this.cases.saveMeta(next, etag))) throw new AppError(409, "the case changed meanwhile (another publish?), please retry", { code: "conflict" });
    return { caseId, publishedVersion: input.version, previousVersion, rollback: previousVersion !== null && input.version < previousVersion, changed: true };
  }

  /** Soft delete: the case disappears from every public route; restorable for TRASH_RETENTION_DAYS. */
  async remove(actor: Actor, caseId: string): Promise<{ caseId: string; trashId: string; expiresAt: string }> {
    const { data: meta, etag } = await this.owned(actor, caseId);
    if (meta.status === "trashed") throw new AppError(409, "this case is already deleted", { code: "trashed" });
    const previous: CaseStatus = meta.status;
    const trashId = await this.trash.put({
      kind: "case", label: `case ${caseId}`, account: null, progress: [], firstBlood: {}, caseId, caseStatus: previous,
    });
    const next = composeCaseMeta({ ...meta, status: "trashed", updatedAt: this.now().toISOString() });
    if (!(await this.cases.saveMeta(next, etag))) {
      await this.trash.discard(trashId); // nothing was trashed: drop the entry again
      throw new AppError(409, "the case changed meanwhile, please retry", { code: "conflict" });
    }
    const deletedAt = trashId.slice(0, trashId.lastIndexOf(":"));
    return { caseId, trashId, expiresAt: this.trash.expiresAt(deletedAt) };
  }

  async restore(actor: Actor, caseId: string): Promise<{ caseId: string; status: CaseStatus }> {
    await this.owned(actor, caseId);
    const trashId = await this.trash.findCaseEntry(caseId);
    if (!trashId) throw new AppError(404, "nothing to restore (not deleted, or deleted more than 7 days ago)", { code: "not-found" });
    await this.trash.restore(trashId);
    const meta = (await this.cases.getMeta(caseId))?.data;
    return { caseId, status: meta?.status ?? "draft" };
  }
}
