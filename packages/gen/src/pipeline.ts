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
import { type GenProviders, providers as defaultProviders } from "./providers";
import type { EnqueueFn, JsonPayload } from "./queue";

export interface PipelineDeps {
  enqueue: EnqueueFn;
  providers?: GenProviders;
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

export async function processImageGenerate(
  rawPayload: unknown,
  deps: PipelineDeps,
): Promise<void> {
  const payload = imageGeneratePayloadSchema.parse(rawPayload);
  const providers = deps.providers ?? defaultProviders;

  const result = await providers.image.generate({
    prompt: payload.prompt,
    count: payload.count,
    seed: payload.seed,
  });

  if (!result.ok) {
    // Retryable → throw so the queue re-attempts. Terminal → finalize as failed.
    if (result.error.retryable) throw new Error(result.error.message);
    await enqueueGenerationFailed(deps, payload, result.error.code, result.error.message);
    return;
  }

  const assets = await Promise.all(
    result.data.assets.map(async (asset, index) => {
      const key = asset.key || `${payload.outputPrefix}${index}.webp`;
      await providers.blob.putPrivate({
        key,
        body: new TextEncoder().encode(`mock image ${payload.generationJobId} ${index}`),
        contentType: "image/webp",
      });
      return {
        key,
        width: asset.width,
        height: asset.height,
        contentType: "image/webp",
      };
    }),
  );

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

export async function processVideoGenerate(
  rawPayload: unknown,
  deps: PipelineDeps,
): Promise<void> {
  const payload = videoGeneratePayloadSchema.parse(rawPayload);
  const providers = deps.providers ?? defaultProviders;

  const result = await providers.video.generate({
    prompt: payload.prompt,
    seconds: payload.seconds,
    seed: payload.seed,
  });

  if (!result.ok) {
    if (result.error.retryable) throw new Error(result.error.message);
    await enqueueGenerationFailed(deps, payload, result.error.code, result.error.message);
    return;
  }

  await providers.blob.putPrivate({
    key: result.data.asset.key,
    body: new TextEncoder().encode(`mock video ${payload.generationJobId}`),
    contentType: "video/mp4",
  });

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
          key: result.data.asset.key,
          seconds: result.data.asset.seconds,
          contentType: "video/mp4",
        },
      ],
      usage: { gpuSeconds: payload.seconds * 2, model: payload.model },
    }),
    dedupeKey: idempotencyKeys.generationFinalize(payload.generationJobId, "completed"),
  });
}
