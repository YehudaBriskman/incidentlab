import { execFileSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";

/*
 * No case content is bundled (#68): the catalog, case content and evidence all come from the content API
 * (src/content/load.ts), and paid content (hint texts, runnable commands) only from the game API after
 * charging. scripts/check-bundle.mjs fails the build if any case JSON, paid string or answer reaches dist.
 */

/** The commit this build came from (BUILD_SHA wins, then git; "-dirty" marks uncommitted changes). */
const buildSha = (): string => {
  const fromEnv = process.env.BUILD_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return git("rev-parse", "--short=12", "HEAD") + (git("status", "--porcelain") === "" ? "" : "-dirty");
  } catch {
    return "unknown";
  }
};

/** Stamps `<meta name="build">` so anyone can tell which commit is live (view source, or the smoke test). */
const buildStampPlugin = (): Plugin => {
  const sha = buildSha();
  return {
    name: "incidentlab-build-stamp",
    transformIndexHtml: () => [{ tag: "meta", attrs: { name: "build", content: sha }, injectTo: "head" }],
  };
};

export default defineConfig({
  base: "/",
  plugins: [buildStampPlugin()],
  build: { outDir: "dist", sourcemap: false },
});
