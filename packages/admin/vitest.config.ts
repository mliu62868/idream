import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // INTENT: Node 24+ ships a process-level Web Storage placeholder that
    // collides with happy-dom when no --localstorage-file is configured.
    // Browser tests must use happy-dom's origin-scoped Storage authority.
    execArgv: ["--no-experimental-webstorage"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
