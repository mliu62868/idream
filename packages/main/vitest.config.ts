import { defineConfig } from "vitest/config";

// SPEC: Integration tests run against a dedicated, freshly-seeded test database
// (SQLite prisma/test.db by default, or the Postgres in DATABASE_URL for the
// dual-DB CI matrix), isolated from the dev database. global-setup resets+seeds
// it once per run. Files run sequentially (fileParallelism:false) so multiple
// forked workers never write the same SQLite file concurrently (avoids SQLITE_BUSY).
// INVARIANTS: APP_ENV=test keeps dev auth headers (x-idream-user-id/role) enabled.
const DB_PROVIDER = process.env.DB_PROVIDER ?? "sqlite";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  (DB_PROVIDER === "sqlite"
    ? "file:./prisma/test.db"
    : "postgresql://postgres:postgres@localhost:5432/idream_test");

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "prisma/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    globalSetup: ["./src/server/test/global-setup.ts"],
    env: {
      APP_ENV: "test",
      DB_PROVIDER,
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
      // Gate per docs/architecture/11-testing.md §7 (≥80% on the main metrics).
      // Branches run lower because the Postgres-only claim path (queue.ts) and
      // env config branches are not reachable under the SQLite test matrix.
      thresholds: {
        statements: 85,
        functions: 85,
        lines: 88,
        branches: 75,
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
      "@idream/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
