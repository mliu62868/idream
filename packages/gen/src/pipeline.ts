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
//   - unmeasured GPU time is absent, never inferred from output size or wall time
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
import { enhancedImageDimensions, prepareImageEnhancement } from "./image-enhancement";
import sharp from "sharp";
import { characterVideoProductionRecipeForWorkflow } from "@idream/shared";
import { redgraftVideoEnvelope, REDGRAFT_VIDEO_DEFAULTS } from "@idream/shared/contracts";
import { probeVideoMedia, type VideoMediaProbe, type VerifiedVideoMedia } from "./backend/video-media-probe";

type AttemptDeps = {
  attemptsMade?: number;
  maxAttempts?: number;
};

export interface PipelineDeps extends AttemptDeps, GenerationExecutionPorts {
  providers?: GenProviders;
  probeVideoMedia?: VideoMediaProbe;
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
      const attemptedKeys = new Set<string>();
      try {
        // Validate every provider artifact before creating any blob. Persist
        // sequentially so a later failure has a complete, race-free list of
        // objects owned by this invocation and can roll them back exactly.
        const normalized = await Promise.all(output.assets.slice(0, payload.count).map(async (asset, index) => {
          const body = await imageAssetBody(asset);
          const decoded = await decodedGeneratedImage(body);
          const dimensions = enhancement ? await enhancedImageDimensions(body, enhancement.pin) : decoded;
          if ((typeof payload.controls.width === "number" && dimensions.width !== payload.controls.width) ||
              (typeof payload.controls.height === "number" && dimensions.height !== payload.controls.height)) {
            throw new GeneratedImageSanityError("Generated image dimensions do not match the accepted dimensions");
          }
          const contentType = dimensions.contentType;
          const key = generatedAssetStorageKey(payload.outputPrefix, `image-${index + 1}`, contentType, ".png");
          const sanityEvidence = assertGeneratedImageSanity(
            decoded.sanityPng,
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
          // A failed acknowledgement cannot prove the store did not write.
          attemptedKeys.add(item.key);
          const persisted = await providers.blob.putPrivateIfAbsent({
            key: item.key,
            body: item.body,
            contentType: item.contentType,
          });
          if (!persisted.ok) throw new Error(persisted.error.message);
          if (!persisted.data.created) attemptedKeys.delete(item.key);
          assets.push({
            ordinal: item.index,
            key: item.key,
            width: item.dimensions.width,
            height: item.dimensions.height,
            contentType: item.contentType,
            providerKey: item.asset.key ?? null,
            quality: generatedImageQuality(item.sanityEvidence),
          });
        }
        return {
          assets,
          usage: {
            model: payload.model,
            ...(output.assets.length !== payload.count ? { expectedOutputs: payload.count, providerOutputs: output.assets.length, deliveredOutputs: assets.length } : {}),
          },
        };
      } catch (error) {
        const cleanupKeys = await rollbackGeneratedAssets(providers.blob, [...attemptedKeys]);
        if (error instanceof GenerationArtifactError) {
          if (!cleanupKeys.length) throw error;
          throw new GenerationArtifactError(error.code, error.message, error.retryBeforeFinalAttempt,
            [...new Set([...(error.cleanupKeys ?? []), ...cleanupKeys])]);
        }
        throw new GenerationArtifactError(
          error instanceof GeneratedImageSanityError ||
            error instanceof GeneratedAssetBodyMissingError
            ? error.code
            : "asset_persist_failed",
          error instanceof Error
            ? error.message
            : "Generated asset persistence failed",
          true,
          cleanupKeys.length ? cleanupKeys : undefined,
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

// SPEC: provider annotations cannot certify the delivered file. Decode every
// still image before persistence; use decoded pixels for all supported formats
// and preserve the provider's original bytes with their actual MIME and size.
async function decodedGeneratedImage(body: Uint8Array) {
  try {
    const image = sharp(body, { failOn: "warning", limitInputPixels: 16_777_216 });
    const metadata = await image.metadata();
    // Preserve the native PNG CRC and blankness checks before raster conversion
    // so a decoder cannot repair a corrupt file and certify the original bytes.
    assertGeneratedImageSanity(Buffer.from(body), "provider image");
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
        (metadata.pages ?? 1) !== 1) {
      throw new Error("Generated image must be one PNG, JPEG or WebP still");
    }
    const { data, info } = await image.autoOrient().flatten({ background: "white" }).toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const sanityPng = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
    return { width: info.width, height: info.height, contentType: `image/${metadata.format}`, sanityPng };
  } catch (error) {
    throw new GeneratedImageSanityError(`Generated image cannot be decoded: ${error instanceof Error ? error.message : String(error)}`);
  }
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
      // Create-if-absent protects published bytes. A lost write acknowledgement
      // still needs compensation even though video writes exactly one object.
      let media: VerifiedVideoMedia;
      const body = await videoAssetBody(output.asset, payload.generationJobId);
      try {
        if (contentType !== "video/mp4" || body.byteLength < 12 || Buffer.from(body).toString("ascii", 4, 8) !== "ftyp") {
          throw new Error("Generated video must be a nonempty MP4 container");
        }
        media = await (deps.probeVideoMedia ?? probeVideoMedia)(body);
        const recipe = characterVideoProductionRecipeForWorkflow(String(payload.controls.workflowKey ?? ""));
        const envelope = recipe && payload.controls.videoOptionsVersion !== undefined
          ? redgraftVideoEnvelope({ seconds: payload.seconds, orientation: String(payload.controls.orientation), quality: String(payload.controls.videoQuality ?? REDGRAFT_VIDEO_DEFAULTS.quality) })
          : recipe;
        if ((typeof payload.controls.width === "number" && media.width !== payload.controls.width) ||
            (typeof payload.controls.height === "number" && media.height !== payload.controls.height) ||
            Math.abs(media.durationSeconds - (envelope?.expectedDurationSeconds ?? payload.seconds)) > 0.25 ||
            (envelope && (media.width !== envelope.width || media.height !== envelope.height ||
              Math.abs(media.framesPerSecond - envelope.fps) > 0.05 || media.frameCount !== envelope.frameCount || !media.hasAudio))) {
          throw new Error("Decoded video does not match the accepted stream envelope");
        }
      } catch (error) {
        throw new GenerationArtifactError("invalid_video_output", error instanceof Error ? error.message : "Generated video cannot be decoded", false);
      }
      try {
        const persisted = await providers.blob.putPrivateIfAbsent({
          key: assetKey,
          body,
          contentType,
        });
        if (!persisted.ok) throw new Error(persisted.error.message);
      } catch (error) {
        const cleanupKeys = await rollbackGeneratedAssets(providers.blob, [assetKey]);
        throw new GenerationArtifactError(
          "asset_persist_failed",
          error instanceof Error
            ? error.message
            : "Generated asset persistence failed",
          true,
          cleanupKeys.length ? cleanupKeys : undefined,
        );
      }
      return {
        assets: [{
          ordinal: 0,
          key: assetKey,
          seconds: media.durationSeconds,
          width: media.width,
          height: media.height,
          contentType,
          providerKey: output.asset.key ?? null,
        }],
        usage: { model: payload.model },
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

async function rollbackGeneratedAssets(blob: GenProviders["blob"], keys: readonly string[]): Promise<string[]> {
  const results = await Promise.allSettled(keys.map(async (key) => {
    const result = await blob.delete({ key });
    if (!result.ok) throw new Error(result.error.message);
  }));
  return keys.filter((_, index) => results[index]!.status === "rejected");
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
