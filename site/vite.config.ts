import { defineConfig, type Plugin } from "vite";

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

export default defineConfig({
  base: "/",
  plugins: [stripPaidContentPlugin()],
  build: { outDir: "dist", sourcemap: false },
});
