// Download cache for evidence files, used by the worker. A worker restart (a regex blew the time budget, or a
// crash) loses every parsed file; without this, a 40 MB log would be downloaded again. Bodies live in Cache
// Storage (on disk), so nothing extra stays in memory: a hit streams back through the same line splitter.
//
// Freshness: when the server sent an ETag or Last-Modified, a hit is revalidated with a conditional GET (304 =
// use the stored body, no transfer). Without a validator, a stored body is only reused inside the page session
// that stored it, so a later deploy can never serve stale evidence.

export const CACHE_NAME = "il-evidence-v1";
export const MAX_ENTRIES = 6;

const H_ETAG = "x-il-etag";
const H_LASTMOD = "x-il-last-modified";
const H_SESSION = "x-il-session";
const H_STORED = "x-il-stored";

export interface CacheDeps {
  caches: CacheStorage | undefined;
  fetch: typeof fetch;
  now: () => number;
}

export interface CachedResponse {
  res: Response;
  fromCache: boolean;
}

function defaultDeps(): CacheDeps {
  return {
    caches: typeof caches === "undefined" ? undefined : caches,
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
  };
}

/** Conditional request headers for a stored entry, or null when it carries no validator. */
export function conditionalHeaders(stored: Headers): Record<string, string> | null {
  const etag = stored.get(H_ETAG);
  if (etag) return { "If-None-Match": etag };
  const lastMod = stored.get(H_LASTMOD);
  if (lastMod) return { "If-Modified-Since": lastMod };
  return null;
}

/** The stored copy of `res`: the body plus the headers the loader and revalidation need. */
function storable(res: Response, body: ReadableStream<Uint8Array> | null, session: string, now: number): Response {
  const headers = new Headers();
  const type = res.headers.get("content-type");
  if (type) headers.set("content-type", type);
  const encoding = (res.headers.get("content-encoding") ?? "identity").toLowerCase();
  const length = res.headers.get("content-length");
  // A decoded body no longer matches a compressed content-length, so only keep it for identity responses.
  if (encoding === "identity" && length) headers.set("content-length", length);
  const etag = res.headers.get("etag");
  const lastMod = res.headers.get("last-modified");
  if (etag) headers.set(H_ETAG, etag);
  if (lastMod) headers.set(H_LASTMOD, lastMod);
  headers.set(H_SESSION, session);
  headers.set(H_STORED, String(now));
  return new Response(body, { status: 200, headers });
}

async function prune(cache: Cache, keep: number): Promise<void> {
  const keys = await cache.keys();
  if (keys.length <= keep) return;
  const dated: Array<[Request, number]> = [];
  for (const req of keys) {
    const hit = await cache.match(req);
    dated.push([req, Number(hit?.headers.get(H_STORED) ?? "0")]);
  }
  dated.sort((a, b) => a[1] - b[1]);
  for (const [req] of dated.slice(0, dated.length - keep)) await cache.delete(req);
}

/**
 * Fetches `url`, answering from the cache when the stored copy is still good. `session` identifies the page
 * session (see the header comment). Never throws for cache trouble: it falls back to the network.
 */
export async function cachedFetch(url: string, signal: AbortSignal, session: string, deps: CacheDeps = defaultDeps()): Promise<CachedResponse> {
  let cache: Cache | null = null;
  try {
    cache = deps.caches ? await deps.caches.open(CACHE_NAME) : null;
  } catch {
    cache = null; // blocked storage (private mode, insecure origin)
  }
  if (!cache) return { res: await deps.fetch(url, { signal }), fromCache: false };

  let hit: Response | undefined;
  try {
    hit = await cache.match(url);
  } catch {
    hit = undefined;
  }
  let res: Response;
  if (hit) {
    const cond = conditionalHeaders(hit.headers);
    if (cond === null) {
      if (hit.headers.get(H_SESSION) === session) return { res: hit, fromCache: true };
      await cache.delete(url).catch(() => false);
      res = await deps.fetch(url, { signal });
    } else {
      try {
        res = await deps.fetch(url, { signal, cache: "no-store", headers: cond });
      } catch (err) {
        if (signal.aborted) throw err;
        return { res: hit, fromCache: true }; // offline: the stored copy is the best we have
      }
      if (res.status === 304) return { res: hit, fromCache: true };
    }
  } else {
    res = await deps.fetch(url, { signal });
  }
  if (!res.ok || !res.body) return { res, fromCache: false };

  const [mine, theirs] = res.body.tee();
  const toStore = storable(res, theirs, session, deps.now());
  const store = cache;
  void store
    .put(url, toStore)
    .then(() => prune(store, MAX_ENTRIES))
    .catch(() => { /* quota or an aborted download: just not cached */ });
  return { res: new Response(mine, { status: res.status, headers: res.headers }), fromCache: false };
}
