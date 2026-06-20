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
    },
  },
  resolve: {
    alias: {
      "@idream/shared/contracts": new URL(
        "../shared/src/contracts/index.ts",
        import.meta.url,
      ).pathname,
      "@idream/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
