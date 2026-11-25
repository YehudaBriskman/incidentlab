// Scoring v2: pure functions, so the formula is testable without storage. Constants live in the contract.
import { QUESTION_ORDER, SCORING } from "../../shared/contract.ts";
import type { ScoreBreakdown, StageProgress } from "../../shared/contract.ts";
import type { CaseSecrets } from "../domain/types.ts";

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Full bonus when solved within the target, fading linearly to 0 at 3× the target. */
export const timeBonus = (solveSeconds: number, targetSeconds: number): number =>
  Math.round(SCORING.TIME_BONUS_MAX * clamp((3 * targetSeconds - solveSeconds) / (2 * targetSeconds), 0, 1));

export type StageScoreInput = {
  readonly basePoints: number;
  readonly hintCosts: readonly number[];
  readonly targetSeconds: number;
  readonly stage: Pick<StageProgress, "hintsRevealed" | "wrongAttempts" | "commandsRevealed">;
  readonly solveSeconds: number;
  readonly isFirstBlood: boolean;
};

export const scoreStage = (input: StageScoreInput): ScoreBreakdown => {
  const { stage } = input;
  const hints = -input.hintCosts.slice(0, stage.hintsRevealed).reduce((sum, cost) => sum + cost, 0);
  const commands = -SCORING.COMMAND_COST * stage.commandsRevealed;
  const wrong = -Math.min(SCORING.WRONG_CAP, SCORING.WRONG_COST * stage.wrongAttempts);
  const penalised = Math.max(0, input.basePoints + hints + commands + wrong);
  const time = timeBonus(input.solveSeconds, input.targetSeconds);
  const isClean = stage.hintsRevealed === 0 && stage.commandsRevealed === 0 && stage.wrongAttempts === 0;
  const clean = isClean ? SCORING.CLEAN_BONUS : 0;
  const firstBlood = input.isFirstBlood ? SCORING.FIRST_BLOOD_BONUS : 0;
  return {
    base: input.basePoints,
    hints,
    commands,
    wrong,
    time,
    clean,
    firstBlood,
    total: penalised + time + clean + firstBlood,
    solveSeconds: Math.max(0, Math.round(input.solveSeconds)),
    targetSeconds: input.targetSeconds,
  };
};

/** Par score for a case: every stage at base + full time bonus + clean, plus the completion bonus. */
export const parScore = (secrets: CaseSecrets): number =>
  QUESTION_ORDER.reduce((sum, q) => sum + secrets.questions[q].points + SCORING.TIME_BONUS_MAX + SCORING.CLEAN_BONUS, 0) + SCORING.COMPLETION_BONUS;
