import { looksLikeMockChatResponse } from "@idream/shared";
import { chatModelTimeoutMs } from "@idream/shared/env";
import { PipelineChatModel } from "./providers/chat/pipeline";
import type { ChatChunk, ChatModel } from "./providers/types";
import type { ChatModelProbeEvidence, ProbeReportOf } from "./readiness/evidence";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";

type ProbeOptions = {
  report: string | null;
  prompt: string;
};

// SPEC: 写出的 JSON 由 launch gate 的 evidence 契约约束，两端共用 readiness/evidence.ts。
type ChatProbeReport = ProbeReportOf<ChatModelProbeEvidence>;

class MockProbeChatModel implements ChatModel {
  async *stream(input: Parameters<ChatModel["stream"]>[0]): AsyncIterable<ChatChunk> {
    const lastUser =
      [...input.messages].reverse().find((message) => message.role === "user")
        ?.content ?? "probe";
    yield {
      delta: `Mock probe response: ${lastUser.slice(0, 32)}`,
      done: false,
    };
    yield { delta: "", done: true };
  }
}

function readOptions(): ProbeOptions {
  return {
    report: probeReportPath("chatModelProbe"),
    prompt:
      probeCliArg("prompt") ??
      "Reply with a short launch readiness acknowledgement.",
  };
}

async function main() {
  const options = readOptions();
  const startedAt = Date.now();
  const provider = process.env.CHAT_MODEL_PROVIDER ?? process.env.CHAT_PROVIDER ?? "mock";
  const baseUrl = process.env.CHAT_MODEL_BASE_URL ?? process.env.PIPELINE_API_URL ?? null;
  const model =
    process.env.CHAT_MODEL_NAME ??
    process.env.PIPELINE_CHAT_MODEL_DEFAULT ??
    (provider === "mock" ? "mock-chat-probe" : null);
  const report = await runProbe({
    provider,
    baseUrl,
    model,
    prompt: options.prompt,
    startedAt,
  });

  if (options.report) {
    await writeProbeReport(options.report, report);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function runProbe(input: {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  prompt: string;
  startedAt: number;
}): Promise<ChatProbeReport> {
  const checkedAt = new Date().toISOString();
  const baseReport = {
    checkedAt,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
  };

  try {
    const chat = createChatModel(input);
    let chunks = 0;
    let characters = 0;
    let done = false;
    const pieces: string[] = [];
    for await (const chunk of chat.stream({
      characterName: "Launch Probe",
      messages: [
        {
          role: "system",
          content: "You are a terse readiness probe. Do not include secrets.",
        },
        {
          role: "user",
          content: input.prompt,
        },
      ],
    })) {
      if (chunk.delta) {
        chunks += 1;
        characters += chunk.delta.length;
        pieces.push(chunk.delta);
      }
      if (chunk.done) done = true;
    }

    const assistantText = pieces.join("");
    const mockTemplate = looksLikeMockChatResponse(assistantText);
    const ok = chunks > 0 && characters > 0 && done && !mockTemplate;
    return {
      ...baseReport,
      ok,
      durationMs: Date.now() - input.startedAt,
      chunks,
      characters,
      assistantPreview: assistantText.slice(0, 240) || null,
      done,
      error: ok
        ? null
        : mockTemplate
          ? {
              code: "chat_model_probe_mock_response",
              message: "chat model probe returned a mock/template response",
            }
          : null,
    };
  } catch (error) {
    return {
      ...baseReport,
      ok: false,
      durationMs: Date.now() - input.startedAt,
      chunks: 0,
      characters: 0,
      assistantPreview: null,
      done: false,
      error: {
        code: "chat_model_probe_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function createChatModel(input: {
  provider: string;
  baseUrl: string | null;
  model: string | null;
}): ChatModel {
  if (input.provider === "mock") return new MockProbeChatModel();
  if (input.provider !== "pipeline" && input.provider !== "openai") {
    throw new Error(`Unsupported chat model provider: ${input.provider}`);
  }

  return new PipelineChatModel({
    baseUrl: requireValue("CHAT_MODEL_BASE_URL or PIPELINE_API_URL", input.baseUrl),
    apiKey: process.env.CHAT_MODEL_API_KEY ?? process.env.PIPELINE_API_TOKEN,
    model: requireValue("CHAT_MODEL_NAME or PIPELINE_CHAT_MODEL_DEFAULT", input.model),
    // 用 chat 生产的预算，而不是探针自己的一套。此前这里是
    // `CHAT_MODEL_TIMEOUT_MS ?? PIPELINE_TIMEOUT_MS ?? 60000` —— 比 chat 多一级
    // 回退、默认值也更大，于是一次 50s 的响应在探针里全绿、在 chat 里早就超时了。
    timeoutMs: chatModelTimeoutMs(),
  });
}

function requireValue(name: string, value: string | null | undefined) {
  if (!value?.trim()) throw new Error(`${name} is required for chat model probe`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
