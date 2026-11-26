// HTTP helpers shared by controllers: JSON responses, body parsing, error mapping.
import type { z } from "zod";
import { AppError } from "../domain/types.ts";

export const MAX_BODY_BYTES = 4096;

const baseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export const json = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, ...extraHeaders } });

export const noContent = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/** How long Netlify's CDN may serve a public response before asking the function again, and which tags purge it. */
export type PublicCache = { readonly maxAgeSeconds: number; readonly staleSeconds: number; readonly tags: readonly string[] };

/**
 * A 200 for a public, non-personalised GET that the CDN may cache: cached hits never reach the function, which is
 * what keeps the 30 s polls of every open tab off the monthly function-call budget. ONLY for responses that
 * don't read or set the session: browsers always revalidate (max-age=0), the CDN keys on the URL and its query
 * string only (never the cookie), and admin writes purge by tag (services/CachePurger.ts).
 */
export const publicJson = (body: unknown, cache: PublicCache): Response =>
  json(200, body, {
    "cache-control": "public, max-age=0, must-revalidate",
    "netlify-cdn-cache-control": `public, durable, max-age=${cache.maxAgeSeconds}, stale-while-revalidate=${cache.staleSeconds}`,
    "netlify-cache-tag": cache.tags.join(","),
    "netlify-vary": "query",
  });

export const errorResponse = (
  status: number,
  error: string,
  options: { code?: string | undefined; retryAfterSeconds?: number | undefined; details?: readonly string[] | undefined } = {},
): Response => {
  const body = {
    error,
    ...(options.code === undefined ? {} : { code: options.code }),
    ...(options.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: options.retryAfterSeconds }),
    ...(options.details === undefined ? {} : { details: options.details }),
  };
  return json(status, body, options.retryAfterSeconds === undefined ? {} : { "retry-after": String(options.retryAfterSeconds) });
};

export const toErrorResponse = (error: unknown): Response => {
  if (error instanceof AppError) return errorResponse(error.status, error.message, { code: error.code, retryAfterSeconds: error.retryAfterSeconds, details: error.details });
  console.error("[incidentlab-api] unhandled error", error);
  return errorResponse(500, "internal");
};

/** Reads a raw binary body (application/octet-stream), refusing more than `maxBytes` with 413 "too-large". */
export const readBytes = async (req: Request, maxBytes: number): Promise<Uint8Array> => {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/octet-stream")) throw new AppError(415, "content-type must be application/octet-stream");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError(413, "request body too large", { code: "too-large" });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new AppError(413, "request body too large", { code: "too-large" });
  return bytes;
};

/** Reads the body (enforcing size + content-type) and validates it with a zod schema. */
export const parseBody = async <T extends z.ZodType>(req: Request, schema: T, maxBytes = MAX_BODY_BYTES): Promise<z.infer<T>> => {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new AppError(415, "content-type must be application/json");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError(413, "request body too large");
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new AppError(413, "request body too large");
  let raw: unknown;
  try {
    raw = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
    throw new AppError(400, `${where}${first?.message ?? "invalid request"}`);
  }
  return parsed.data;
};

// ---- session cookie -------------------------------------------------------
// HttpOnly (no JS access), SameSite=Lax (no cross-site POSTs) and JSON-only POST bodies (no simple
// cross-origin form posts) together cover CSRF. Path=/api keeps the cookie off static asset requests.
export const SESSION_COOKIE = "il_session";

export const sessionToken = (req: Request): string | null => {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
};

/** Secure is dropped only for plain-http localhost so `netlify dev` works. */
const isSecureRequest = (req: Request): boolean => {
  const url = new URL(req.url);
  return url.protocol === "https:" || !["localhost", "127.0.0.1"].includes(url.hostname);
};

export const sessionCookie = (req: Request, session: { token: string; maxAgeSeconds: number } | null): string =>
  [
    `${SESSION_COOKIE}=${session?.token ?? ""}`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${session?.maxAgeSeconds ?? 0}`,
    ...(isSecureRequest(req) ? ["Secure"] : []),
  ].join("; ");

export const withCookie = (res: Response, cookie: string): Response => {
  res.headers.append("set-cookie", cookie);
  return res;
};
