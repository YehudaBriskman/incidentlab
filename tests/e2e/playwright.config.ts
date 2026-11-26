// Playwright config for the IncidentLab end-to-end tests.
// Target: a running site (tests/local-server.ts by default). Env:
//   E2E_BASE_URL   site under test (default http://localhost:8888)
//   CHROMIUM_PATH  use a system Chromium instead of Playwright's bundled one (e.g. /usr/bin/chromium)
//   ADMIN_KEY      admin key of the server under test (default: the local-server default)
import { defineConfig, devices } from "@playwright/test";

const chromiumPath = process.env.CHROMIUM_PATH;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "test-results",
  // The walkthrough mutates shared server state (schedule, accounts), so keep runs serial.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // CI runs 4 shards (--shard=i/4): each writes a blob report, and the e2e-report job merges them into one HTML.
  reporter: process.env.CI ? [["list"], ["blob"]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8888",
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    },
  ],
});
