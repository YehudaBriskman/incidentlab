// Which run a case page plays (#253): the player's own run, or a class event run that counts on that class's board
// only. The choice is kept per case in sessionStorage (`il.run.<caseId>`), so it survives a reload and the case's
// Toolbox and Explorer pages use the same record, while another tab can play the other run. api.ts reads it for
// every play request; the progress view's `run` says which record the server answered from.
import { z } from "zod";
import type { ClassEvent } from "../../shared/contract";
import { classEventPhase } from "./challenges.ts";

const RunChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("own") }),
  z.object({ kind: z.literal("event"), classId: z.string().regex(/^[0-9A-Za-z]{12}$/) }),
]);
export type RunChoice = z.infer<typeof RunChoiceSchema>;

const key = (caseId: string): string => `il.run.${caseId}`;

/** The stored choice for this case, or null when the player hasn't chosen (or storage is unavailable). */
export function readRunChoice(caseId: string): RunChoice | null {
  try {
    const raw = window.sessionStorage.getItem(key(caseId));
    if (raw === null) return null;
    const parsed = RunChoiceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeRunChoice(caseId: string, choice: RunChoice): void {
  try {
    window.sessionStorage.setItem(key(caseId), JSON.stringify(choice));
  } catch {
    /* no storage: the page still plays the run chosen for this page load */
  }
}

/** The class whose event run this case plays, or null for the player's own run. */
export function runClassOf(caseId: string): string | null {
  const choice = readRunChoice(caseId);
  return choice?.kind === "event" ? choice.classId : null;
}

/**
 * True when a class event can take an event run now: it has a full window and `now` is inside it (the server
 * checks the same, and membership and the case's assignment on top).
 */
export function eventRunOpen(event: Pick<ClassEvent, "startsAt" | "endsAt"> | undefined, now: number): boolean {
  if (event === undefined || event.startsAt === null || event.endsAt === null) return false;
  return classEventPhase(event, now).kind === "live";
}

export type RunOffer = "none" | "ask" | "offer";

/**
 * What the case page offers on the player's own run while a class event is open: "ask" (the choice card, the first
 * time on this case), "offer" (a quiet "Play the event run" in the status line, once they chose their own run), or
 * "none" (already on an event run, or no open event).
 */
export function runOffer(input: { onEventRun: boolean; eventOpen: boolean; choice: RunChoice | null }): RunOffer {
  if (input.onEventRun || !input.eventOpen) return "none";
  return input.choice?.kind === "own" ? "offer" : "ask";
}
