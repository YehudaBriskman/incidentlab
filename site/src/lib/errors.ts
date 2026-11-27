// Friendly text for API errors raised by gameplay actions (answers, hints, reveals).
import type { ProgressView } from "../../shared/contract";
import { ApiError } from "./api";
import { toast } from "./overlay";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { TP } from "../i18n/strings-play";
import { T } from "../i18n/strings-player";

export function playErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return T().genericError;
  switch (err.code) {
    case "unknown-command":
      return TG().unknownCommand;
    case "admin":
      return TG().adminBody;
    default:
      if (err.isRateLimited) return TA().rateLimited(err.retryAfterSeconds ?? 60);
      return err.message;
  }
}

/**
 * After a play write the server refused as stale, or that got no clear answer (#202, #203): the server's progress
 * to redraw from, with a toast saying why. Null when the error carries none (show it as usual).
 */
export function recoverFromWrite(err: unknown): ProgressView | null {
  if (!(err instanceof ApiError) || err.progress === null) return null;
  const stale = err.code === "stale";
  toast({ tone: stale ? "info" : "warning", text: stale ? TP().staleWrite : TP().unconfirmedWrite });
  return err.progress;
}
