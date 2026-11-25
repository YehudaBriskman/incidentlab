// HTTP helpers shared by controllers: JSON responses, body parsing, error mapping.
import type { z } from "zod";
import { AppError } from "../domain/types.ts";

export const MAX_BODY_BYTES = 4096;

const baseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export const json = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, ...extraHeaders } });

export const noContent = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

export const errorResponse = (status: number, error: string, options: { code?: string; retryAfterSeconds?: number } = {}): Response => {
  const body = { error, ...(options.code === undefined ? {} : { code: options.code }), ...(options.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: options.retryAfterSeconds }) };
  return json(status, body, options.retryAfterSeconds === undefined ? {} : { "retry-after": String(options.retryAfterSeconds) });
};

export const toErrorResponse = (error: unknown): Response => {
  if (error instanceof AppError) return errorResponse(error.status, error.message, { code: error.code, retryAfterSeconds: error.retryAfterSeconds });
  console.error("[incidentlab-api] unhandled error", error);
  return errorResponse(500, "internal");
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
