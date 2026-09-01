import { randomUUID } from "node:crypto";
import { env } from "./lib/env";
import { createVoicePortsForKey } from "./providers/voice/factory";
import type {
  BlobStore,
  ProviderResult,
  VoiceClipPort,
  VoiceIdentityPort,
  VoiceProviderKey,
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
  "audioDurationMs" | "bytes" | "contentType" | "identity"
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
  // INTENT: 读 lib/env.ts 校验过的 env，而不是自己 `process.env.X ?? 字面量`。
  // 这个探针本来就通过 providers/voice/factory 传递地 import 了 env（那边 import 时
  // 就 parse），所以"探针不能碰 env"在这里并不成立 —— 它只是没用而已，于是把 zod 里
  // 的六个默认值又抄了一遍。probe-chat-model 的超时 bug 就是这么抄出来的：
  // 抄着抄着抄成了不一样的数。这些值目前与 zod 一致，改成引用后不可能再不一致。
  const system = configuredVoiceProbeTarget(env.VOICE_PROVIDER);
  const options = readOptions(defaultVoiceForModel(system.model));
  const systemReport = await runProbe({
    ...system,
    voiceId: options.voiceId,
    text: options.text,
    startedAt,
  });
  const identityProvider = env.VOICE_IDENTITY_PROVIDER;
  let report: VoiceModelProbeEvidence = systemReport;
  if (identityProvider && identityProvider !== system.provider) {
    const identityTarget = configuredVoiceProbeTarget(identityProvider);
    const identityReport = await runProbe({
      ...identityTarget,
      voiceId:
        process.env.VOICE_IDENTITY_PROBE_VOICE_ID ??
        defaultVoiceForModel(identityTarget.model),
      text: options.text,
      startedAt: Date.now(),
    });
    const {
      checkedAt: _identityCheckedAt,
      durationMs: _identityDurationMs,
      ...identity
    } = identityReport;
    report = {
      ...systemReport,
      ok: systemReport.ok === true && identity.ok === true,
      durationMs: Date.now() - startedAt,
      identity,
    };
  }

  if (options.report) {
    await writeProbeReport(options.report, report);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function runProbe(input: {
  provider: "mock" | "pipeline" | "fish-audio" | "pocket-tts";
  providerKey: VoiceProviderKey;
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
  let voiceCatalogAvailable: boolean | null = null;
  let voiceCatalogVerified: boolean | null = null;
  let voiceCatalogSize = 0;
  let catalogVoices: readonly string[] = [];

  try {
    const voice = createVoicePortsForKey(input.providerKey, blob);
    if (voice.identity) {
      const capabilities = await voice.identity.inspectCapabilities();
      voiceCloningAvailable = capabilities.ok
        ? capabilities.data.voiceCloning
        : null;
      catalogVoices = capabilities.ok
        ? (capabilities.data.catalogVoices ?? [])
        : [];
      voiceCatalogSize = catalogVoices.length;
      voiceCatalogAvailable = capabilities.ok
        ? catalogVoices.length > 0
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
        voiceCatalogAvailable,
        voiceCatalogVerified,
        voiceCatalogSize,
        error: {
          code: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable,
        },
      };
    }
    let synthesized = result.data;
    if (input.provider === "pocket-tts" || input.provider === "fish-audio") {
      const identity = voice.identity;
      const pocketReady =
        input.provider === "pocket-tts" &&
        voiceCatalogAvailable === true &&
        catalogVoices.length > 0 &&
        typeof identity?.createPresetVoice === "function";
      const fishReady =
        input.provider === "fish-audio" &&
        voiceCloningAvailable === true &&
        Boolean(identity && blob.stored?.body);
      if (!pocketReady && !fishReady) {
        return {
          ...baseReport,
          ok: false,
          durationMs: Date.now() - input.startedAt,
          key: result.data.key,
          audioDurationMs: result.data.durationMs,
          voiceCloningAvailable,
          voiceCloneVerified:
            input.provider === "fish-audio" ? false : voiceCloneVerified,
          voiceCatalogAvailable,
          voiceCatalogVerified:
            input.provider === "pocket-tts" ? false : voiceCatalogVerified,
          voiceCatalogSize,
          bytes: blob.stored?.size,
          contentType: blob.stored?.contentType,
          error: {
            code:
              input.provider === "pocket-tts"
                ? "voice_catalog_unavailable"
                : "voice_clone_unavailable",
            message:
              input.provider === "pocket-tts"
                ? "pocket-tts did not expose a usable English voice catalog"
                : "fish-audio did not expose a usable voice-cloning capability",
            retryable: false,
          },
        };
      }
      if (!identity) throw new Error("Voice Identity port disappeared during probe");
      const probeVoiceId = `idream-probe-${randomUUID()}`;
      const provisioned = input.provider === "pocket-tts"
        ? await identity.createPresetVoice!({
            voiceId: probeVoiceId,
            presetVoiceId: catalogVoices[0]!,
            language: env.POCKET_TTS_LANGUAGE,
          })
        : await identity.cloneVoice({
            voiceId: probeVoiceId,
            audio: blob.stored!.body,
            contentType: blob.stored!.contentType,
            filename: "fish-audio-probe-reference.wav",
            language: env.FISH_AUDIO_LANGUAGE,
            referenceText: input.text,
          });
      if (!provisioned.ok) {
        return {
          ...baseReport,
          ok: false,
          durationMs: Date.now() - input.startedAt,
          key: result.data.key,
          audioDurationMs: result.data.durationMs,
          voiceCloningAvailable,
          voiceCloneVerified:
            input.provider === "fish-audio" ? false : voiceCloneVerified,
          voiceCatalogAvailable,
          voiceCatalogVerified:
            input.provider === "pocket-tts" ? false : voiceCatalogVerified,
          voiceCatalogSize,
          bytes: blob.stored?.size,
          contentType: blob.stored?.contentType,
          error: {
            code: provisioned.error.code,
            message: provisioned.error.message,
            retryable: provisioned.error.retryable,
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
          voiceId: provisioned.data.voiceId,
        });
      } finally {
        deleted = await identity.deleteVoice({ voiceId: provisioned.data.voiceId });
      }
      if (!clonedSpeech.ok) {
        return {
          ...baseReport,
          ok: false,
          durationMs: Date.now() - input.startedAt,
          key: null,
          audioDurationMs: undefined,
          voiceCloningAvailable,
          voiceCloneVerified:
            input.provider === "fish-audio" ? false : voiceCloneVerified,
          voiceCatalogAvailable,
          voiceCatalogVerified:
            input.provider === "pocket-tts" ? false : voiceCatalogVerified,
          voiceCatalogSize,
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
          voiceCloneVerified:
            input.provider === "fish-audio" ? false : voiceCloneVerified,
          voiceCatalogAvailable,
          voiceCatalogVerified:
            input.provider === "pocket-tts" ? false : voiceCatalogVerified,
          voiceCatalogSize,
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
      if (input.provider === "pocket-tts") {
        voiceCatalogVerified = true;
      } else {
        voiceCloneVerified = true;
      }
    }

    return {
      ...baseReport,
      ok: hasText(synthesized.key) && synthesized.durationMs > 0,
      durationMs: Date.now() - input.startedAt,
      key: synthesized.key,
      audioDurationMs: synthesized.durationMs,
      voiceCloningAvailable,
      voiceCloneVerified,
      voiceCatalogAvailable,
      voiceCatalogVerified,
      voiceCatalogSize,
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
      voiceCatalogAvailable,
      voiceCatalogVerified,
      voiceCatalogSize,
      error: {
        code: "voice_model_probe_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }
}

function configuredVoiceProbeTarget(
  provider: "mock" | "pipeline" | "fish-audio" | "pocket-tts",
) {
  if (provider === "pocket-tts") {
    return {
      provider,
      providerKey: "pocket_tts" as const,
      baseUrl: env.POCKET_TTS_API_URL,
      model: env.POCKET_TTS_MODEL,
    };
  }
  if (provider === "fish-audio") {
    return {
      provider,
      providerKey: "fish_audio" as const,
      baseUrl: env.FISH_AUDIO_API_URL,
      model: env.FISH_AUDIO_MODEL,
    };
  }
  if (provider === "mock") {
    return {
      provider,
      providerKey: provider,
      baseUrl: null,
      model: process.env.PIPELINE_VOICE_MODEL_DEFAULT ?? "mock-voice-probe",
    };
  }
  return {
    provider,
    providerKey: provider,
    baseUrl: env.PIPELINE_VOICE_API_URL ?? env.PIPELINE_API_URL ?? null,
    model: env.PIPELINE_VOICE_MODEL_DEFAULT,
  };
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
