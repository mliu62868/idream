import { defineConfig } from "vitest/config";
import {
  chatTestBullMqPrefix,
  chatTestDatabaseTarget,
} from "./test/provision.mjs";

const chatTestTarget = chatTestDatabaseTarget();
const chatTestBullMqNamespace =
  chatTestBullMqPrefix(chatTestTarget);

// Chat service tests run against a freshly-provisioned Postgres (global-setup
// pushes main schema + applies the boundary SQL). chat is Postgres-native, so
// there is no SQLite matrix here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      APP_ENV: "test",
      NODE_ENV: "test",
      CHAT_TEST_DB: chatTestTarget.database,
      CHAT_BFF_SIGNING_SECRET: "test-bff-secret-0123456789abcdef",
      CHAT_TEST_REDIS_URL: "redis://127.0.0.1:6379/14",
      CHAT_REDIS_URL: "redis://127.0.0.1:6379/14",
      BULLMQ_PREFIX: chatTestBullMqNamespace,
      CHAT_MODEL_PROVIDER: "mock",
      MODERATION_PROVIDER: "mock",
      // Pin extraction to the deterministic regex so the suite never spawns the
      // real igrep/omlx LLM. extract.test.ts opts into igrep per-test via a fake bin.
      CHAT_MEMORY_EXTRACT: "heuristic",
    },
  },
  resolve: {
    alias: {
      "@idream/shared/contracts": new URL(
        "../shared/src/contracts/index.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared/bff": new URL("../shared/src/bff/signing.ts", import.meta.url).pathname,
      "@idream/shared/chat/limits": new URL(
        "../shared/src/chat/limits.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared/env": new URL(
        "../shared/src/contracts/env.ts",
        import.meta.url,
      ).pathname,
      // Bare specifier stays LAST — Vite alias matching is prefix-based, first match wins.
      "@idream/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
