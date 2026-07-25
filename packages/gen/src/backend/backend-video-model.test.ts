import { describe, expect, it, vi } from "vitest";
import { BackendVideoModel } from "./backend-video-model";
import type { GenBackend } from "./types";
import { workflowDescriptorSchema } from "./workflow";

const MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
  0x6d, 0x70, 0x34, 0x32,
]);

const descriptor = workflowDescriptorSchema.parse({
  workflowKey: "ltx23-gtanimation-i2v",
  modelId: "ltx23-gtanimation-int4-convrot",
  backendKind: "comfyui",
  comfyWorkflow: {
    id: "66666666-6666-4666-8666-666666666666",
    name: "LTX 2.3 GTAnimation I2V",
  },
  version: 1,
  capabilities: ["video", "img2video", "referenceImages", "stableSeed"],
  identity: {
    mode: "single_reference",
    maxReferences: 1,
    acceptedRoles: ["source_image"],
    supportsLookReference: false,
    supportsSourceImageWithIdentity: false,
  },
  apiPrompt: {
    "269": { class_type: "LoadImage", inputs: { image: "" } },
  },
  inputs: [
    {
      key: "source_image",
      type: "image",
      referenceRoles: ["source_image"],
      target: { nodeId: "269", field: "image" },
    },
  ],
});

function backend(): GenBackend {
  return {
    id: "comfyui",
    kind: "comfyui",
    capabilities: () => ({
      textToImage: true,
      img2img: true,
      referenceImages: true,
      stableSeed: true,
      edit: false,
    }),
    submit: vi.fn(async () => ({ id: "prompt-video-1" })),
    poll: vi.fn(async () => ({
      assets: [{
        body: MP4,
        width: 768,
        height: 1152,
        contentType: "video/mp4",
      }],
    })),
    health: vi.fn(async () => ({ ok: true })),
  };
}

describe("BackendVideoModel", () => {
  it("binds production video slots and the pinned source image", async () => {
    const stub = backend();
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({ backend: stub, descriptor })),
    });
    const referenceImages = [{
      assetId: "character-primary-image-1",
      role: "source_image" as const,
      b64Json: "aW1hZ2U=",
      contentType: "image/webp",
    }];

    const result = await model.generate({
      prompt: "She smiles, blinks, and waves naturally.",
      negativePrompt: "flicker, identity drift",
      seconds: 4,
      seed: "100",
      model: "ltx23-gtanimation-i2v",
      requestId: "request-video-1",
      controls: {
        workflowKey: "ltx23-gtanimation-i2v",
        workflowVersion: 1,
        width: 768,
        height: 1152,
      },
      referenceImages,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        asset: {
          seconds: 4,
          contentType: "video/mp4",
          body: MP4,
        },
      },
      invocation: {
        providerRequestId: "prompt-video-1",
      },
    });
    expect(stub.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor,
        requestId: "request-video-1",
        referenceImages,
        slots: {
          prompt: "She smiles, blinks, and waves naturally.",
          negative: "flicker, identity drift",
          width: 768,
          height: 1152,
          seconds: 4,
          fps: 25,
          seed: 100,
          refinerSeed: 101,
        },
      }),
    );
  });

  it("rejects a stale pinned workflow before submitting", async () => {
    const stub = backend();
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({ backend: stub, descriptor })),
    });

    const result = await model.generate({
      prompt: "wave",
      seconds: 4,
      model: "ltx23-gtanimation-i2v",
      controls: {
        workflowKey: "ltx23-gtanimation-i2v",
        workflowVersion: 2,
      },
      referenceImages: [{
        assetId: "source-1",
        role: "source_image",
        b64Json: "aW1hZ2U=",
      }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "workflow_version_mismatch",
        retryable: false,
      },
    });
    expect(stub.submit).not.toHaveBeenCalled();
  });
});
