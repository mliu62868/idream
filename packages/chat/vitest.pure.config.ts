import "dotenv/config";
import { defineConfig } from "vitest/config";

// Pure behavior tests mock every DB/Redis boundary. Keep this list explicit so
// a focused regression can never invoke the integration suite's schema setup.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/generate-agent-tools.test.ts",
      "src/runtime-readiness.test.ts",
      "src/companion-runtime-selection.test.ts",
      "src/companion-runtime.test.ts",
      "src/companion-memory-cutover.test.ts",
      "src/companion-memory-cutover-runtime.test.ts",
      "src/memory-cutover-audit-core.test.ts",
      "src/memory-cutover-audit.test.ts",
      "src/legacy-memory-import-pure.test.ts",
      "src/service.test.ts",
    ],
    env: {
      APP_ENV: "test",
      NODE_ENV: "test",
      CHAT_BFF_SIGNING_SECRET: "test-bff-secret-0123456789abcdef",
      CHAT_DATABASE_URL: "postgresql://pure:unused@127.0.0.1:1/pure?schema=chat",
      CHAT_MODEL_PROVIDER: "mock",
      MODERATION_PROVIDER: "mock",
      CHAT_DATABASE_URL: "postgresql://pure_test:pure_test@127.0.0.1:1/pure_test",
      CHAT_PROJECTOR_DATABASE_URL:
        "postgresql://pure_test_projector:pure_test@127.0.0.1:1/pure_test",
    },
  },
  resolve: {
    alias: {
      "@idream/shared/contracts": new URL(
        "../shared/src/contracts/index.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared/bff": new URL(
        "../shared/src/bff/signing.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared/chat/limits": new URL(
        "../shared/src/chat/limits.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared/chat/companion-runtime": new URL(
        "../shared/src/chat/companion-runtime.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared/env": new URL(
        "../shared/src/contracts/env.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared/observability/sentry": new URL(
        "../shared/src/observability/sentry.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
