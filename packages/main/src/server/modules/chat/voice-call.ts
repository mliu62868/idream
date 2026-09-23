import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

export type VoiceCallAvailability = {
  status: "unavailable";
  reason: "transport_unimplemented";
};

/**
 * SPEC: Voice Call (PRD CH-14) has no bidirectional STT/TTS transport, call
 * ledger or settlement yet, so every call operation fails closed.
 * INTENT: availability used to turn "available" as soon as two env vars were
 * set, while start still threw 503 unconditionally — a UI trusting it would
 * offer a button that can only fail. Until the transport exists in code, no
 * configuration can make it available. Voice Clip playback is not Voice Call.
 */
export function voiceCallAvailability(): VoiceCallAvailability {
  return { status: "unavailable", reason: "transport_unimplemented" };
}

export async function getVoiceCallCapability(userId: string, sessionId: string) {
  const session = await prisma.recentChat.findFirst({ where: { userId, sessionId }, select: { sessionId: true } });
  if (!session) throw Errors.notFound("Chat session not found");
  return { sessionId, ...voiceCallAvailability() };
}

export async function startVoiceCall(userId: string, sessionId: string): Promise<never> {
  await getVoiceCallCapability(userId, sessionId);
  throw Errors.unavailable("Two-way Voice Call is not implemented yet");
}
