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
    const qwenEdit = descriptors.find((d) => d.workflowKey === "qwen-image-edit-img2img");
    expect(qwenEdit).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(qwenEdit)).not.toThrow();
  });

  it("loads the two-reference Qwen identity workflow with two required semantic graph slots", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const multiIdentity = descriptors.find(
      (descriptor) => descriptor.workflowKey === "qwen-image-edit-multi-identity",
    );
    expect(multiIdentity).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(multiIdentity)).not.toThrow();
    expect(multiIdentity).toMatchObject({
      modelId: "qwen-image-edit-multi-identity",
      identity: {
        mode: "multi_identity",
        maxReferences: 2,
        acceptedRoles: [
          "identity_anchor",
          "identity_reference",
          "look_reference",
        ],
        supportsLookReference: true,
        supportsSourceImageWithIdentity: false,
      },
    });
    if (!multiIdentity || multiIdentity.backendKind !== "comfyui") {
      throw new Error("expected Qwen multi-identity ComfyUI descriptor");
    }
    const imageSlots = multiIdentity.inputs.filter((input) => input.type === "image");
    expect(imageSlots).toEqual([
      expect.objectContaining({
        key: "identity_anchor",
        required: true,
        referenceRoles: ["identity_anchor"],
        target: { nodeId: "8", field: "image" },
      }),
      expect.objectContaining({
        key: "identity_reference",
        required: true,
        referenceRoles: ["identity_reference", "look_reference"],
        target: { nodeId: "12", field: "image" },
      }),
    ]);
    expect(multiIdentity.apiPrompt["3"]?.inputs).toMatchObject({
      image1: ["8", 0],
      image2: ["12", 0],
    });

    const identityAndSource = descriptors.find(
      (descriptor) => descriptor.workflowKey === "qwen-image-edit-multi-reference",
    );
    expect(identityAndSource).toMatchObject({
      modelId: "qwen-image-edit-multi-reference",
      identity: {
        mode: "multi_reference",
        maxReferences: 2,
        acceptedRoles: [
          "identity_anchor",
          "identity_reference",
          "source_image",
        ],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: true,
      },
    });
    if (!identityAndSource || identityAndSource.backendKind !== "comfyui") {
      throw new Error("expected Qwen identity-plus-source ComfyUI descriptor");
    }
    expect(
      identityAndSource.inputs.filter((input) => input.type === "image"),
    ).toEqual([
      expect.objectContaining({
        key: "identity_image",
        referenceRoles: ["identity_anchor", "identity_reference"],
        target: { nodeId: "8", field: "image" },
      }),
      expect.objectContaining({
        key: "source_image",
        referenceRoles: ["source_image"],
        target: { nodeId: "12", field: "image" },
      }),
    ]);
    expect(identityAndSource.apiPrompt["3"]?.inputs).toMatchObject({
      image1: ["8", 0],
      image2: ["12", 0],
    });
  });

  it("loads the opt-in Draw Things Pornmaster descriptor", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const drawThings = descriptors.find((d) => d.modelId === "pornmaster-zimage-drawthings");
    expect(drawThings).toBeDefined();
    expect(drawThings?.backendKind).toBe("drawthings");
  });
});
