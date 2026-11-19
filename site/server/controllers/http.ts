// HTTP helpers shared by controllers: JSON responses, body parsing, error mapping.
import type { z } from "zod";
import { AppError } from "../domain/types.ts";

export const MAX_BODY_BYTES = 4096;

const baseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export const json = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, ...extraHeaders } });

export const noContent = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

export const errorResponse = (status: number, error: string, retryAfterSeconds?: number): Response =>
  retryAfterSeconds === undefined
    ? json(status, { error })
    : json(status, { error, retryAfterSeconds }, { "retry-after": String(retryAfterSeconds) });

export const toErrorResponse = (error: unknown): Response => {
  if (error instanceof AppError) return errorResponse(error.status, error.message, error.retryAfterSeconds);
  console.error("[incidentlab-api] unhandled error", error);
  return errorResponse(500, "internal");
};

/** Reads the body (enforcing size + content-type) and validates it with a zod schema. */
export const parseBody = async <T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> => {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new AppError(415, "content-type must be application/json");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new AppError(413, "request body too large");
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new AppError(413, "request body too large");
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

export const bearerToken = (req: Request): string | null => {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
};
