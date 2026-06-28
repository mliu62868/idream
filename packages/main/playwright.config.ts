import "dotenv/config";
import { defineConfig } from "@playwright/test";

// SPEC (docs/architecture/11-testing.md §5): L4 E2E runs against a real `next dev`
// server backed by seeded Postgres with the provider config from the active env.
// Keep a single dev server so browser flows share the same seeded state.
//
// Server management: by default the suite expects a dev server already running at
// baseURL (start it with `bun run dev`, e.g. in tmux/CI before the run). Set
// PW_WEBSERVER=1 to let Playwright boot and manage `next dev` itself.
const managedWebServer = process.env.PW_WEBSERVER === "1";
const baseURL = process.env.PW_BASE_URL ?? "http://127.0.0.1:3000";
const basePort = new URL(baseURL).port || "3000";
const adminBaseURL =
  process.env.PW_ADMIN_BASE_URL ??
  (() => {
    const url = new URL(baseURL);
    url.port = "3001";
    return url.toString().replace(/\/$/, "");
  })();

export default defineConfig({
  testDir: "src",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  // One retry: the suite runs serially against the live standalone server on a shared
  // machine, where the heaviest tests (chat streaming, generation pipeline) occasionally
  // exceed a timeout under cumulative load. A real failure still fails on retry; this only
  // absorbs environmental contention, not product/test defects.
  retries: 1,
  reporter: "list",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
  },
  webServer: managedWebServer
    ? [
        {
          command: `bun run dev -- --port ${basePort}`,
          url: baseURL,
          reuseExistingServer: true,
          timeout: 120_000,
        },
        ...(process.env.PW_ADMIN_BASE_URL
          ? []
          : [
              {
                command: "bun --cwd ../.. run --filter @idream/admin dev",
                url: adminBaseURL,
                reuseExistingServer: true,
                timeout: 120_000,
              },
            ]),
      ]
    : undefined,
});
