import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "./env";

const originalWorkflowDir = process.env.GEN_WORKFLOW_DIR;
const originalVideoTimeout = process.env.GEN_VIDEO_TIMEOUT_MS;

afterEach(() => {
  if (originalWorkflowDir === undefined) {
    delete process.env.GEN_WORKFLOW_DIR;
  } else {
    process.env.GEN_WORKFLOW_DIR = originalWorkflowDir;
  }
  if (originalVideoTimeout === undefined) {
    delete process.env.GEN_VIDEO_TIMEOUT_MS;
  } else {
    process.env.GEN_VIDEO_TIMEOUT_MS = originalVideoTimeout;
  }
});

describe("generation environment", () => {
  it("resolves the bundled workflow directory independently of process cwd", async () => {
    delete process.env.GEN_WORKFLOW_DIR;

    expect((await stat(env.GEN_WORKFLOW_DIR)).isDirectory()).toBe(true);
  });

  it("fails fast when the video timeout is not a positive integer", () => {
    process.env.GEN_VIDEO_TIMEOUT_MS = "not-a-timeout";

    expect(() => env.VIDEO_TIMEOUT_MS).toThrow(
      "GEN_VIDEO_TIMEOUT_MS must be a positive integer",
    );
  });
});
