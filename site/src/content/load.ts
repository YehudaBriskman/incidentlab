import { getLang } from "../i18n/i18n";
import { CaseSchema, TeasersSchema, type Case, type Teaser } from "./schema";

/*
 * Content is bundled at build time and validated with zod at startup.
 *
 * Cases: every `cases/*.json` file except ones starting with "_" is a real case.
 * `_dev-sample.json` is only picked up in `vite dev` (the DEV branch is
 * dead-code-eliminated in production builds) and only when no real case with
 * the same id exists, so it never ships.
 */
const realCaseModules = import.meta.glob<unknown>(["./cases/*.json", "!./cases/_*.json", "!./cases/*.he.json"], {
  eager: true,
  import: "default",
});

const devCaseModules: Record<string, unknown> = import.meta.env.DEV
  ? import.meta.glob<unknown>("./cases/_*.json", { eager: true, import: "default" })
  : {};

// Hebrew translations: cases/<id>.he.json. Optional; a missing or invalid file falls back to English.
const heCaseModules = import.meta.glob<unknown>("./cases/*.he.json", { eager: true, import: "default" });

const teaserModules = import.meta.glob<unknown>("./teasers.json", { eager: true, import: "default" });

export const FEATURED_CASE_ID = "3am-outage";

function parseCases(): Map<string, Case> {
  const cases = new Map<string, Case>();
  const add = (path: string, raw: unknown, overwrite: boolean): void => {
    const result = CaseSchema.safeParse(raw);
    if (!result.success) {
      console.error(`[content] ${path} failed schema validation`, result.error.issues);
      return;
    }
    if (overwrite || !cases.has(result.data.id)) cases.set(result.data.id, result.data);
  };
  for (const [path, raw] of Object.entries(realCaseModules)) add(path, raw, true);
  for (const [path, raw] of Object.entries(devCaseModules)) add(path, raw, false);
  return cases;
}

function parseTeasers(): Teaser[] {
  const raw = Object.values(teaserModules)[0];
  if (raw === undefined) return [];
  const result = TeasersSchema.safeParse(raw);
  if (!result.success) {
    console.error("[content] teasers.json failed schema validation", result.error.issues);
    return [];
  }
  return result.data;
}

export const cases: ReadonlyMap<string, Case> = parseCases();

/** Hebrew overrides keyed by case id; only valid files whose id matches an English case. */
function parseHebrewCases(): Map<string, Case> {
  const out = new Map<string, Case>();
  for (const [path, raw] of Object.entries(heCaseModules)) {
    const result = CaseSchema.safeParse(raw);
    if (!result.success) {
      console.warn(`[content] ${path} failed schema validation; using English`, result.error.issues);
      continue;
    }
    if (cases.has(result.data.id)) out.set(result.data.id, result.data);
  }
  return out;
}
const heCases: ReadonlyMap<string, Case> = parseHebrewCases();

function localized(c: Case | undefined): Case | undefined {
  if (c === undefined || getLang() !== "he") return c;
  return heCases.get(c.id) ?? c;
}
export const teasers: readonly Teaser[] = parseTeasers();

export function getCase(id: string): Case | undefined {
  return localized(cases.get(id));
}

export function featuredCase(): Case | undefined {
  return localized(cases.get(FEATURED_CASE_ID) ?? cases.values().next().value);
}
