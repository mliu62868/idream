import { characterVideoProductionRecipe } from "@idream/shared";
import type { VideoGeneratePayload } from "@idream/shared/contracts";
import { env } from "../env";
import {
  stableNumericSeed,
  type VideoModel,
} from "../providers";
import { assignWorkflowReferenceSlots, type SlotValues } from "./workflow";
import { validateWorkflowPin, type BackendRegistry } from "./registry";
import { BackendInvocationError, type BackendAsset } from "./types";
import { assertCharacterVideoProductionDescriptor } from "./production-video-descriptor";

type GenerateInput = Parameters<VideoModel["generate"]>[0];
type GenerateResult = Awaited<ReturnType<VideoModel["generate"]>>;
type ReferenceImages = NonNullable<VideoGeneratePayload["referenceImages"]>;
const PRODUCTION_DURATION_TOLERANCE_SECONDS = 0.25;
const PRODUCTION_FPS_TOLERANCE = 0.05;

export class BackendVideoModel implements VideoModel {
  constructor(
    private readonly registry: BackendRegistry | Promise<BackendRegistry>,
  ) {}

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const modelId = input.model ?? env.PIPELINE_VIDEO_MODEL_DEFAULT;
    let resolved: ReturnType<BackendRegistry["resolveForModel"]>;
    try {
      const registry = await this.registry;
      resolved = registry.resolveForModel(modelId);
    } catch (error) {
      return failure("unknown_model", error, false);
    }

    const { backend, descriptor } = resolved;
    const descriptorError = validateProductionVideoDescriptor(descriptor);
    if (descriptorError) {
      return failure("unsupported_video_workflow", descriptorError, false);
    }
    const workflowPinError = validateWorkflowPin(descriptor, input.controls);
    if (workflowPinError) {
      return failure("workflow_version_mismatch", workflowPinError, false);
    }
    const referenceError = validateVideoReferences(
      descriptor,
      input.referenceImages ?? [],
    );
    if (referenceError) {
      return failure("unsupported_video_workflow", referenceError, false);
    }
    if (input.seconds !== characterVideoProductionRecipe.durationSeconds) {
      return failure(
        "unsupported_video_duration",
        "LTX 2.3 production video generation requires exactly four seconds",
        false,
      );
    }

    const width = numericControl(input.controls, "width");
    const height = numericControl(input.controls, "height");
    const requestedFps = numericControl(input.controls, "fps");
    if (
      width !== characterVideoProductionRecipe.width ||
      height !== characterVideoProductionRecipe.height ||
      (
        requestedFps !== undefined &&
        requestedFps !== characterVideoProductionRecipe.fps
      )
    ) {
      return failure(
        "unsupported_video_envelope",
        "LTX 2.3 production video generation requires 768x1152 at 25fps",
        false,
      );
    }
    const seconds = characterVideoProductionRecipe.durationSeconds;
    const fps = characterVideoProductionRecipe.fps;
    const seed =
      stableNumericSeed(input.seed ?? input.requestId ?? "video") ?? 0;
    const slots: SlotValues = {
      prompt: input.prompt,
      negative: input.negativePrompt ?? "",
      width,
      height,
      seconds,
      fps,
      seed,
      refinerSeed: seed + 1,
    };
    let providerRequestId: string | null = null;
    try {
      const handle = await backend.submit({
        descriptor,
        slots,
        referenceImages: input.referenceImages,
        requestId: input.requestId,
        timeoutMs: env.VIDEO_TIMEOUT_MS,
      });
      providerRequestId = handle.id;
      const result = await backend.poll(handle);
      const asset = result.assets.find(
        (candidate) => candidate.contentType === "video/mp4",
      );
      if (!asset) {
        return failure(
          "invalid_video_output",
          `Workflow ${descriptor.workflowKey} completed without an MP4 asset`,
          false,
          providerRequestId,
        );
      }
      const mediaError = validateProductionVideoOutput(asset, descriptor);
      if (mediaError) {
        return failure(
          "invalid_video_output",
          mediaError,
          false,
          providerRequestId,
          "definitive",
        );
      }
      return {
        ok: true,
        data: {
          asset: {
            key: `backend/videos/${providerRequestId}.mp4`,
            seconds: asset.verifiedVideo!.durationSeconds,
            contentType: "video/mp4",
            body: asset.body,
          },
        },
        invocation: invocation(providerRequestId),
      };
    } catch (error) {
      const classified = backendFailure(
        error,
        providerRequestId === null ? "pre_submit" : "post_submit",
      );
      return failure(
        classified.code,
        classified.message,
        classified.outcome === "ambiguous" ||
          classified.phase === "pre_submit",
        providerRequestId,
        classified.outcome,
      );
    }
  }
}

function validateProductionVideoOutput(
  asset: BackendAsset,
  descriptor: ReturnType<BackendRegistry["resolveForModel"]>["descriptor"],
) {
  const media = asset.verifiedVideo;
  if (!media) {
    return "ComfyUI video output has no verified decode metadata";
  }
  if (
    media.width !== characterVideoProductionRecipe.width ||
    media.height !== characterVideoProductionRecipe.height
  ) {
    return `Decoded video is ${media.width}x${media.height}; expected ${characterVideoProductionRecipe.width}x${characterVideoProductionRecipe.height}`;
  }
  if (
    Math.abs(
      media.durationSeconds - characterVideoProductionRecipe.durationSeconds,
    ) > PRODUCTION_DURATION_TOLERANCE_SECONDS
  ) {
    return `Decoded video duration is ${media.durationSeconds}s; expected approximately ${characterVideoProductionRecipe.durationSeconds}s`;
  }
  if (
    Math.abs(media.framesPerSecond - characterVideoProductionRecipe.fps) >
      PRODUCTION_FPS_TOLERANCE
  ) {
    return `Decoded video frame rate is ${media.framesPerSecond}fps; expected ${characterVideoProductionRecipe.fps}fps`;
  }
  if (descriptor.capabilities.includes("audio") && !media.hasAudio) {
    return "Decoded video has no audio stream required by the production recipe";
  }
  return null;
}

function backendFailure(
  error: unknown,
  fallbackPhase: "pre_submit" | "post_submit",
) {
  if (error instanceof BackendInvocationError) return error;
  return new BackendInvocationError(
    error instanceof Error && /timed out/i.test(error.message)
      ? "timeout"
      : "backend_error",
    error instanceof Error ? error.message : String(error),
    fallbackPhase,
    fallbackPhase === "post_submit" ? "ambiguous" : "definitive",
  );
}

function validateProductionVideoDescriptor(
  descriptor: ReturnType<BackendRegistry["resolveForModel"]>["descriptor"],
) {
  try {
    assertCharacterVideoProductionDescriptor(descriptor);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validateVideoReferences(
  descriptor: ReturnType<BackendRegistry["resolveForModel"]>["descriptor"],
  references: ReferenceImages,
) {
  if (!descriptor.capabilities.includes("video")) {
    return `Workflow ${descriptor.workflowKey} does not declare video capability`;
  }
  const slotAuthority = assignWorkflowReferenceSlots(
    descriptor,
    references.map((reference) => reference.role),
  );
  if (!slotAuthority.ok) {
    return `Workflow ${descriptor.workflowKey} cannot bind the requested source image`;
  }
  if (
    references.length !== 1 ||
    references[0]?.role !== "source_image"
  ) {
    return `Workflow ${descriptor.workflowKey} requires exactly one source_image`;
  }
  return null;
}

function numericControl(
  controls: Record<string, unknown> | undefined,
  key: string,
) {
  const value = controls?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

function invocation(providerRequestId: string | null) {
  return {
    providerRequestId,
    usage: {
      providerRequestIds: providerRequestId ? [providerRequestId] : [],
    },
    costMicros: null,
    pricingVersion: null,
  };
}

function failure(
  code: string,
  error: unknown,
  retryable: boolean,
  providerRequestId: string | null = null,
  outcome?: "definitive" | "ambiguous",
): GenerateResult {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable,
      ...(outcome ? { outcome } : {}),
    },
    ...(providerRequestId
      ? { invocation: invocation(providerRequestId) }
      : {}),
  };
}
