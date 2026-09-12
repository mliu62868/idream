import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";

export type VoiceCallAvailability = {
  status: "unavailable" | "available";
  reason?: "provider_unconfigured" | "transport_unimplemented";
  provider?: string;
};

/**
 * Voice Clip playback is intentionally not treated as Voice Call. Until a
 * bidirectional STT/TTS transport and durable call ledger are configured,
 * every call operation fails closed with an actionable capability response.
 */
export function voiceCallAvailability(): VoiceCallAvailability {
  const provider = process.env.CHAT_VOICE_CALL_PROVIDER?.trim();
  if (!provider || !process.env.CHAT_VOICE_CALL_TRANSPORT_URL?.trim()) {
    return { status: "unavailable", reason: provider ? "transport_unimplemented" : "provider_unconfigured" };
  }
  return { status: "available", provider };
}

export async function getVoiceCallCapability(userId: string, sessionId: string) {
  const session = await prisma.recentChat.findFirst({ where: { userId, sessionId }, select: { sessionId: true } });
  if (!session) throw Errors.notFound("Chat session not found");
  return { sessionId, ...voiceCallAvailability() };
}

export async function startVoiceCall(userId: string, sessionId: string): Promise<never> {
  await getVoiceCallCapability(userId, sessionId);
  throw Errors.unavailable("Two-way Voice Call is unavailable until its STT/TTS transport is configured");
}
