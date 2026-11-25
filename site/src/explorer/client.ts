import type { WorkerRequest, WorkerResponse } from "./protocol";

type Listener = (msg: WorkerResponse) => void;

/**
 * Owns the worker. Restarts it on crash or when a job blows its hard time budget,
 * calling `onRestart` so the UI can reload state and explain what happened.
 */
export class WorkerClient {
  private worker: Worker | null = null;
  private listener: Listener;
  private onRestart: (reason: string) => void;
  private hardTimer: number | null = null;
  private disposed = false;
  private nextJob = 1;

  constructor(listener: Listener, onRestart: (reason: string) => void) {
    this.listener = listener;
    this.onRestart = onRestart;
    this.spawn();
  }

  job(): number {
    return this.nextJob++;
  }

  private spawn(): void {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      if (this.disposed || w !== this.worker) return;
      const msg = ev.data;
      if (msg.type !== "progress" && msg.type !== "window") this.clearHardTimer();
      try {
        this.listener(msg);
      } catch (err) {
        console.error("explorer: listener failed", err);
      }
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      this.restart("The analysis worker crashed (probably out of memory). It has been restarted.");
    };
    this.worker = w;
  }

  /** Send a request. `hardTimeoutMs` kills the worker if it does not answer in time. */
  send(msg: WorkerRequest, hardTimeoutMs = 0): void {
    if (this.disposed || !this.worker) return;
    if (hardTimeoutMs > 0) {
      this.clearHardTimer();
      this.hardTimer = window.setTimeout(() => {
        this.hardTimer = null;
        this.restart("regex took too long — the search was stopped. Simplify the pattern and try again.");
      }, hardTimeoutMs);
    }
    this.worker.postMessage(msg);
  }

  private clearHardTimer(): void {
    if (this.hardTimer !== null) {
      window.clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
  }

  restart(reason: string): void {
    if (this.disposed) return;
    this.clearHardTimer();
    this.worker?.terminate();
    this.worker = null;
    this.spawn();
    this.onRestart(reason);
  }

  dispose(): void {
    this.disposed = true;
    this.clearHardTimer();
    this.worker?.terminate();
    this.worker = null;
  }
}
