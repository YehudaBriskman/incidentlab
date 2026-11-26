import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { summarize, type CatalogEntry, type EvidenceFormats } from "./src/content/catalog-schema.ts";
import { CaseSchema } from "./src/content/schema.ts";

/**
 * Paid content never ships to the browser. Case JSONs are authored with the full toolbox commands
 * (`command`, `powershell`) and hint texts, which the server hands out only after charging for them
 * (see scripts/make_flags.py and /api/cases/:id/{hint,reveal-command}). This plugin removes them from
 * the case files before Vite turns them into modules. Free fields (syntax, explain, costs) stay.
 * scripts/check-bundle.mjs fails the build if any of it leaks anyway.
 */
const CASE_JSON = /[\\/]src[\\/]content[\\/]cases[\\/][^\\/]+\.json$/;

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

export function stripPaidContent(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const out: JsonObject = { ...raw };
  if (Array.isArray(raw["questions"])) {
    out["questions"] = raw["questions"].map((q: unknown) => {
      if (!isObject(q) || !Array.isArray(q["hints"])) return q;
      return { ...q, hints: q["hints"].map((hint: unknown) => (isObject(hint) ? { cost: hint["cost"] } : hint)) };
    });
  }
  if (Array.isArray(raw["toolbox"])) {
    out["toolbox"] = raw["toolbox"].map((section: unknown) => {
      if (!isObject(section) || !Array.isArray(section["items"])) return section;
      return {
        ...section,
        items: section["items"].map((item: unknown) => {
          if (!isObject(item)) return item;
          const { command: _command, powershell: _powershell, ...free } = item;
          return free;
        }),
      };
    });
  }
  return out;
}

const stripPaidContentPlugin = (): Plugin => ({
  name: "incidentlab-strip-paid-content",
  enforce: "pre",
  transform(code, id) {
    if (!CASE_JSON.test(id.split("?")[0] ?? "")) return null;
    const parsed: unknown = JSON.parse(code);
    return { code: JSON.stringify(stripPaidContent(parsed)), map: null };
  },
});

/**
 * `virtual:case-catalog`: the per-case fields the home page, leaderboard and stats need (title, subtitle,
 * difficulty, estMinutes, tags, question count, in English and Hebrew), so the entry chunk carries a few KB
 * instead of every case in both languages. Full case files are lazy chunks (src/content/load.ts).
 * Invalid cases are left out here, as the runtime loader would reject them too. `_*.json` samples are only
 * included under `vite dev`, and only when no real case has the same id.
 *
 * `virtual:case-evidence-formats`: each case's English evidence format labels, which only the (lazy)
 * Explorer needs, so it ships in the Explorer's chunk rather than the entry.
 */
const CATALOG_ID = "virtual:case-catalog";
const RESOLVED_CATALOG_ID = `\0${CATALOG_ID}`;
const FORMATS_ID = "virtual:case-evidence-formats";
const RESOLVED_FORMATS_ID = `\0${FORMATS_ID}`;
const CASES_DIR = fileURLToPath(new URL("./src/content/cases/", import.meta.url));

function readCase(file: string): ReturnType<typeof CaseSchema.safeParse> {
  return CaseSchema.safeParse(JSON.parse(readFileSync(`${CASES_DIR}${file}`, "utf8")));
}

export function buildCatalog(includeDevSamples: boolean): { entries: CatalogEntry[]; formats: EvidenceFormats } {
  const formats: EvidenceFormats = {};
  const all = readdirSync(CASES_DIR);
  const files = all.filter((f) => f.endsWith(".json") && !f.endsWith(".he.json"))
    .sort((a, b) => Number(a.startsWith("_")) - Number(b.startsWith("_")) || a.localeCompare(b)); // samples last
  const entries = new Map<string, CatalogEntry>();
  for (const file of files) {
    const isSample = file.startsWith("_");
    if (isSample && !includeDevSamples) continue;
    const en = readCase(file);
    if (!en.success) {
      console.warn(`[case-catalog] ${file} failed schema validation; left out`);
      continue;
    }
    if (isSample && entries.has(en.data.id)) continue;
    const stem = file.slice(0, -".json".length);
    const heFile = `${stem}.he.json`;
    const he = all.includes(heFile) ? readCase(heFile) : null;
    entries.set(en.data.id, {
      file: stem,
      en: summarize(en.data),
      he: he?.success && he.data.id === en.data.id ? summarize(he.data) : undefined,
    });
    formats[en.data.id] = en.data.evidence.map((f) => ({ path: f.path, format: f.format }));
  }
  return { entries: [...entries.values()], formats };
}

const caseCatalogPlugin = (): Plugin => {
  let includeDevSamples = false;
  return {
    name: "incidentlab-case-catalog",
    configResolved(config) {
      includeDevSamples = config.command === "serve";
    },
    resolveId(id) {
      return id === CATALOG_ID || id === FORMATS_ID ? `\0${id}` : null;
    },
    load(id) {
      if (id === RESOLVED_CATALOG_ID) return `export default ${JSON.stringify(buildCatalog(includeDevSamples).entries)};`;
      if (id === RESOLVED_FORMATS_ID) return `export default ${JSON.stringify(buildCatalog(includeDevSamples).formats)};`;
      return null;
    },
    configureServer(server) {
      // Editing a case JSON changes the catalog too: rebuild it and reload the page.
      const refresh = (file: string): void => {
        if (!CASE_JSON.test(file)) return;
        for (const id of [RESOLVED_CATALOG_ID, RESOLVED_FORMATS_ID]) {
          const mod = server.moduleGraph.getModuleById(id);
          if (mod !== undefined) server.moduleGraph.invalidateModule(mod);
        }
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("change", refresh).on("add", refresh).on("unlink", refresh);
    },
  };
};

/** The commit this build came from (BUILD_SHA wins, then git; "-dirty" marks uncommitted changes). */
const buildSha = (): string => {
  const fromEnv = process.env.BUILD_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return git("rev-parse", "--short=12", "HEAD") + (git("status", "--porcelain") === "" ? "" : "-dirty");
  } catch {
    return "unknown";
  }
};

/** Stamps `<meta name="build">` so anyone can tell which commit is live (view source, or the smoke test). */
const buildStampPlugin = (): Plugin => {
  const sha = buildSha();
  return {
    name: "incidentlab-build-stamp",
    transformIndexHtml: () => [{ tag: "meta", attrs: { name: "build", content: sha }, injectTo: "head" }],
  };
};

export default defineConfig({
  base: "/",
  plugins: [stripPaidContentPlugin(), caseCatalogPlugin(), buildStampPlugin()],
  build: { outDir: "dist", sourcemap: false },
});
