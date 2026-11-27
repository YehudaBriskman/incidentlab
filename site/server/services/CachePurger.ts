// Purges CDN-cached public API responses by tag after an instructor write, so the change shows at once
// instead of after the cache's max-age (see `publicJson` in controllers/http.ts and docs/API.md).
// Production purges through Netlify's cache API; tests and the local server use the no-op purger.

/**
 * One tag per public, non-personalised GET that the CDN may cache; `class:<classId>` is one class's board (#181),
 * `catalog` is GET /api/cases and `case:<caseId>` every language and version of that case's public content (#243).
 */
export type CacheTag = "event" | "today" | "leaderboard" | "catalog" | `class:${string}` | `case:${string}`;

export const classBoardTag = (classId: string): CacheTag => `class:${classId}`;
export const caseContentTag = (caseId: string): CacheTag => `case:${caseId}`;
/** What a change to a case's live version (publish, rollback, approve, delete, restore) makes stale. */
export const caseChangeTags = (caseId: string): CacheTag[] => ["catalog", caseContentTag(caseId)];

export interface CachePurger {
  purge(tags: readonly CacheTag[]): Promise<void>;
}

/** Tests, the local server and any store without a CDN in front of it. */
export const noopCachePurger: CachePurger = {
  purge: () => Promise.resolve(),
};

/**
 * Netlify's purge API (`purgeCache` from @netlify/functions). Loaded lazily so node tests never import it, and
 * never throws: a failed purge only means the old response lives until its short max-age runs out.
 */
export const netlifyCachePurger: CachePurger = {
  async purge(tags) {
    if (tags.length === 0) return;
    try {
      const { purgeCache } = await import("@netlify/functions");
      await purgeCache({ tags: [...tags] });
    } catch (error) {
      console.error("[incidentlab-api] CDN cache purge failed", tags, error);
    }
  },
};
