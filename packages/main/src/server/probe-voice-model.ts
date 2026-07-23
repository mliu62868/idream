import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MockVoiceModel } from "./providers/voice/mock";
import { PipelineVoiceModel } from "./providers/voice/pipeline";
import { PocketTtsVoiceModel } from "./providers/voice/pocket-tts";
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
  voiceCloningAvailable: boolean | null;
  voiceCloneVerified: boolean | null;
  bytes?: number;
  contentType?: string | null;
  error: { code: string; message: string; retryable?: boolean } | null;
};

type StoredBlob = {
  key: string;
  size: number;
  contentType: string;
  body: Uint8Array;
};

class ProbeBlobStore implements BlobStore {
  stored: StoredBlob | null = null;

  async putPrivate(input: Parameters<BlobStore["putPrivate"]>[0]) {
    this.stored = {
      key: input.key,
      size: input.body.byteLength,
      contentType: input.contentType,
      body: input.body,
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

function readOptions(defaultVoiceId: string): ProbeOptions {
  return {
    report: readArg("report") ?? process.env.VOICE_MODEL_PROBE_REPORT ?? null,
    text:
      readArg("text") ??
      "Launch readiness voice probe. This short line should synthesize clearly.",
    voiceId: readArg("voice") ?? process.env.VOICE_MODEL_PROBE_VOICE_ID ?? defaultVoiceId,
  };
}

async function main() {
  const startedAt = Date.now();
  const provider = process.env.VOICE_PROVIDER ?? "mock";
  const baseUrl = provider === "pocket-tts"
    ? process.env.POCKET_TTS_API_URL ?? "http://127.0.0.1:8062/v1"
    : process.env.PIPELINE_VOICE_API_URL ?? process.env.PIPELINE_API_URL ?? null;
  const model = provider === "pocket-tts"
    ? process.env.POCKET_TTS_MODEL ?? "kyutai/pocket-tts"
    : process.env.PIPELINE_VOICE_MODEL_DEFAULT ??
      (provider === "mock" ? "mock-voice-probe" : "voice-default");
  const options = readOptions(defaultVoiceForModel(model));
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
  let voiceCloningAvailable: boolean | null = null;
  let voiceCloneVerified: boolean | null = null;

  try {
    const voice = createVoiceModel({
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      blob,
    });
    if (voice.inspectCapabilities) {
      const capabilities = await voice.inspectCapabilities();
      voiceCloningAvailable = capabilities.ok
        ? capabilities.data.voiceCloning
        : null;
    }
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
        voiceCloningAvailable,
        voiceCloneVerified,
        error: {
          code: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable,
        },
      };
    }
    let synthesized = result.data;
    if (input.provider === "pocket-tts") {
      if (
        voiceCloningAvailable !== true ||
        !voice.cloneVoice ||
        !voice.deleteVoice ||
        !blob.stored?.body
      ) {
        return {
          ...baseReport,
          ok: false,
          durationMs: Date.now() - input.startedAt,
          key: result.data.key,
          audioDurationMs: result.data.durationMs,
          voiceCloningAvailable,
          voiceCloneVerified: false,
          bytes: blob.stored?.size,
          contentType: blob.stored?.contentType,
          error: {
            code: "voice_clone_unavailable",
            message: "Pocket TTS did not expose a usable voice-cloning capability",
            retryable: false,
          },
        };
      }
      const reference = blob.stored;
      const probeVoiceId = `idream-probe-${randomUUID()}`;
      const clone = await voice.cloneVoice({
        voiceId: probeVoiceId,
        audio: reference.body,
        contentType: reference.contentType,
        filename: "pocket-tts-probe-reference.wav",
        language: process.env.POCKET_TTS_LANGUAGE ?? "english",
      });
      if (!clone.ok) {
        return {
          ...baseReport,
          ok: false,
          durationMs: Date.now() - input.startedAt,
          key: result.data.key,
          audioDurationMs: result.data.durationMs,
          voiceCloningAvailable,
          voiceCloneVerified: false,
          bytes: blob.stored?.size,
          contentType: blob.stored?.contentType,
          error: {
            code: clone.error.code,
            message: clone.error.message,
            retryable: clone.error.retryable,
          },
        };
      }
      let clonedSpeech: Awaited<ReturnType<VoiceModel["synthesize"]>>;
      let deleted: Awaited<ReturnType<NonNullable<VoiceModel["deleteVoice"]>>>;
      try {
        clonedSpeech = await voice.synthesize({
          text: input.text,
          voiceId: clone.data.voiceId,
        });
      } finally {
        deleted = await voice.deleteVoice({ voiceId: clone.data.voiceId });
      }
      if (!clonedSpeech.ok) {
        return {
          ...baseReport,
          ok: false,
          durationMs: Date.now() - input.startedAt,
          key: null,
          audioDurationMs: null,
          voiceCloningAvailable,
          voiceCloneVerified: false,
          bytes: blob.stored?.size,
          contentType: blob.stored?.contentType,
          error: {
            code: clonedSpeech.error.code,
            message: clonedSpeech.error.message,
            retryable: clonedSpeech.error.retryable,
          },
        };
      }
      if (!deleted.ok) {
        return {
          ...baseReport,
          ok: false,
          durationMs: Date.now() - input.startedAt,
          key: clonedSpeech.data.key,
          audioDurationMs: clonedSpeech.data.durationMs,
          voiceCloningAvailable,
          voiceCloneVerified: false,
          bytes: blob.stored?.size,
          contentType: blob.stored?.contentType,
          error: {
            code: deleted.error.code,
            message: deleted.error.message,
            retryable: deleted.error.retryable,
          },
        };
      }
      synthesized = clonedSpeech.data;
      voiceCloneVerified = true;
    }

    return {
      ...baseReport,
      ok: hasText(synthesized.key) && synthesized.durationMs > 0,
      durationMs: Date.now() - input.startedAt,
      key: synthesized.key,
      audioDurationMs: synthesized.durationMs,
      voiceCloningAvailable,
      voiceCloneVerified,
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
      voiceCloningAvailable,
      voiceCloneVerified,
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
  if (input.provider === "pocket-tts") {
    return new PocketTtsVoiceModel({
      baseUrl: requireValue("POCKET_TTS_API_URL", input.baseUrl),
      apiKey: process.env.POCKET_TTS_API_TOKEN,
      model: requireValue("POCKET_TTS_MODEL", input.model),
      language: process.env.POCKET_TTS_LANGUAGE ?? "english",
      defaultVoiceId: process.env.POCKET_TTS_DEFAULT_VOICE_ID ?? "alba",
      maxInputChars: readIntEnv("PIPELINE_VOICE_MAX_INPUT_CHARS", 900, 1),
      timeoutMs: readIntEnv("POCKET_TTS_TIMEOUT_MS", 120_000, 250),
      blob: input.blob,
    });
  }
  if (input.provider !== "pipeline") {
    throw new Error(`Unsupported voice model provider: ${input.provider}`);
  }

  return new PipelineVoiceModel({
    baseUrl: requireValue("PIPELINE_VOICE_API_URL or PIPELINE_API_URL", input.baseUrl),
    apiKey: process.env.PIPELINE_VOICE_API_TOKEN ?? process.env.PIPELINE_API_TOKEN,
    model: requireValue("PIPELINE_VOICE_MODEL_DEFAULT", input.model),
    sendInstructions: process.env.PIPELINE_VOICE_SEND_INSTRUCTIONS === "true",
    maxInputCharsPerRequest: readIntEnv("PIPELINE_VOICE_CHUNK_CHARS", 0),
    maxInputChars: readIntEnv("PIPELINE_VOICE_MAX_INPUT_CHARS", 900),
    timeoutMs: readIntEnv(
      "PIPELINE_VOICE_TIMEOUT_MS",
      readIntEnv("PIPELINE_TIMEOUT_MS", 120_000, 250),
      250,
    ),
    blob: input.blob,
  });
}

function readIntEnv(name: string, fallback: number, min = 0) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function requireValue(name: string, value: string | null | undefined) {
  if (!value?.trim()) throw new Error(`${name} is required for voice model probe`);
  return value;
}

function hasText(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function defaultVoiceForModel(model: string | null) {
  const normalized = model?.toLowerCase() ?? "";
  if (normalized.includes("qwen3-tts")) return "serena";
  if (normalized.includes("kokoro")) return "af_heart";
  if (normalized.includes("pocket-tts")) return "alba";
  return "default";
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
