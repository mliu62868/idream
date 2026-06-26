import { defineConfig } from "vitest/config";

// SPEC: Integration tests run against a dedicated, freshly-seeded test database
// (Postgres in TEST_DATABASE_URL, or the local compose Postgres by default),
// isolated from the dev database. global-setup resets+seeds its public schema
// once per run.
// INVARIANTS: APP_ENV=test keeps dev auth headers (x-idream-user-id/role) enabled.
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/idream_test";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "prisma/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    globalSetup: ["./src/server/test/global-setup.ts"],
    env: {
      APP_ENV: "test",
      DB_PROVIDER: "postgresql",
      DATABASE_URL,
      CHAT_PROVIDER: "mock",
      IMAGE_PROVIDER: "mock",
      VIDEO_PROVIDER: "mock",
      VOICE_PROVIDER: "mock",
      MODERATION_PROVIDER: "mock",
      PAYMENT_PROVIDER: "mock",
      BLOB_PROVIDER: "mock",
      AGE_VERIFICATION_PROVIDER: "mock",
      BETTER_AUTH_SECRET: "test-secret-please-change-0123456789abcdef",
      INTERNAL_TOKEN: "test-internal-token-0123456789",
      CRON_SECRET: "test-cron-token-0123456789",
      REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15",
      BULLMQ_PREFIX: process.env.BULLMQ_PREFIX ?? "idream:test",
    },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json-summary"],
      include: ["src/server/**/*.ts"],
      exclude: [
        "src/server/**/*.test.ts",
        "src/server/test/**",
        "src/server/lib/better-auth.ts",
      ],
      // Gate per docs/architecture/11-testing.md §7. These thresholds are a
      // ratchet at the 2026-06-25 baseline; raise them as provider/admin branch
      // tests are added instead of letting coverage drift down silently.
      // Branches run lower because some env/provider failure branches are not
      // reachable in the deterministic Postgres + mock-provider test run.
      thresholds: {
        statements: 77,
        functions: 83,
        lines: 81,
        branches: 65,
      },
    },
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "@idream/shared/contracts": new URL(
        "../shared/src/contracts/index.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared/bff": new URL("../shared/src/bff/signing.ts", import.meta.url).pathname,
      "@idream/shared/storage/local-blob": new URL(
        "../shared/src/storage/local-blob.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared/storage": new URL("../shared/src/storage/s3-blob.ts", import.meta.url)
        .pathname,
      "@idream/shared/moderation": new URL(
        "../shared/src/moderation/safety-gateway.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
