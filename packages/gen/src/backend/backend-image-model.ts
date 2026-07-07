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
//    controls always win.
import { env } from "../env";
import type { ImageModel } from "../providers";
import type { SlotValues } from "./workflow";
import type { BackendRegistry } from "./registry";

type GenerateInput = Parameters<ImageModel["generate"]>[0];
type GenerateResult = Awaited<ReturnType<ImageModel["generate"]>>;
type SuccessData = Extract<GenerateResult, { ok: true }>["data"];
type ImageAsset = SuccessData["assets"][number];

// SPEC: orientation -> default pixel size. Mirrors the intent of
// orientationToOpenAiSize in providers.ts but returns a {width,height} pair since
// GenBackend slots need numeric dimensions, not an OpenAI "WxH" size string.
export function orientationToSize(orientation?: string): { width: number; height: number } {
  switch (orientation) {
    case "portrait":
      return { width: 832, height: 1216 };
    case "landscape":
      return { width: 1216, height: 832 };
    case "square":
    default:
      return { width: 1024, height: 1024 };
  }
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
    const size = resolveSize(input);
    const baseSeed = numericSeed(input.seed);
    const count = Math.max(1, Math.min(input.count, 4));
    const stepsOverride = numericControl(input.controls, "steps");

    try {
      const assets: ImageAsset[] = [];
      for (let index = 0; index < count; index += 1) {
        const slots: SlotValues = {
          prompt: input.prompt,
          negative: input.negativePrompt ?? "",
          width: size.width,
          height: size.height,
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
      return { ok: true, data: { assets } };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "backend_error",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
  }
}

function resolveSize(input: GenerateInput): { width: number; height: number } {
  const orientationSize = orientationToSize(input.orientation);
  const width = numericControl(input.controls, "width") ?? orientationSize.width;
  const height = numericControl(input.controls, "height") ?? orientationSize.height;
  return { width, height };
}

function numericSeed(seed: string | undefined): number {
  if (seed === undefined) return 0;
  const parsed = Number(seed);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numericControl(controls: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = controls?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
