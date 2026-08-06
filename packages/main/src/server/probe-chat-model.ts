import {
  looksLikeMockChatResponse,
  resolveChatModelProfile,
  type ChatModelProfile,
} from "@idream/shared";
import { OpenAIChatModel } from "../../../chat/src/providers";
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
  const profile = resolveChatModelProfile(process.env);
  const report = await runProbe({
    profile,
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
  profile: ChatModelProfile;
  prompt: string;
  startedAt: number;
}): Promise<ChatProbeReport> {
  const checkedAt = new Date().toISOString();
  const baseReport = {
    checkedAt,
    provider: input.profile.provider,
    baseUrl: input.profile.baseUrl,
    model: input.profile.model,
  };

  try {
    const chat = createChatModel(input.profile);
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

function createChatModel(profile: ChatModelProfile): ChatModel {
  if (profile.provider === "mock") return new MockProbeChatModel();
  // The probe executes the exact production adapter and timeout semantics.
  return new OpenAIChatModel(profile);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
