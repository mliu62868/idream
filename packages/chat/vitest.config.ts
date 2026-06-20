import { defineConfig } from "vitest/config";

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
      NODE_ENV: "test",
      CHAT_BFF_SIGNING_SECRET: "test-bff-secret-0123456789abcdef",
    },
  },
  resolve: {
    alias: {
      "@idream/shared/contracts": new URL(
        "../shared/src/contracts/index.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared/bff": new URL("../shared/src/bff/signing.ts", import.meta.url).pathname,
      "@idream/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
