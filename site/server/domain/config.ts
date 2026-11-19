// Loads and validates the case config (points, hint costs) and the generated secrets.
import { CaseSchema } from "../../src/content/schema.ts";
import { QUESTION_ORDER } from "../../shared/contract.ts";
import type { QuestionId } from "../../shared/contract.ts";
import caseJson from "../../src/content/cases/3am-outage.json" with { type: "json" };
import secretsJson from "../generated/secrets.json" with { type: "json" };
import { SecretsSchema } from "./types.ts";
import type { CaseConfig, QuestionConfig, Secrets } from "./types.ts";

export const buildCaseConfig = (raw: unknown): CaseConfig => {
  const parsed = CaseSchema.parse(raw);
  const entries = QUESTION_ORDER.map((questionId): [QuestionId, QuestionConfig] => {
    const question = parsed.questions.find((q) => q.id === questionId);
    if (!question) throw new Error(`case ${parsed.id} is missing question ${questionId}`);
    return [questionId, { points: question.points, hintCosts: question.hints.map((h) => h.cost) }];
  });
  const questions = Object.fromEntries(entries) as Record<QuestionId, QuestionConfig>;
  return { caseId: parsed.id, questions };
};

export const loadCaseConfig = (): CaseConfig => buildCaseConfig(caseJson);
export const loadSecrets = (): Secrets => SecretsSchema.parse(secretsJson);
