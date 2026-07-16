import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { providers } from "@/server/providers";
import type { ChatModel } from "@/server/providers/types";

export type AdminTextGenerationRuntime = {
  provider: "mock" | "pipeline";
  stream: ChatModel["stream"];
};

const defaultRuntime: AdminTextGenerationRuntime = {
  provider: env.CHAT_PROVIDER,
  stream: (input) => providers.chat.stream(input),
};

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
