// SPEC: Image/video generation validates the shared payload, records provider
//   transport evidence, persists one durable terminal record, then waits for
//   durable relay admission. A retry replays the record into that relay first.
// INTENT: gen has NO DB authority. Blob persistence is the durable hand-off;
//   Main alone projects succeeded/failed/blocked/unknown outcomes into product
//   state. Every image use case, including Character Preview, shares this path.
// INVARIANTS:
//   - persist terminal record before attempting durable relay admission
//   - persisted terminal record is relayed before moderation/provider invocation
//   - only provider-declared deterministic replay may retry provider invocation
import {
  imageGeneratePayloadSchema,
  type ImageGeneratePayload,
  videoGeneratePayloadSchema,
  type VideoGeneratePayload,
} from "@idream/shared/contracts";
import { env } from "./env";
import {
  assertGeneratedImageSanity,
  GeneratedImageSanityError,
  type GeneratedImageSanityEvidence,
} from "@idream/shared/media/generated-image-sanity";
import {
  type GenProviders,
  providers as defaultProviders,
} from "./providers";
import {
  GenerationArtifactError,
  GenerationExecution,
  type GenerationExecutionPorts,
} from "./generation-execution";
import { hydratedImageReferenceInputs } from "./reference-images";

type AttemptDeps = {
  attemptsMade?: number;
  maxAttempts?: number;
};

export interface PipelineDeps extends AttemptDeps, GenerationExecutionPorts {
  providers?: GenProviders;
}

class GeneratedAssetBodyMissingError extends Error {
  readonly code = "asset_body_missing";

  constructor(message: string) {
    super(message);
    this.name = "GeneratedAssetBodyMissingError";
  }
}

function generatedImageQuality(
  evidence: GeneratedImageSanityEvidence,
) {
  return {
    schemaVersion: "1" as const,
    evaluatorVersion: evidence.evaluatorVersion,
    artifact: {
      status: "unscored" as const,
      reason: "artifact_evaluator_unavailable",
    },
    faceCount: {
      status: "unscored" as const,
      reason: "evaluator_unavailable",
    },
    identity: {
      status: "unscored" as const,
      reason: "evaluator_unavailable",
    },
    intent: {
      status: "unscored" as const,
      reason: "evaluator_unavailable",
    },
    sanity: evidence.sanity,
    composition: evidence.composition,
  };
}

export async function processImageGenerate(
  rawPayload: unknown,
  deps: PipelineDeps,
): Promise<void> {
  const payload = imageGeneratePayloadSchema.parse(rawPayload);
  const providers = deps.providers ?? defaultProviders;
  const execution = new GenerationExecution({
    payload,
    provider: payload.provider,
    blob: providers.blob,
    attemptsMade: deps.attemptsMade,
    maxAttempts: deps.maxAttempts,
    acknowledgeTerminalRecord: deps.acknowledgeTerminalRecord,
    recordTransportExecution: deps.recordTransportExecution,
  });
  if (await execution.resumeTerminalRecord()) return;
  assertWorkerAdapterMatchesRecordedProvider(payload.provider, env.IMAGE_PROVIDER, "image");

  const inputModeration = await providers.moderation.check({
    targetType: "text",
    content: `${payload.prompt} ${payload.negativePrompt ?? ""}`,
  });
  if (!inputModeration.ok) {
    // INTENT: moderation infrastructure failure is not a provider outcome.
    // Let Bull retry the pre-provider phase; emitting a provider terminal fact
    // here would fabricate transport/usage authority.
    throw new Error(
      `Input moderation failed (${inputModeration.error.code}): ${inputModeration.error.message}`,
    );
  }
  if (inputModeration.data.status === "blocked") {
    await execution.block(
      inputModeration.data.policyCode ?? "PROHIBITED_OTHER",
      "Input moderation blocked the generation request",
      "input",
    );
    return;
  }

  const referenceImages = await hydratedImageReferenceInputs(
    payload.referenceImages,
    providers.blob,
  );
  const imageModel = providers.image;
  await execution.execute({
    model: imageModel,
    invoke: ({ providerIdempotencyKey }) => imageModel.generate({
      prompt: payload.prompt,
      count: payload.count,
      seed: payload.seed,
      negativePrompt: payload.negativePrompt,
      model: payload.model,
      controls: payload.controls,
      requestId: providerIdempotencyKey,
      orientation: payload.orientation,
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
    }),
    normalizeArtifacts: async (output) => {
      if (output.assets.length === 0) {
        throw new GenerationArtifactError(
          "empty_provider_result",
          "Image provider returned no assets",
          false,
        );
      }
      const createdKeys: string[] = [];
      try {
        // Validate every provider artifact before creating any blob. Persist
        // sequentially so a later failure has a complete, race-free list of
        // objects owned by this invocation and can roll them back exactly.
        const normalized = await Promise.all(output.assets.map(async (asset, index) => {
          const hasProviderMedia = Boolean(asset.body || asset.sourceUrl);
          const contentType = hasProviderMedia
            ? (asset.contentType ?? "image/webp")
            : "image/png";
          const key = generatedAssetStorageKey(
            payload.outputPrefix,
            `image-${index + 1}`,
            contentType,
            ".png",
          );
          const body = await imageAssetBody(asset);
          const sanityEvidence = assertGeneratedImageSanity(
            Buffer.from(body),
            `${payload.generationJobId} asset ${index + 1}`,
            {
              singleContinuousFrame:
                payload.controls.compositionRequirement ===
                "single_subject_single_frame",
            },
          );
          return { asset, body, contentType, index, key, sanityEvidence };
        }));
        const assets = [];
        for (const item of normalized) {
          const persisted = await providers.blob.putPrivateIfAbsent({
            key: item.key,
            body: item.body,
            contentType: item.contentType,
          });
          if (!persisted.ok) throw new Error(persisted.error.message);
          if (persisted.data.created) createdKeys.push(item.key);
          assets.push({
            ordinal: item.index,
            key: item.key,
            width: item.asset.width,
            height: item.asset.height,
            contentType: item.contentType,
            providerKey: item.asset.key ?? null,
            quality: generatedImageQuality(item.sanityEvidence),
          });
        }
        return {
          assets,
          usage: { gpuSeconds: assets.length * 1.2, model: payload.model },
        };
      } catch (error) {
        await Promise.allSettled(
          createdKeys.map((key) => providers.blob.delete({ key })),
        );
        throw new GenerationArtifactError(
          error instanceof GeneratedImageSanityError ||
            error instanceof GeneratedAssetBodyMissingError
            ? error.code
            : "asset_persist_failed",
          error instanceof Error
            ? error.message
            : "Generated asset persistence failed",
          true,
        );
      }
    },
  });
}

async function imageAssetBody(
  asset: { body?: Uint8Array; sourceUrl?: string },
) {
  if (asset.body) return asset.body;
  if (!asset.sourceUrl) {
    throw new GeneratedAssetBodyMissingError(
      "Generated image asset has neither bytes nor a source URL",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PIPELINE_TIMEOUT_MS);
  try {
    const response = await fetch(asset.sourceUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Generated asset fetch failed with status ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Generated asset fetch timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function processVideoGenerate(
  rawPayload: unknown,
  deps: PipelineDeps,
): Promise<void> {
  const payload = videoGeneratePayloadSchema.parse(rawPayload);
  const providers = deps.providers ?? defaultProviders;
  const execution = new GenerationExecution({
    payload,
    provider: payload.provider,
    blob: providers.blob,
    attemptsMade: deps.attemptsMade,
    maxAttempts: deps.maxAttempts,
    acknowledgeTerminalRecord: deps.acknowledgeTerminalRecord,
    recordTransportExecution: deps.recordTransportExecution,
  });
  if (await execution.resumeTerminalRecord()) return;
  assertWorkerAdapterMatchesRecordedProvider(payload.provider, env.VIDEO_PROVIDER, "video");

  const inputModeration = await providers.moderation.check({
    targetType: "text",
    content: `${payload.prompt} ${payload.negativePrompt ?? ""}`,
  });
  if (!inputModeration.ok) {
    throw new Error(
      `Input moderation failed (${inputModeration.error.code}): ${inputModeration.error.message}`,
    );
  }
  if (inputModeration.data.status === "blocked") {
    await execution.block(
      inputModeration.data.policyCode ?? "PROHIBITED_OTHER",
      "Input moderation blocked the generation request",
      "input",
    );
    return;
  }

  const referenceImages = await hydratedImageReferenceInputs(
    payload.referenceImages,
    providers.blob,
  );
  const videoModel = providers.video;
  await execution.execute({
    model: videoModel,
    invoke: ({ providerIdempotencyKey }) => videoModel.generate({
      prompt: payload.prompt,
      seconds: payload.seconds,
      seed: payload.seed,
      negativePrompt: payload.negativePrompt,
      model: payload.model,
      controls: payload.controls,
      requestId: providerIdempotencyKey,
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
    }),
    normalizeArtifacts: async (output) => {
      const contentType = output.asset.contentType ?? "video/mp4";
      const assetKey = generatedAssetStorageKey(
        payload.outputPrefix,
        "video",
        contentType,
        ".mp4",
      );
      // Same persistence transaction as the image path: create-if-absent, so a
      // duplicate delivery of this attempt cannot overwrite bytes an earlier
      // invocation already published under the same key. No rollback branch
      // here — unlike images this writes exactly one object, so there is never
      // a partially-created set to undo.
      try {
        const persisted = await providers.blob.putPrivateIfAbsent({
          key: assetKey,
          body: await videoAssetBody(output.asset, payload.generationJobId),
          contentType,
        });
        if (!persisted.ok) throw new Error(persisted.error.message);
      } catch (error) {
        throw new GenerationArtifactError(
          "asset_persist_failed",
          error instanceof Error
            ? error.message
            : "Generated asset persistence failed",
          true,
        );
      }
      return {
        assets: [{
          ordinal: 0,
          key: assetKey,
          seconds: output.asset.seconds,
          contentType,
          providerKey: output.asset.key ?? null,
        }],
        usage: { gpuSeconds: payload.seconds * 2, model: payload.model },
      };
    },
  });
}

// SPEC: deployment self-check, NOT backend selection. `payload.provider` is
// Main's `GenerationModelProfile.runner` copied onto the Attempt — an accounting
// field that ends up verbatim in the terminal record. It never chooses an
// execution body: the backend is decided by
// `registry.resolveForModel(payload.model).descriptor.backendKind`, admitted by
// the workflowKey@workflowVersion pin (backend/registry.ts validateWorkflowPin).
// INTENT: this only asserts the worker's own GEN_*_PROVIDER adapter is the one
// Main assumed when it recorded that runner — i.e. a `mock`-provisioned attempt
// cannot land on a real-backend worker and vice versa. The two vocabularies are
// deliberately many-to-one (Main's runner names ⇒ gen's adapter names), so
// matching here proves nothing about which backend actually runs.
function assertWorkerAdapterMatchesRecordedProvider(
  recordedProvider: string,
  configuredAdapter: string,
  mode: "image" | "video",
) {
  const requiredAdapter = providerAdapterForPinnedAuthority(recordedProvider);
  if (requiredAdapter !== configuredAdapter) {
    throw new Error(
      `Pinned ${mode} provider ${recordedProvider} requires GEN_${mode.toUpperCase()}_PROVIDER=${requiredAdapter}; configured=${configuredAdapter}`,
    );
  }
}

// SPEC: Main runner name -> gen adapter name. Many-to-one by construction.
// INTENT: `sd_cpp` still maps to `backend` even though gen no longer has an
// sd.cpp backend, because it is the `GenerationModelProfile.runner` DB default
// and public text-to-image selection still admits such profiles. Fail-closing it
// here would take out any live profile still carrying the default; the correct
// fix is main-side (retire the runner value / change the column default), not a
// worker-side reject. Whatever the runner says, the descriptor decides.
export function providerAdapterForPinnedAuthority(provider: string) {
  switch (provider) {
    case "mock":
    case "backend":
    case "pipeline":
      return provider;
    case "comfyui":
    case "sd_cpp":
      return "backend";
    case "mlx":
    case "external":
      return "pipeline";
    default:
      throw new Error(`Unsupported pinned generation provider: ${provider}`);
  }
}

async function videoAssetBody(
  asset: { body?: Uint8Array; sourceUrl?: string },
  generationJobId: string,
) {
  if (asset.body) return asset.body;
  if (!asset.sourceUrl) {
    throw new Error(
      `Generated video ${generationJobId} did not include video bytes or a source URL`,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PIPELINE_TIMEOUT_MS);
  try {
    const response = await fetch(asset.sourceUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Generated video fetch failed with status ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Generated video fetch timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function mediaFileExtension(contentType: string | undefined) {
  const extensions: Record<string, string> = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  return contentType ? (extensions[contentType] ?? "") : "";
}

function generatedAssetStorageKey(
  outputPrefix: string,
  name: string,
  contentType: string | undefined,
  fallbackExtension: string,
) {
  return `${outputPrefix}${name}${mediaFileExtension(contentType) || fallbackExtension}`;
}
