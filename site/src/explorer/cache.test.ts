// Run: node --test --experimental-strip-types src/explorer/
import { test } from "node:test";
import assert from "node:assert/strict";

const mod: typeof import("./cache") = await import(new URL("./cache.ts", import.meta.url).href);

/** A tiny in-memory Cache Storage: enough of the API for cachedFetch. */
function fakeCaches(): { storage: CacheStorage; entries: Map<string, Response> } {
  const entries = new Map<string, Response>();
  const keyOf = (req: RequestInfo | URL): string => (typeof req === "string" ? req : req instanceof URL ? req.href : req.url);
  const cache = {
    async match(req: RequestInfo | URL) {
      const hit = entries.get(keyOf(req));
      return hit ? hit.clone() : undefined;
    },
    async put(req: RequestInfo | URL, res: Response) {
      const body = await res.arrayBuffer();
      entries.set(keyOf(req), new Response(body, { status: res.status, headers: res.headers }));
    },
    async delete(req: RequestInfo | URL) {
      return entries.delete(keyOf(req));
    },
    async keys() {
      return [...entries.keys()].map((k) => new Request(k));
    },
  };
  const storage = { open: async () => cache } as unknown as CacheStorage;
  return { storage, entries };
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(respond: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = init?.headers;
    const headers: Record<string, string> = raw && !(raw instanceof Headers) && !Array.isArray(raw) ? { ...raw } : {};
    const call = { url: String(input), headers };
    calls.push(call);
    return respond(call);
  };
  return { fetch: f, calls };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const signal = new AbortController().signal;

test("a validated entry is revalidated with If-None-Match and a 304 reuses the stored body", async () => {
  const { storage } = fakeCaches();
  const net = fakeFetch((call) =>
    call.headers["If-None-Match"] === '"v1"' ? new Response(null, { status: 304 }) : new Response("a\nb\n", { headers: { etag: '"v1"' } }),
  );
  const deps = { caches: storage, fetch: net.fetch, now: () => 1 };
  const first = await mod.cachedFetch("http://x/e/a.log", signal, "s1", deps);
  assert.equal(first.fromCache, false);
  assert.equal(await first.res.text(), "a\nb\n");
  await settle();
  const second = await mod.cachedFetch("http://x/e/a.log", signal, "s2", deps);
  assert.equal(second.fromCache, true);
  assert.equal(await second.res.text(), "a\nb\n");
  assert.equal(net.calls[1]?.headers["If-None-Match"], '"v1"');
});

test("a changed file (200 on revalidation) replaces the stored copy", async () => {
  const { storage } = fakeCaches();
  let version = 1;
  const net = fakeFetch((call) =>
    call.headers["If-None-Match"] === `"v${version}"` ? new Response(null, { status: 304 }) : new Response(`body ${version}`, { headers: { etag: `"v${version}"` } }),
  );
  const deps = { caches: storage, fetch: net.fetch, now: () => 1 };
  await (await mod.cachedFetch("http://x/e/a.log", signal, "s", deps)).res.text();
  await settle();
  version = 2;
  const next = await mod.cachedFetch("http://x/e/a.log", signal, "s", deps);
  assert.equal(next.fromCache, false);
  assert.equal(await next.res.text(), "body 2");
});

test("an immutable (versioned) file is reused without a request, in any session", async () => {
  const { storage } = fakeCaches();
  const net = fakeFetch(() => new Response("v1 body", { headers: { etag: '"sha"', "cache-control": "public, max-age=31536000, immutable" } }));
  const deps = { caches: storage, fetch: net.fetch, now: () => 1 };
  await (await mod.cachedFetch("http://x/evidence/db/c/v1/files/a.log", signal, "s1", deps)).res.text();
  await settle();
  const again = await mod.cachedFetch("http://x/evidence/db/c/v1/files/a.log", signal, "s2", deps);
  assert.equal(again.fromCache, true);
  assert.equal(await again.res.text(), "v1 body");
  assert.equal(net.calls.length, 1, "no revalidation for an immutable URL");
});

test("without a validator, a stored body is reused only in the same page session", async () => {
  const { storage } = fakeCaches();
  const net = fakeFetch(() => new Response("x"));
  const deps = { caches: storage, fetch: net.fetch, now: () => 1 };
  await (await mod.cachedFetch("http://x/e/a.log", signal, "s1", deps)).res.text();
  await settle();
  const same = await mod.cachedFetch("http://x/e/a.log", signal, "s1", deps);
  assert.equal(same.fromCache, true);
  assert.equal(net.calls.length, 1);
  const other = await mod.cachedFetch("http://x/e/a.log", signal, "s2", deps);
  assert.equal(other.fromCache, false);
  assert.equal(net.calls.length, 2);
});

test("no Cache Storage (blocked or insecure): plain network fetch", async () => {
  const net = fakeFetch(() => new Response("x"));
  const r = await mod.cachedFetch("http://x/e/a.log", signal, "s", { caches: undefined, fetch: net.fetch, now: () => 1 });
  assert.equal(r.fromCache, false);
  assert.equal(await r.res.text(), "x");
});

test("errors are not cached and old entries are pruned", async () => {
  const { storage, entries } = fakeCaches();
  let t = 0;
  const net = fakeFetch((call) => (call.url.endsWith("missing") ? new Response("no", { status: 404 }) : new Response("x")));
  const deps = { caches: storage, fetch: net.fetch, now: () => ++t };
  await (await mod.cachedFetch("http://x/e/missing", signal, "s", deps)).res.text();
  await settle();
  assert.equal(entries.size, 0);
  for (let i = 0; i < mod.MAX_ENTRIES + 2; i++) {
    await (await mod.cachedFetch(`http://x/e/${i}.log`, signal, "s", deps)).res.text();
    await settle();
  }
  assert.equal(entries.size, mod.MAX_ENTRIES);
  assert.ok(!entries.has("http://x/e/0.log"));
  assert.deepEqual(mod.conditionalHeaders(new Headers({ "x-il-last-modified": "Tue" })), { "If-Modified-Since": "Tue" });
});
