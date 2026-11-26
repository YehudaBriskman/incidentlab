// Where a case's lab lives (lab mode, #146). The IncidentsLab/labs workflow publishes one image per case version
// as ghcr.io/incidentslab/lab-<case>:v<version> (public, amd64 and arm64), built only from the public evidence.
// Some cases also have a Codespaces template, for players without Docker: they copy it into their own account,
// so the Codespace uses their free quota. Pure (no DOM): unit-tested in node.

export const LAB_REGISTRY = "ghcr.io/incidentslab";

/** Codespaces templates that exist so far (IncidentsLab/lab-<case>). */
const TEMPLATES: Readonly<Record<string, string>> = {
  "ghost-in-the-network": "https://github.com/IncidentsLab/lab-ghost-in-the-network",
};

/** The published image for one case version. */
export function labImage(caseId: string, version: number): string {
  return `${LAB_REGISTRY}/lab-${caseId}:v${version}`;
}

/** The command that opens the lab locally (the shell starts in /case). */
export function labRunCommand(caseId: string, version: number): string {
  return `docker run -it --rm ${labImage(caseId, version)}`;
}

/** The case's Codespaces template, or null when it has none yet. */
export function labTemplate(caseId: string): string | null {
  return TEMPLATES[caseId] ?? null;
}
