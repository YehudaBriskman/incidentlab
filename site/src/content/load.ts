import { getLang, type Lang } from "../i18n/i18n";
import { TeasersSchema, type CaseSummary, type CatalogEntry, type Teaser } from "./catalog-schema";
import type { Case } from "../../shared/case";
import { fetchDbCatalog, loadDbCase } from "./db-cases";
import { fetchMyCases } from "../lib/api";
import { pickStartHere } from "../lib/startHere";
import { loadAccount, mayHavePrivateCases, onAccountChange } from "../lib/session";
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
 * 3. Private cases (#184): never in the public catalog. When the session says the account may have some, the
 *    personalised GET /api/me/cases lists the ones it may play, and they join the catalog for this page load
 *    (fetched again when someone else signs in). Their content comes from the same content route, no-store.
 */

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
let publicEntries: CatalogEntry[] = [];
let privateEntries: CatalogEntry[] = [];
/** The account the private entries belong to (null: signed out), so a sign-in or sign-out fetches them again. */
let privateOwner: string | null = null;
let catalogState: "loading" | "ready" | "failed" = "loading";
const catalogListeners = new Set<() => void>();

const rebuildCatalog = (): void => {
  catalog = new Map([...privateEntries, ...publicEntries].map((e) => [e.en.id, e]));
};

/** The private cases this session may play; [] for visitors and whenever the call fails (public cases still load). */
async function fetchPrivateEntries(): Promise<CatalogEntry[]> {
  try {
    const account = await loadAccount();
    privateOwner = account?.id ?? null;
    return account !== null && mayHavePrivateCases() ? await fetchMyCases() : [];
  } catch {
    return [];
  }
}

async function fetchCatalog(): Promise<void> {
  const [entries, mine] = await Promise.all([fetchDbCatalog(), fetchPrivateEntries()]);
  if (entries === null) {
    catalogState = "failed";
  } else {
    publicEntries = entries;
    privateEntries = mine;
    rebuildCatalog();
    catalogState = "ready";
  }
  for (const fn of catalogListeners) fn();
}

// Someone signed in or out after the catalog loaded: their private cases come or go (one call per sign-in).
onAccountChange((account) => {
  const id = account?.id ?? null;
  if (catalogState === "loading" || id === privateOwner) return;
  privateOwner = id;
  const next = account === null || account.kind === "guest" ? Promise.resolve([]) : fetchMyCases().catch((): CatalogEntry[] => []);
  void next.then((mine) => {
    if (privateOwner !== id) return; // another change won meanwhile
    privateEntries = mine;
    rebuildCatalog();
    for (const fn of catalogListeners) fn();
  });
});

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
/** The published version of a case (from the catalog), or undefined before the catalog has it. */
export function caseVersion(id: string): number | undefined {
  return catalog.get(id)?.version;
}

export function caseSummary(id: string): CaseSummary | undefined {
  const entry = catalog.get(id);
  return entry === undefined ? undefined : summaryIn(entry, getLang());
}

/** Catalog order: easiest to hardest, then by (English) title. */
const DIFFICULTY_ORDER: Record<CaseSummary["difficulty"], number> = { easy: 0, medium: 1, hard: 2 };
export function caseSummaries(): CaseSummary[] {
  const lang = getLang();
  return [...catalog.values()]
    .sort(
      (a, b) =>
        DIFFICULTY_ORDER[a.en.difficulty] - DIFFICULTY_ORDER[b.en.difficulty] ||
        a.en.title.localeCompare(b.en.title),
    )
    .map((e) => summaryIn(e, lang));
}

/**
 * The "Start here" case (lib/startHere.ts): a published case tagged `tutorial`, else the easiest and shortest.
 * Reads the English entries, so the tag test never depends on the active language. Public cases only: a private
 * class case is never a stranger's first case. `released` (GET /api/today) limits it to playable cases when known.
 */
export function startHereCaseId(released?: readonly string[] | null): string | null {
  return pickStartHere(publicEntries.map((e) => e.en), released);
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
