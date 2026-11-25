import { cases } from "../content/load";
import type { Case } from "../content/schema";
import { T } from "../i18n/strings-tools";

export interface EvidenceFile {
  path: string;
  size: string;
  description: string;
  mode: "text" | "json" | "csv";
}

/** 3am-outage's hand-written catalog (sizes + localized descriptions). Descriptions describe the format only, never the findings. */
const LEGACY_3AM_FILES: readonly EvidenceFile[] = [
  { path: "README_FIRST.txt", size: "2 KB", get description() { return T().fdReadme; }, mode: "text" },
  { path: "nginx/access.log", size: "~40 MB", get description() { return T().fdAccess; }, mode: "text" },
  { path: "app/checkout-service.log", size: "~7 MB", get description() { return T().fdCheckout; }, mode: "json" },
  { path: "metrics/checkout_metrics.csv", size: "25 KB", get description() { return T().fdMetrics; }, mode: "csv" },
  { path: "db/postgresql-slow.log", size: "16 KB", get description() { return T().fdPg; }, mode: "text" },
  { path: "deploys/deploys.log", size: "2 KB", get description() { return T().fdDeploys; }, mode: "text" },
  { path: "slack/inc-checkout.json", size: "8 KB", get description() { return T().fdSlack; }, mode: "text" },
  { path: "nginx/nginx.conf.snippet", size: "2 KB", get description() { return T().fdNginx; }, mode: "text" },
  { path: "repo/git-log.txt", size: "varies", get description() { return T().fdGit; }, mode: "text" },
];

// Binary twins live only in the zip (see scripts/package.sh); the Explorer can't show them.
const BINARY_EXTENSIONS = [".bundle", ".pcap", ".tar.gz", ".bin"];

/**
 * JSON Lines get the JSON field filter; a single JSON document is shown as text. Logs are often JSON Lines
 * under a `.log` name, so the case's format label ("JSON lines (UTC)", "CSV") counts as much as the extension.
 */
function modeFor(path: string, format: string): EvidenceFile["mode"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".csv") || /^csv\b/i.test(format)) return "csv";
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson") || /json ?lines|jsonl|ndjson/i.test(format)) return "json";
  return "text";
}

const plainText = (markdown: string): string => markdown.replace(/[`*_]/g, "");

/** Sidebar catalog for a case: README first, then the case JSON's evidence list in order. */
export function evidenceFilesFor(c: Case): EvidenceFile[] {
  if (c.id === "3am-outage") return [...LEGACY_3AM_FILES];
  // Format labels may be translated, so the mode always comes from the English case.
  const englishFormat = new Map((cases.get(c.id)?.evidence ?? []).map((f) => [f.path, f.format]));
  const files = c.evidence
    .filter((f) => !BINARY_EXTENSIONS.some((ext) => f.path.toLowerCase().endsWith(ext)))
    .map((f): EvidenceFile => ({ path: f.path, size: f.format, description: plainText(f.description), mode: modeFor(f.path, englishFormat.get(f.path) ?? f.format) }));
  return files.sort((a, b) => Number(b.path === "README_FIRST.txt") - Number(a.path === "README_FIRST.txt"));
}

export function evidenceUrl(caseId: string, path: string): string {
  return `${import.meta.env.BASE_URL}evidence/${encodeURIComponent(caseId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export interface Preset {
  label: string;
  kind: "contains" | "not" | "regex";
  text: string;
}

/** Generic teaching examples. They must never contain incident-specific values. */
export const FILTER_PRESETS: readonly Preset[] = [
  { get label() { return T().pl5xx; }, kind: "regex", text: '" 5\\d\\d ' },
  { get label() { return T().plPost; }, kind: "contains", text: "POST /api/checkout" },
  { get label() { return T().plHealthz; }, kind: "not", text: "healthz" },
  { get label() { return T().plLevelErr; }, kind: "contains", text: '"level":"error"' },
];

export const UNIQUE_PRESETS: readonly string[] = ["cid=(\\S+)", '"msg":"([^"]+)"', '" (\\d{3}) ', "^(\\S+)"];

export const HISTOGRAM_PRESETS: ReadonlyArray<{ label: string; pattern: string }> = [
  { get label() { return T().hlNginx; }, pattern: "\\[(\\d+/\\w+/\\d+:\\d\\d:\\d\\d)" },
  { get label() { return T().hlIso; }, pattern: "(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d)" },
  { get label() { return T().hlPg; }, pattern: "^(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d)" },
];
