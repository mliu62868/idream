import "dotenv/config";
import { defineConfig } from "vitest/config";

// Chat has no database test harness. Tests use temporary AgentRun directories;
// Redis/DSH boundaries are covered by focused adapter tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      APP_ENV: "test",
      NODE_ENV: "test",
      CHAT_BFF_SIGNING_SECRET: "test-bff-secret-0123456789abcdef",
      DSH_AGENT_TOKEN: "test-sidecar-token",
      CHAT_MODEL_PROVIDER: "mock",
    },
  },
  resolve: {
    alias: {
      "@idream/shared/contracts": new URL("../shared/src/contracts/index.ts", import.meta.url).pathname,
      "@idream/shared/bff": new URL("../shared/src/bff/signing.ts", import.meta.url).pathname,
      "@idream/shared/chat/limits": new URL("../shared/src/chat/limits.ts", import.meta.url).pathname,
      "@idream/shared/chat/companion-runtime": new URL("../shared/src/chat/companion-runtime.ts", import.meta.url).pathname,
      "@idream/shared/chat/image-action": new URL("../shared/src/chat/image-action.ts", import.meta.url).pathname,
      "@idream/shared/env": new URL("../shared/src/contracts/env.ts", import.meta.url).pathname,
      "@idream/shared/observability/sentry": new URL("../shared/src/observability/sentry.ts", import.meta.url).pathname,
      "@idream/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
