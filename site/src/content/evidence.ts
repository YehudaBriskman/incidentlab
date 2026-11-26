// Where a case's evidence is downloaded from: the one resolver the whole client goes through (#68).
// The content API says where each published version's evidence lives (`evidence: {filesBase, zip}` in
// GET /api/cases/:id/content, decided by evidenceLocation() on the server), so moving evidence to another
// host is a server change only. Responses from before that field fall back to the Edge Function path.
import type { EvidenceLocation } from "../../shared/case-records";

const locations = new Map<string, EvidenceLocation>();

/** The Edge Function path for a published version (site/netlify/edge-functions/evidence.ts). */
const edgeLocation = (caseId: string, version: number): EvidenceLocation => {
  const base = `${import.meta.env.BASE_URL}evidence/db/${encodeURIComponent(caseId)}/v${version}`;
  return { filesBase: `${base}/files/`, zip: `${base}.zip` };
};

/** Records the location a case's content was served with (content/db-cases.ts). */
export function rememberEvidence(caseId: string, version: number, location: EvidenceLocation | undefined): void {
  locations.set(caseId, location ?? edgeLocation(caseId, version));
}

/** An evidence file's URL, or undefined before the case's content has loaded. */
export function evidenceFileUrl(caseId: string, path: string): string | undefined {
  const location = locations.get(caseId);
  return location === undefined ? undefined : location.filesBase + path.split("/").map(encodeURIComponent).join("/");
}

/** The evidence zip's URL, or undefined before the case's content has loaded. */
export function evidenceZipUrl(caseId: string): string | undefined {
  return locations.get(caseId)?.zip;
}
