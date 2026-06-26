import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PipelineChatModel } from "./providers/chat/pipeline";
import type { ChatChunk, ChatModel } from "./providers/types";

type ProbeOptions = {
  report: string | null;
  prompt: string;
};

type ChatProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  provider: string;
  baseUrl: string | null;
  model: string | null;
  chunks: number;
  characters: number;
  done: boolean;
  error: { code: string; message: string } | null;
};

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

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptions(): ProbeOptions {
  return {
    report: readArg("report") ?? process.env.CHAT_MODEL_PROBE_REPORT ?? null,
    prompt:
      readArg("prompt") ??
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
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
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
      }
      if (chunk.done) done = true;
    }

    return {
      ...baseReport,
      ok: chunks > 0 && characters > 0 && done,
      durationMs: Date.now() - input.startedAt,
      chunks,
      characters,
      done,
      error: null,
    };
  } catch (error) {
    return {
      ...baseReport,
      ok: false,
      durationMs: Date.now() - input.startedAt,
      chunks: 0,
      characters: 0,
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
    timeoutMs: Number.parseInt(
      process.env.CHAT_MODEL_TIMEOUT_MS ?? process.env.PIPELINE_TIMEOUT_MS ?? "60000",
      10,
    ),
  });
}

function requireValue(name: string, value: string | null | undefined) {
  if (!value?.trim()) throw new Error(`${name} is required for chat model probe`);
  return value;
}

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
