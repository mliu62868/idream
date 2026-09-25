import { createHash } from "node:crypto";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { previewConfiguredVoiceIdentity } from "@/server/modules/admin-v2/characters/voice-identity";
import { resolveCharacterVoiceAuthority } from "@/server/modules/voice-defaults";
import { providers } from "@/server/providers";
import { encodeVoiceClipMp3 } from "@/server/providers/voice/transcode";

// SPEC: 角色详情页「Hear voice」的营销试听。每个「角色当前声音 profile 版本」只合成一次，
//   结果按确定性 key 缓存进 Blob；profile 换版后 key 随之变化，旧缓存自然失效。
// INTENT: 固定、与角色无关的中性文本（与 Create 选声音时的试听同一句）。不用开场白：
//   它是创作者写的、可能含私有或未审核内容，试听会把它变成对外可播放的音频。
// INTENT: 不扣额度也不扣币 —— 这是开聊前的转化触点，每个版本全站只合成一次，
//   成本与观众数无关；滥用面由限流（voiceSample）兜住。
export const VOICE_SAMPLE_TEXT = "Hello, it's good to meet you. I'm happy we can spend some time together.";
const VOICE_SAMPLE_FORMAT_VERSION = 1;

type VoiceSample = { body: Uint8Array; contentType: string };

// 同一进程的并发首请求共用一次合成，免得每个等待者都占着一条 DB 连接排 advisory 锁。
const inflight = new Map<string, Promise<VoiceSample>>();

// SPEC: 只有绑定了 active 声音 profile 的角色才有试听；落回系统默认声音的（legacy /
//   未绑定 / 悬空指针）返回 null —— 与 Voice Clip 的声音权威同一判据。
export async function characterVoiceSampleProfile(characterId: string) {
  const authority = await resolveCharacterVoiceAuthority({ characterId });
  if (authority.source !== "character_clone" || authority.characterVoiceProfileVersion === null) return null;
  return {
    providerKey: authority.providerKey,
    voiceId: authority.voiceId,
    version: authority.characterVoiceProfileVersion,
    delivery: authority.delivery,
  };
}

// INVARIANT: 调用方已确认该角色对当前观众可见；这里只负责「有声音 → 取或合成一次」。
export async function characterVoiceSample(characterId: string): Promise<VoiceSample> {
  const profile = await characterVoiceSampleProfile(characterId);
  if (!profile) throw Errors.notFound("Character has no voice sample");
  const digest = createHash("sha256").update(JSON.stringify({
    format: VOICE_SAMPLE_FORMAT_VERSION, text: VOICE_SAMPLE_TEXT, ...profile,
  })).digest("hex").slice(0, 32);
  const key = `voice-samples/characters/${characterId}/v${profile.version}-${digest}`;
  const cached = await readCachedSample(key);
  if (cached) return cached;
  let pending = inflight.get(key);
  if (!pending) {
    pending = synthesizeOnce(key, profile).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

// INVARIANT: 跨进程也只合成一次 —— advisory 锁串行化同一 key，拿到锁后再查一次缓存。
async function synthesizeOnce(
  key: string,
  profile: NonNullable<Awaited<ReturnType<typeof characterVoiceSampleProfile>>>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`voice-sample:${key}`}))`;
    const cached = await readCachedSample(key);
    if (cached) return cached;
    const preview = await previewConfiguredVoiceIdentity({
      providerKey: profile.providerKey,
      text: VOICE_SAMPLE_TEXT,
      voiceId: profile.voiceId,
      delivery: profile.delivery,
    });
    const mp3 = await encodeVoiceClipMp3(preview.body, { ffmpegBin: env.VOICE_FFMPEG_BIN });
    if (!mp3) logger.warn({ key }, "Voice sample MP3 encoding failed; caching WAV");
    const body = mp3 ?? preview.body;
    const contentType = sniffAudioContentType(body);
    const stored = await providers.blob.putPrivate({ key, body, contentType });
    if (!stored.ok) throw Errors.unavailable("Voice sample storage failed", stored.error);
    return { body, contentType };
  }, { timeout: env.POCKET_TTS_TIMEOUT_MS + 60_000 });
}

async function readCachedSample(key: string): Promise<VoiceSample | null> {
  const read = await providers.blob.getPrivate?.({ key });
  if (!read) throw Errors.unavailable("Voice sample storage cannot be read");
  if (!read.ok) {
    if (read.error.code === "not_found") return null;
    throw Errors.unavailable("Voice sample storage is unavailable", read.error);
  }
  return { body: read.data.body, contentType: sniffAudioContentType(read.data.body) };
}

// Blob key 不带扩展名（转码可能回退 WAV），本地 Blob 也不存 content-type，按文件头判断。
function sniffAudioContentType(body: Uint8Array) {
  return String.fromCharCode(...body.subarray(0, 4)) === "RIFF" ? "audio/wav" : "audio/mpeg";
}
