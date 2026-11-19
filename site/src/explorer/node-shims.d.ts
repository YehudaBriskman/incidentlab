// Minimal typings for the node:test suite (the site does not depend on @types/node).
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, message?: string): void;
  };
  export default assert;
}
declare module "node:fs" {
  export function readFileSync(path: URL, encoding: "utf8"): string;
  export function existsSync(path: URL): boolean;
}
