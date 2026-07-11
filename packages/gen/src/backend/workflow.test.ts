import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workflowDescriptorSchema, loadWorkflowDescriptors } from "./workflow";

// Resolve packages/gen/workflows relative to this test file (not process.cwd()),
// so the test works regardless of which directory vitest is invoked from.
const WORKFLOWS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../workflows",
);

// Pure-function tests (bindComfySlots/bindSdcppArgs) and the onSkip-callback
// contract now live at packages/shared/src/gen/workflow.test.ts, alongside the
// hoisted SSoT (@idream/shared/gen-workflow). This file keeps only the test
// that reads gen's real on-disk workflows/ directory through the thin shell,
// since that fixture is gen-specific.
describe("loadWorkflowDescriptors (real files on disk)", () => {
  it("loads the redcraft-krea2 txt2img descriptor and validates it against the schema", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    // The dir also contains a legacy non-conforming file
    // (redcraft-krea2-comfyui-text.json) which the loader warn-skips —
    // so we assert presence of the target modelId, not array length.
    const redcraft = descriptors.find((d) => d.modelId === "redcraft-krea2-comfyui");
    expect(redcraft).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(redcraft)).not.toThrow();
  });

  it("loads the qwen-image-edit img2img descriptor and validates it against the schema", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const qwenEdit = descriptors.find((d) => d.modelId === "qwen-image-edit");
    expect(qwenEdit).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(qwenEdit)).not.toThrow();
  });

  it("loads the opt-in Draw Things Pornmaster descriptor", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const drawThings = descriptors.find((d) => d.modelId === "pornmaster-zimage-drawthings");
    expect(drawThings).toBeDefined();
    expect(drawThings?.backendKind).toBe("drawthings");
  });
});
