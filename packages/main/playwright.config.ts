import "dotenv/config";
import {
  defineConfig,
  type PlaywrightTestConfig,
} from "@playwright/test";
import {
  managedPlaywrightWebServers,
  resolvePlaywrightEnvironment,
} from "./playwright-environment";
import { createPlaywrightCleanupPlan } from "./src/e2e/playwright-cleanup";
import { createPlaywrightLifecycleVerifier } from "./src/e2e/playwright-lifecycle-receipt";

// Browser tests own every writable dependency. Ambient Main/Admin/Chat processes,
// CHAT_SERVICE_URL, CHAT_DATABASE_URL, Redis db 0, and the live chat file store
// are never reused.
const environment = resolvePlaywrightEnvironment(process.env);
const cleanupPlan = createPlaywrightCleanupPlan(environment);
Object.assign(process.env, environment.serviceEnv, {
  PW_WEBSERVER: "1",
  PW_BASE_URL: environment.mainBaseURL,
  PW_ADMIN_BASE_URL: environment.adminBaseURL,
});

const config: PlaywrightTestConfig & {
  readonly "@playwright/test": {
    readonly plugins: ReadonlyArray<
      () => ReturnType<typeof createPlaywrightLifecycleVerifier>
    >;
  };
} = {
  // Playwright appends webServer plugins after configured plugins and tears
  // them down in reverse order. This verifier therefore runs after every
  // managed server has stopped and turns a missing/failed cleanup receipt into
  // a test-run failure, independently of CLI reporter overrides.
  "@playwright/test": {
    plugins: [() => createPlaywrightLifecycleVerifier(cleanupPlan)],
  },
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
};

export default defineConfig(config);
