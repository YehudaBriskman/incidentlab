import { CaseSchema, TeasersSchema, type Case, type Teaser } from "./schema";

/*
 * Content is bundled at build time and validated with zod at startup.
 *
 * Cases: every `cases/*.json` file except ones starting with "_" is a real case.
 * `_dev-sample.json` is only picked up in `vite dev` (the DEV branch is
 * dead-code-eliminated in production builds) and only when no real case with
 * the same id exists, so it never ships.
 */
const realCaseModules = import.meta.glob<unknown>(["./cases/*.json", "!./cases/_*.json"], {
  eager: true,
  import: "default",
});

const devCaseModules: Record<string, unknown> = import.meta.env.DEV
  ? import.meta.glob<unknown>("./cases/_*.json", { eager: true, import: "default" })
  : {};

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
export const teasers: readonly Teaser[] = parseTeasers();

export function getCase(id: string): Case | undefined {
  return cases.get(id);
}

export function featuredCase(): Case | undefined {
  return cases.get(FEATURED_CASE_ID) ?? cases.values().next().value;
}
