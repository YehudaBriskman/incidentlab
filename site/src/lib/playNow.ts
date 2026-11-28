// "Play now, no sign-up" (#223): one action from the landing into a case. A visitor gets a guest session, then
// everyone lands in the start-here case (lib/startHere.ts) at its first stage. Used by the home intro button, the
// Start-here card and the #/play route (the static hero's link in index.html works before the app has booted).
import { catalogReady, startHereCaseId } from "../content/load";
import { loadAccount, loadToday } from "./session";

/** Where the start-here case lives, or the catalog when no case qualifies. */
export async function startHereHref(): Promise<string> {
  await catalogReady;
  const today = await loadToday().catch(() => null);
  const id = startHereCaseId(today?.releasedCaseIds ?? null);
  return id === null ? "#/cases" : `#/case/${encodeURIComponent(id)}`;
}

/**
 * Starts a guest session when nobody is signed in, then opens the start-here case. False when the guest session
 * could not start (playAsGuest has shown a toast saying why). `replace`: the #/play route swaps itself out of
 * the history, so Back never runs it again.
 */
export async function playNow(options: { replace?: boolean } = {}): Promise<boolean> {
  const account = await loadAccount().catch(() => null);
  if (account === null) {
    const guest = await import("../views/guest");
    if (!(await guest.playAsGuest())) return false;
  }
  const href = await startHereHref();
  if (options.replace === true) window.location.replace(href);
  else window.location.hash = href;
  return true;
}
