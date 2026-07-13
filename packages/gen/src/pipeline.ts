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
import { assertGeneratedImageSanity, GeneratedImageSanityError } from "./generated-image-sanity";
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

const placeholderImagePng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ),
);

export interface PipelineDeps {
  enqueue: EnqueueFn;
  providers?: GenProviders;
  attemptsMade?: number;
  maxAttempts?: number;
  acknowledgeCompletion?: (input: GenerationManifestIngest) => Promise<void>;
  recordTransportExecution?: (input: GenerationTransportExecutionEvent) => Promise<void>;
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
        if (hasProviderMedia) {
          assertGeneratedImageSanity(
            Buffer.from(body),
            `${payload.generationJobId} asset ${index + 1}`,
          );
        }
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
        };
      }),
    );
  } catch (error) {
    if (!isFinalAttempt(deps)) throw error;
    await enqueueGenerationFailed(
      deps,
      payload,
      error instanceof GeneratedImageSanityError ? error.code : "asset_persist_failed",
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

async function imageAssetBody(
  asset: { body?: Uint8Array; sourceUrl?: string },
) {
  if (asset.body) return asset.body;
  if (!asset.sourceUrl) return new Uint8Array(placeholderImagePng);

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
