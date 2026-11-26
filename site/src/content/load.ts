import { getLang, type Lang } from "../i18n/i18n";
import { TeasersSchema, type CaseSummary, type CatalogEntry, type Teaser } from "./catalog-schema";
import type { Case } from "../../shared/case";
import { fetchDbCatalog, loadDbCase } from "./db-cases";
import teasersRaw from "./teasers.json";

/*
 * Case content comes only from the content API (#68); nothing about a case is in the bundle.
 *
 * 1. The catalog: GET /api/cases, fetched once per page load (`catalogReady`). It lists every published
 *    case with its version and the few fields the home page, leaderboard and stats need, per language.
 *    The router waits for it before it decides whether a case id exists.
 * 2. Full cases: GET /api/cases/<id>/content, fetched by `loadCase` only when a case route opens, in the
 *    active language (content/db-cases.ts), and cached per id, version and language. Hint texts and
 *    runnable commands are never in it: the server hands them out in `progress.unlocked` after charging.
 */

export const FEATURED_CASE_ID = "3am-outage";

function parseTeasers(): Teaser[] {
  const result = TeasersSchema.safeParse(teasersRaw);
  if (!result.success) {
    console.error("[content] teasers.json failed schema validation", result.error.issues);
    return [];
  }
  return result.data;
}
export const teasers: readonly Teaser[] = parseTeasers();

/* ---------- catalog ---------- */

let catalog = new Map<string, CatalogEntry>();
let catalogState: "loading" | "ready" | "failed" = "loading";
const catalogListeners = new Set<() => void>();

async function fetchCatalog(): Promise<void> {
  const entries = await fetchDbCatalog();
  if (entries === null) {
    catalogState = "failed";
  } else {
    catalog = new Map(entries.map((e) => [e.en.id, e]));
    catalogState = "ready";
  }
  for (const fn of catalogListeners) fn();
}

/** Resolves once the catalog has loaded, or could not be fetched (`catalogFailed()`); it never rejects. */
export let catalogReady: Promise<void> = fetchCatalog();

/** True when the last catalog fetch failed (the API could not be reached). */
export function catalogFailed(): boolean {
  return catalogState === "failed";
}

/** True until the first catalog fetch has answered. */
export function catalogLoading(): boolean {
  return catalogState === "loading";
}

/** Fetch the catalog again (a retry after `catalogFailed()`); listeners run when it answers. */
export function reloadCatalog(): Promise<void> {
  catalogState = "loading";
  catalogReady = fetchCatalog();
  return catalogReady;
}

/** Called whenever the catalog answers (first load or a retry). */
export function onCatalogChange(fn: () => void): void {
  catalogListeners.add(fn);
}

const summaryIn = (entry: CatalogEntry, lang: Lang): CaseSummary => (lang === "he" ? (entry.he ?? entry.en) : entry.en);

/** A case's catalog card in the active language, or undefined for an unknown id (or before the catalog loaded). */
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

/* ---------- full cases (lazy, per id, version and language) ---------- */

const pending = new Map<string, Promise<Case | undefined>>();
const loaded = new Map<string, Case>();
/** The catalog's version is part of the key, so a newly published version is fetched fresh. */
const cacheKey = (id: string, lang: Lang): string => `${lang}:${id}:v${catalog.get(id)?.version ?? 0}`;

/**
 * The full case in `lang` (default: the active language), validated. Resolves undefined for an id the
 * catalog does not list or the API does not serve; rejects only on a network failure (a later call retries).
 */
export function loadCase(id: string, lang: Lang = getLang()): Promise<Case | undefined> {
  const key = cacheKey(id, lang);
  const existing = pending.get(key);
  if (existing !== undefined) return existing;
  const entry = catalog.get(id);
  if (entry === undefined) return Promise.resolve(undefined);
  const promise = loadDbCase(id, lang, entry.version).then(
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
  await catalogReady;
  await Promise.all([...catalog.keys()].map((id) => loadCase(id)));
}

/** A case already fetched by `loadCase` in the active language; undefined if it has not loaded (yet). */
export function cachedCase(id: string): Case | undefined {
  return loaded.get(cacheKey(id, getLang()));
}
