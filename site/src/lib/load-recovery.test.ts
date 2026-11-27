import { test } from "node:test";
import assert from "node:assert/strict";
import { RELOAD_GUARD_KEY, RELOAD_GUARD_TTL_MS, claimReload, classifyLoadError, clearReloadGuard, isChunkLoadError, type GuardStorage } from "./load-recovery.ts";

function memoryStorage(): GuardStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test("claimReload allows one reload, then refuses until the guard expires or is cleared", () => {
  const s = memoryStorage();
  assert.equal(claimReload(s, 1_000), true);
  assert.equal(s.data.get(RELOAD_GUARD_KEY), "1000");
  assert.equal(claimReload(s, 2_000), false, "a second stale chunk right after the reload must not loop");
  assert.equal(claimReload(s, 1_000 + RELOAD_GUARD_TTL_MS + 1), true, "a stale guard from long ago does not block");
  clearReloadGuard(s);
  assert.equal(s.data.has(RELOAD_GUARD_KEY), false);
  assert.equal(claimReload(s, 5_000), true);
});

test("claimReload never reloads without working storage", () => {
  assert.equal(claimReload(null, 1), false);
  const throwing: GuardStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  assert.equal(claimReload(throwing, 1), false);
  // setItem silently dropped (some private modes): the read-back fails, so no reload.
  const dropping: GuardStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  assert.equal(claimReload(dropping, 1), false);
  assert.doesNotThrow(() => clearReloadGuard(throwing));
});

test("claimReload ignores a guard from the future (clock change)", () => {
  const s = memoryStorage();
  s.data.set(RELOAD_GUARD_KEY, "9999999");
  assert.equal(claimReload(s, 10), true);
});

test("isChunkLoadError recognises each browser's dynamic-import failure", () => {
  assert.equal(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/case-abc.js")), true);
  assert.equal(isChunkLoadError(new TypeError("error loading dynamically imported module: https://x/assets/a.js")), true);
  assert.equal(isChunkLoadError(new TypeError("Importing a module script failed.")), true);
  assert.equal(isChunkLoadError(new Error("Unable to preload CSS for /assets/case-abc.css")), true);
  assert.equal(isChunkLoadError(new Error("Request failed (500)")), false);
  assert.equal(isChunkLoadError("Failed to fetch dynamically imported module"), false);
  assert.equal(isChunkLoadError(null), false);
});

test("classifyLoadError tells offline, server and other failures apart", () => {
  const apiError = (status: number): Error & { status: number } => Object.assign(new Error("x"), { status });
  assert.equal(classifyLoadError(new TypeError("Importing a module script failed."), true), "chunk");
  assert.equal(classifyLoadError(new TypeError("Importing a module script failed."), false), "offline", "offline: reloading would not help");
  assert.equal(classifyLoadError(apiError(0), true), "offline");
  assert.equal(classifyLoadError(apiError(500), false), "offline", "offline wins: the fix is to reconnect");
  assert.equal(classifyLoadError(apiError(503), true), "server");
  assert.equal(classifyLoadError(apiError(500), true), "server");
  assert.equal(classifyLoadError(apiError(404), true), "other");
  assert.equal(classifyLoadError(new Error("boom"), true), "other");
  assert.equal(classifyLoadError(undefined, true), "other");
});
