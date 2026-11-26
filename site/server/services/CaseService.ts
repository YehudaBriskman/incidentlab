// DB-stored cases: the published catalog, public content, server-only sealed material and evidence.
// Only `publishedVersion` of a case is visible here (isPublicVersion); drafts, older versions and trashed
// cases are invisible to every public route. GameService reads its answer keys from here (#68).
import { summarize } from "../../shared/catalog.ts";
import type { CatalogEntry } from "../../shared/catalog.ts";
import type { CaseContent, CaseLang, CaseMeta, CaseSealed, EvidenceEntry } from "../../shared/case-records.ts";
import { AppError } from "../domain/types.ts";
import type { CaseRepository } from "../repositories/case-repository.ts";
import { mapWithConcurrency } from "../repositories/KvStore.ts";
import { isPublicVersion } from "./evidenceStream.ts";
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

/** The live version of a case, or null while it is a draft or trashed. */
const live = (meta: CaseMeta): Live | null =>
  meta.publishedVersion !== null && isPublicVersion(meta, meta.publishedVersion) ? { meta, version: meta.publishedVersion } : null;

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

  /** Ids of every published case (the game's answer keys, CaseSecretsProvider). */
  async publishedIds(): Promise<string[]> {
    return (await this.cases.listMetas()).map(live).filter((l): l is Live => l !== null).map((l) => l.meta.id);
  }

  /** Catalog entries for every published case, by id. A case whose English content is missing or corrupt is left out. */
  async listPublished(): Promise<CatalogEntry[]> {
    const published = (await this.cases.listMetas()).map(live).filter((l): l is Live => l !== null);
    const entries = await mapWithConcurrency(published, async ({ meta, version }): Promise<CatalogEntry | null> => {
      const en = await this.cases.getContent(meta.id, version, "en");
      if (!en) return null;
      const he = meta.langs.includes("he") ? await this.cases.getContent(meta.id, version, "he") : null;
      return { file: meta.id, version, en: summarize(en), ...(he ? { he: summarize(he) } : {}) };
    });
    return entries.filter((e): e is CatalogEntry => e !== null);
  }

  /** Public content of the published version. `he` falls back to `en`; 404 when not published. */
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

  /** Server-only: answers, hint texts, commands and debriefs of the published version (null when not published). */
  async getSealed(id: string): Promise<CaseSealed | null> {
    const found = await this.liveVersion(id);
    return found ? this.cases.getSealed(id, found.version) : null;
  }

  /** The evidence file list of a published version; 404 otherwise. */
  async evidenceIndex(id: string, version: number): Promise<EvidenceEntry[]> {
    const meta = (await this.cases.getMeta(id))?.data;
    if (!meta || !isPublicVersion(meta, version)) throw notFound();
    return (await this.cases.getEvidenceIndex(id, version)) ?? [];
  }

  /** Streams one evidence file of a published version (in chunk order), optionally one byte range of it. */
  async readEvidence(id: string, version: number, path: string, range?: ByteRange): Promise<EvidenceRead> {
    const resolved = await this.evidence.resolve({ kind: "file", caseId: id, version, path });
    if (!resolved) throw new AppError(404, "evidence not found", { code: "not-found" });
    const { entry } = resolved;
    if (range && (range.start < 0 || range.end < range.start || range.end >= entry.size)) {
      throw new AppError(416, "range not satisfiable");
    }
    return { entry, range: range ?? null, stream: this.evidence.read(entry, range) };
  }
}
