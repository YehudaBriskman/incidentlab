// Per-player progress metrics for the live grid, the Needs help list and the stats: stage status, stuck and
// idle levels, who needs help, finish times, the score breakdown lines and the grid's sort orders.
import { T } from "../../i18n/strings-tools";
import { QUESTION_ORDER, type AdminProgress, type ScoreBreakdown, type StageStatus } from "../../../shared/contract";
import { questionTitle, type StageKey } from "./caseInfo";
import { formatDuration, formatSeconds, ms } from "./format";

export const STUCK_WARN_MIN = 8;
export const STUCK_ALERT_MIN = 15;
/** Wrong answers on the current stage that put a player on the "Needs help" list (and make it urgent). */
export const WRONG_HELP_MIN = 3;
export const WRONG_ALERT_MIN = 5;
/** A player who started, hasn't finished and hasn't been seen for this long counts as idle. */
export const IDLE_MIN = 10;
/** Needs help shows this many players before "Show all": the list must not push the grid off the screen. */
export const HELP_PREVIEW = 6;

export type LiveSortKey = "score" | "progress" | "name" | "stuck";

export function stageLabel(stage: StageKey): string {
  return stage === "setup" ? T().admSetup : stage.toUpperCase();
}

export function stageLongLabel(caseId: string, stage: AdminProgress["currentStage"]): string {
  if (stage === "done") return T().admFinished;
  if (stage === "setup") return T().admSetup;
  const title = questionTitle(caseId, stage);
  return title ? `${stage.toUpperCase()} · ${title}` : stage.toUpperCase();
}

export function stageStatus(p: AdminProgress, stage: StageKey): StageStatus {
  if (stage === "setup") return p.setupDoneAt ? "solved" : p.startedAt ? "active" : "locked";
  return p.stages[stage]?.status ?? "locked";
}

export const isFinishedStatus = (s: StageStatus): boolean => s === "solved" || s === "revealed";

export function progressCount(p: AdminProgress, stages: readonly StageKey[]): number {
  return stages.filter((s) => isFinishedStatus(stageStatus(p, s))).length;
}

export const isDone = (p: AdminProgress): boolean => p.completedAt !== null || p.currentStage === "done";

export function stuckLevel(p: AdminProgress): "none" | "warn" | "alert" {
  if (isDone(p)) return "none";
  if (p.stuckMinutes >= STUCK_ALERT_MIN) return "alert";
  if (p.stuckMinutes >= STUCK_WARN_MIN) return "warn";
  return "none";
}

export function minutesSince(iso: string | null, now: number): number | null {
  const t = ms(iso);
  return t === null ? null : Math.max(0, (now - t) / 60000);
}

/** Started, not finished, and not seen for IDLE_MIN minutes (left the room, or the tab is closed). */
export function isIdle(p: AdminProgress, now: number): boolean {
  if (isDone(p) || p.startedAt === null) return false;
  const seen = minutesSince(p.lastSeenAt, now);
  return seen !== null && seen >= IDLE_MIN;
}

export function currentWrong(p: AdminProgress): number {
  const cur = p.currentStage;
  return cur !== "setup" && cur !== "done" ? (p.stages[cur]?.wrongAttempts ?? 0) : 0;
}

export type HelpLevel = "alert" | "warn" | "idle";
export type HelpEntry = { p: AdminProgress; level: HelpLevel; stuck: boolean; wrong: number; idleMin: number | null; urgency: number };

/**
 * Who needs the instructor now: stuck >= STUCK_WARN_MIN on one stage, or >= WRONG_HELP_MIN wrong answers on it,
 * or idle. Urgent (alert) first, then warnings, then idle; inside a level the longest-stuck first.
 */
export function helpEntries(players: readonly AdminProgress[], now: number): HelpEntry[] {
  const out: HelpEntry[] = [];
  for (const p of players) {
    if (isDone(p)) continue;
    const wrong = currentWrong(p);
    const stuck = p.stuckMinutes >= STUCK_WARN_MIN;
    const manyWrong = wrong >= WRONG_HELP_MIN;
    const idle = isIdle(p, now);
    if (!stuck && !manyWrong && !idle) continue;
    const level: HelpLevel =
      p.stuckMinutes >= STUCK_ALERT_MIN || wrong >= WRONG_ALERT_MIN ? "alert" : stuck || manyWrong ? "warn" : "idle";
    const rank = level === "alert" ? 2 : level === "warn" ? 1 : 0;
    out.push({ p, level, stuck, wrong, idleMin: idle ? minutesSince(p.lastSeenAt, now) : null, urgency: rank * 1e6 + p.stuckMinutes * 10 + wrong });
  }
  return out.sort((a, b) => b.urgency - a.urgency || a.p.username.localeCompare(b.p.username));
}

/** Same definition the server uses for durationSeconds: setup done -> completed. */
export function finishDurationMs(p: AdminProgress): number | null {
  const end = ms(p.completedAt);
  const start = ms(p.setupDoneAt) ?? ms(p.startedAt);
  return end !== null && start !== null ? Math.max(0, end - start) : null;
}

export function stageTooltip(p: AdminProgress, stage: StageKey, now: number): string {
  const status = stageStatus(p, stage);
  if (stage === "setup") {
    const start = ms(p.startedAt);
    const end = ms(p.setupDoneAt) ?? now;
    const spent = start !== null ? formatDuration(end - start) : "—";
    return T().admSetupTip(p.setupDoneAt !== null, spent);
  }
  const sp = p.stages[stage];
  const title = questionTitle(p.caseId, stage);
  if (!sp || status === "locked") return `${stage.toUpperCase()} ${title}: ${T().admStatus("locked")}`;
  const start = ms(sp.startedAt);
  const end = ms(sp.finishedAt) ?? now;
  const spent = start !== null ? formatDuration(end - start) : "—";
  const lines = [
    `${stage.toUpperCase()} ${title}: ${T().admStatus(status)}`,
    T().admWrongAttempts(sp.wrongAttempts),
    T().admHintsUsed(sp.hintsRevealed),
    T().admCommandsUsed(sp.commandsRevealed),
    T().admTime(spent),
  ];
  if (status === "solved") {
    lines.push(T().admPoints(sp.points));
    if (sp.breakdown) lines.push(...breakdownLines(sp.breakdown).map((l) => `  ${l}`));
  }
  return lines.join("\n");
}

export function sortPlayers(players: readonly AdminProgress[], key: LiveSortKey, stages: readonly StageKey[]): AdminProgress[] {
  const byName = (a: AdminProgress, b: AdminProgress): number => a.username.localeCompare(b.username);
  const prog = (p: AdminProgress): number => progressCount(p, stages);
  const list = [...players];
  switch (key) {
    case "score":
      return list.sort((a, b) => b.score - a.score || prog(b) - prog(a) || byName(a, b));
    case "progress":
      return list.sort((a, b) => prog(b) - prog(a) || b.score - a.score || byName(a, b));
    case "name":
      return list.sort(byName);
    case "stuck":
      return list.sort((a, b) => {
        const sa = isDone(a) ? -1 : a.stuckMinutes;
        const sb = isDone(b) ? -1 : b.stuckMinutes;
        return sb - sa || byName(a, b);
      });
  }
}

export const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");

export function breakdownLines(b: ScoreBreakdown): string[] {
  const lines = [`${T().admBdBase} ${b.base}`];
  if (b.hints) lines.push(`${T().admBdHints} ${signed(b.hints)}`);
  if (b.commands) lines.push(`${T().admBdCommands} ${signed(b.commands)}`);
  if (b.wrong) lines.push(`${T().admBdWrong} ${signed(b.wrong)}`);
  if (b.time) lines.push(`${T().admBdTime} ${signed(b.time)}`);
  if (b.clean) lines.push(`${T().admBdClean} ${signed(b.clean)}`);
  if (b.firstBlood) lines.push(`${T().admBdFirstBlood} ${signed(b.firstBlood)}`);
  lines.push(`${T().admBdTotal} ${b.total}`);
  lines.push(T().admBdSolve(formatSeconds(b.solveSeconds), formatSeconds(b.targetSeconds)));
  return lines;
}

/** Commands paid for on this case (summed over stages, like the server's UserStats). */
export function commandsUsed(p: AdminProgress): number {
  return QUESTION_ORDER.reduce((sum, q) => sum + (p.stages[q]?.commandsRevealed ?? 0), 0);
}
