import { z } from "zod";
import type { Case, Question } from "../content/schema";

const ProgressSchema = z.object({
  version: z.literal(2),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  // `answer` is the normalized correct answer; it is part of the debrief decryption key.
  solved: z.record(z.string(), z.object({ at: z.number(), points: z.number(), answer: z.string() })),
  hintsRevealed: z.record(z.string(), z.number().int().nonnegative()),
  attempts: z.record(z.string(), z.number().int().nonnegative()),
});
export type Progress = z.infer<typeof ProgressSchema>;

const memoryStore = new Map<string, string>();
const keyFor = (caseId: string): string => `incidentlab:progress:${caseId}`;

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memoryStore.get(key) ?? null;
  }
}

function writeRaw(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable (private mode, blocked storage): keep it in memory.
  }
  if (value === null) memoryStore.delete(key);
  else memoryStore.set(key, value);
}

function fresh(): Progress {
  return { version: 2, startedAt: Date.now(), finishedAt: null, solved: {}, hintsRevealed: {}, attempts: {} };
}

export function loadProgress(caseId: string): Progress {
  const key = keyFor(caseId);
  const raw = readRaw(key);
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const result = ProgressSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // corrupt entry: fall through and start over
    }
  }
  const p = fresh();
  saveProgress(caseId, p);
  return p;
}

export function saveProgress(caseId: string, progress: Progress): void {
  writeRaw(keyFor(caseId), JSON.stringify(progress));
}

export function resetProgress(caseId: string): Progress {
  const p = fresh();
  saveProgress(caseId, p);
  return p;
}

/* ---------- derived values ---------- */

export function hintsUsedFor(p: Progress, q: Question): number {
  return Math.min(p.hintsRevealed[q.id] ?? 0, q.hints.length);
}

export function hintCostFor(p: Progress, q: Question): number {
  return q.hints.slice(0, hintsUsedFor(p, q)).reduce((sum, hint) => sum + hint.cost, 0);
}

export function potentialPoints(p: Progress, q: Question): number {
  return Math.max(0, q.points - hintCostFor(p, q));
}

export interface Score {
  points: number;
  maxPoints: number;
  hintsUsed: number;
  solved: number;
  total: number;
  complete: boolean;
  debriefUnlocked: boolean;
}

export function computeScore(c: Case, p: Progress): Score {
  let points = 0;
  let hintsUsed = 0;
  let solved = 0;
  for (const q of c.questions) {
    hintsUsed += hintsUsedFor(p, q);
    const s = p.solved[q.id];
    if (s) {
      solved += 1;
      points += s.points;
    }
  }
  const total = c.questions.length;
  return {
    points,
    maxPoints: c.questions.reduce((sum, q) => sum + q.points, 0),
    hintsUsed,
    solved,
    total,
    complete: solved === total,
    debriefUnlocked: solved === total,
  };
}

export function elapsedMs(p: Progress, now = Date.now()): number {
  return (p.finishedAt ?? now) - p.startedAt;
}

/** Normalized answers by question id, used to derive the debrief key. */
export function solvedAnswers(p: Progress): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, s] of Object.entries(p.solved)) out[id] = s.answer;
  return out;
}
