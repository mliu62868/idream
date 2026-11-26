// Session pinning and Serving Release gates shared by reads and commands.
import { loadCharacterSoulSnapshot } from "@idream/shared";
import { Prisma, type RecentChat } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { AppError, Errors } from "@/server/lib/errors";
import { directCharacterAudienceWhere } from "@/server/modules/ourdream/public-content-audience";
import { ACTIVE_ASSISTANT_STATES, firstMessage } from "./turn-ledger-support";

// A group member and a single-character session use exactly the same audience
// and immutable Release pinning rules.
export async function chatSessionCharacterPin(
  userId: string,
  characterId: string,
  tx: Prisma.TransactionClient = prisma,
) {
  const character = await tx.character.findFirst({
    where: {
      id: characterId,
      age: { gte: 18 },
      deletedAt: null,
      OR: [
        { creatorId: userId },
        directCharacterAudienceWhere,
      ],
    },
    include: {
      currentContentVersion: true,
      serving: { include: { currentRelease: true } },
      visualProfiles: { where: { status: "active" }, orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!character) throw Errors.notFound("Character not found");

  const owner = character.creatorId === userId;
  const servingRelease = character.serving?.state === "live" &&
      character.serving.currentRelease?.status === "published"
    ? character.serving.currentRelease
    : null;
  if (!owner && !servingRelease) {
    throw Errors.gone("Character is not backed by an active Serving Release");
  }
  const release = servingRelease;
  const content = release
    ? await tx.characterContentVersion.findUnique({
        where: { id: release.characterContentVersionId },
      })
    : character.currentContentVersion;
  if (!content) {
    throw Errors.gone("Character has no immutable Chat content version");
  }
  // New sessions must pin a runnable Soul. Historical reads and accepted Turn
  // replay keep their own immutable authority and do not re-enter this gate.
  if (content.characterId !== character.id || !loadCharacterSoulSnapshot(content.personaSnapshot).ok) {
    throw Errors.gone("Character has no valid immutable Chat Soul");
  }
  const openingMessage = firstMessage(content.openingSnapshot) ?? null;
  const visual = release
    ? { id: release.visualProfileId, version: release.visualProfileVersion }
    : character.visualProfiles[0]
      ? { id: character.visualProfiles[0].id, version: character.visualProfiles[0].version }
      : null;
  return { character, owner, release, content, visual, openingMessage };
}

export async function requireSession(userId: string, sessionId: string) {
  const session = await prisma.recentChat.findFirst({ where: { sessionId, userId } });
  if (!session) throw Errors.notFound("Chat session not found");
  return session;
}

export async function requireActiveSession(userId: string, sessionId: string) {
  const session = await requireSession(userId, sessionId);
  if (session.status !== "active") throw Errors.gone("Chat session is archived");
  return session;
}

/**
 * SPEC: the author's own Release-pinned session follows the Character's serving
 * Release; the next Turn runs on the version the author just published.
 * INTENT: readers get a new session when Serving moves (their pin is the version
 * they chose to talk to). The author is the one who changed it, and archiving
 * their chat on every publish would bury it; re-pinning in place keeps one
 * conversation, while every existing Turn keeps its own frozen pins (CR-08).
 * A session whose reply is still pending/generating keeps its pin until the
 * reply ends. A session without a Release pin (private-era) is left alone: it
 * already follows the author's saved edits through character-edit.
 * INVARIANT: caller holds the session row lock (lockChatScope or beginChatTurn).
 */
export async function repinOwnerSessionToServingRelease<T extends {
  sessionId: string;
  characterId: string;
  characterReleaseId: string | null;
}>(tx: Prisma.TransactionClient, userId: string, session: T): Promise<T | RecentChat> {
  if (!session.characterReleaseId) return session;
  const character = await tx.character.findUnique({
    where: { id: session.characterId },
    select: { creatorId: true, serving: { select: { state: true, currentRelease: true } } },
  });
  const serving = character?.serving;
  const release = serving?.state === "live" && serving.currentRelease?.status === "published"
    ? serving.currentRelease
    : null;
  if (character?.creatorId !== userId || !release || release.id === session.characterReleaseId) return session;
  const active = await tx.chatTurn.findFirst({
    where: { sessionId: session.sessionId, assistantStatus: { in: ACTIVE_ASSISTANT_STATES } },
    select: { id: true },
  });
  if (active) return session;
  return tx.recentChat.update({
    where: { sessionId: session.sessionId },
    data: {
      characterReleaseId: release.id,
      characterContentVersionId: release.characterContentVersionId,
      characterVisualProfileId: release.visualProfileId,
      characterVisualProfileVersion: release.visualProfileVersion,
      releasePinnedAt: new Date(),
      // Same as the operator Release migration: Chat's cached context is stale.
      contextRevision: { increment: 1 },
    },
  });
}

export async function assertChatSessionServingAuthority(
  tx: Prisma.TransactionClient,
  userId: string,
  session: { characterId: string; characterReleaseId: string | null },
): Promise<void> {
  const character = await tx.character.findUnique({
    where: { id: session.characterId },
    select: {
      creatorId: true,
      visibility: true,
      status: true,
      deletedAt: true,
      serving: {
        select: {
          state: true,
          currentRelease: { select: { id: true, status: true } },
        },
      },
    },
  });
  if (!character || character.deletedAt) throw Errors.gone("Character is unavailable");
  if (character.creatorId === userId) return;
  const publicServingIsLive =
    ["public", "unlisted"].includes(character.visibility) &&
    character.status === "approved" &&
    character.serving?.state === "live" &&
    character.serving.currentRelease?.status === "published";
  if (publicServingIsLive && character.serving?.currentRelease?.id === session.characterReleaseId) return;
  // INTENT: a session never leaves its Release pin, so after an update this one
  // stays read-only. To the reader that is "the Character changed", not "the chat
  // broke": the reason lets the page open the Character's current chat
  // (createChatSession) and carry the unsent message over. Nothing was admitted
  // or charged — this runs before any Turn or usage fact exists.
  throw Errors.gone(
    "Character has no active Serving Release",
    publicServingIsLive ? { reason: "character_release_changed", characterId: session.characterId } : undefined,
  );
}

// Historical reads keep their immutable content. New actions use exactly the
// same Serving gate as admission, so the page can explain a pause or update
// before asking the reader to send an impossible request.
export async function chatSessionContinuation(
  tx: Prisma.TransactionClient,
  userId: string,
  session: { characterId: string; characterReleaseId: string | null },
): Promise<"available" | "character_unavailable" | "character_release_changed"> {
  try {
    await assertChatSessionServingAuthority(tx, userId, session);
    return "available";
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "gone") throw error;
    const details = error.details;
    return details && typeof details === "object" && "reason" in details
      && details.reason === "character_release_changed"
      ? "character_release_changed"
      : "character_unavailable";
  }
}
