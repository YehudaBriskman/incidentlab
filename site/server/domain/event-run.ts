// Event runs (#253): during a live class event a member may play an assigned case in a separate record that counts
// only on that class's board, so a case they finished before tonight can still score tonight.
//
//   eventprogress:<classId>:<eventKey>:<caseId>:<accountId>   ProgressRecord (the same shape as `progress:`)
//
// `eventKey` names one occurrence of the class event: the first 16 hex characters of sha256 over the event's
// `startsAt`, normalised to an ISO instant ("2026-12-01T18:00:00.000Z"). Renaming the event, moving its end or its
// freeze, or editing the announcement keeps the key (and every record played so far); moving `startsAt` starts a
// new occurrence with fresh records, and the earlier ones stay in the store, uncounted. An event without both
// `startsAt` and `endsAt` has no key: there is no window to play an event run in.
import { createHash } from "node:crypto";
import type { ClassEvent } from "../../shared/contract.ts";

export type EventRun = { readonly classId: string; readonly className: string; readonly eventKey: string };

type EventWindow = Pick<ClassEvent, "startsAt" | "endsAt">;

/** The key of the class event's occurrence, or null when the event has no full window. */
export const eventKeyOf = (event: EventWindow): string | null => {
  if (event.startsAt === null || event.endsAt === null) return null;
  const startsAt = Date.parse(event.startsAt);
  if (Number.isNaN(startsAt)) return null;
  return createHash("sha256").update(new Date(startsAt).toISOString(), "utf8").digest("hex").slice(0, 16);
};

/** True while `now` is inside the event window (startsAt <= now < endsAt, like the board's window rule). */
export const isEventLive = (event: EventWindow, now: Date): boolean => {
  if (event.startsAt === null || event.endsAt === null) return false;
  const t = now.getTime();
  return Date.parse(event.startsAt) <= t && t < Date.parse(event.endsAt);
};
