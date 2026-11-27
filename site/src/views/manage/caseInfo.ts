// Case content lookups for the manage panels: titles, question ids and par come from the case content (all
// loaded before an admin or class view renders); ids come from the server.
import { cachedCase } from "../../content/load";
import { QUESTION_ORDER, type QuestionId } from "../../../shared/contract";

/** A column of the live grid: the setup step, then one per question. */
export type StageKey = "setup" | QuestionId;

const QUESTION_IDS: ReadonlySet<string> = new Set<string>(QUESTION_ORDER);
export const isQuestionId = (id: string): id is QuestionId => QUESTION_IDS.has(id);

export function caseTitle(caseId: string): string {
  return cachedCase(caseId)?.title ?? caseId;
}

export function caseQuestionIds(caseId: string): QuestionId[] {
  const c = cachedCase(caseId);
  const ids = c ? c.questions.map((q) => q.id).filter(isQuestionId) : [];
  return ids.length > 0 ? ids : [...QUESTION_ORDER];
}

export function questionTitle(caseId: string, q: QuestionId): string {
  return cachedCase(caseId)?.questions.find((x) => x.id === q)?.title ?? "";
}

export function caseMaxScore(caseId: string): number | null {
  const c = cachedCase(caseId);
  return c ? c.questions.reduce((sum, q) => sum + q.points, 0) : null;
}

export function caseStages(caseId: string): StageKey[] {
  return ["setup", ...caseQuestionIds(caseId)];
}
