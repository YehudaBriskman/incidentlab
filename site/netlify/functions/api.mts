// Netlify Functions v2 entry point for /api/*. All logic lives in site/server (Controller -> Service -> Repository).
import type { Context } from "@netlify/functions";
import { errorResponse } from "../../server/controllers/http.ts";
import { BlobsByteStore, InMemoryByteStore } from "../../server/repositories/ByteStore.ts";
import type { ByteStore } from "../../server/repositories/ByteStore.ts";
import { BlobsKvStore, InMemoryKvStore } from "../../server/repositories/KvStore.ts";
import type { KvStore } from "../../server/repositories/KvStore.ts";
import { createApp } from "../../server/router.ts";
import type { App } from "../../server/router.ts";
import { netlifyCachePurger, noopCachePurger } from "../../server/services/CachePurger.ts";
import { fetchUsage } from "../../server/ops/netlify-usage.ts";
import type { UsageSource } from "../../server/services/UsageService.ts";

/**
 * The owner overview's budget tile (#235): only when NETLIFY_USAGE_TOKEN (a personal access token, read-only use) is
 * set on the site. SITE_ID is set by Netlify in every function; NETLIFY_USAGE_SITE_ID overrides it.
 */
const usageSource: UsageSource = {
  token: () => process.env.NETLIFY_USAGE_TOKEN,
  siteId: () => process.env.NETLIFY_USAGE_SITE_ID ?? process.env.SITE_ID,
  fetch: fetchUsage,
};

type Stores = { readonly kv: KvStore; readonly bytes: ByteStore };

let stores: Stores | null = null;
let app: App | null = null;

const selectStores = (): Stores =>
  process.env.INCIDENTLAB_STORE === "memory"
    ? { kv: new InMemoryKvStore(), bytes: new InMemoryByteStore() }
    : { kv: new BlobsKvStore(), bytes: new BlobsByteStore() };

/** The stores behind the app. tests/local-server.ts uses them to serve /evidence/db/ from the same memory. */
export const appStores = (): Stores => {
  stores ??= selectStores();
  return stores;
};

const getApp = (): App => {
  const { kv, bytes } = appStores();
  // Purge the CDN only where there is one: the in-memory store is the local server and the tests.
  const cachePurger = process.env.INCIDENTLAB_STORE === "memory" ? noopCachePurger : netlifyCachePurger;
  app ??= createApp({ store: kv, bytes, adminKey: () => process.env.ADMIN_KEY, cachePurger, usage: usageSource });
  return app;
};

/** Test hook: drop the cached app (and its in-memory stores). */
export const resetAppForTests = (): void => {
  app = null;
  stores = null;
};

export default async (req: Request, context: Pick<Context, "ip">): Promise<Response> => {
  try {
    return await getApp().handle(req, context.ip);
  } catch (error) {
    console.error("[incidentlab-api] fatal", error);
    return errorResponse(500, "internal");
  }
};

export const config = { path: "/api/*" };
