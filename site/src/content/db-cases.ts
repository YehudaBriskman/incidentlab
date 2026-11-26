// The content API client (#68): the catalog from GET /api/cases and each case's public content from
// GET /api/cases/:id/content, validated with the same CaseSchema the authoring tools use (hint texts and full
// commands are simply absent). Each content response also says where that version's evidence lives
// (content/evidence.ts); the English format labels are kept because the Explorer picks a file's parser from them.
import { z } from "zod";
import { CaseSchema, type Case } from "../../shared/case";
import { EvidenceLocationSchema } from "../../shared/case-records";
import { CasesResponseSchema } from "../../shared/contract";
import type { CatalogEntry } from "./catalog-schema";
import { fetchPublic } from "../lib/api";
import type { Lang } from "../i18n/i18n";
import { rememberEvidence, evidenceZipUrl } from "./evidence";

const ContentResponseSchema = z.object({
  id: z.string(),
  version: z.number().int().min(1),
  lang: z.enum(["en", "he"]),
  content: CaseSchema,
  evidence: EvidenceLocationSchema.optional(),
});

const englishFormats = new Map<string, ReadonlyArray<{ path: string; format: string }>>();

/** Published cases, or null when the API can't be reached (the caller shows an error with a retry). */
export async function fetchDbCatalog(): Promise<CatalogEntry[] | null> {
  try {
    return (await fetchPublic("/api/cases", CasesResponseSchema)).cases;
  } catch (err: unknown) {
    console.warn("[content] case catalog unavailable", err);
    return null;
  }
}

/**
 * A case in `lang` (the server falls back to English). `version` is the catalog's: it goes into the URL so
 * the HTTP cache keeps one entry per published version. Rejects on network errors so a later visit retries.
 */
export async function loadDbCase(id: string, lang: Lang, version: number | undefined): Promise<Case | undefined> {
  // The Explorer picks a file's parser from its English format label, whatever the UI language: load the
  // English content first (once) so a Hebrew session parses files the same way.
  if (lang !== "en" && !englishFormats.has(id)) await loadDbCase(id, "en", version);
  const v = version === undefined ? "" : `&v=${version}`;
  const res = await fetchPublic(`/api/cases/${encodeURIComponent(id)}/content?lang=${lang}${v}`, ContentResponseSchema);
  if (res.id !== id) return undefined;
  rememberEvidence(id, res.version, res.evidence);
  if (res.lang === "en") englishFormats.set(id, res.content.evidence.map((e) => ({ path: e.path, format: e.format })));
  return { ...res.content, evidenceZip: evidenceZipUrl(id) ?? res.content.evidenceZip };
}

/** A case's English evidence format labels (undefined before its content loaded). */
export function dbEnglishFormats(id: string): ReadonlyArray<{ path: string; format: string }> | undefined {
  return englishFormats.get(id);
}
