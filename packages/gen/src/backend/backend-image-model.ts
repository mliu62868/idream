// SPEC: BackendImageModel — ImageModel adapter over the workflow-native GenBackend
// contract (Task 1-4). Resolves a model id to {backend, descriptor} via the
// registry, then drives one submit/poll round-trip per requested image.
// INTENT: Bridge point between the new local-backend abstraction and the existing
// ImageModel envelope providers.ts/pipeline.ts already depend on — batching
// (count>1) is handled here by looping with an incremented seed rather than
// teaching GenBackend implementations about batch semantics.
// INVARIANTS:
//  - Unknown model id (registry.resolveForModel throws) -> {ok:false, code:
//    "unknown_model", retryable:false} — this is a caller/config error, not transient.
//  - Any other thrown error during submit/poll -> {ok:false, code:"backend_error",
//    retryable:true} — network hiccups / process failures are treated as transient.
//  - orientation maps to a default {width,height}; explicit numeric width/height in
//    controls always win; orientation undefined/null omits width/height entirely so
//    the workflow descriptor's own declared slot defaults apply instead.
//  - seed mirrors main's actual wire contract (packages/main service.ts:
//    `seed: job.seed ?? job.id`, where job.id is a non-numeric random string) — a
//    non-numeric seed is FNV-hashed via providers.ts's stableNumericSeed rather than
//    coerced to 0, so concurrent jobs don't collide on the same numeric seed.
import { env } from "../env";
import { logger } from "../logger";
import { stableNumericSeed, type ImageModel } from "../providers";
import {
  assignWorkflowReferenceSlots,
  type SlotValues,
} from "./workflow";
import type { BackendRegistry } from "./registry";
import { BackendInvocationError } from "./types";

type GenerateInput = Parameters<ImageModel["generate"]>[0];
type GenerateResult = Awaited<ReturnType<ImageModel["generate"]>>;
type SuccessData = Extract<GenerateResult, { ok: true }>["data"];
type ImageAsset = SuccessData["assets"][number];

// SPEC: orientation -> default pixel size. Wire vocabulary mirrors main's actual
// contract (packages/main/src/server/modules/ourdream/generation-dimensions.ts:
// imageOrientations = ["1:1","4:5","3:4","9:16","16:9"], wire default "4:5") and its
// dimensionsForImageOrientation math: base = the shorter side, the other side is
// snapDimension(base * aspectRatio) — snapped to the nearest multiple of 64 (min 64).
// gen cannot import packages/main, so that math is duplicated below (keep both in
// sync). BASE=832 is the short side the legacy orientationToOpenAiSize/
// orientationToSize mapping used for "portrait", chosen here too so the new wire
// aspect strings land in the same dimensional neighborhood as those pre-existing
// values rather than introducing an unrelated second scale.
// INTENT: "portrait"/"landscape"/"square" are the OLD (pre-wire-contract) values —
// kept byte-for-byte so any caller still using them doesn't see a behavior shift.
// An unrecognized non-empty orientation is logged once (config drift, not a crash)
// and treated as the wire default "4:5". orientation undefined/null/"" returns
// undefined so resolveSize() can omit width/height and let the workflow
// descriptor's own declared slot defaults apply.
const ORIENTATION_BASE = 832;

let warnedUnknownOrientation = false;

export function orientationToSize(
  orientation?: string | null,
): { width: number; height: number } | undefined {
  if (orientation === undefined || orientation === null || orientation === "") return undefined;
  switch (orientation) {
    case "portrait":
      return { width: 832, height: 1216 };
    case "landscape":
      return { width: 1216, height: 832 };
    case "square":
      return { width: 1024, height: 1024 };
    case "1:1":
    case "4:5":
    case "3:4":
    case "9:16":
    case "16:9":
      return dimensionsForOrientation(orientation);
    default:
      if (!warnedUnknownOrientation) {
        warnedUnknownOrientation = true;
        logger.warn({ orientation }, "unknown image orientation, falling back to wire default 4:5");
      }
      return dimensionsForOrientation("4:5");
  }
}

// Mirrors generation-dimensions.ts's dimensionsForImageOrientation switch (minus the
// normalizeImageOrientation step, since callers here only ever pass one of the 5
// known aspect strings or the "4:5" fallback).
function dimensionsForOrientation(orientation: string): { width: number; height: number } {
  const base = ORIENTATION_BASE;
  switch (orientation) {
    case "16:9":
      return { width: snapDimension((base * 16) / 9), height: base };
    case "9:16":
      return { width: base, height: snapDimension((base * 16) / 9) };
    case "4:5":
      return { width: base, height: snapDimension((base * 5) / 4) };
    case "3:4":
      return { width: base, height: snapDimension((base * 4) / 3) };
    case "1:1":
    default:
      return { width: base, height: base };
  }
}

// Mirrors generation-dimensions.ts's snapDimension exactly (duplicated for the same
// cross-package reason as above — keep both in sync).
function snapDimension(value: number): number {
  const snapped = Math.round(value / 64) * 64;
  return Math.max(64, snapped);
}

export class BackendImageModel implements ImageModel {
  constructor(private readonly registry: BackendRegistry | Promise<BackendRegistry>) {}

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const modelId = input.model ?? env.PIPELINE_IMAGE_MODEL_DEFAULT;
    let resolved: ReturnType<BackendRegistry["resolveForModel"]>;
    try {
      const registry = await this.registry;
      resolved = registry.resolveForModel(modelId);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "unknown_model",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
    }

    const { backend, descriptor } = resolved;
    const workflowPinError = validateWorkflowPin(descriptor, input.controls);
    if (workflowPinError) {
      return {
        ok: false,
        error: {
          code: "workflow_version_mismatch",
          message: workflowPinError,
          retryable: false,
        },
      };
    }
    const referenceContractError = validateReferenceContract(
      descriptor,
      input.referenceImages ?? [],
    );
    if (referenceContractError) {
      return {
        ok: false,
        error: {
          code: "unsupported_identity_workflow",
          message: referenceContractError,
          retryable: false,
        },
      };
    }
    const size = resolveSize(input);
    const baseSeed = numericSeed(input.seed, input.requestId);
    const count = Math.max(1, Math.min(input.count, 4));
    const stepsOverride = numericControl(input.controls, "steps");

    const providerRequestIds: string[] = [];
    let failurePhase: "pre_submit" | "post_submit" = "pre_submit";
    try {
      const assets: ImageAsset[] = [];
      for (let index = 0; index < count; index += 1) {
        failurePhase = "pre_submit";
        const slots: SlotValues = {
          prompt: input.prompt,
          negative: input.negativePrompt ?? "",
          ...(size.width !== undefined ? { width: size.width } : {}),
          ...(size.height !== undefined ? { height: size.height } : {}),
          seed: baseSeed + index,
          ...(stepsOverride !== undefined ? { steps: stepsOverride } : {}),
        };
        const handle = await backend.submit({
          descriptor,
          slots,
          referenceImages: input.referenceImages,
          requestId: input.requestId,
          timeoutMs: env.PIPELINE_TIMEOUT_MS,
        });
        providerRequestIds.push(handle.id);
        failurePhase = "post_submit";
        const result = await backend.poll(handle);
        for (const asset of result.assets) {
          assets.push({
            width: asset.width,
            height: asset.height,
            contentType: asset.contentType,
            body: asset.body,
          });
        }
      }
      return {
        ok: true,
        data: { assets },
        invocation: {
          providerRequestId: providerRequestIds[0] ?? null,
          usage: { providerRequestIds },
          costMicros: null,
          pricingVersion: null,
        },
      };
    } catch (error) {
      const failure = backendFailure(error, failurePhase);
      return {
        ok: false,
        error: {
          code: failure.code,
          message: failure.message,
          retryable:
            failure.outcome === "ambiguous" ||
            failure.phase === "pre_submit",
          outcome: failure.outcome,
        },
        invocation: {
          providerRequestId: providerRequestIds[0] ?? null,
          usage: { providerRequestIds },
          costMicros: null,
          pricingVersion: null,
        },
      };
    }
  }
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

function validateReferenceContract(
  descriptor: ReturnType<BackendRegistry["resolveForModel"]>["descriptor"],
  images: NonNullable<GenerateInput["referenceImages"]>,
) {
  const identityImages = images.filter((image) => image.role !== "source_image");
  const sourceImages = images.filter((image) => image.role === "source_image");
  const lookImages = images.filter((image) => image.role === "look_reference");
  const contract = descriptor.identity;
  if (images.length > 0 && contract.mode === "none") {
    return `Workflow ${descriptor.workflowKey} does not accept reference images`;
  }
  if (
    lookImages.length > 0 &&
    !contract.supportsLookReference
  ) {
    return `Workflow ${descriptor.workflowKey} does not accept Character Look image references`;
  }
  if (
    identityImages.length > 0 &&
    sourceImages.length > 0 &&
    !contract.supportsSourceImageWithIdentity
  ) {
    return `Workflow ${descriptor.workflowKey} cannot combine a source image with identity references`;
  }
  const slotAuthority = assignWorkflowReferenceSlots(
    descriptor,
    images.map((image) => image.role),
  );
  if (!slotAuthority.ok) {
    if (slotAuthority.reason === "reference_cardinality_mismatch") {
      return `Workflow ${descriptor.workflowKey} requires ${slotAuthority.minReferences}-${slotAuthority.maxReferences} semantic image references`;
    }
    if (slotAuthority.reason === "reference_role_unsupported") {
      return `Workflow ${descriptor.workflowKey} does not accept one or more reference roles`;
    }
    return `Workflow ${descriptor.workflowKey} cannot assign the requested roles to semantic image slots`;
  }
  return null;
}

function resolveSize(input: GenerateInput): { width?: number; height?: number } {
  const orientationSize = orientationToSize(input.orientation);
  const width = numericControl(input.controls, "width") ?? orientationSize?.width;
  const height = numericControl(input.controls, "height") ?? orientationSize?.height;
  return { width, height };
}

// SPEC: mirrors main's actual wire contract — job.seed is `job.seed ?? job.id` where
// job.id is a non-numeric random string (packages/main service.ts), so "seed" is
// usually NOT parseable as a number. A finite-integer seed is used verbatim; a
// non-empty non-numeric seed is FNV-hashed via providers.ts's stableNumericSeed (the
// same hashing the old pipeline provider used) so distinct seeds land on distinct
// numeric seeds instead of every job colliding at 0. Falls back to hashing requestId
// (or the literal "gen") when no seed at all is supplied.
function numericSeed(seed: string | undefined, requestId: string | undefined): number {
  if (seed !== undefined && seed !== "") {
    const parsed = Number(seed);
    if (Number.isInteger(parsed)) return parsed;
    return stableNumericSeed(seed) ?? 0;
  }
  return stableNumericSeed(requestId ?? "gen") ?? 0;
}

function numericControl(controls: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = controls?.[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
