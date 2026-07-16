import "dotenv/config";
import { defineConfig } from "@playwright/test";
import {
  managedPlaywrightWebServers,
  resolvePlaywrightEnvironment,
} from "./playwright-environment";

// Browser tests own every writable dependency. Ambient Main/Admin/Chat processes,
// CHAT_SERVICE_URL, CHAT_DATABASE_URL, Redis db 0, and the live chat file store
// are never reused.
const environment = resolvePlaywrightEnvironment(process.env);
Object.assign(process.env, environment.serviceEnv, {
  PW_WEBSERVER: "1",
  PW_BASE_URL: environment.mainBaseURL,
  PW_ADMIN_BASE_URL: environment.adminBaseURL,
});

export default defineConfig({
  testDir: "src",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: "list",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: environment.mainBaseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
  },
  webServer: managedPlaywrightWebServers(environment),
});
