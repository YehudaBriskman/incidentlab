// Keeps a case page's progress in step across the player's tabs (#203). After every write the client shares the
// server's progress here: this tab's follower notes it, and other tabs get it over a BroadcastChannel (when the
// browser has one). A tab coming back into view re-reads progress, at most every REFETCH_FLOOR_MS.
import type { ProgressView } from "../../shared/contract";
import { getLang } from "../i18n/i18n";
import { decideIncoming, parseSyncMessage, sameProgress, sameRun, shouldRefetch, type SyncMessage } from "./progress-sync-logic";

const CHANNEL = "incidentlab-progress";

type Listener = (progress: ProgressView) => void;
const localListeners = new Set<Listener>();
let channel: BroadcastChannel | null | undefined;
const remoteListeners = new Set<(message: SyncMessage) => void>();

function openChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = null;
  if (typeof BroadcastChannel !== "function") return channel;
  try {
    const opened = new BroadcastChannel(CHANNEL);
    opened.addEventListener("message", (ev: MessageEvent<unknown>) => {
      const message = parseSyncMessage(ev.data);
      if (message !== null) for (const fn of remoteListeners) fn(message);
    });
    channel = opened;
  } catch {
    channel = null;
  }
  return channel;
}

/** The server's progress after a write (or after a refused or unconfirmed one): tell this tab and the others. */
export function shareProgress(progress: ProgressView): void {
  for (const fn of localListeners) fn(progress);
  const message: SyncMessage = { kind: "progress", lang: getLang(), progress };
  try {
    openChannel()?.postMessage(message);
  } catch {
    /* a closed or unavailable channel: the other tabs catch up when they become visible */
  }
}

export interface ProgressFollower {
  stop: () => void;
}

/**
 * Follows one case's progress for a view. `apply` gets progress that differs from what the view shows: a newer
 * one from another tab, or the server's after the tab became visible again. Writes this tab made are not passed
 * to `apply` (the view already redraws from their result) but count as fresh. Stops itself once `alive()` is false.
 */
export function followProgress(opts: {
  initial: ProgressView;
  load: () => Promise<ProgressView>;
  apply: (next: ProgressView) => void;
  alive: () => boolean;
}): ProgressFollower {
  let current = opts.initial;
  let syncedAt = Date.now();
  let stopped = false;
  let loading = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    localListeners.delete(onLocal);
    remoteListeners.delete(onRemote);
    document.removeEventListener("visibilitychange", onVisible);
  };
  const live = (): boolean => {
    if (!stopped && !opts.alive()) stop();
    return !stopped;
  };
  const take = (next: ProgressView): void => {
    syncedAt = Date.now();
    if (sameProgress(next, current)) return;
    current = next;
    opts.apply(next);
  };
  const refetch = (): void => {
    if (loading) return;
    loading = true;
    opts
      .load()
      .then((next) => {
        if (live()) take(next);
      })
      .catch(() => undefined) // offline: the next visibility change or write tries again
      .finally(() => {
        loading = false;
      });
  };
  function onLocal(next: ProgressView): void {
    if (!live() || next.caseId !== current.caseId || !sameRun(next, current)) return;
    current = next;
    syncedAt = Date.now();
  }
  function onRemote(message: SyncMessage): void {
    if (!live()) return;
    const decision = decideIncoming(current, getLang(), message);
    if (decision === "apply") take(message.progress);
    else if (decision === "refetch") refetch();
  }
  function onVisible(): void {
    if (!live() || document.visibilityState !== "visible") return;
    if (shouldRefetch(syncedAt, Date.now())) refetch();
  }

  localListeners.add(onLocal);
  remoteListeners.add(onRemote);
  openChannel();
  document.addEventListener("visibilitychange", onVisible);
  return { stop };
}
