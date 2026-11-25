import type { FilterStep, HistogramResult, JsonFilter } from "./core";

export const MAX_UNIQUE_ROWS = 500;
export const MAX_COPY_LINES = 5000;
export const MAX_FILES_IN_WORKER = 2;

/** Why a worker job failed. The UI turns these into localized text; the worker never sends prose. */
export type WorkerErrorCode = "notLoaded" | "timeout" | "cancelled" | "http" | "unexpected";

export type WorkerRequest =
  | { type: "load"; job: number; path: string; url: string }
  | { type: "cancelLoad"; path: string }
  /** `skipHeader` hides line 1 (a CSV header) from the view and the counts. */
  | { type: "filter"; job: number; path: string; steps: FilterStep[]; json: JsonFilter | null; skipHeader: boolean }
  | { type: "window"; job: number; path: string; start: number; count: number }
  | { type: "unique"; job: number; path: string; pattern: string; ci: boolean }
  | { type: "histogram"; job: number; path: string; pattern: string; year: number | null }
  /** Copies the filtered view, or only view row `row` when it is set. */
  | { type: "copy"; job: number; path: string; row?: number }
  /** Finds the view row that shows file line `line` (0-based). */
  | { type: "locate"; job: number; path: string; line: number };

export type WorkerResponse =
  | { type: "progress"; job: number; path: string; loaded: number; total: number }
  | { type: "loaded"; job: number; path: string; lineCount: number; bytes: number; isJson: boolean; year: number | null }
  | { type: "filtered"; job: number; path: string; total: number; count: number }
  | { type: "window"; job: number; path: string; start: number; rows: Array<[number, string]> }
  | {
      type: "unique";
      job: number;
      rows: Array<[string, number]>;
      distinct: number;
      matchedLines: number;
      more: number;
    }
  | { type: "histogram"; job: number; result: HistogramResult }
  | { type: "copy"; job: number; text: string; count: number; capped: boolean }
  | { type: "located"; job: number; line: number; row: number }
  | { type: "error"; job: number; code: WorkerErrorCode; status?: number; detail?: string };
