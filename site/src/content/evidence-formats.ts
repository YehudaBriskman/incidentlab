import formatsRaw from "virtual:case-evidence-formats";
import { EvidenceFormatsSchema, type EvidenceFormats } from "./catalog-schema";

/*
 * Each case's English evidence format labels. The Explorer derives a file's mode and profile from them
 * whatever the UI language (Hebrew labels are translated). Only the Explorer imports this, so it ships in
 * the Explorer's chunk, and the Explorer does not need the English case file when the UI is in Hebrew.
 */
function parseFormats(): EvidenceFormats {
  const result = EvidenceFormatsSchema.safeParse(formatsRaw);
  if (!result.success) {
    console.error("[content] evidence formats failed schema validation", result.error.issues);
    return {};
  }
  return result.data;
}

const formats: EvidenceFormats = parseFormats();

export function englishEvidenceFormats(caseId: string): ReadonlyArray<{ path: string; format: string }> | undefined {
  return formats[caseId];
}
