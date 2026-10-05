import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { providers } from "@/server/providers";
import type { ChatModel } from "@/server/providers/types";
import { PipelineChatRequestError } from "@/server/providers/chat/pipeline";
import { logger } from "@/server/lib/logger";

export type AdminTextGenerationRuntime = {
  provider: "mock" | "pipeline";
  pipelineUrl: string | null;
  model: string | null;
  sourceRevision?: string | null;
  stream: ChatModel["stream"];
};

export type AdminTextRuntimeIdentity = Pick<
  AdminTextGenerationRuntime,
  "provider" | "pipelineUrl" | "model"
> & { sourceRevision?: string | null };

const defaultRuntime: AdminTextGenerationRuntime = {
  provider: env.CHAT_PROVIDER,
  pipelineUrl: env.PIPELINE_API_URL ?? null,
  model: env.PIPELINE_CHAT_MODEL_DEFAULT,
  sourceRevision:
    process.env.IDREAM_SOURCE_REVISION?.trim() ||
    process.env.SENTRY_RELEASE?.trim() ||
    null,
  stream: (input) => providers.chat.stream(input),
};

export function adminTextRuntimeIdentity(
  runtime: AdminTextGenerationRuntime = defaultRuntime,
): AdminTextRuntimeIdentity {
  const sourceRevision = runtime.sourceRevision?.trim();
  return {
    provider: runtime.provider,
    pipelineUrl: runtime.pipelineUrl,
    model: runtime.model,
    ...(sourceRevision ? { sourceRevision } : {}),
  };
}

export function assertAdminTextGenerationAvailable(
  runtime: AdminTextGenerationRuntime = defaultRuntime,
): void {
  if (runtime.provider === "mock") {
    throw Errors.unavailable(
      "AI text generation is unavailable until a real chat model is configured",
    );
  }
}

export async function generateAdminText(
  input: Parameters<ChatModel["stream"]>[0],
  runtime: AdminTextGenerationRuntime = defaultRuntime,
  context: { stage?: string; maxTokens?: number; maxCharacters?: number; requestId?: string } = {},
): Promise<string> {
  assertAdminTextGenerationAvailable(runtime);
  const modelRequestId = crypto.randomUUID();
  const startedAt = Date.now();
  const facts = {
    stage: context.stage ?? "text",
    provider: runtime.provider,
    model: runtime.model,
    modelRequestId,
    requestId: context.requestId ?? null,
    maxTokens: context.maxTokens ?? input.maxTokens ?? 2048,
    ...(context.maxCharacters === undefined ? {} : { maxCharacters: context.maxCharacters }),
  };
  let text = "";
  let finishReason: string | undefined;
  try {
    for await (const chunk of runtime.stream({ ...input, maxTokens: facts.maxTokens, requestId: modelRequestId, timeoutMode: "progress" })) {
      text += chunk.delta;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      // Do not make truncated model text editable or consume later draft stages.
      if (finishReason === "length") break;
    }
  } catch (cause) {
    const details = {
      ...facts,
      elapsedMs: Date.now() - startedAt,
      failureKind: cause instanceof PipelineChatRequestError ? cause.kind
        : cause instanceof Error && ["AbortError", "TimeoutError"].includes(cause.name) ? "timeout" : "provider",
      ...(cause instanceof PipelineChatRequestError ? { timeoutPhase: cause.timeoutPhase ?? null, httpStatus: cause.status ?? null } : {}),
    };
    logger.warn(details, "Admin text generation failed");
    throw Errors.unavailable(
      "AI text generation is temporarily unavailable. Check the chat model connection and try again",
      details,
    );
  }

  if (finishReason === "length") {
    const details = { ...facts, elapsedMs: Date.now() - startedAt, failureKind: "output_limit", finishReason };
    logger.warn(details, "Admin text generation failed");
    throw Errors.unavailable(
      "AI text generation reached its output limit before completing the draft. Try a shorter seed",
      details,
    );
  }

  const output = text.trim();
  if (!output || /^Mock .+ reply:/i.test(output)) {
    throw Errors.unavailable(
      "AI text generation returned no usable model output. Check the chat model connection and try again",
      { ...facts, elapsedMs: Date.now() - startedAt, failureKind: "empty_output" },
    );
  }
  if (context.maxCharacters !== undefined && output.length > context.maxCharacters) {
    const details = { ...facts, elapsedMs: Date.now() - startedAt, failureKind: "summary_limit", outputCharacters: output.length, finishReason: finishReason ?? null };
    logger.warn(details, "Admin text generation failed");
    throw Errors.unavailable(
      "AI text generation exceeded the summary character limit. Try a shorter seed",
      details,
    );
  }
  logger.info({ ...facts, elapsedMs: Date.now() - startedAt, outputCharacters: output.length, finishReason: finishReason ?? null }, "Admin text generation completed");
  return output;
}
