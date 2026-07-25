// SPEC: The generation pipeline. processImageGenerate / processVideoGenerate:
//   validate payload (shared zod) → call provider → write blob → enqueue
//   app.ai.finalize with a generation.completed payload. On a non-retryable
//   provider failure, enqueue generation.failed. Mirrors packages/main
//   local-pipeline.ts processImageGenerate/processVideoGenerate exactly.
// INTENT: gen has NO DB authority — it only writes the blob and hands assets +
//   usage to gen-finalizer (main-side) via app.ai.finalize. The enqueue function
//   is INJECTED so unit tests need no Redis (DI over a module singleton).
// INVARIANTS:
//   - completed finalize dedupeKey = generationFinalize(jobId, "completed")
//   - failed    finalize dedupeKey = generationFinalize(jobId, "failed")
//   - retryable provider error → throw (BullMQ retries the generate job)
//   - non-retryable error → enqueue generation.failed (terminal, refund main-side)
import {
  type AiFinalizePayload,
  characterPreviewGeneratePayloadSchema,
  type CharacterPreviewGeneratePayload,
  type GenerationManifestIngest,
  type GenerationTransportExecutionEvent,
  idempotencyKeys,
  imageGeneratePayloadSchema,
  type ImageGeneratePayload,
  MAIN_QUEUES,
  videoGeneratePayloadSchema,
  type VideoGeneratePayload,
} from "@idream/shared/contracts";
import { mockVideoMp4Bytes } from "@idream/shared";
import { env } from "./env";
import {
  assertGeneratedImageSanity,
  GeneratedImageSanityError,
  type GeneratedImageSanityEvidence,
} from "./generated-image-sanity";
import {
  type GenProviders,
  type ImageModel,
  type ProviderFailure,
  type ProviderInvocationMetadata,
  type VideoModel,
  providers as defaultProviders,
} from "./providers";
import type { EnqueueFn, JsonPayload } from "./queue";
import { hydratedImageReferenceInputs } from "./reference-images";
import { loadPersistedCompletionManifest, persistCompletionManifest } from "./completion-manifest";

export interface PipelineDeps {
  enqueue: EnqueueFn;
  providers?: GenProviders;
  attemptsMade?: number;
  maxAttempts?: number;
  acknowledgeCompletion?: (input: GenerationManifestIngest) => Promise<void>;
  recordTransportExecution?: (input: GenerationTransportExecutionEvent) => Promise<void>;
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

function asPayload(value: AiFinalizePayload): JsonPayload {
  return value as unknown as JsonPayload;
}

async function enqueueGenerationFailed(
  deps: PipelineDeps,
  payload: ImageGeneratePayload | VideoGeneratePayload,
  code: string,
  message: string,
  terminal: { attemptOutcome?: "failed" | "unknown"; retryability?: "retryable" | "not_retryable" | "operator_retry" } = {},
): Promise<void> {
  await deps.enqueue({
    queue: MAIN_QUEUES.aiFinalize,
    payload: asPayload({
      version: 1,
      kind: "generation.failed",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      attemptId: payload.attemptId,
      attemptNo: payload.attemptNo,
      mode: payload.kind,
      error: {
        code,
        message,
        retryable: false,
        attemptOutcome: terminal.attemptOutcome ?? "failed",
        retryability: terminal.retryability ?? "retryable",
      },
    }),
    dedupeKey: idempotencyKeys.generationFinalize(payload.generationJobId, "failed"),
  });
}

async function enqueueGenerationBlocked(
  deps: PipelineDeps,
  payload: ImageGeneratePayload | VideoGeneratePayload,
  policyCode: string,
  message: string,
  layer: "input" | "output" | "provider",
): Promise<void> {
  await deps.enqueue({
    queue: MAIN_QUEUES.aiFinalize,
    payload: asPayload({
      version: 1,
      kind: "generation.blocked",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      attemptId: payload.attemptId,
      attemptNo: payload.attemptNo,
      mode: payload.kind,
      policyCode,
      message,
      layer,
    }),
    dedupeKey: idempotencyKeys.generationFinalize(payload.generationJobId, "blocked"),
  });
}

function isFinalAttempt(deps: PipelineDeps) {
  const attemptsMade = deps.attemptsMade ?? 0;
  const maxAttempts = deps.maxAttempts ?? 1;
  return attemptsMade + 1 >= maxAttempts;
}

function transportIdentity(payload: ImageGeneratePayload | VideoGeneratePayload, deps: PipelineDeps) {
  const attemptId = payload.attemptId ?? `${payload.generationJobId}:1`;
  return {
    attemptId,
    attemptNo: payload.attemptNo ?? 1,
    transportAttemptNo: (deps.attemptsMade ?? 0) + 1,
    idempotencyKey: `generation:${attemptId}:provider`,
  };
}

function canAutomaticallyRetry(model: ImageModel | VideoModel, error: ProviderFailure) {
  const capabilities = model.retryCapabilities;
  return error.retryable && capabilities?.deterministicIdempotencyKey === true && capabilities.retryableFailureCodes.includes(error.code);
}

async function recordTransport(
  deps: PipelineDeps,
  payload: ImageGeneratePayload | VideoGeneratePayload,
  provider: string,
  status: "running" | "failed" | "unknown",
  error: { code: string; message: string } | null = null,
  accounting?: ReturnType<typeof invocationAccounting>,
  providerRequestId: string | null = null,
) {
  if (!deps.recordTransportExecution) return;
  const identity = transportIdentity(payload, deps);
  await deps.recordTransportExecution({
    version: 1,
    ...identity,
    generationJobId: payload.generationJobId,
    provider,
    model: payload.model ?? provider,
    providerRequestId,
    status,
    occurredAt: new Date().toISOString(),
    error,
    ...(accounting ? { accounting } : {}),
  });
}

function invocationAccounting(
  invocation: ProviderInvocationMetadata | undefined,
  latencyMs: number,
  fallbackUsage: Readonly<Record<string, unknown>> = {},
) {
  const pricingVersion = invocation?.pricingVersion?.trim() || null;
  const providerCost = invocation?.costMicros;
  const costMicros = pricingVersion !== null && Number.isSafeInteger(providerCost) && (providerCost ?? -1) >= 0
    ? providerCost ?? null
    : null;
  return {
    usage: { ...(invocation?.usage ?? fallbackUsage) },
    latencyMs: Math.max(0, Math.round(latencyMs)),
    costMicros,
    pricingVersion,
  };
}

export async function processImageGenerate(
  rawPayload: unknown,
  deps: PipelineDeps,
): Promise<void> {
  const payload = imageGeneratePayloadSchema.parse(rawPayload);
  const providers = deps.providers ?? defaultProviders;
  if (await resumePersistedCompletion(payload, providers, deps)) return;
  const inputModeration = await providers.moderation.check({
    targetType: "text",
    content: `${payload.prompt} ${payload.negativePrompt ?? ""}`,
  });
  if (!inputModeration.ok) {
    await enqueueGenerationFailed(
      deps,
      payload,
      inputModeration.error.code,
      inputModeration.error.message,
    );
    return;
  }
  if (inputModeration.data.status === "blocked") {
    await enqueueGenerationBlocked(
      deps,
      payload,
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
  const imageProvider = env.IMAGE_PROVIDER;
  const imageTransport = transportIdentity(payload, deps);
  await recordTransport(deps, payload, imageProvider, "running");
  const invocationStartedAt = performance.now();
  const result = await imageModel.generate({
    prompt: payload.prompt,
    count: payload.count,
    seed: payload.seed,
    negativePrompt: payload.negativePrompt,
    model: payload.model,
    controls: payload.controls,
    requestId: imageTransport.idempotencyKey,
    orientation: payload.orientation,
    ...(referenceImages.length > 0 ? { referenceImages } : {}),
  });
  const invocationLatencyMs = performance.now() - invocationStartedAt;

  if (!result.ok) {
    const safeRetry = canAutomaticallyRetry(imageModel, result.error);
    const ambiguous = result.error.retryable && !safeRetry && ["timeout", "internal"].includes(result.error.code);
    try {
      await recordTransport(
        deps,
        payload,
        imageProvider,
        ambiguous ? "unknown" : "failed",
        result.error,
        invocationAccounting(result.invocation, invocationLatencyMs),
        result.invocation?.providerRequestId ?? null,
      );
    } catch (recordError) {
      if (safeRetry && !isFinalAttempt(deps)) throw recordError;
    }
    if (safeRetry && !isFinalAttempt(deps)) throw new Error(result.error.message);
    if (ambiguous) {
      await enqueueGenerationFailed(deps, payload, "ambiguous_non_replayable", result.error.message, { attemptOutcome: "unknown", retryability: "not_retryable" });
      return;
    }
    if (result.error.code === "content_blocked") {
      await enqueueGenerationBlocked(deps, payload, result.error.code, result.error.message, "provider");
      return;
    }
    await enqueueGenerationFailed(deps, payload, result.error.code, result.error.message);
    return;
  }

  if (result.data.assets.length === 0) {
    await enqueueGenerationFailed(
      deps,
      payload,
      "empty_provider_result",
      "Image provider returned no assets",
    );
    return;
  }

  let assets: Array<{
    key: string;
    width: number;
    height: number;
    contentType: string;
    providerKey: string | null;
    quality: ReturnType<typeof generatedImageQuality>;
  }>;
  try {
    assets = await Promise.all(
      result.data.assets.map(async (asset, index) => {
        const hasProviderMedia = Boolean(asset.body || asset.sourceUrl);
        const contentType = hasProviderMedia ? (asset.contentType ?? "image/webp") : "image/png";
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
        const persisted = await providers.blob.putPrivate({
          key,
          body,
          contentType,
        });
        if (!persisted.ok) throw new Error(persisted.error.message);
        return {
          key,
          width: asset.width,
          height: asset.height,
          contentType,
          providerKey: asset.key ?? null,
          quality: generatedImageQuality(sanityEvidence),
        };
      }),
    );
  } catch (error) {
    if (!isFinalAttempt(deps)) throw error;
    await enqueueGenerationFailed(
      deps,
      payload,
      error instanceof GeneratedImageSanityError ||
        error instanceof GeneratedAssetBodyMissingError
        ? error.code
        : "asset_persist_failed",
      error instanceof Error ? error.message : "Generated asset persistence failed",
    );
    return;
  }

  const completedPayload = {
    version: 1 as const,
    kind: "generation.completed" as const,
    requestId: payload.requestId,
    generationJobId: payload.generationJobId,
    attemptId: payload.attemptId,
    attemptNo: payload.attemptNo,
    mode: "image" as const,
    provider: imageProvider,
    model: payload.model,
    assets,
    usage: { gpuSeconds: assets.length * 1.2, model: payload.model },
  };
  const accounting = invocationAccounting(result.invocation, invocationLatencyMs, completedPayload.usage);
  if (deps.acknowledgeCompletion) {
    const ingest = await persistCompletionManifest(providers.blob, {
      version: 1,
      attemptId: payload.attemptId ?? `${payload.generationJobId}:1`,
      attemptNo: payload.attemptNo ?? 1,
      transportAttemptNo: imageTransport.transportAttemptNo,
      providerIdempotencyKey: imageTransport.idempotencyKey,
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: "image",
      provider: imageProvider,
      model: payload.model,
      providerRequestId: result.invocation?.providerRequestId ?? null,
      completedAt: new Date().toISOString(),
      assets: assets.map((asset, ordinal) => ({ ordinal, ...asset })),
      usage: completedPayload.usage,
      accounting,
    });
    await deps.acknowledgeCompletion(ingest);
    return;
  }
  await deps.enqueue({
    queue: MAIN_QUEUES.aiFinalize,
    payload: asPayload(completedPayload),
    dedupeKey: idempotencyKeys.generationFinalize(payload.generationJobId, "completed"),
  });
}

export async function processCharacterPreviewGenerate(
  rawPayload: unknown,
  deps: PipelineDeps,
): Promise<void> {
  const payload = characterPreviewGeneratePayloadSchema.parse(rawPayload);
  const providers = deps.providers ?? defaultProviders;
  const inputModeration = await providers.moderation.check({
    targetType: "text",
    content: `${payload.prompt} ${payload.negativePrompt ?? ""}`,
  });
  if (!inputModeration.ok) {
    await enqueueCharacterPreviewFailed(
      deps,
      payload,
      inputModeration.error.code,
      inputModeration.error.message,
    );
    return;
  }
  if (inputModeration.data.status === "blocked") {
    await enqueueCharacterPreviewFailed(
      deps,
      payload,
      inputModeration.data.policyCode ?? "content_blocked",
      "Character preview input was blocked",
    );
    return;
  }

  const imageModel = providers.image;
  const result = await imageModel.generate({
    prompt: payload.prompt,
    count: 1,
    seed: payload.seed,
    negativePrompt: payload.negativePrompt,
    model: payload.model,
    controls: payload.controls,
    requestId: idempotencyKeys.characterPreview(payload.previewJobId),
    orientation: payload.orientation,
  });
  if (!result.ok) {
    if (canAutomaticallyRetry(imageModel, result.error) && !isFinalAttempt(deps)) {
      throw new Error(result.error.message);
    }
    await enqueueCharacterPreviewFailed(
      deps,
      payload,
      result.error.code,
      result.error.message,
    );
    return;
  }

  const generated = result.data.assets[0];
  if (!generated) {
    await enqueueCharacterPreviewFailed(
      deps,
      payload,
      "empty_provider_result",
      "Image provider returned no character preview",
    );
    return;
  }

  try {
    const contentType = generated.contentType ?? "image/webp";
    const body = await imageAssetBody(generated);
    assertGeneratedImageSanity(
      Buffer.from(body),
      `${payload.previewJobId} character preview`,
    );
    const key = generatedAssetStorageKey(
      payload.outputPrefix,
      "image-1",
      contentType,
      ".png",
    );
    const persisted = await providers.blob.putPrivate({ key, body, contentType });
    if (!persisted.ok) throw new Error(persisted.error.message);

    await deps.enqueue({
      queue: MAIN_QUEUES.aiFinalize,
      payload: asPayload({
        version: 1,
        kind: "character.preview.completed",
        requestId: payload.requestId,
        previewJobId: payload.previewJobId,
        draftId: payload.draftId,
        userId: payload.userId,
        provider: env.IMAGE_PROVIDER,
        model: payload.model,
        asset: {
          key,
          width: generated.width,
          height: generated.height,
          contentType,
          providerKey: generated.key ?? null,
        },
      } satisfies AiFinalizePayload),
      dedupeKey: idempotencyKeys.characterPreviewFinalize(
        payload.previewJobId,
        "completed",
      ),
    });
  } catch (error) {
    if (!isFinalAttempt(deps)) throw error;
    await enqueueCharacterPreviewFailed(
      deps,
      payload,
      error instanceof GeneratedImageSanityError ||
        error instanceof GeneratedAssetBodyMissingError
        ? error.code
        : "asset_persist_failed",
      error instanceof Error ? error.message : "Character preview persistence failed",
    );
  }
}

async function enqueueCharacterPreviewFailed(
  deps: PipelineDeps,
  payload: CharacterPreviewGeneratePayload,
  code: string,
  message: string,
) {
  await deps.enqueue({
    queue: MAIN_QUEUES.aiFinalize,
    payload: asPayload({
      version: 1,
      kind: "character.preview.failed",
      requestId: payload.requestId,
      previewJobId: payload.previewJobId,
      draftId: payload.draftId,
      userId: payload.userId,
      error: { code, message, retryable: false },
    } satisfies AiFinalizePayload),
    dedupeKey: idempotencyKeys.characterPreviewFinalize(
      payload.previewJobId,
      "failed",
    ),
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
  if (await resumePersistedCompletion(payload, providers, deps)) return;
  const inputModeration = await providers.moderation.check({
    targetType: "text",
    content: `${payload.prompt} ${payload.negativePrompt ?? ""}`,
  });
  if (!inputModeration.ok) {
    await enqueueGenerationFailed(
      deps,
      payload,
      inputModeration.error.code,
      inputModeration.error.message,
    );
    return;
  }
  if (inputModeration.data.status === "blocked") {
    await enqueueGenerationBlocked(
      deps,
      payload,
      inputModeration.data.policyCode ?? "PROHIBITED_OTHER",
      "Input moderation blocked the generation request",
      "input",
    );
    return;
  }

  const videoModel = providers.video;
  const videoProvider = env.VIDEO_PROVIDER;
  const videoTransport = transportIdentity(payload, deps);
  await recordTransport(deps, payload, videoProvider, "running");
  const invocationStartedAt = performance.now();
  const result = await videoModel.generate({
    prompt: payload.prompt,
    seconds: payload.seconds,
    seed: payload.seed,
    negativePrompt: payload.negativePrompt,
    model: payload.model,
    controls: payload.controls,
    requestId: videoTransport.idempotencyKey,
  });
  const invocationLatencyMs = performance.now() - invocationStartedAt;

  if (!result.ok) {
    const safeRetry = canAutomaticallyRetry(videoModel, result.error);
    const ambiguous = result.error.retryable && !safeRetry && ["timeout", "internal"].includes(result.error.code);
    try {
      await recordTransport(
        deps,
        payload,
        videoProvider,
        ambiguous ? "unknown" : "failed",
        result.error,
        invocationAccounting(result.invocation, invocationLatencyMs),
        result.invocation?.providerRequestId ?? null,
      );
    } catch (recordError) {
      if (safeRetry && !isFinalAttempt(deps)) throw recordError;
    }
    if (safeRetry && !isFinalAttempt(deps)) throw new Error(result.error.message);
    if (ambiguous) {
      await enqueueGenerationFailed(deps, payload, "ambiguous_non_replayable", result.error.message, { attemptOutcome: "unknown", retryability: "not_retryable" });
      return;
    }
    if (result.error.code === "content_blocked") {
      await enqueueGenerationBlocked(deps, payload, result.error.code, result.error.message, "provider");
      return;
    }
    await enqueueGenerationFailed(deps, payload, result.error.code, result.error.message);
    return;
  }

  const contentType = result.data.asset.contentType ?? "video/mp4";
  const assetKey = generatedAssetStorageKey(payload.outputPrefix, "video", contentType, ".mp4");
  try {
    const persisted = await providers.blob.putPrivate({
      key: assetKey,
      body: await videoAssetBody(result.data.asset, payload.generationJobId),
      contentType,
    });
    if (!persisted.ok) throw new Error(persisted.error.message);
  } catch (error) {
    if (!isFinalAttempt(deps)) throw error;
    await enqueueGenerationFailed(
      deps,
      payload,
      "asset_persist_failed",
      error instanceof Error ? error.message : "Generated asset persistence failed",
    );
    return;
  }

  const completedPayload = {
    version: 1 as const,
    kind: "generation.completed" as const,
    requestId: payload.requestId,
    generationJobId: payload.generationJobId,
    attemptId: payload.attemptId,
    attemptNo: payload.attemptNo,
    mode: "video" as const,
    provider: videoProvider,
    model: payload.model,
    assets: [{
      key: assetKey,
      seconds: result.data.asset.seconds,
      contentType,
      providerKey: result.data.asset.key ?? null,
    }],
    usage: { gpuSeconds: payload.seconds * 2, model: payload.model },
  };
  const accounting = invocationAccounting(result.invocation, invocationLatencyMs, completedPayload.usage);
  if (deps.acknowledgeCompletion) {
    const ingest = await persistCompletionManifest(providers.blob, {
      version: 1,
      attemptId: payload.attemptId ?? `${payload.generationJobId}:1`,
      attemptNo: payload.attemptNo ?? 1,
      transportAttemptNo: videoTransport.transportAttemptNo,
      providerIdempotencyKey: videoTransport.idempotencyKey,
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: "video",
      provider: videoProvider,
      model: payload.model,
      providerRequestId: result.invocation?.providerRequestId ?? null,
      completedAt: new Date().toISOString(),
      assets: completedPayload.assets.map((asset, ordinal) => ({ ordinal, ...asset })),
      usage: completedPayload.usage,
      accounting,
    });
    await deps.acknowledgeCompletion(ingest);
    return;
  }
  await deps.enqueue({
    queue: MAIN_QUEUES.aiFinalize,
    payload: asPayload(completedPayload),
    dedupeKey: idempotencyKeys.generationFinalize(payload.generationJobId, "completed"),
  });
}

async function resumePersistedCompletion(
  payload: ImageGeneratePayload | VideoGeneratePayload,
  providers: GenProviders,
  deps: PipelineDeps,
): Promise<boolean> {
  if (!deps.acknowledgeCompletion) return false;
  const attemptId = payload.attemptId ?? `${payload.generationJobId}:1`;
  const persisted = await loadPersistedCompletionManifest(providers.blob, attemptId);
  if (!persisted) return false;
  if (persisted.manifest.generationJobId !== payload.generationJobId) {
    throw new Error(`completion manifest identity mismatch for ${attemptId}`);
  }
  await deps.acknowledgeCompletion(persisted);
  return true;
}

async function videoAssetBody(
  asset: { body?: Uint8Array; sourceUrl?: string },
  generationJobId: string,
) {
  if (asset.body) return asset.body;
  if (!asset.sourceUrl) {
    void generationJobId;
    return mockVideoMp4Bytes();
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
