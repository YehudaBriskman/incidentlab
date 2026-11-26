import catalogRaw from "virtual:case-catalog";
import { getLang, type Lang } from "../i18n/i18n";
import { CatalogSchema, TeasersSchema, type CaseSummary, type CatalogEntry, type Teaser } from "./catalog-schema";
import { CaseSchema, type Case } from "../../shared/case";
import { fetchDbCatalog, loadDbCase } from "./db-cases";

/*
 * Two layers of content:
 *
 * 1. The catalog (virtual:case-catalog, generated in vite.config.ts): id, title, subtitle, difficulty,
 *    estMinutes, tags and question count per case and language. It is in the entry chunk, so the home page,
 *    leaderboard and stats render without loading any case.
 * 2. Full cases: each `cases/<id>.json` and `cases/<id>.he.json` is its own lazy chunk, fetched by
 *    `loadCase` only when a case route opens, in the active language only (Hebrew falls back to English when
 *    its file is missing or invalid). Each file is validated with zod when it loads.
 *
 * The paid-content strip plugin in vite.config.ts transforms every case JSON module, so it applies to each
 * of these chunks. `_dev-sample.json` is only reachable under `vite dev`: its loader glob sits behind
 * `import.meta.env.DEV` (dead-code-eliminated in production builds) and the catalog leaves it out of builds.
 */
const enLoaders = import.meta.glob<unknown>(["./cases/*.json", "!./cases/_*.json", "!./cases/*.he.json"], { import: "default" });
const devLoaders: Record<string, () => Promise<unknown>> = import.meta.env.DEV
  ? import.meta.glob<unknown>("./cases/_*.json", { import: "default" })
  : {};
const heLoaders = import.meta.glob<unknown>("./cases/*.he.json", { import: "default" });

const teaserModules = import.meta.glob<unknown>("./teasers.json", { eager: true, import: "default" });

export const FEATURED_CASE_ID = "3am-outage";

function parseCatalog(): CatalogEntry[] {
  const result = CatalogSchema.safeParse(catalogRaw);
  if (!result.success) {
    console.error("[content] case catalog failed schema validation", result.error.issues);
    return [];
  }
  return result.data;
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

/** Bundled cases first; DB-published cases (content/db-cases.ts) join or replace them when /api/cases answers. */
const catalog = new Map<string, CatalogEntry>(parseCatalog().map((e) => [e.en.id, e]));
const dbIds = new Set<string>();
const catalogListeners = new Set<() => void>();

/** How long the first DB catalog fetch may hold back a case route before it falls back to bundled cases. */
const DB_CATALOG_WAIT_MS = 4000;

/** Resolves once the DB catalog has been merged in (or could not be fetched, or took too long). */
export const catalogReady: Promise<void> = Promise.race([
  fetchDbCatalog().then((entries) => {
    let changed = false;
    for (const entry of entries) {
      dbIds.add(entry.en.id);
      const before = catalog.get(entry.en.id);
      if (before === undefined || JSON.stringify(before) !== JSON.stringify(entry)) changed = true;
      catalog.set(entry.en.id, entry);
    }
    if (changed) for (const fn of catalogListeners) fn();
  }),
  new Promise<void>((resolve) => setTimeout(resolve, DB_CATALOG_WAIT_MS)),
]);

/** Called when DB cases change the catalog after the first render (new or retitled cases). */
export function onCatalogChange(fn: () => void): void {
  catalogListeners.add(fn);
}

/** True for a case served from the DB (its evidence lives under /evidence/db/). */
export function isDbCase(id: string): boolean {
  return dbIds.has(id);
}
export const teasers: readonly Teaser[] = parseTeasers();

/* ---------- catalog (synchronous) ---------- */

const summaryIn = (entry: CatalogEntry, lang: Lang): CaseSummary => (lang === "he" ? (entry.he ?? entry.en) : entry.en);

/** A case's catalog card in the active language, or undefined for an unknown id. */
export function caseSummary(id: string): CaseSummary | undefined {
  const entry = catalog.get(id);
  return entry === undefined ? undefined : summaryIn(entry, getLang());
}

/** Catalog order: the original case first, then easiest to hardest, then by (English) title. */
const DIFFICULTY_ORDER: Record<CaseSummary["difficulty"], number> = { easy: 0, medium: 1, hard: 2 };
export function caseSummaries(): CaseSummary[] {
  const lang = getLang();
  return [...catalog.values()]
    .sort(
      (a, b) =>
        Number(b.en.id === FEATURED_CASE_ID) - Number(a.en.id === FEATURED_CASE_ID) ||
        DIFFICULTY_ORDER[a.en.difficulty] - DIFFICULTY_ORDER[b.en.difficulty] ||
        a.en.title.localeCompare(b.en.title),
    )
    .map((e) => summaryIn(e, lang));
}

/* ---------- full cases (lazy, one chunk per case and language) ---------- */

const pending = new Map<string, Promise<Case | undefined>>();
const loaded = new Map<string, Case>();
const cacheKey = (id: string, lang: Lang): string => `${lang}:${id}`;

async function importEnglish(entry: CatalogEntry): Promise<Case | undefined> {
  const path = `./cases/${entry.file}.json`;
  const load = enLoaders[path] ?? devLoaders[path];
  if (load === undefined) return undefined;
  const result = CaseSchema.safeParse(await load());
  if (!result.success) {
    console.error(`[content] ${path} failed schema validation`, result.error.issues);
    return undefined;
  }
  return result.data.id === entry.en.id ? result.data : undefined;
}

async function importHebrew(entry: CatalogEntry): Promise<Case | undefined> {
  const path = `./cases/${entry.file}.he.json`;
  const load = heLoaders[path];
  if (load !== undefined) {
    const result = CaseSchema.safeParse(await load());
    if (result.success && result.data.id === entry.en.id) return result.data;
    console.warn(`[content] ${path} failed schema validation; using English`, result.error?.issues);
  }
  return loadCase(entry.en.id, "en");
}

/**
 * The full case in `lang` (default: the active language), validated. Resolves undefined for an unknown or
 * invalid case; rejects only when the chunk could not be fetched (a later call retries).
 */
export function loadCase(id: string, lang: Lang = getLang()): Promise<Case | undefined> {
  const key = cacheKey(id, lang);
  const existing = pending.get(key);
  if (existing !== undefined) return existing;
  const entry = catalog.get(id);
  if (entry === undefined) return Promise.resolve(undefined);
  const source = dbIds.has(id) ? loadDbCase(id, lang) : lang === "he" ? importHebrew(entry) : importEnglish(entry);
  const promise = source.then(
    (c) => {
      if (c !== undefined) loaded.set(key, c);
      return c;
    },
    (err: unknown) => {
      pending.delete(key); // network failure: let the next visit try again
      throw err;
    },
  );
  pending.set(key, promise);
  return promise;
}

/** Load every catalog case in the active language (the admin dashboard needs all titles and questions). */
export async function loadAllCases(): Promise<void> {
  await Promise.all([...catalog.keys()].map((id) => loadCase(id)));
}

/** A case already fetched by `loadCase` in the active language; undefined if it has not loaded (yet). */
export function cachedCase(id: string): Case | undefined {
  return loaded.get(cacheKey(id, getLang()));
}
