import { T } from "../i18n/strings-tools";

export interface EvidenceFile {
  path: string;
  size: string;
  description: string;
  mode: "text" | "json" | "csv";
}

/** Catalog shown in the sidebar. Descriptions describe the format only, never the findings. */
export const EVIDENCE_FILES: readonly EvidenceFile[] = [
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

export function evidenceUrl(path: string): string {
  return `${import.meta.env.BASE_URL}evidence/files/${path.split("/").map(encodeURIComponent).join("/")}`;
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
