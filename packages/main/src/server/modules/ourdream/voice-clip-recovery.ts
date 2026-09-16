import { prisma } from "@/server/lib/db";
import { logger } from "@/server/lib/logger";
import { reclaimExpiredVoiceClip, type VoiceClipDependencies } from "./voice-clip";

// A sweep reuses admission's pinned payload, consent and provider key. It never
// retries failed/unknown requests or invents another charge. Two crash takeovers
// are enough for automatic recovery; further attempts require an operator.
export async function recoverExpiredVoiceClips(input: {
  readonly deps: VoiceClipDependencies;
  readonly cursorId?: string | null;
}) {
  const candidate = await prisma.voiceClipRequest.findFirst({
    where: {
      status: "running",
      attemptNo: { lt: 3 },
      AND: [
        { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }] },
        { OR: [{ errorCode: null }, { errorCode: { not: "provider_outcome_unknown" } }] },
      ],
      ...(input.cursorId ? { id: { gt: input.cursorId } } : {}),
    },
    orderBy: { id: "asc" },
    select: { id: true, characterId: true },
  });
  if (!candidate) return { examined: 0, recovered: 0, nextCursorId: null };
  // An operator command owns its own atomic receipt. Let its existing takeover
  // protocol resolve a crash rather than completing the clip behind its back.
  const command = await prisma.controlPlaneCommand.findFirst({
    where: {
      commandType: "character.voice_clip.reclaim",
      targetId: candidate.id,
      status: { in: ["accepted", "running"] },
    },
    select: { id: true },
  });
  if (command) return { examined: 1, recovered: 0, nextCursorId: candidate.id };
  try {
    await reclaimExpiredVoiceClip({
      requestId: candidate.id,
      characterId: candidate.characterId,
      deps: input.deps,
    });
    return { examined: 1, recovered: 1, nextCursorId: candidate.id };
  } catch (error) {
    // Advance even for legacy payloads/withdrawn Characters so one blocked row
    // cannot starve the rest. The reclaim CAS leaves another owner's lease intact.
    logger.warn({ error, voiceClipRequestId: candidate.id }, "voice lease recovery deferred");
    return { examined: 1, recovered: 0, nextCursorId: candidate.id };
  }
}
