import type { FilterStep, HistogramResult, JsonFilter } from "./core";

export const MAX_UNIQUE_ROWS = 500;
export const MAX_COPY_LINES = 5000;
export const MAX_FILES_IN_WORKER = 2;

export type WorkerRequest =
  | { type: "load"; job: number; path: string; url: string }
  | { type: "cancelLoad"; path: string }
  | { type: "filter"; job: number; path: string; steps: FilterStep[]; json: JsonFilter | null }
  | { type: "window"; job: number; path: string; start: number; count: number }
  | { type: "unique"; job: number; path: string; pattern: string; ci: boolean }
  | { type: "histogram"; job: number; path: string; pattern: string }
  | { type: "copy"; job: number; path: string };

export type WorkerResponse =
  | { type: "progress"; job: number; path: string; loaded: number; total: number }
  | { type: "loaded"; job: number; path: string; lineCount: number; bytes: number; isJson: boolean }
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
  | { type: "error"; job: number; message: string; notLoaded?: boolean; cancelled?: boolean };
