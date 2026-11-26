// Cases published in the DB (#64/#66), next to the bundled ones. The catalog comes from GET /api/cases and
// each case's content from GET /api/cases/:id/content, validated with the same CaseSchema as bundled cases
// (DB content is the public part, so hint texts and full commands are simply absent). Evidence of a DB case
// lives under /evidence/db/<id>/v<version>/…, so the version each case was served at is remembered here.
import { z } from "zod";
import { CaseSchema, type Case } from "../../shared/case";
import { CasesResponseSchema } from "../../shared/contract";
import type { CatalogEntry } from "./catalog-schema";
import { fetchPublic } from "../lib/api";
import type { Lang } from "../i18n/i18n";

const DbContentSchema = z.object({ id: z.string(), version: z.number().int().min(1), lang: z.enum(["en", "he"]), content: CaseSchema });

const versions = new Map<string, number>();
const englishFormats = new Map<string, ReadonlyArray<{ path: string; format: string }>>();

/** Published DB cases; an empty list when the API can't be reached (bundled cases keep working). */
export async function fetchDbCatalog(): Promise<CatalogEntry[]> {
  try {
    return (await fetchPublic("/api/cases", CasesResponseSchema)).cases;
  } catch (err: unknown) {
    console.warn("[content] DB case catalog unavailable; showing bundled cases only", err);
    return [];
  }
}

const zipUrl = (id: string, version: number): string => `${import.meta.env.BASE_URL}evidence/db/${encodeURIComponent(id)}/v${version}.zip`;

/** A DB case in `lang` (the server falls back to English). Rejects on network errors so a later visit retries. */
export async function loadDbCase(id: string, lang: Lang): Promise<Case | undefined> {
  // The Explorer picks a file's parser from its English format label, whatever the UI language: load the
  // English content first (once) so a Hebrew session parses files the same way.
  if (lang !== "en" && !englishFormats.has(id)) await loadDbCase(id, "en");
  const res = await fetchPublic(`/api/cases/${encodeURIComponent(id)}/content?lang=${lang}`, DbContentSchema);
  if (res.id !== id) return undefined;
  versions.set(id, res.version);
  if (res.lang === "en") englishFormats.set(id, res.content.evidence.map((e) => ({ path: e.path, format: e.format })));
  return { ...res.content, evidenceZip: zipUrl(id, res.version) };
}

/** The version a DB case was served at (undefined for bundled cases and before its content loaded). */
export function dbCaseVersion(id: string): number | undefined {
  return versions.get(id);
}

export function dbEnglishFormats(id: string): ReadonlyArray<{ path: string; format: string }> | undefined {
  return englishFormats.get(id);
}
