import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { providers } from "@/server/providers";
import type { ChatModel } from "@/server/providers/types";

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
): Promise<string> {
  assertAdminTextGenerationAvailable(runtime);

  let text = "";
  try {
    for await (const chunk of runtime.stream(input)) {
      text += chunk.delta;
    }
  } catch {
    throw Errors.unavailable(
      "AI text generation is temporarily unavailable. Check the chat model connection and try again",
    );
  }

  const output = text.trim();
  if (!output || /^Mock .+ reply:/i.test(output)) {
    throw Errors.unavailable(
      "AI text generation returned no usable model output. Check the chat model connection and try again",
    );
  }
  return output;
}
