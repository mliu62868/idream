import { describe, expect, it } from "vitest";
import { isProcessEntrypoint } from "./process-entrypoint";

describe("Bun process entrypoint detection", () => {
  it("recognizes the PM2 Bun wrapper through pm_exec_path", () => {
    expect(isProcessEntrypoint(
      ["finalizer.ts", "finalizer.js"],
      {
        argvEntry: "/Users/kk/node_modules/pm2/lib/ProcessContainerForkBun.js",
        pmExecPath: "/workspace/packages/main/src/processes/finalizer.ts",
      },
    )).toBe(true);
  });

  it("still recognizes a direct Bun invocation and rejects imports", () => {
    expect(isProcessEntrypoint(
      ["event-consumer.ts", "event-consumer.js"],
      { argvEntry: "/workspace/packages/main/src/processes/event-consumer.ts" },
    )).toBe(true);
    expect(isProcessEntrypoint(
      ["event-consumer.ts", "event-consumer.js"],
      { argvEntry: "/workspace/packages/main/src/server/test.ts" },
    )).toBe(false);
  });
});
