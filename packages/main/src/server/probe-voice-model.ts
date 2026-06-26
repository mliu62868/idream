import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MockVoiceModel } from "./providers/voice/mock";
import { PipelineVoiceModel } from "./providers/voice/pipeline";
import type { BlobStore, ProviderResult, VoiceModel } from "./providers/types";

type ProbeOptions = {
  report: string | null;
  text: string;
  voiceId: string;
};

type VoiceProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  provider: string;
  baseUrl: string | null;
  model: string | null;
  voiceId: string;
  key: string | null;
  audioDurationMs: number | null;
  bytes?: number;
  contentType?: string | null;
  error: { code: string; message: string; retryable?: boolean } | null;
};

type StoredBlob = {
  key: string;
  size: number;
  contentType: string;
};

class ProbeBlobStore implements BlobStore {
  stored: StoredBlob | null = null;

  async putPrivate(input: Parameters<BlobStore["putPrivate"]>[0]) {
    this.stored = {
      key: input.key,
      size: input.body.byteLength,
      contentType: input.contentType,
    };
    return {
      ok: true as const,
      data: {
        key: input.key,
        size: input.body.byteLength,
      },
    };
  }

  async signGetUrl(): Promise<ProviderResult<{ url: string }>> {
    return {
      ok: false,
      error: {
        code: "not_supported",
        message: "Voice probe does not sign in-memory blob URLs",
        retryable: false,
      },
    };
  }

  async delete(): Promise<ProviderResult<{ deleted: true }>> {
    this.stored = null;
    return { ok: true, data: { deleted: true } };
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
    report: readArg("report") ?? process.env.VOICE_MODEL_PROBE_REPORT ?? null,
    text:
      readArg("text") ??
      "Launch readiness voice probe. This short line should synthesize clearly.",
    voiceId: readArg("voice") ?? process.env.VOICE_MODEL_PROBE_VOICE_ID ?? "default",
  };
}

async function main() {
  const options = readOptions();
  const startedAt = Date.now();
  const provider = process.env.VOICE_PROVIDER ?? "mock";
  const baseUrl = process.env.PIPELINE_API_URL ?? null;
  const model =
    process.env.PIPELINE_VOICE_MODEL_DEFAULT ??
    (provider === "mock" ? "mock-voice-probe" : "voice-default");
  const report = await runProbe({
    provider,
    baseUrl,
    model,
    voiceId: options.voiceId,
    text: options.text,
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
  voiceId: string;
  text: string;
  startedAt: number;
}): Promise<VoiceProbeReport> {
  const checkedAt = new Date().toISOString();
  const baseReport = {
    checkedAt,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    voiceId: input.voiceId,
  };
  const blob = new ProbeBlobStore();

  try {
    const voice = createVoiceModel({
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      blob,
    });
    const result = await voice.synthesize({
      text: input.text,
      voiceId: input.voiceId,
    });
    if (!result.ok) {
      return {
        ...baseReport,
        ok: false,
        durationMs: Date.now() - input.startedAt,
        key: null,
        audioDurationMs: null,
        error: {
          code: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable,
        },
      };
    }

    return {
      ...baseReport,
      ok: hasText(result.data.key) && result.data.durationMs > 0,
      durationMs: Date.now() - input.startedAt,
      key: result.data.key,
      audioDurationMs: result.data.durationMs,
      bytes: blob.stored?.size,
      contentType: blob.stored?.contentType,
      error: null,
    };
  } catch (error) {
    return {
      ...baseReport,
      ok: false,
      durationMs: Date.now() - input.startedAt,
      key: null,
      audioDurationMs: null,
      error: {
        code: "voice_model_probe_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }
}

function createVoiceModel(input: {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  blob: BlobStore;
}): VoiceModel {
  if (input.provider === "mock") return new MockVoiceModel();
  if (input.provider !== "pipeline") {
    throw new Error(`Unsupported voice model provider: ${input.provider}`);
  }

  return new PipelineVoiceModel({
    baseUrl: requireValue("PIPELINE_API_URL", input.baseUrl),
    apiKey: process.env.PIPELINE_API_TOKEN,
    model: requireValue("PIPELINE_VOICE_MODEL_DEFAULT", input.model),
    timeoutMs: Number.parseInt(process.env.PIPELINE_TIMEOUT_MS ?? "60000", 10),
    blob: input.blob,
  });
}

function requireValue(name: string, value: string | null | undefined) {
  if (!value?.trim()) throw new Error(`${name} is required for voice model probe`);
  return value;
}

function hasText(value: string | null | undefined) {
  return Boolean(value?.trim());
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
