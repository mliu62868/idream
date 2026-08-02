import { describe, expect, it, vi } from "vitest";
import { BackendVideoModel } from "./backend-video-model";
import { BackendInvocationError, type GenBackend } from "./types";
import { workflowDescriptorSchema } from "./workflow";
import type { VerifiedVideoMedia } from "./video-media-probe";
import productionDescriptor from "../../workflows/ltx23-gtanimation-i2v.json";

const MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
  0x6d, 0x70, 0x34, 0x32,
]);

const descriptor = workflowDescriptorSchema.parse(productionDescriptor);
const VERIFIED_VIDEO: VerifiedVideoMedia = {
  width: 768,
  height: 1152,
  durationSeconds: 4.04,
  framesPerSecond: 25,
  hasAudio: true,
};

function backend(
  verifiedVideo: VerifiedVideoMedia | null = VERIFIED_VIDEO,
): GenBackend {
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
        ...(verifiedVideo ? { verifiedVideo } : {}),
      }],
    })),
    health: vi.fn(async () => ({ ok: true })),
  };
}

function validGenerationInput() {
  return {
    prompt: "wave",
    seconds: 4,
    model: "ltx23-gtanimation-i2v",
    controls: {
      workflowKey: "ltx23-gtanimation-i2v",
      workflowVersion: 1,
      width: 768,
      height: 1152,
    },
    referenceImages: [{
      assetId: "source-1",
      role: "source_image" as const,
      b64Json: "aW1hZ2U=",
    }],
  };
}

describe("BackendVideoModel", () => {
  it("does not advertise deterministic replay for ComfyUI video submissions", () => {
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({ backend: backend(), descriptor })),
    });

    expect("retryCapabilities" in model).toBe(false);
  });

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
          seconds: VERIFIED_VIDEO.durationSeconds,
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

  it.each([
    {
      label: "decoded dimensions",
      media: { ...VERIFIED_VIDEO, width: 640 },
      message: "640x1152",
    },
    {
      label: "decoded duration",
      media: { ...VERIFIED_VIDEO, durationSeconds: 4.5 },
      message: "duration is 4.5s",
    },
    {
      label: "decoded frame rate",
      media: { ...VERIFIED_VIDEO, framesPerSecond: 24 },
      message: "frame rate is 24fps",
    },
    {
      label: "required audio stream",
      media: { ...VERIFIED_VIDEO, hasAudio: false },
      message: "no audio stream",
    },
  ])("rejects a production artifact with invalid $label", async ({
    media,
    message,
  }) => {
    const stub = backend(media);
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({ backend: stub, descriptor })),
    });

    const result = await model.generate(validGenerationInput());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_video_output",
        message: expect.stringContaining(message),
        outcome: "definitive",
        retryable: false,
      },
      invocation: { providerRequestId: "prompt-video-1" },
    });
  });

  it("rejects an MP4 asset when decode verification metadata is unavailable", async () => {
    const stub = backend(null);
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({ backend: stub, descriptor })),
    });

    const result = await model.generate(validGenerationInput());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_video_output",
        message: expect.stringContaining("no verified decode metadata"),
        retryable: false,
      },
    });
  });

  it("maps a post-submit history reset to an ambiguous outcome", async () => {
    const stub = backend();
    stub.poll = vi.fn(async () => {
      throw new Error("connection reset by peer");
    });
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({ backend: stub, descriptor })),
    });

    const result = await model.generate(validGenerationInput());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "backend_error",
        outcome: "ambiguous",
        retryable: true,
      },
      invocation: { providerRequestId: "prompt-video-1" },
    });
  });

  it("preserves an explicit ComfyUI prompt failure as definitive", async () => {
    const stub = backend();
    stub.poll = vi.fn(async () => {
      throw new BackendInvocationError(
        "backend_error",
        "ComfyUI prompt failed",
        "post_submit",
        "definitive",
      );
    });
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({ backend: stub, descriptor })),
    });

    const result = await model.generate(validGenerationInput());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "backend_error",
        outcome: "definitive",
        retryable: false,
      },
    });
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

  it("rejects a descriptor whose executable checkpoint was tampered", async () => {
    const stub = backend();
    const tampered = structuredClone(descriptor);
    if (tampered.backendKind !== "comfyui") throw new Error("expected comfyui");
    const loader = tampered.apiPrompt["320:333"];
    if (!loader || typeof loader.inputs !== "object" || !loader.inputs) {
      throw new Error("expected production UNET loader");
    }
    loader.inputs.unet_name = "unreviewed-video-model.safetensors";
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({ backend: stub, descriptor: tampered })),
    });

    const result = await model.generate(validGenerationInput());

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsupported_video_workflow", retryable: false },
    });
    expect(stub.submit).not.toHaveBeenCalled();
  });

  it("rejects a descriptor whose seconds slot was rebound", async () => {
    const stub = backend();
    const tampered = workflowDescriptorSchema.parse({
      ...structuredClone(descriptor),
      inputs: descriptor.inputs.map((input) =>
        input.key === "seconds"
          ? { ...input, target: { nodeId: "320:302", field: "value" } }
          : input
      ),
    });
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({ backend: stub, descriptor: tampered })),
    });

    const result = await model.generate(validGenerationInput());

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsupported_video_workflow", retryable: false },
    });
    expect(stub.submit).not.toHaveBeenCalled();
  });

  it("rejects video durations outside the production four-second envelope", async () => {
    const stub = backend();
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({ backend: stub, descriptor })),
    });

    const result = await model.generate({
      prompt: "wave",
      seconds: 6,
      model: "ltx23-gtanimation-i2v",
      controls: {
        workflowKey: "ltx23-gtanimation-i2v",
        workflowVersion: 1,
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
        code: "unsupported_video_duration",
        retryable: false,
      },
    });
    expect(stub.submit).not.toHaveBeenCalled();
  });

  it("requires exact workflow pins and the production spatial envelope", async () => {
    const stub = backend();
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({ backend: stub, descriptor })),
    });
    const referenceImages = [{
      assetId: "source-1",
      role: "source_image" as const,
      b64Json: "aW1hZ2U=",
    }];

    const missingPins = await model.generate({
      prompt: "wave",
      seconds: 4,
      model: "ltx23-gtanimation-i2v",
      controls: { width: 768, height: 1152 },
      referenceImages,
    });
    expect(missingPins).toMatchObject({
      ok: false,
      error: { code: "workflow_version_mismatch", retryable: false },
    });

    const wrongEnvelope = await model.generate({
      prompt: "wave",
      seconds: 4,
      model: "ltx23-gtanimation-i2v",
      controls: {
        workflowKey: "ltx23-gtanimation-i2v",
        workflowVersion: 1,
        width: 1024,
        height: 1152,
      },
      referenceImages,
    });
    expect(wrongEnvelope).toMatchObject({
      ok: false,
      error: { code: "unsupported_video_envelope", retryable: false },
    });
    expect(stub.submit).not.toHaveBeenCalled();
  });

  it("rejects a non-production video descriptor", async () => {
    const stub = backend();
    const model = new BackendVideoModel({
      resolveForModel: vi.fn(() => ({
        backend: stub,
        descriptor: { ...descriptor, modelId: "other-video-model" },
      })),
    });

    const result = await model.generate({
      prompt: "wave",
      seconds: 4,
      model: "other-video-model",
      controls: {
        workflowKey: "ltx23-gtanimation-i2v",
        workflowVersion: 1,
        width: 768,
        height: 1152,
      },
      referenceImages: [{
        assetId: "source-1",
        role: "source_image",
        b64Json: "aW1hZ2U=",
      }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsupported_video_workflow", retryable: false },
    });
    expect(stub.submit).not.toHaveBeenCalled();
  });
});
