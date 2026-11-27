// Who may see and play a private case (#184). A public case is open to everyone. A private case is open to:
//   - its author (`meta.createdBy`), to test-play it;
//   - the site admin (content only: the admin account can't play);
//   - active members of an active class in `meta.classIds`.
// Everyone else gets the same 404 as for an unknown case, so a private case id reveals nothing.
//
// Membership is read live (two small reads per assigned class), never from a cache, so removing a member or a
// class takes effect at once. Only the "does this account have any?" hint for the session uses the cached list.
import type { CatalogEntry } from "../../shared/catalog.ts";
import type { CaseMeta } from "../../shared/case-records.ts";
import { AppError } from "../domain/types.ts";
import type { AccountRecord } from "../domain/types.ts";
import type { AuthService } from "./AuthService.ts";
import type { CaseSecretsProvider } from "./CaseSecretsProvider.ts";
import type { CaseService } from "./CaseService.ts";
import type { ClassService } from "./ClassService.ts";

/** The caller of a case route: the site admin, a signed-in account, or nobody. */
export type CaseViewer = { readonly kind: "admin" } | { readonly kind: "account"; readonly accountId: string } | { readonly kind: "anonymous" };

/** The 404 every refusal uses: the same answer as for a case that does not exist. */
export const caseNotFound = (): AppError => new AppError(404, "unknown case", { code: "unknown-case" });

export class CaseAccessService {
  private readonly cases: CaseService;
  private readonly classes: ClassService;
  private readonly secrets: CaseSecretsProvider;
  private readonly auth: AuthService;

  constructor(deps: { cases: CaseService; classes: ClassService; secrets: CaseSecretsProvider; auth: AuthService }) {
    this.cases = deps.cases;
    this.classes = deps.classes;
    this.secrets = deps.secrets;
    this.auth = deps.auth;
  }

  /**
   * The viewer behind a session cookie. Signed out, expired, pending, rejected or mid password change all count
   * as anonymous: they see public cases only. Never throws for a missing or bad session.
   */
  async viewer(sessionToken: string | null): Promise<CaseViewer> {
    if (sessionToken === null) return { kind: "anonymous" };
    try {
      const principal = await this.auth.requirePlayerOrAdmin(sessionToken);
      return principal.kind === "admin" ? { kind: "admin" } : { kind: "account", accountId: principal.account.id };
    } catch (error: unknown) {
      if (error instanceof AppError && (error.status === 401 || error.status === 403)) return { kind: "anonymous" };
      throw error;
    }
  }

  /** True when the viewer may see this live case (public: always). */
  async mayAccess(viewer: CaseViewer, meta: CaseMeta): Promise<boolean> {
    if (meta.visibility === "public") return true;
    if (viewer.kind === "admin") return true;
    if (viewer.kind === "anonymous") return false;
    if (meta.createdBy === viewer.accountId) return true;
    for (const classId of meta.classIds) {
      if (await this.classes.isActiveMember(viewer.accountId, classId)) return true;
    }
    return false;
  }

  /**
   * Before any play route (progress, answer, hint, debrief...): passes for released cases at once (no read),
   * and for a private case only when the player may play it; 404 otherwise. Loads the answer key of a private
   * case published on another instance since the last refresh.
   */
  async assertPlayable(player: AccountRecord, caseId: string): Promise<void> {
    if (caseId in this.secrets.cases) return;
    const meta = await this.cases.liveMeta(caseId);
    if (meta === null) throw caseNotFound(); // also a private case trashed since the last refresh
    if (meta.visibility === "public") return; // made public since the last refresh
    if (!(await this.mayAccess({ kind: "account", accountId: player.id }, meta))) throw caseNotFound();
    if (!(caseId in this.secrets.playable.cases)) await this.secrets.refresh(true);
  }

  /** The live private cases the viewer may see, as catalog entries (GET /api/me/cases). */
  async privateCatalog(viewer: CaseViewer): Promise<CatalogEntry[]> {
    if (viewer.kind === "anonymous") return [];
    const metas = await this.cases.privateMetas();
    const allowed: CaseMeta[] = [];
    for (const meta of metas) if (await this.mayAccess(viewer, meta)) allowed.push(meta);
    return this.cases.catalogOfPrivate(allowed);
  }

  /**
   * A cheap hint for the session response: may this viewer have any private case? From the cached list (no
   * read when there are no private cases at all); at worst one TTL stale, and the catalog call is exact.
   */
  async hasPrivateCases(viewer: CaseViewer): Promise<boolean> {
    const refs = this.secrets.privateCases();
    if (refs.length === 0 || viewer.kind === "anonymous") return false;
    if (viewer.kind === "admin") return true;
    if (refs.some((r) => r.createdBy === viewer.accountId)) return true;
    if (!refs.some((r) => r.classIds.length > 0)) return false;
    const mine = new Set(await this.classes.activeClassIdsOf(viewer.accountId));
    return refs.some((r) => r.classIds.some((id) => mine.has(id)));
  }
}
