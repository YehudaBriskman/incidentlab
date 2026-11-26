// The home dashboard's case filters and sort as URL state (#/?q=dns&difficulty=hard&tag=k8s&status=completed&sort=hard),
// so a filtered view can be shared. DOM-free, with unit tests (caseFilters.test.ts).

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const STATUSES = ["not-started", "in-progress", "completed"] as const;
export const SORT_PRESETS = ["", "title", "easy", "hard", "short", "score"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];
export type CaseStatus = (typeof STATUSES)[number];
export type SortPreset = (typeof SORT_PRESETS)[number];

export type CaseFilters = {
  readonly q: string;
  readonly difficulty: ReadonlySet<Difficulty>;
  readonly tags: ReadonlySet<string>;
  readonly status: ReadonlySet<CaseStatus>;
  /** a preset, or "<column>:<asc|desc>" chosen from a table header */
  readonly sort: string;
};

export type FilterableCase = {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly difficulty: Difficulty;
  readonly tags: readonly string[];
};

const isDifficulty = (v: string): v is Difficulty => (DIFFICULTIES as readonly string[]).includes(v);
const isStatus = (v: string): v is CaseStatus => (STATUSES as readonly string[]).includes(v);
const SORT_RE = /^(?:title|easy|hard|short|score|[a-z]{1,20}:(?:asc|desc))$/;

/** Values may repeat (`tag=a&tag=b`) or be comma-separated (`tag=a,b`). */
const listOf = (params: URLSearchParams, key: string): string[] =>
  params
    .getAll(key)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= 60);

export function parseFilters(params: URLSearchParams): CaseFilters {
  const sort = params.get("sort") ?? "";
  return {
    q: (params.get("q") ?? "").slice(0, 100),
    difficulty: new Set(listOf(params, "difficulty").filter(isDifficulty)),
    tags: new Set(listOf(params, "tag").slice(0, 20)),
    status: new Set(listOf(params, "status").filter(isStatus)),
    sort: SORT_RE.test(sort) ? sort : "",
  };
}

/** The query string for `filters` ("" when nothing is set), in a stable order. */
export function serializeFilters(filters: CaseFilters): string {
  const params = new URLSearchParams();
  if (filters.q.trim() !== "") params.set("q", filters.q.trim());
  for (const d of DIFFICULTIES) if (filters.difficulty.has(d)) params.append("difficulty", d);
  for (const t of [...filters.tags].sort()) params.append("tag", t);
  for (const s of STATUSES) if (filters.status.has(s)) params.append("status", s);
  if (filters.sort !== "") params.set("sort", filters.sort);
  return params.toString();
}

/** How many filter values are on (the search box and the sort don't count). */
export function activeFilterCount(filters: CaseFilters): number {
  return filters.difficulty.size + filters.tags.size + filters.status.size;
}

/** Does the case pass the search and every filter group? (OR inside a group, AND across groups.) */
export function matchesFilters(c: FilterableCase, status: CaseStatus | null, filters: CaseFilters): boolean {
  const q = filters.q.trim().toLocaleLowerCase();
  if (q !== "") {
    const haystack = [c.id, c.title, c.subtitle, ...c.tags].join(" ").toLocaleLowerCase();
    if (!q.split(/\s+/).every((word) => haystack.includes(word))) return false;
  }
  if (filters.difficulty.size > 0 && !filters.difficulty.has(c.difficulty)) return false;
  if (filters.tags.size > 0 && !c.tags.some((t) => filters.tags.has(t))) return false;
  // Status only means something for a signed-in player (status null = unknown): it is ignored otherwise.
  if (filters.status.size > 0 && status !== null && !filters.status.has(status)) return false;
  return true;
}

/** Tags across the cases, most used first (ties alphabetical), at most `max`. */
export function topTags(cases: readonly Pick<FilterableCase, "tags">[], max = 12): string[] {
  const counts = new Map<string, number>();
  for (const c of cases) for (const tag of c.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([tag]) => tag);
}
