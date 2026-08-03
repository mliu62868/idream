import { randomUUID } from "node:crypto";
import { createConfiguredVoicePorts } from "./providers/voice/factory";
import type {
  BlobStore,
  ProviderResult,
  VoiceClipPort,
  VoiceIdentityPort,
} from "./providers/types";
import type { ProbeReportOf, VoiceModelProbeEvidence } from "./readiness/evidence";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";

type ProbeOptions = {
  report: string | null;
  text: string;
  voiceId: string;
};

// SPEC: 写出的 JSON 由 launch gate 的 evidence 契约约束，两端共用 readiness/evidence.ts。
// INTENT: bytes/contentType 只有拿到音频 blob 才有；audioDurationMs 以前在失败路径写 null，而契约
//         声明的是 number，靠消费端把 null 洗成 undefined 才没炸 —— 现在改成按路径省略这个 key。
type VoiceProbeReport = ProbeReportOf<
  VoiceModelProbeEvidence,
  "audioDurationMs" | "bytes" | "contentType"
>;

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

function readOptions(defaultVoiceId: string): ProbeOptions {
  return {
    report: probeReportPath("voiceModelProbe"),
    text:
      probeCliArg("text") ??
      "Launch readiness voice probe. This short line should synthesize clearly.",
    voiceId: probeCliArg("voice") ?? process.env.VOICE_MODEL_PROBE_VOICE_ID ?? defaultVoiceId,
  };
}

async function main() {
  const startedAt = Date.now();
  const provider = process.env.VOICE_PROVIDER ?? "mock";
  const baseUrl = provider === "fish-audio"
    ? process.env.FISH_AUDIO_API_URL ?? "http://127.0.0.1:8062/v1"
    : provider === "pocket-tts"
      ? process.env.POCKET_TTS_API_URL ?? "http://127.0.0.1:8062/v1"
    : process.env.PIPELINE_VOICE_API_URL ?? process.env.PIPELINE_API_URL ?? null;
  const model = provider === "fish-audio"
    ? process.env.FISH_AUDIO_MODEL ?? "fish-audio-s2-pro-8bit"
    : provider === "pocket-tts"
      ? process.env.POCKET_TTS_MODEL ?? "pocket-tts-4bit"
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
    await writeProbeReport(options.report, report);
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
    const voice = createConfiguredVoicePorts(blob);
    if (voice.identity) {
      const capabilities = await voice.identity.inspectCapabilities();
      voiceCloningAvailable = capabilities.ok
        ? capabilities.data.voiceCloning
        : null;
    }
    const result = await voice.clip.synthesize({
      requestId: `voice-probe-${input.startedAt}`,
      attemptNo: 1,
      idempotencyKey: `voice-probe-${input.startedAt}:1`,
      text: input.text,
      voiceId: input.voiceId,
    });
    if (!result.ok) {
      return {
        ...baseReport,
        ok: false,
        durationMs: Date.now() - input.startedAt,
        key: null,
        audioDurationMs: undefined,
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
    if (input.provider === "pocket-tts" || input.provider === "fish-audio") {
      if (
        voiceCloningAvailable !== true ||
        !voice.identity ||
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
            message: `${input.provider} did not expose a usable voice-cloning capability`,
            retryable: false,
          },
        };
      }
      const reference = blob.stored;
      const probeVoiceId = `idream-probe-${randomUUID()}`;
      const clone = await voice.identity.cloneVoice({
        voiceId: probeVoiceId,
        audio: reference.body,
        contentType: reference.contentType,
        filename: `${input.provider}-probe-reference.wav`,
        language:
          input.provider === "fish-audio"
            ? process.env.FISH_AUDIO_LANGUAGE ?? "auto"
            : process.env.POCKET_TTS_LANGUAGE ?? "english",
        referenceText: input.text,
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
      let clonedSpeech: Awaited<ReturnType<VoiceClipPort["synthesize"]>>;
      let deleted: Awaited<ReturnType<VoiceIdentityPort["deleteVoice"]>>;
      try {
        clonedSpeech = await voice.clip.synthesize({
          requestId: `voice-clone-probe-${input.startedAt}`,
          attemptNo: 1,
          idempotencyKey: `voice-clone-probe-${input.startedAt}:1`,
          text: input.text,
          voiceId: clone.data.voiceId,
        });
      } finally {
        deleted = await voice.identity.deleteVoice({ voiceId: clone.data.voiceId });
      }
      if (!clonedSpeech.ok) {
        return {
          ...baseReport,
          ok: false,
          durationMs: Date.now() - input.startedAt,
          key: null,
          audioDurationMs: undefined,
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
      audioDurationMs: undefined,
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

function hasText(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function defaultVoiceForModel(model: string | null) {
  const normalized = model?.toLowerCase() ?? "";
  if (normalized.includes("qwen3-tts")) return "serena";
  if (normalized.includes("kokoro")) return "af_heart";
  if (normalized.includes("pocket-tts")) return "alba";
  if (normalized.includes("fish-audio")) return "fish-female-default";
  return "default";
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
