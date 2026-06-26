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
  idempotencyKeys,
  imageGeneratePayloadSchema,
  type ImageGeneratePayload,
  MAIN_QUEUES,
  videoGeneratePayloadSchema,
  type VideoGeneratePayload,
} from "@idream/shared/contracts";
import { mockVideoMp4Bytes } from "@idream/shared";
import { env } from "./env";
import { type GenProviders, providers as defaultProviders } from "./providers";
import type { EnqueueFn, JsonPayload } from "./queue";

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
}

function asPayload(value: AiFinalizePayload): JsonPayload {
  return value as unknown as JsonPayload;
}

async function enqueueGenerationFailed(
  deps: PipelineDeps,
  payload: ImageGeneratePayload | VideoGeneratePayload,
  code: string,
  message: string,
): Promise<void> {
  await deps.enqueue({
    queue: MAIN_QUEUES.aiFinalize,
    payload: asPayload({
      version: 1,
      kind: "generation.failed",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: payload.kind,
      error: { code, message, retryable: false },
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

export async function processImageGenerate(
  rawPayload: unknown,
  deps: PipelineDeps,
): Promise<void> {
  const payload = imageGeneratePayloadSchema.parse(rawPayload);
  const providers = deps.providers ?? defaultProviders;
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

  const result = await providers.image.generate({
    prompt: payload.prompt,
    count: payload.count,
    seed: payload.seed,
    negativePrompt: payload.negativePrompt,
    model: payload.model,
    controls: payload.controls,
    requestId: payload.requestId,
    orientation: payload.orientation,
  });

  if (!result.ok) {
    // Retryable → throw so the queue re-attempts. Terminal → finalize as failed.
    if (result.error.retryable && !isFinalAttempt(deps)) throw new Error(result.error.message);
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

  let assets: Array<{ key: string; width: number; height: number; contentType: string }>;
  try {
    assets = await Promise.all(
      result.data.assets.map(async (asset, index) => {
        const key = asset.key || `${payload.outputPrefix}${index}.webp`;
        const hasProviderMedia = Boolean(asset.body || asset.sourceUrl);
        const contentType = hasProviderMedia ? (asset.contentType ?? "image/webp") : "image/png";
        const persisted = await providers.blob.putPrivate({
          key,
          body: await imageAssetBody(asset),
          contentType,
        });
        if (!persisted.ok) throw new Error(persisted.error.message);
        return {
          key,
          width: asset.width,
          height: asset.height,
          contentType,
        };
      }),
    );
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

  await deps.enqueue({
    queue: MAIN_QUEUES.aiFinalize,
    payload: asPayload({
      version: 1,
      kind: "generation.completed",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: "image",
      assets,
      usage: { gpuSeconds: assets.length * 1.2, model: payload.model },
    }),
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

  const result = await providers.video.generate({
    prompt: payload.prompt,
    seconds: payload.seconds,
    seed: payload.seed,
    negativePrompt: payload.negativePrompt,
    model: payload.model,
    controls: payload.controls,
    requestId: payload.requestId,
  });

  if (!result.ok) {
    if (result.error.retryable && !isFinalAttempt(deps)) throw new Error(result.error.message);
    if (result.error.code === "content_blocked") {
      await enqueueGenerationBlocked(deps, payload, result.error.code, result.error.message, "provider");
      return;
    }
    await enqueueGenerationFailed(deps, payload, result.error.code, result.error.message);
    return;
  }

  const assetKey = result.data.asset.key || `${payload.outputPrefix}video.mp4`;
  const contentType = result.data.asset.contentType ?? "video/mp4";
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

  await deps.enqueue({
    queue: MAIN_QUEUES.aiFinalize,
    payload: asPayload({
      version: 1,
      kind: "generation.completed",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: "video",
      assets: [
        {
          key: assetKey,
          seconds: result.data.asset.seconds,
          contentType,
        },
      ],
      usage: { gpuSeconds: payload.seconds * 2, model: payload.model },
    }),
    dedupeKey: idempotencyKeys.generationFinalize(payload.generationJobId, "completed"),
  });
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
