export interface EvidenceFile {
  path: string;
  size: string;
  description: string;
  mode: "text" | "json" | "csv";
}

/** Catalog shown in the sidebar. Descriptions describe the format only, never the findings. */
export const EVIDENCE_FILES: readonly EvidenceFile[] = [
  { path: "README_FIRST.txt", size: "2 KB", description: "Start here: what each file is.", mode: "text" },
  { path: "nginx/access.log", size: "~40 MB", description: "Edge access log, one request per line.", mode: "text" },
  { path: "app/checkout-service.log", size: "~7 MB", description: "Checkout service logs, JSON per line.", mode: "json" },
  { path: "metrics/checkout_metrics.csv", size: "25 KB", description: "15-second metrics samples, epoch timestamps.", mode: "csv" },
  { path: "db/postgresql-slow.log", size: "16 KB", description: "Postgres slow-query and checkpoint log.", mode: "text" },
  { path: "deploys/deploys.log", size: "2 KB", description: "Deploy and rollback events.", mode: "text" },
  { path: "slack/inc-checkout.json", size: "8 KB", description: "Incident channel export (epoch ts).", mode: "text" },
  { path: "nginx/nginx.conf.snippet", size: "2 KB", description: "Relevant nginx config.", mode: "text" },
  { path: "repo/git-log.txt", size: "varies", description: "Full git log -p of the service repo.", mode: "text" },
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
  { label: "only 5xx", kind: "regex", text: '" 5\\d\\d ' },
  { label: "POST /api/checkout", kind: "contains", text: "POST /api/checkout" },
  { label: "exclude healthz", kind: "not", text: "healthz" },
  { label: "level error (JSON)", kind: "contains", text: '"level":"error"' },
];

export const UNIQUE_PRESETS: readonly string[] = ["cid=(\\S+)", '"msg":"([^"]+)"', '" (\\d{3}) ', "^(\\S+)"];

export const HISTOGRAM_PRESETS: ReadonlyArray<{ label: string; pattern: string }> = [
  { label: "nginx minute", pattern: "\\[(\\d+/\\w+/\\d+:\\d\\d:\\d\\d)" },
  { label: "ISO minute", pattern: "(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d)" },
  { label: "postgres minute", pattern: "^(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d)" },
];
