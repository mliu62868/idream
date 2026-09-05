import { defineConfig } from "vitest/config";

// Gen service unit tests run with no external deps: pipeline.test.ts injects a
// fake enqueue so no Redis is required. The @idream/shared alias is resolved
// here the same way tsconfig paths resolve it for `tsc`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      GEN_VIDEO_PROVIDER: "mock",
    },
  },
  resolve: {
    alias: {
      "@idream/shared/contracts": new URL(
        "../shared/src/contracts/index.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared/media/generated-image-sanity": new URL(
        "../shared/src/media/generated-image-sanity.ts",
        import.meta.url,
      ).pathname,
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
      "@idream/shared/gen-workflow": new URL(
        "../shared/src/gen/workflow.ts",
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
      // Bare specifier stays LAST — Vite alias matching is prefix-based, first match wins.
      "@idream/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
