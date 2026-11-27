// DB-stored cases: the published catalog, public content, server-only sealed material and evidence.
// Only `publishedVersion` of a case is visible here (isLiveVersion); drafts, older versions and trashed
// cases are invisible to every route. GameService reads its answer keys from here (#68).
// Private cases (#184) are live too, but the public catalog and the released ids (`publishedIds`) hold public
// cases only. Whoever serves a private case's content or answer key checks access first (CaseAccessService).
import { summarize } from "../../shared/catalog.ts";
import type { CatalogEntry } from "../../shared/catalog.ts";
import type { CaseContent, CaseLang, CaseMeta, CaseSealed, EvidenceEntry } from "../../shared/case-records.ts";
import { AppError } from "../domain/types.ts";
import type { CaseRepository } from "../repositories/case-repository.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import { isLiveVersion, isPublicVersion } from "./evidenceStream.ts";
import type { ByteRange, EvidenceService } from "./evidenceStream.ts";

export type PublishedContent = {
  readonly meta: CaseMeta;
  /** the version served: meta.publishedVersion */
  readonly version: number;
  /** the language actually served: `he` falls back to `en` when the case has no Hebrew content */
  readonly lang: CaseLang;
  readonly content: CaseContent;
};

export type EvidenceRead = {
  readonly entry: EvidenceEntry;
  readonly range: ByteRange | null;
  readonly stream: ReadableStream<Uint8Array>;
};

type Live = { readonly meta: CaseMeta; readonly version: number };

/** The live version of a case, public or private, or null while it is a draft or trashed. */
const live = (meta: CaseMeta): Live | null =>
  meta.publishedVersion !== null && isLiveVersion(meta, meta.publishedVersion) ? { meta, version: meta.publishedVersion } : null;
const isPublic = (l: Live): boolean => isPublicVersion(l.meta, l.version);

const notFound = (): AppError => new AppError(404, "case not found", { code: "not-found" });

export class CaseService {
  private readonly cases: CaseRepository;
  private readonly evidence: EvidenceService;

  constructor(deps: { cases: CaseRepository; evidence: EvidenceService }) {
    this.cases = deps.cases;
    this.evidence = deps.evidence;
  }

  private async liveVersion(id: string): Promise<Live | null> {
    const meta = (await this.cases.getMeta(id))?.data;
    return meta ? live(meta) : null;
  }

  private async liveCases(): Promise<Live[]> {
    return (await this.cases.listMetas()).map(live).filter((l): l is Live => l !== null);
  }

  /** Ids of every published public case: the released cases (CaseSecretsProvider). */
  async publishedIds(): Promise<string[]> {
    return (await this.liveCases()).filter(isPublic).map((l) => l.meta.id);
  }

  /** The metas of every live private case (#184); CaseSecretsProvider keeps their answer keys apart. */
  async privateMetas(): Promise<CaseMeta[]> {
    return (await this.liveCases()).filter((l) => !isPublic(l)).map((l) => l.meta);
  }

  /** The meta of a case's live version, public or private; null while it is a draft, trashed or unknown. */
  async liveMeta(id: string): Promise<CaseMeta | null> {
    return (await this.liveVersion(id))?.meta ?? null;
  }

  /** Catalog entries for every published public case, by id. A case whose English content is missing or corrupt is left out. */
  async listPublished(): Promise<CatalogEntry[]> {
    return this.catalogOf((await this.liveCases()).filter(isPublic));
  }

  /** Catalog entries of the given private cases that are live (the personalised GET /api/me/cases). */
  async catalogOfPrivate(metas: readonly CaseMeta[]): Promise<CatalogEntry[]> {
    return this.catalogOf(metas.map(live).filter((l): l is Live => l !== null && !isPublic(l)));
  }

  private async catalogOf(cases: readonly Live[]): Promise<CatalogEntry[]> {
    const entries = await mapWithConcurrency(cases, async ({ meta, version }): Promise<CatalogEntry | null> => {
      const en = await this.cases.getContent(meta.id, version, "en");
      if (!en) return null;
      const he = meta.langs.includes("he") ? await this.cases.getContent(meta.id, version, "he") : null;
      return { file: meta.id, version, en: summarize(en), ...(he ? { he: summarize(he) } : {}) };
    });
    return entries.filter((e): e is CatalogEntry => e !== null);
  }

  /**
   * Content of the live version, public or private: the caller decides who may see a private one
   * (`meta.visibility`). `he` falls back to `en`; 404 when not published.
   */
  async getContent(id: string, lang: CaseLang): Promise<PublishedContent> {
    const found = await this.liveVersion(id);
    if (!found) throw notFound();
    const { meta, version } = found;
    if (lang !== "en" && meta.langs.includes(lang)) {
      const localized = await this.cases.getContent(id, version, lang);
      if (localized) return { meta, version, lang, content: localized };
    }
    const en = await this.cases.getContent(id, version, "en");
    if (!en) throw notFound();
    return { meta, version, lang: "en", content: en };
  }

  /** Server-only: answers, hint texts, commands and debriefs of the live version, public or private (null when not published). */
  async getSealed(id: string): Promise<CaseSealed | null> {
    const found = await this.liveVersion(id);
    return found ? this.cases.getSealed(id, found.version) : null;
  }

  /** The evidence file list of a published public version; 404 otherwise. */
  async evidenceIndex(id: string, version: number): Promise<EvidenceEntry[]> {
    const meta = (await this.cases.getMeta(id))?.data;
    if (!meta || !isPublicVersion(meta, version)) throw notFound();
    return (await this.cases.getEvidenceIndex(id, version)) ?? [];
  }

  /** Streams one evidence file of a published public version (in chunk order), optionally one byte range of it. */
  async readEvidence(id: string, version: number, path: string, range?: ByteRange): Promise<EvidenceRead> {
    const resolved = await this.evidence.resolve({ kind: "file", caseId: id, version, key: null, path });
    if (!resolved) throw new AppError(404, "evidence not found", { code: "not-found" });
    const { entry } = resolved;
    if (range && (range.start < 0 || range.end < range.start || range.end >= entry.size)) {
      throw new AppError(416, "range not satisfiable");
    }
    return { entry, range: range ?? null, stream: this.evidence.read(entry, range) };
  }
}
