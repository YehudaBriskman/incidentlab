// Public, cacheable case content from the DB: GET /api/cases and GET /api/cases/:id/content.
// These are the only /api routes that may be cached: they are the same for every visitor and carry no
// account data. Every other route keeps `cache-control: no-store` (http.ts). Netlify does not apply
// netlify.toml [[headers]] to function responses, so the header set here is what the CDN and browser see.
import { CaseIdSchema } from "../../shared/contract.ts";
import { CaseLangSchema } from "../../shared/case-records.ts";
import { AppError } from "../domain/types.ts";
import { sha256Hex } from "../repositories/case-repository.ts";
import type { CaseService } from "../services/CaseService.ts";
import { json } from "./http.ts";

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

  constructor(deps: { cases: CaseService }) {
    this.cases = deps.cases;
  }

  /** GET /api/cases -> {cases: CatalogEntry[]}. ETag is a hash of the body. */
  async catalog(req: Request): Promise<Response> {
    const body = { cases: await this.cases.listPublished() };
    const etag = `"${(await sha256Hex(new TextEncoder().encode(JSON.stringify(body)))).slice(0, 32)}"`;
    return cacheable(req, etag, body);
  }

  /** GET /api/cases/:id/content?lang=en|he -> {id, version, lang, content}. ETag: contentSha + version + served lang. */
  async content(req: Request, caseId: string): Promise<Response> {
    if (!CaseIdSchema.safeParse(caseId).success) throw new AppError(404, "case not found", { code: "not-found" });
    const lang = CaseLangSchema.safeParse(new URL(req.url).searchParams.get("lang") ?? "en");
    if (!lang.success) throw new AppError(400, "lang must be en or he");
    const published = await this.cases.getContent(caseId, lang.data);
    const etag = `"${published.meta.contentSha}-v${published.meta.version}-${published.lang}"`;
    return cacheable(req, etag, { id: caseId, version: published.meta.version, lang: published.lang, content: published.content });
  }
}
