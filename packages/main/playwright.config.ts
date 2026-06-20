import { defineConfig } from "@playwright/test";

// SPEC (docs/architecture/11-testing.md §5): L4 E2E runs against a real `next dev`
// server backed by the seeded dev.db with mock providers. SQLite + a single dev
// server → run serially to avoid write-lock contention.
//
// Server management: by default the suite expects a dev server already running at
// baseURL (start it with `npm run dev`, e.g. in tmux/CI before the run). Set
// PW_WEBSERVER=1 to let Playwright boot and manage `next dev` itself.
const managedWebServer = process.env.PW_WEBSERVER === "1";

export default defineConfig({
  testDir: "src",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:3000",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
  },
  webServer: managedWebServer
    ? {
        command: "npm run dev",
        url: "http://127.0.0.1:3000",
        reuseExistingServer: true,
        timeout: 120_000,
      }
    : undefined,
});
