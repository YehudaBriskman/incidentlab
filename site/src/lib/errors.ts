// Friendly text for API errors raised by gameplay actions (answers, hints, reveals).
import { ApiError } from "./api";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
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
