// Friendly text for API errors raised by gameplay actions (answers, hints, reveals) and failed loads.
import type { ProgressView } from "../../shared/contract";
import { ApiError } from "./api";
import { toast } from "./overlay";
import { TA } from "../i18n/strings-account";
import { TE } from "../i18n/strings-errors";
import { TG } from "../i18n/strings-game";
import { TP } from "../i18n/strings-play";
import { T } from "../i18n/strings-player";
import { classifyLoadError } from "./load-recovery";

export function playErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return T().genericError;
  switch (err.code) {
    case "unknown-command":
      return TG().unknownCommand;
    case "admin":
      return TG().adminBody;
    default:
      if (err.isRateLimited) return TA().rateLimited(err.retryAfterSeconds ?? 60);
      // The server's own English for these ("sign in required", "forbidden") never reaches the page.
      if (err.isUnauthorized) return TE().signedOut;
      if (err.status === 403) return TE().forbidden;
      if (err.status === 0) return TE().loadFailedOffline;
      if (err.status >= 500) return TE().loadFailedServer;
      return err.message;
  }
}

/** Why a panel's data did not load, in the reader's language (offline, server error, or generic). */
export function loadErrorText(err: unknown): string {
  switch (classifyLoadError(err, navigator.onLine)) {
    case "offline":
      return TE().loadFailedOffline;
    case "server":
      return TE().loadFailedServer;
    case "chunk":
      return TE().loadFailedCode;
    case "other":
      return TE().loadFailedOther;
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
