import type { VideoGeneratePayload } from "@idream/shared/contracts";
import { env } from "../env";
import {
  stableNumericSeed,
  type VideoModel,
} from "../providers";
import { assignWorkflowReferenceSlots, type SlotValues } from "./workflow";
import type { BackendRegistry } from "./registry";

type GenerateInput = Parameters<VideoModel["generate"]>[0];
type GenerateResult = Awaited<ReturnType<VideoModel["generate"]>>;
type ReferenceImages = NonNullable<VideoGeneratePayload["referenceImages"]>;

export class BackendVideoModel implements VideoModel {
  readonly retryCapabilities = {
    deterministicIdempotencyKey: true,
    retryableFailureCodes: [
      "rate_limited",
      "overloaded",
      "timeout",
      "internal",
      "backend_error",
    ],
  } as const;

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
    if (input.seconds !== 4) {
      return failure(
        "unsupported_video_duration",
        "LTX 2.3 production video generation requires exactly four seconds",
        false,
      );
    }

    const width = numericControl(input.controls, "width") ?? 768;
    const height = numericControl(input.controls, "height") ?? 1152;
    const seconds = 4;
    const fps = numericControl(input.controls, "fps") ?? 25;
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
      return {
        ok: true,
        data: {
          asset: {
            key: `backend/videos/${providerRequestId}.mp4`,
            seconds,
            contentType: "video/mp4",
            body: asset.body,
          },
        },
        invocation: invocation(providerRequestId),
      };
    } catch (error) {
      return failure(
        error instanceof Error && /timed out/i.test(error.message)
          ? "timeout"
          : "backend_error",
        error,
        true,
        providerRequestId,
      );
    }
  }
}

function validateWorkflowPin(
  descriptor: ReturnType<BackendRegistry["resolveForModel"]>["descriptor"],
  controls: GenerateInput["controls"],
) {
  const workflowKey = controls?.workflowKey;
  const workflowVersion = controls?.workflowVersion;
  if (workflowKey === undefined && workflowVersion === undefined) return null;
  if (
    workflowKey !== descriptor.workflowKey ||
    workflowVersion !== descriptor.version
  ) {
    return `Pinned workflow ${String(workflowKey)}@${String(workflowVersion)} does not match worker descriptor ${descriptor.workflowKey}@${descriptor.version}`;
  }
  return null;
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
): GenerateResult {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable,
    },
    ...(providerRequestId
      ? { invocation: invocation(providerRequestId) }
      : {}),
  };
}
