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
      "src/components/ourdream/**/*.test.ts",
      "src/hooks/**/*.test.ts",
      "src/app/sitemap.test.ts",
      "src/e2e/playwright-environment.test.ts",
      "src/e2e/playwright-chat-service-outcome.test.ts",
      "src/e2e/playwright-workspace-lease.test.ts",
      "src/lib/**/*.test.ts",
      "src/server/launch-readiness.test.ts",
      "src/server/modules/voice-defaults.test.ts",
      "src/server/next-standalone-runtime.test.ts",
      "src/server/probe-web-surface-assets.test.ts",
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
      // 子路径名与目录名不一致的必须显式列出，通配规则会把 env 解析成 shared/src/env。
      {
        find: /^@idream\/shared\/env$/,
        replacement: `${sharedSourceRoot}contracts/env.ts`,
      },
      {
        find: /^@idream\/shared\/(.+)$/,
        replacement: `${sharedSourceRoot}$1`,
      },
    ],
  },
});
