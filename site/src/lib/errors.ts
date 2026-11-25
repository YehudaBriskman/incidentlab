// Friendly text for API errors raised by gameplay actions (answers, hints, reveals).
import { ApiError } from "./api";
import { cachedEvent, eventPhase, refreshEvent } from "./event";
import { TA } from "../i18n/strings-account";
import { TG } from "../i18n/strings-game";
import { T } from "../i18n/strings-player";

export function playErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return T().genericError;
  switch (err.code) {
    case "not-today":
      return TA().notToday;
    case "event-closed": {
      refreshEvent(); // the cached event may be up to 30 s old: update the header countdown now
      const phase = eventPhase(cachedEvent()).kind;
      if (phase === "before") return TG().eventNotStarted;
      if (phase === "over") return TG().eventEnded;
      // Cache is stale: fall back to what the server said ("the event hasn't started yet" / "the event is over").
      return /start/i.test(err.message) ? TG().eventNotStarted : TG().eventEnded;
    }
    case "unknown-command":
      return TG().unknownCommand;
    case "admin":
      return TG().adminBody;
    default:
      if (err.isRateLimited) return TA().rateLimited(err.retryAfterSeconds ?? 60);
      return err.message;
  }
}
