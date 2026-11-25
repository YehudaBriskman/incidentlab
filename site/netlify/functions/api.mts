// Netlify Functions v2 entry point for /api/*. All logic lives in site/server (Controller -> Service -> Repository).
import type { Context } from "@netlify/functions";
import { errorResponse } from "../../server/controllers/http.ts";
import { BlobsKvStore, InMemoryKvStore } from "../../server/repositories/KvStore.ts";
import type { KvStore } from "../../server/repositories/KvStore.ts";
import { createApp } from "../../server/router.ts";
import type { App } from "../../server/router.ts";

let app: App | null = null;

const selectStore = (): KvStore => (process.env.INCIDENTLAB_STORE === "memory" ? new InMemoryKvStore() : new BlobsKvStore());

const getApp = (): App => {
  app ??= createApp({ store: selectStore(), adminKey: () => process.env.ADMIN_KEY });
  return app;
};

/** Test hook: drop the cached app (and its in-memory store). */
export const resetAppForTests = (): void => {
  app = null;
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
