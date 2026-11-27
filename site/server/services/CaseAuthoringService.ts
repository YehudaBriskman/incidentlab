// Managing stored cases (#66): list the cases an author may manage, publish a version (rollback is
// publishing an older one), soft delete and restore. Uploads are CaseUploadService.
//
// Private cases and owner review (#184):
// - An author's publish of a case that is not public yet makes (or keeps) it private: it is live for its author,
//   the site admin and active members of the classes in `classIds`, and nowhere else.
// - An author's publish of another version of a PUBLIC case does not go live. It becomes `pendingVersion`,
//   submitted for review, and the public version stays live. The owner's approval makes it the published version.
//   (Re-review is the safer rule: a public case can't change under players without the owner seeing it.)
// - The site admin's publish keeps the case's visibility, or sets the one it asks for.
// - Submit for review, class assignment (classes the author admins), and the owner's approve / reject.
import { randomBytes } from "node:crypto";
import type { AuthorCase, PublishResponse, ReviewDecisionRequest, ReviewItem } from "../../shared/author-contract.ts";
import { composeCaseMeta } from "../../shared/case-records.ts";
import type { CaseMeta, CaseStatus, CaseVisibility } from "../../shared/case-records.ts";
import { AppError } from "../domain/types.ts";
import type { CaseRepository } from "../repositories/case-repository.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import type { Versioned } from "../repositories/KvStore.ts";
import type { AccountRepository, ProgressRepository } from "../repositories/repositories.ts";
import { assertOwner, ownerId } from "./AuthorAuthService.ts";
import type { Actor } from "./AuthorAuthService.ts";
import type { ClassService } from "./ClassService.ts";
import type { TrashService } from "./TrashService.ts";

const notFound = (): AppError => new AppError(404, "case not found", { code: "not-found" });
const conflict = (): AppError => new AppError(409, "the case changed meanwhile, please retry", { code: "conflict" });

const versionState = (meta: CaseMeta, version: number): AuthorCase["versions"][number]["state"] => {
  if (meta.publishedVersion === version) return "published";
  if (meta.pendingVersion === version) return "pending";
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
  visibility: meta.visibility,
  review: meta.review,
  reviewNote: meta.reviewNote,
  reviewAt: meta.reviewAt,
  classIds: [...meta.classIds],
  pendingVersion: meta.pendingVersion,
});

/** True when the case has a live public version (what every public route serves). */
const isPublicNow = (meta: CaseMeta): boolean => meta.visibility === "public" && meta.publishedVersion !== null;
/** The version the owner is asked to approve: a public case's pending version, else the private published one. */
const reviewedVersion = (meta: CaseMeta): number | null => meta.pendingVersion ?? meta.publishedVersion;
const newEvidenceKey = (): string => randomBytes(16).toString("hex");

export class CaseAuthoringService {
  private readonly cases: CaseRepository;
  private readonly progress: ProgressRepository;
  private readonly accounts: AccountRepository | null;
  private readonly classes: ClassService | null;
  private readonly trash: TrashService;
  private readonly bundledFingerprint: (caseId: string) => Promise<string | null>;
  private readonly now: () => Date;

  constructor(deps: {
    cases: CaseRepository;
    progress: ProgressRepository;
    /** usernames for the review queue (#184) */
    accounts?: AccountRepository;
    /** class admin checks for class assignment (#184) */
    classes?: ClassService;
    trash: TrashService;
    /** the answer fingerprint of a bundled (pre-DB) case, the drift baseline before a case's first publish */
    bundledFingerprint: (caseId: string) => Promise<string | null>;
    now: () => Date;
  }) {
    this.cases = deps.cases;
    this.progress = deps.progress;
    this.accounts = deps.accounts ?? null;
    this.classes = deps.classes ?? null;
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

  private async save(next: CaseMeta, etag: string): Promise<CaseMeta> {
    if (!(await this.cases.saveMeta(next, etag))) throw conflict();
    return next;
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

  /** The deploy.sh rule: never change what scoring depends on under players who are mid-case, unless told to. */
  private async assertNoDrift(meta: CaseMeta, version: number, acceptAnswerChanges: boolean): Promise<void> {
    const target = meta.versions.find((v) => v.version === version);
    if (!target) throw new AppError(404, `version ${version} does not exist`, { code: "not-found" });
    const previousVersion = meta.publishedVersion;
    const baseline = previousVersion === null
      ? await this.bundledFingerprint(meta.id)
      : (meta.versions.find((v) => v.version === previousVersion)?.answerFingerprint ?? null);
    if (baseline !== null && baseline !== target.answerFingerprint && !acceptAnswerChanges && (await this.progress.hasAny(meta.id))) {
      throw new AppError(409, "the answer key, points or hint costs changed and players have progress on this case; reset the case or accept the answer changes", { code: "answer-drift" });
    }
  }

  async publish(actor: Actor, caseId: string, input: { version: number; acceptAnswerChanges: boolean; visibility?: CaseVisibility | undefined }): Promise<PublishResponse> {
    const { data: meta, etag } = await this.owned(actor, caseId);
    if (meta.status === "trashed") throw new AppError(409, "this case is deleted; restore it first", { code: "trashed" });
    if (input.visibility !== undefined && actor.kind !== "admin") {
      throw new AppError(403, "only the site owner sets a case's visibility; submit it for review instead", { code: "not-admin" });
    }
    const target = meta.versions.find((v) => v.version === input.version);
    if (!target) throw new AppError(404, `version ${input.version} does not exist`, { code: "not-found" });
    const previousVersion = meta.publishedVersion;
    const visibility: CaseVisibility = actor.kind === "admin"
      ? (input.visibility ?? meta.visibility)
      : (isPublicNow(meta) ? "public" : "private");
    const unchanged = { caseId, publishedVersion: input.version, previousVersion, rollback: false, changed: false, pendingReview: false, visibility };
    if (previousVersion === input.version && meta.status === "published" && meta.visibility === visibility) return unchanged;
    if (!(await this.isComplete(meta, input.version))) {
      throw new AppError(409, `version ${input.version} is incomplete (its upload did not finish); upload it again`, { code: "incomplete-version" });
    }
    const nowIso = this.now().toISOString();

    // An author's new version of a public case waits for the owner; the public version stays live.
    if (actor.kind === "author" && isPublicNow(meta) && previousVersion !== null) {
      if (meta.pendingVersion === input.version && meta.review === "submitted") {
        return { ...unchanged, publishedVersion: previousVersion, pendingReview: true, visibility: "public" };
      }
      await this.save(composeCaseMeta({
        ...meta, pendingVersion: input.version, review: "submitted", reviewNote: null, reviewAt: nowIso, updatedAt: nowIso,
      }), etag);
      return { caseId, publishedVersion: previousVersion, previousVersion, rollback: false, changed: true, pendingReview: true, visibility: "public" };
    }

    await this.assertNoDrift(meta, input.version, input.acceptAnswerChanges);
    // Publishing privately changes what a submitted review would approve: the author submits again.
    const review = visibility === "private" && meta.review === "submitted" ? "none" : meta.review;
    const next = composeCaseMeta({
      ...meta,
      publishedVersion: input.version,
      status: "published",
      visibility,
      review,
      reviewAt: review === meta.review ? meta.reviewAt : nowIso,
      pendingVersion: meta.pendingVersion === input.version || visibility === "private" ? null : meta.pendingVersion,
      evidenceKey: visibility === "private" ? (meta.evidenceKey ?? newEvidenceKey()) : meta.evidenceKey,
      updatedAt: nowIso,
    });
    await this.save(next, etag);
    return { caseId, publishedVersion: input.version, previousVersion, rollback: previousVersion !== null && input.version < previousVersion, changed: true, pendingReview: false, visibility };
  }

  /** The author asks the owner to make the case public (or to approve a public case's pending version). */
  async submitReview(actor: Actor, caseId: string): Promise<AuthorCase> {
    const { data: meta, etag } = await this.owned(actor, caseId);
    if (meta.status === "trashed") throw new AppError(409, "this case is deleted; restore it first", { code: "trashed" });
    if (meta.status !== "published" || meta.publishedVersion === null) {
      throw new AppError(409, "publish the case (privately) first, so it can be tried out", { code: "not-published" });
    }
    if (isPublicNow(meta) && meta.pendingVersion === null) throw new AppError(409, "this case is already public", { code: "already-public" });
    if (meta.review === "submitted") return toAuthorCase(meta);
    const nowIso = this.now().toISOString();
    return toAuthorCase(await this.save(composeCaseMeta({ ...meta, review: "submitted", reviewNote: null, reviewAt: nowIso, updatedAt: nowIso }), etag));
  }

  /**
   * Sets the classes whose active members may play the case while it is private. Every class added must be one
   * the author is an active admin of; the site admin may assign any existing class. Removing needs no check.
   */
  async setClasses(actor: Actor, caseId: string, classIds: readonly string[]): Promise<AuthorCase> {
    const { data: meta, etag } = await this.owned(actor, caseId);
    if (meta.status === "trashed") throw new AppError(409, "this case is deleted; restore it first", { code: "trashed" });
    const wanted = [...new Set(classIds)];
    const added = wanted.filter((id) => !meta.classIds.includes(id));
    for (const classId of added) {
      const allowed = this.classes === null
        ? false
        : actor.kind === "admin"
          ? await this.classes.exists(classId)
          : await this.classes.isActiveClassAdmin(actor.accountId, classId);
      if (!allowed) throw new AppError(403, `you are not an admin of class ${classId}`, { code: "not-class-admin" });
    }
    return toAuthorCase(await this.save(composeCaseMeta({ ...meta, classIds: wanted, updatedAt: this.now().toISOString() }), etag));
  }

  /** The owner's queue: every case waiting for review, oldest submission first. */
  async reviewQueue(): Promise<ReviewItem[]> {
    const waiting = (await this.cases.listMetas()).filter((m) => m.review === "submitted" && m.status === "published");
    const items = await mapWithConcurrency(waiting, async (meta): Promise<ReviewItem | null> => {
      const version = reviewedVersion(meta);
      if (version === null) return null;
      const account = this.accounts === null ? null : await this.accounts.get(meta.createdBy);
      const reviewed = meta.versions.find((v) => v.version === version);
      const live = isPublicNow(meta) ? meta.versions.find((v) => v.version === meta.publishedVersion) : undefined;
      return {
        caseId: meta.id,
        title: reviewed?.title ?? meta.title,
        createdBy: meta.createdBy,
        author: account?.data.username ?? (meta.createdBy === "admin" ? "admin" : null),
        version,
        publishedVersion: meta.publishedVersion,
        visibility: meta.visibility,
        langs: reviewed?.langs ?? meta.langs,
        submittedAt: meta.reviewAt,
        answerKeyChanged: live !== undefined && reviewed !== undefined && live.answerFingerprint !== reviewed.answerFingerprint,
      };
    });
    return items.filter((i): i is ReviewItem => i !== null).sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
  }

  /** The owner's decision. Approve: the reviewed version goes public. Reject: the note is recorded, a pending version is dropped. */
  async decide(caseId: string, input: ReviewDecisionRequest): Promise<AuthorCase> {
    const found = await this.cases.getMeta(caseId);
    if (!found) throw notFound();
    const { data: meta, etag } = found;
    if (meta.review !== "submitted" || meta.status !== "published") throw new AppError(409, "this case is not waiting for review", { code: "not-submitted" });
    const version = reviewedVersion(meta);
    if (version === null) throw new AppError(409, "this case is not waiting for review", { code: "not-submitted" });
    const nowIso = this.now().toISOString();
    if (input.decision === "reject") {
      return toAuthorCase(await this.save(composeCaseMeta({
        ...meta, review: "rejected", reviewNote: input.note, reviewAt: nowIso, pendingVersion: null, updatedAt: nowIso,
      }), etag));
    }
    if (version !== meta.publishedVersion) {
      if (!(await this.isComplete(meta, version))) throw new AppError(409, `version ${version} is incomplete`, { code: "incomplete-version" });
      await this.assertNoDrift(meta, version, input.acceptAnswerChanges);
    }
    return toAuthorCase(await this.save(composeCaseMeta({
      ...meta,
      publishedVersion: version,
      status: "published",
      visibility: "public",
      review: "approved",
      reviewNote: input.note,
      reviewAt: nowIso,
      pendingVersion: null,
      updatedAt: nowIso,
    }), etag));
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
      throw conflict();
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
