import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "./env";

describe("generation workflow configuration", () => {
  const originalWorkflowDir = process.env.GEN_WORKFLOW_DIR;

  afterEach(() => {
    if (originalWorkflowDir === undefined) delete process.env.GEN_WORKFLOW_DIR;
    else process.env.GEN_WORKFLOW_DIR = originalWorkflowDir;
  });

  it("resolves the bundled workflow directory independently of process cwd", async () => {
    delete process.env.GEN_WORKFLOW_DIR;

    expect((await stat(env.GEN_WORKFLOW_DIR)).isDirectory()).toBe(true);
  });
});
