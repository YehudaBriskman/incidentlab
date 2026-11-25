import { cases } from "../content/load";
import type { Case } from "../content/schema";
import { T } from "../i18n/strings-tools";
import type { StepKind } from "./core";

/**
 * How a file is laid out, from the case's format label and path. It picks the filter, unique and histogram
 * examples, so a player on CloudTrail gets `eventTime` and a player on syslog gets `Nov 18 07:00`.
 */
export type Profile =
  | "nginx"
  | "s3"
  | "cloudtrail"
  | "jsonl"
  | "syslog"
  | "dpkg"
  | "pg"
  | "spring"
  | "vpc"
  | "csvEpoch"
  | "csv"
  | "iso"
  | "text";

export interface EvidenceFile {
  path: string;
  /** size hint from the catalog ("~40 MB"), or "" when unknown */
  size: string;
  /** format label in the UI language ("nginx log (UTC)") */
  format: string;
  description: string;
  mode: "text" | "json" | "csv";
  profile: Profile;
}

/** 3am-outage's hand-written size hints and localized descriptions. Descriptions describe the format only, never the findings. */
const LEGACY_3AM: ReadonlyArray<{ path: string; size: string; description: () => string }> = [
  { path: "README_FIRST.txt", size: "2 KB", description: () => T().fdReadme },
  { path: "nginx/access.log", size: "~40 MB", description: () => T().fdAccess },
  { path: "app/checkout-service.log", size: "~7 MB", description: () => T().fdCheckout },
  { path: "metrics/checkout_metrics.csv", size: "25 KB", description: () => T().fdMetrics },
  { path: "db/postgresql-slow.log", size: "16 KB", description: () => T().fdPg },
  { path: "deploys/deploys.log", size: "2 KB", description: () => T().fdDeploys },
  { path: "slack/inc-checkout.json", size: "8 KB", description: () => T().fdSlack },
  { path: "nginx/nginx.conf.snippet", size: "2 KB", description: () => T().fdNginx },
  { path: "repo/git-log.txt", size: "", description: () => T().fdGit },
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

export function profileFor(path: string, englishFormat: string, mode: EvidenceFile["mode"]): Profile {
  const p = path.toLowerCase();
  const f = englishFormat.toLowerCase();
  if (p.includes("cloudtrail")) return "cloudtrail";
  if (f.startsWith("nginx log")) return "nginx";
  if (f.includes("s3 access log")) return "s3";
  if (f.includes("vpc flow")) return "vpc";
  if (f.startsWith("syslog")) return "syslog";
  if (f.startsWith("dpkg")) return "dpkg";
  if (f.startsWith("postgres")) return "pg";
  if (f.includes("spring boot")) return "spring";
  if (mode === "json") return "jsonl";
  if (mode === "csv") return f.includes("epoch") ? "csvEpoch" : "csv";
  if (f.includes("iso-8601") || f.includes("key=value")) return "iso";
  return "text";
}

const plainText = (markdown: string): string => markdown.replace(/[`*_]/g, "");

/** Sidebar catalog for a case: README first, then the case JSON's evidence list in order. */
export function evidenceFilesFor(c: Case): EvidenceFile[] {
  // Format labels may be translated, so the mode always comes from the English case.
  const englishFormat = new Map((cases.get(c.id)?.evidence ?? []).map((f) => [f.path, f.format]));
  const localFormat = new Map(c.evidence.map((f) => [f.path, f.format]));
  const build = (path: string, size: string, description: string): EvidenceFile => {
    const en = englishFormat.get(path) ?? localFormat.get(path) ?? "";
    const mode = modeFor(path, en);
    return { path, size, format: localFormat.get(path) ?? en, description, mode, profile: profileFor(path, en, mode) };
  };
  if (c.id === "3am-outage") return LEGACY_3AM.map((f) => build(f.path, f.size, f.description()));
  const files = c.evidence
    .filter((f) => !BINARY_EXTENSIONS.some((ext) => f.path.toLowerCase().endsWith(ext)))
    .map((f) => build(f.path, "", plainText(f.description)));
  return files.sort((a, b) => Number(b.path === "README_FIRST.txt") - Number(a.path === "README_FIRST.txt"));
}

export function evidenceUrl(caseId: string, path: string): string {
  return `${import.meta.env.BASE_URL}evidence/${encodeURIComponent(caseId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Zones a case's evidence is written in, from its English format labels (UTC is always offered first). */
export function caseZones(c: Case): string[] {
  const labels = (cases.get(c.id)?.evidence ?? c.evidence).map((f) => f.format).join(" ");
  const zones: string[] = [];
  if (/\bEST\b|-0500/.test(labels)) zones.push("America/New_York");
  if (/\bCET\b/.test(labels)) zones.push("Europe/Paris");
  if (/\+02:?00/.test(labels)) zones.push("+02:00");
  return zones;
}

/** The time converter's zones: UTC, then the case's own zones, then the rest. */
export const ALL_ZONES: readonly string[] = ["UTC", "America/New_York", "Europe/Paris", "+02:00"];

export function zoneLabel(zone: string): string {
  if (zone === "America/New_York") return "EST/EDT";
  if (zone === "Europe/Paris") return "CET/CEST";
  return zone;
}

/** A year for year-less syslog stamps, from the case's evidence paths and labels (e.g. `2026-11-18.log`). */
export function caseYearHint(c: Case): number | null {
  const text = [...c.evidence.map((f) => `${f.path} ${f.format}`), c.briefing].join(" ");
  const m = /\b(20\d{2})(?:-[01]\d-[0-3]\d|[01]\d[0-3]\d\b)/.exec(text);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------ presets */

export interface FilterPreset {
  label: string;
  kind: StepKind;
  text: string;
}

export interface PatternPreset {
  label: string;
  pattern: string;
}

/**
 * Teaching examples per file format. They describe the format (status codes, levels, event names),
 * never the findings of a case.
 */
export function filterPresetsFor(profile: Profile): FilterPreset[] {
  const t = T();
  switch (profile) {
    case "nginx":
      return [
        { label: t.pl5xx, kind: "regex", text: '" 5\\d\\d ' },
        { label: t.pl4xx, kind: "regex", text: '" 4\\d\\d ' },
        { label: t.plHealthz, kind: "not", text: "/health" },
        { label: t.plPost, kind: "contains", text: '"POST ' },
      ];
    case "s3":
      return [
        { label: t.plS3Delete, kind: "contains", text: "REST.DELETE" },
        { label: t.plS3Get, kind: "contains", text: "REST.GET.OBJECT" },
        { label: t.plErrStatus, kind: "regex", text: '" [45]\\d\\d ' },
      ];
    case "cloudtrail":
      return [
        { label: t.plCtError, kind: "contains", text: '"errorCode"' },
        { label: t.plCtWrite, kind: "regex", text: '"eventName":"(Delete|Put|Create|Update|Attach|Detach)' },
        { label: t.plCtNotRead, kind: "regex", text: '"readOnly":false' },
      ];
    case "jsonl":
      return [
        { label: t.plLevelErr, kind: "regex", text: '"level":"(error|ERROR|fatal)"' },
        { label: t.plLevelWarn, kind: "regex", text: '"level":"(warn|warning|WARN)"' },
      ];
    case "syslog":
      return [
        { label: t.plKernel, kind: "contains", text: " kernel: " },
        { label: t.plDrop, kind: "contains", text: "DROP" },
        { label: t.plError, kind: "contains", text: "error" },
      ];
    case "dpkg":
      return [
        { label: t.plDpkgInstall, kind: "regex", text: " (install|upgrade) " },
        { label: t.plDpkgInstalled, kind: "contains", text: " status installed " },
      ];
    case "pg":
      return [
        { label: t.plPgSlow, kind: "contains", text: "duration:" },
        { label: t.plError, kind: "regex", text: "(ERROR|FATAL|PANIC):" },
      ];
    case "spring":
      return [
        { label: t.plWarnErr, kind: "regex", text: "\\s(WARN|ERROR)\\s" },
        { label: t.plException, kind: "contains", text: "Exception" },
      ];
    case "vpc":
      return [
        { label: t.plReject, kind: "contains", text: " REJECT " },
        { label: t.plAccept, kind: "contains", text: " ACCEPT " },
      ];
    case "csv":
    case "csvEpoch":
      return [];
    case "iso":
    case "text":
      return [
        { label: t.plError, kind: "contains", text: "error" },
        { label: t.plWarn, kind: "contains", text: "warn" },
      ];
  }
}

export function uniquePresetsFor(profile: Profile): PatternPreset[] {
  const t = T();
  switch (profile) {
    case "nginx":
      return [
        { label: t.exUStatus, pattern: '" (\\d{3}) ' },
        { label: t.exUClientIp, pattern: "^(\\S+)" },
        { label: t.exUPath, pattern: '"[A-Z]+ ([^ ?"]+)' },
        { label: t.exUMethod, pattern: '"([A-Z]+) ' },
      ];
    case "s3":
      return [
        { label: t.exUOperation, pattern: " (REST\\.\\S+|WEBSITE\\.\\S+|BATCH\\.\\S+) " },
        { label: t.exURequester, pattern: "\\] \\S+ (\\S+) " },
        { label: t.exUClientIp, pattern: "\\] (\\S+) " },
      ];
    case "cloudtrail":
      return [
        { label: t.exUEventName, pattern: '"eventName":"([^"]+)"' },
        { label: t.exUCaller, pattern: '"arn":"([^"]+)"' },
        { label: t.exUSourceIp, pattern: '"sourceIPAddress":"([^"]+)"' },
        { label: t.exUErrorCode, pattern: '"errorCode":"([^"]+)"' },
      ];
    case "jsonl":
      return [
        { label: t.exULevel, pattern: '"level":"([^"]+)"' },
        { label: t.exUMsg, pattern: '"msg":"([^"]+)"' },
      ];
    case "syslog":
      return [
        { label: t.exUHost, pattern: "^\\w{3} +\\d+ [\\d:]+ (\\S+)" },
        { label: t.exUProcess, pattern: "^\\w{3} +\\d+ [\\d:]+ \\S+ ([^:\\[ ]+)" },
        { label: t.exUSrcIp, pattern: "SRC=(\\S+)" },
        { label: t.exUDstPort, pattern: "DPT=(\\d+)" },
      ];
    case "dpkg":
      return [
        { label: t.exUHost, pattern: "^(\\S+)" },
        { label: t.exUAction, pattern: "^\\S+ \\S+ \\S+ (\\w+) " },
        { label: t.exUPackage, pattern: " (?:install|upgrade|configure|remove) ([^:\\s]+)" },
      ];
    case "pg":
      return [
        { label: t.exUPid, pattern: "\\[(\\d+)\\]" },
        { label: t.exUKind, pattern: "\\] (\\w+):" },
      ];
    case "spring":
      return [
        { label: t.exULevel, pattern: "\\s(TRACE|DEBUG|INFO|WARN|ERROR)\\s" },
        { label: t.exULogger, pattern: "\\] ([\\w.$]+)\\s+:" },
      ];
    case "vpc":
      return [
        { label: t.exUSrcIp, pattern: "^\\S+ \\S+ \\S+ (\\S+)" },
        { label: t.exUDstPort, pattern: "^(?:\\S+ ){6}(\\S+)" },
        { label: t.exUAction, pattern: " (ACCEPT|REJECT) " },
      ];
    case "csv":
    case "csvEpoch":
      return [
        { label: t.exUCol1, pattern: "^([^,]*)" },
        { label: t.exUCol2, pattern: "^[^,]*,([^,]*)" },
      ];
    case "iso":
      return [
        { label: t.exUField2, pattern: "^\\S+ +(\\S+)" },
        { label: t.exUKeys, pattern: "(\\w+)=" },
      ];
    case "text":
      return [{ label: t.exUWord1, pattern: "^(\\S+)" }];
  }
}

const NGINX_MINUTE = "\\[(\\d+/\\w+/\\d+:\\d\\d:\\d\\d)";
const ISO_MINUTE = "(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d)";

/** Timestamp captures per format, best first. The capture is read as a time and plotted on a real axis. */
export function histogramPresetsFor(profile: Profile): PatternPreset[] {
  const t = T();
  switch (profile) {
    case "nginx":
    case "s3":
      return [{ label: t.hlNginx, pattern: NGINX_MINUTE }];
    case "cloudtrail":
      return [{ label: t.hlEventTime, pattern: '"eventTime":"(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d)' }];
    case "jsonl":
      return [
        { label: t.hlJsonTs, pattern: '"(?:ts|time|timestamp|@timestamp)":"(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d)' },
        { label: t.hlIso, pattern: ISO_MINUTE },
      ];
    case "syslog":
      return [{ label: t.hlSyslog, pattern: "^(\\w{3} +\\d+ \\d\\d:\\d\\d)" }];
    case "dpkg":
      return [{ label: t.hlDpkg, pattern: "(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d)" }];
    case "pg":
      return [{ label: t.hlPg, pattern: "^(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d)" }];
    case "spring":
    case "iso":
      return [{ label: t.hlIso, pattern: `^${ISO_MINUTE}` }];
    case "vpc":
      return [{ label: t.hlVpcStart, pattern: "(\\d{10}) \\d{10} (?:ACCEPT|REJECT)" }];
    case "csvEpoch":
      return [{ label: t.hlEpoch, pattern: "^(\\d{10})" }];
    case "csv":
      return [{ label: t.hlIso, pattern: ISO_MINUTE }];
    case "text":
      return [
        { label: t.hlIso, pattern: ISO_MINUTE },
        { label: t.hlSyslog, pattern: "^(\\w{3} +\\d+ \\d\\d:\\d\\d)" },
        { label: t.hlNginx, pattern: NGINX_MINUTE },
      ];
  }
}
