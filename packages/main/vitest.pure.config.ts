import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const mainSourceRoot = fileURLToPath(new URL("./src/", import.meta.url));
const sharedSourceRoot = fileURLToPath(
  new URL("../shared/src/", import.meta.url),
);

// Pure contracts, client-state helpers, and provider adapters must remain
// runnable without PostgreSQL/Redis. Integration tests continue to use the
// default config and its isolated database global setup.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "prisma/main-chat-turn-authority.test.ts",
      "src/components/ourdream/**/*.test.ts",
      "src/hooks/**/*.test.ts",
      "src/app/sitemap.test.ts",
      "src/e2e/playwright-environment.test.ts",
      "src/e2e/playwright-chat-service-outcome.test.ts",
      "src/e2e/playwright-workspace-lease.test.ts",
      "src/lib/**/*.test.ts",
      "src/scripts/character-quality/*.test.ts",
      "src/server/launch-readiness.test.ts",
      "src/server/lib/auth/password.test.ts",
      "src/server/modules/voice-defaults.test.ts",
      "src/server/modules/chat/companion-memory-authority.test.ts",
      "src/server/modules/admin-v2/characters/simplified-release.test.ts",
      "src/server/modules/admin-v2/characters/readiness.test.ts",
      "src/server/modules/admin-v2/characters/character-release-contract.test.ts",
      "src/server/modules/admin-v2/characters/production-journey.test.ts",
      "src/server/modules/admin-v2/characters/image-qualification.test.ts",
      "src/server/modules/admin-v2/creative/run-create-authority.test.ts",
      "src/server/modules/admin-v2/shared/state-transition-authority.test.ts",
      "src/server/modules/admin-v2/shared/api-manifest.test.ts",
      "src/server/modules/admin-v2/shared/route-handler.test.ts",
      "src/server/modules/admin-v2/shared/deep-module-authority-boundaries.test.ts",
      "src/server/modules/admin-v2/shared/finite-state-authority-inventory.test.ts",
      "src/server/modules/ourdream/architecture-boundaries.test.ts",
      "src/server/modules/ourdream/generation-prompt.test.ts",
      "src/server/modules/ourdream/generation-context.test.ts",
      "src/server/modules/ourdream/voice-clip-quote.test.ts",
      "src/server/modules/ourdream/generation-profile-selection.test.ts",
      "src/server/next-standalone-runtime.test.ts",
      "src/server/probe-web-surface-assets.test.ts",
      "src/server/probe-payment-provider.test.ts",
      "src/server/probe-product-config.test.ts",
      "src/server/probe-age-verification.test.ts",
      "src/server/probe-generation-persistence.test.ts",
      "src/server/probe-chat-service.test.ts",
      "src/server/dsh-image-tool-e2e-evidence.test.ts",
      "src/server/probe-chat-dsh-image-tool.test.ts",
      "src/server/probe-sentry.test.ts",
      "src/server/readiness/chat-sse-probe.test.ts",
      "src/server/readiness/probe-report.test.ts",
      "src/server/readiness/migration-authority.test.ts",
      "src/server/readiness/migration-authority-lifecycle.test.ts",
      "src/server/readiness/recovery-rehearsal-authority.test.ts",
      "src/server/readiness/recovery-rehearsal-executor.test.ts",
      "src/server/readiness/recovery-rehearsal-producer.test.ts",
      "src/server/readiness/recovery-service-environment.test.ts",
      "src/server/cms/**/*.test.ts",
      "src/server/providers/**/*.test.ts",
      "src/server/seed-nondestructive.test.ts",
    ],
  },
  resolve: {
    alias: [
      {
        find: /^@\/(.+)$/,
        replacement: `${mainSourceRoot}$1`,
      },
      {
        find: /^@idream\/shared$/,
        replacement: `${sharedSourceRoot}index.ts`,
      },
      {
        find: /^@idream\/shared\/contracts$/,
        replacement: `${sharedSourceRoot}contracts/index.ts`,
      },
      {
        find: /^@idream\/shared\/bff$/,
        replacement: `${sharedSourceRoot}bff/signing.ts`,
      },
      // 子路径名与目录名不一致的必须显式列出，通配规则会把 env 解析成 shared/src/env。
      {
        find: /^@idream\/shared\/env$/,
        replacement: `${sharedSourceRoot}contracts/env.ts`,
      },
      {
        find: /^@idream\/shared\/gen-workflow$/,
        replacement: `${sharedSourceRoot}gen/workflow.ts`,
      },
      {
        find: /^@idream\/shared\/(.+)$/,
        replacement: `${sharedSourceRoot}$1`,
      },
    ],
  },
});
