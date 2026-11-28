// The "Start here" case for first-timers (#223, #224): the one case a new visitor, a guest or a player with no
// progress is pointed at, and where "Play now, no sign-up" lands. It is read from the catalog, never hard-coded:
// a case tagged `tutorial` wins (a short tutorial case switches it over the moment it is published), else the
// easiest released case, then the shortest. DOM-free so the rule has unit tests (startHere.test.ts).

/** The small client config: which catalog tag marks a tutorial case. */
export const START_HERE = { preferTag: "tutorial" } as const;

/** The catalog fields the choice reads (a `CaseSummary` has them all). */
export type StartHereCandidate = {
  readonly id: string;
  readonly title: string;
  readonly difficulty: "easy" | "medium" | "hard";
  readonly estMinutes: number;
  readonly tags: readonly string[];
};

const DIFFICULTY_RANK: Readonly<Record<StartHereCandidate["difficulty"], number>> = { easy: 0, medium: 1, hard: 2 };

/** Easiest first, then shortest, then by title and id (stable whatever order the catalog arrives in). */
const easiestFirst = (a: StartHereCandidate, b: StartHereCandidate): number =>
  DIFFICULTY_RANK[a.difficulty] - DIFFICULTY_RANK[b.difficulty] ||
  a.estMinutes - b.estMinutes ||
  a.title.localeCompare(b.title) ||
  a.id.localeCompare(b.id);

/**
 * The start-here case id, or null when no case qualifies.
 * `released` (from GET /api/today) limits the choice to playable cases; null or undefined while it is unknown.
 */
export function pickStartHere(cases: readonly StartHereCandidate[], released?: readonly string[] | null): string | null {
  const playable = released === undefined || released === null ? [...cases] : cases.filter((c) => released.includes(c.id));
  const tutorials = playable.filter((c) => c.tags.some((t) => t.toLowerCase() === START_HERE.preferTag));
  const pool = tutorials.length > 0 ? tutorials : playable;
  return [...pool].sort(easiestFirst)[0]?.id ?? null;
}
