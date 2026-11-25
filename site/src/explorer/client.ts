import type { WorkerRequest, WorkerResponse } from "./protocol";

type Listener = (msg: WorkerResponse) => void;

/** Why the worker was restarted: a job blew its hard time budget, or the worker crashed (e.g. out of memory). */
export type RestartReason = { kind: "timeout"; job: number } | { kind: "crash" };

/**
 * Owns the worker. Restarts it on crash or when a job blows its hard time budget, calling `onRestart`
 * with the reason so the UI can reload state and say, in the player's language, what happened.
 * Each timed job has its own timer, so an unrelated reply (a scroll window, another job) never cancels it.
 */
export class WorkerClient {
  private worker: Worker | null = null;
  private listener: Listener;
  private onRestart: (reason: RestartReason) => void;
  private hardTimers = new Map<number, number>();
  private disposed = false;
  private nextJob = 1;

  constructor(listener: Listener, onRestart: (reason: RestartReason) => void) {
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
      if (msg.type !== "progress") this.clearHardTimer(msg.job);
      try {
        this.listener(msg);
      } catch (err) {
        console.error("explorer: listener failed", err);
      }
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      this.restart({ kind: "crash" });
    };
    this.worker = w;
  }

  /** Send a request. `hardTimeoutMs` kills the worker if this job does not answer in time. */
  send(msg: WorkerRequest, hardTimeoutMs = 0): void {
    if (this.disposed || !this.worker) return;
    if (hardTimeoutMs > 0 && "job" in msg) {
      const job = msg.job;
      this.clearHardTimer(job);
      this.hardTimers.set(job, window.setTimeout(() => {
        this.hardTimers.delete(job);
        this.restart({ kind: "timeout", job });
      }, hardTimeoutMs));
    }
    this.worker.postMessage(msg);
  }

  private clearHardTimer(job: number): void {
    const t = this.hardTimers.get(job);
    if (t !== undefined) {
      window.clearTimeout(t);
      this.hardTimers.delete(job);
    }
  }

  private clearAllTimers(): void {
    for (const t of this.hardTimers.values()) window.clearTimeout(t);
    this.hardTimers.clear();
  }

  restart(reason: RestartReason): void {
    if (this.disposed) return;
    this.clearAllTimers();
    this.worker?.terminate();
    this.worker = null;
    this.spawn();
    this.onRestart(reason);
  }

  dispose(): void {
    this.disposed = true;
    this.clearAllTimers();
    this.worker?.terminate();
    this.worker = null;
  }
}
