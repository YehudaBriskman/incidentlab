// The shared auth-loss handler (#209): a play action (answer, hint, reveal) answered 401, or 403 because the
// account must pass the gate again. The page that owns the action registers how to re-run its account gate;
// the action's catch hands the error here. The gate re-runs with fresh session state, and the page draws itself
// again afterwards, so whatever the page keeps outside the DOM (the case's answer drafts) survives.
import { ApiError } from "./api";
import { loadAccount, setAccount } from "./session";

let registered: { hash: string; rerun: () => void } | null = null;

/** The route without its "?query" (a stage or Explorer file change keeps the same page). */
const routePath = (): string => window.location.hash.split("?")[0] ?? "";

/** The page on screen re-runs its gate with `rerun`; it is ignored once the route has changed. */
export function onAuthLoss(rerun: () => void): void {
  registered = { hash: routePath(), rerun };
}

/** True for errors that mean "run the account gate again", not "this action failed". */
export function isAuthLoss(err: unknown): err is ApiError {
  return err instanceof ApiError && (err.isUnauthorized || err.isNotApproved || err.needsGate);
}

/**
 * Handles `err` when it is an auth loss on the page that registered: refreshes the session and re-runs the gate.
 * Returns false (the caller shows its own error) for other errors, or when no page on this route registered.
 */
export function handleAuthLoss(err: unknown): boolean {
  const target = registered;
  if (!isAuthLoss(err) || target === null || target.hash !== routePath()) return false;
  if (err.isUnauthorized) setAccount(null);
  void loadAccount(true).finally(() => {
    if (routePath() === target.hash) target.rerun();
  });
  return true;
}
