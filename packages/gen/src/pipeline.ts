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
  videoGeneratePayloadSchema,
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
  runGeneration,
  type GenerationExecutionPorts,
} from "./generation-execution";
import { hydratedImageReferenceInputs } from "./reference-images";
import { enhancedImageDimensions, prepareImageEnhancement } from "./image-enhancement";

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
  const imageModel = providers.image;
  await runGeneration(payload, {
    mode: "image",
    configuredAdapter: env.IMAGE_PROVIDER,
    model: imageModel,
    // Enhance replaces the reference set with its own pinned source, so it has
    // to resolve before the provider call and travel with it.
    prepare: async ({ referenceImages }) => {
      const enhancement = await prepareImageEnhancement(payload, referenceImages);
      return {
        enhancement,
        referenceImages: enhancement ? [enhancement.reference] : referenceImages,
      };
    },
    invoke: ({ prepared, providerIdempotencyKey, executionBoundary }) => imageModel.generate({
      executionBoundary,
      prompt: payload.prompt,
      count: payload.count,
      seed: payload.seed,
      negativePrompt: payload.negativePrompt,
      model: payload.model,
      controls: payload.controls,
      requestId: providerIdempotencyKey,
      orientation: payload.orientation,
      ...(prepared.referenceImages.length > 0 ? { referenceImages: prepared.referenceImages } : {}),
    }),
    normalizeArtifacts: async ({ prepared, output }) => {
      const enhancement = prepared.enhancement;
      if (enhancement && output.assets.length !== 1) {
        throw new GenerationArtifactError("enhancement_output_invalid", "Enhance must return exactly one image", false);
      }
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
          let contentType = hasProviderMedia
            ? (asset.contentType ?? "image/webp")
            : "image/png";
          const body = await imageAssetBody(asset);
          const dimensions = enhancement ? await enhancedImageDimensions(body, enhancement.pin) : null;
          if (dimensions) contentType = dimensions.contentType;
          const key = generatedAssetStorageKey(payload.outputPrefix, `image-${index + 1}`, contentType, ".png");
          const sanityEvidence = assertGeneratedImageSanity(
            Buffer.from(body),
            `${payload.generationJobId} asset ${index + 1}`,
            {
              singleContinuousFrame:
                payload.controls.compositionRequirement ===
                "single_subject_single_frame",
            },
          );
          return { asset, body, contentType, index, key, sanityEvidence, dimensions };
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
            width: item.dimensions?.width ?? item.asset.width,
            height: item.dimensions?.height ?? item.asset.height,
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
        if (error instanceof GenerationArtifactError) throw error;
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
  }, {
    blob: providers.blob,
    moderation: providers.moderation,
    attemptsMade: deps.attemptsMade,
    maxAttempts: deps.maxAttempts,
    acknowledgeTerminalRecord: deps.acknowledgeTerminalRecord,
    recordTransportExecution: deps.recordTransportExecution,
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
  const videoModel = providers.video;
  await runGeneration(payload, {
    mode: "video",
    configuredAdapter: env.VIDEO_PROVIDER,
    model: videoModel,
    // Video takes its references straight through; nothing modality-specific
    // happens between moderation and the provider call.
    prepare: async ({ referenceImages }) => ({ referenceImages }),
    invoke: ({ prepared, providerIdempotencyKey, executionBoundary }) => videoModel.generate({
      executionBoundary,
      prompt: payload.prompt,
      seconds: payload.seconds,
      seed: payload.seed,
      negativePrompt: payload.negativePrompt,
      model: payload.model,
      controls: payload.controls,
      requestId: providerIdempotencyKey,
      ...(prepared.referenceImages.length > 0 ? { referenceImages: prepared.referenceImages } : {}),
    }),
    normalizeArtifacts: async ({ output }) => {
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
  }, {
    blob: providers.blob,
    moderation: providers.moderation,
    attemptsMade: deps.attemptsMade,
    maxAttempts: deps.maxAttempts,
    acknowledgeTerminalRecord: deps.acknowledgeTerminalRecord,
    recordTransportExecution: deps.recordTransportExecution,
  });
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
