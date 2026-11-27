// Public, cacheable case content from the DB: GET /api/cases and GET /api/cases/:id/content.
// These are the only /api routes that may be cached: they are the same for every visitor and carry no
// account data. Every other route keeps `cache-control: no-store` (http.ts). Netlify does not apply
// netlify.toml [[headers]] to function responses, so the header set here is what the CDN and browser see.
//
// Private cases (#184) never reach a cacheable response: the catalog lists public cases only, and a private
// case's content is answered no-store, only to its author, the site admin and members of an assigned class
// (404 for everyone else, like an unknown id). GET /api/me/cases is the personalised list of those cases.
import { CaseIdSchema } from "../../shared/contract.ts";
import { CaseLangSchema } from "../../shared/case-records.ts";
import { AppError } from "../domain/types.ts";
import { sha256Hex } from "../repositories/case-repository.ts";
import type { CaseAccessService } from "../services/CaseAccessService.ts";
import type { CaseService } from "../services/CaseService.ts";
import { evidenceLocation } from "../services/evidenceStream.ts";
import { json, sessionToken } from "./http.ts";

export const PUBLIC_CONTENT_CACHE = "public, max-age=60, stale-while-revalidate=600";

const matchesEtag = (req: Request, etag: string): boolean => {
  const header = req.headers.get("if-none-match");
  return header !== null && header.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
};

/** 304 when the client already has this representation, else 200 with the body. */
const cacheable = (req: Request, etag: string, body: unknown): Response => {
  const headers = { etag, "cache-control": PUBLIC_CONTENT_CACHE };
  if (matchesEtag(req, etag)) return new Response(null, { status: 304, headers });
  return json(200, body, headers);
};

export class ContentController {
  private readonly cases: CaseService;
  private readonly access: CaseAccessService | null;

  constructor(deps: { cases: CaseService; access?: CaseAccessService }) {
    this.cases = deps.cases;
    this.access = deps.access ?? null;
  }

  /** GET /api/cases -> {cases: CatalogEntry[]}. ETag is a hash of the body. */
  async catalog(req: Request): Promise<Response> {
    const body = { cases: await this.cases.listPublished() };
    const etag = `"${(await sha256Hex(new TextEncoder().encode(JSON.stringify(body)))).slice(0, 32)}"`;
    return cacheable(req, etag, body);
  }

  /** GET /api/me/cases -> {cases: CatalogEntry[]}: the private cases this session may play (no-store). */
  async mine(req: Request): Promise<Response> {
    if (this.access === null) return json(200, { cases: [] });
    const viewer = await this.access.viewer(sessionToken(req));
    return json(200, { cases: await this.access.privateCatalog(viewer) });
  }

  /** GET /api/cases/:id/content?lang=en|he -> {id, version, lang, content, evidence}. ETag: contentSha + version + served lang. */
  async content(req: Request, caseId: string): Promise<Response> {
    if (!CaseIdSchema.safeParse(caseId).success) throw new AppError(404, "case not found", { code: "not-found" });
    const lang = CaseLangSchema.safeParse(new URL(req.url).searchParams.get("lang") ?? "en");
    if (!lang.success) throw new AppError(400, "lang must be en or he");
    const published = await this.cases.getContent(caseId, lang.data);
    if (published.meta.visibility === "private") {
      const viewer = this.access === null ? null : await this.access.viewer(sessionToken(req));
      if (viewer === null || this.access === null || !(await this.access.mayAccess(viewer, published.meta))) {
        throw new AppError(404, "case not found", { code: "not-found" });
      }
      // Personalised: json() is no-store, so neither the CDN nor the browser keeps it.
      return json(200, {
        id: caseId, version: published.version, lang: published.lang, content: published.content,
        evidence: evidenceLocation(caseId, published.version, published.meta.evidenceKey),
      });
    }
    const etag = `"${published.meta.contentSha}-v${published.version}-${published.lang}"`;
    return cacheable(req, etag, {
      id: caseId, version: published.version, lang: published.lang, content: published.content,
      evidence: evidenceLocation(caseId, published.version),
    });
  }
}
