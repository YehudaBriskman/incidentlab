// Client-side view of "who is signed in". The real session is the HttpOnly cookie; this module only
// caches the account the server reported, and tells listeners (the header menu, views) when it changes.
import type { AccountView, TodayResponse } from "../../shared/contract";
import { fetchMe, fetchToday, logout } from "./api";

type Listener = (account: AccountView | null) => void;

let current: AccountView | null = null;
let loaded: Promise<AccountView | null> | null = null;
const listeners = new Set<Listener>();

export function onAccountChange(fn: Listener): void {
  listeners.add(fn);
}

export function setAccount(account: AccountView | null): void {
  current = account;
  loaded = Promise.resolve(account);
  for (const fn of listeners) fn(account);
}

export function cachedAccount(): AccountView | null {
  return current;
}

/** Asks the server once per page load (or after `refresh`). */
export function loadAccount(refresh = false): Promise<AccountView | null> {
  if (!loaded || refresh) {
    loaded = fetchMe().then(
      (account) => {
        if (account?.id !== current?.id || account?.status !== current?.status) setAccount(account);
        return account;
      },
      (err: unknown) => {
        loaded = null; // network failure: try again next time
        throw err;
      },
    );
  }
  return loaded;
}

export async function signOut(): Promise<void> {
  try {
    await logout();
  } finally {
    setAccount(null);
  }
}

let today: Promise<TodayResponse> | null = null;
/** Today's scheduled case (cached for the page load; refreshed on demand). */
export function loadToday(refresh = false): Promise<TodayResponse> {
  if (!today || refresh) {
    today = fetchToday().catch((err: unknown) => {
      today = null;
      throw err;
    });
  }
  return today;
}
