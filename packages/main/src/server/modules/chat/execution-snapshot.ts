// Immutable per-attempt execution snapshot frozen before admission.
import type { ChatExecutionSnapshot, ChatContextDirective, ChatExperiencePreference, UserChatPersona, RecoveredMediaAction } from "@idream/shared/contracts";
import { chatContextDirectivesSchema, chatExecutionSnapshotSchema, chatExperiencePreferenceSchema } from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { AppError, Errors } from "@/server/lib/errors";
import { ZodError } from "zod";
import { userChatPersonaForTurn } from "./user-persona";
import { DEFAULT_PROFILE_EXPERIENCE } from "./conversation-profiles";
import { deliveredChatMedia } from "./chat-media-history";
import { fail, toJson } from "./turn-ledger-support";

/** A snapshot that can never become executable (corrupt, missing Turn, invalid shape). */
export class InvalidExecutionSnapshotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InvalidExecutionSnapshotError";
  }
}

/** Deterministic snapshot failures; transient database errors are not among them. */
export function isPermanentSnapshotFailure(error: unknown): boolean {
  return error instanceof InvalidExecutionSnapshotError
    || error instanceof ZodError
    || (error instanceof AppError && error.status === 404);
}

export async function executionSnapshot(turnId: string): Promise<ChatExecutionSnapshot> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "chat_turns" WHERE id = ${turnId} FOR UPDATE`;
    // Newly accepted Turns already carry their explicit context. A legacy
    // missing snapshot must not acquire today's settings during recovery.
    return frozenExecutionSnapshot(tx, turnId, true, [], null, null, { preservedImageEditSourceAssetId: null });
  });
}

export async function frozenExecutionSnapshot(
  tx: Prisma.TransactionClient,
  turnId: string,
  memoryEnabled = true,
  preservedDirectives?: ChatContextDirective[],
  preservedExperience?: ChatExperiencePreference | null,
  preservedUserPersona?: UserChatPersona | null,
  media?: { recoveredMediaAction?: RecoveredMediaAction; userMessageRevision?: number; preservedImageEditSourceAssetId?: string | null },
): Promise<ChatExecutionSnapshot> {
  const turn = await tx.chatTurn.findUnique({
    where: { id: turnId }, include: { session: true, groupTurn: true },
  });
  if (!turn) throw Errors.notFound("Chat turn not found");
  const persisted = turn.executionSnapshot;
  if (persisted) {
    const parsed = chatExecutionSnapshotSchema.safeParse(persisted);
    if (parsed.success) return parsed.data;
    throw new InvalidExecutionSnapshotError("Chat Turn has an invalid frozen execution snapshot", { cause: parsed.error });
  }
  const recent = await tx.chatTurn.findMany({
    where: {
      ...(turn.groupTurn
        ? { groupTurn: { groupId: turn.groupTurn.groupId, ordinal: { lt: turn.groupTurn.ordinal } } }
        : { sessionId: turn.sessionId, createdAt: { lt: turn.createdAt } }),
      assistantStatus: "sent",
    },
    orderBy: turn.groupTurn ? { groupTurn: { ordinal: "desc" } } : [{ createdAt: "desc" }, { id: "desc" }],
    take: 24,
    select: {
      id: true, userMessageId: true, assistantMessageId: true, userContent: true,
      assistantContent: true, origin: true, createdAt: true,
      session: { select: { sessionId: true, characterId: true, title: true } },
    },
  });
  recent.reverse();
  const groupMembers = turn.groupTurn ? await tx.recentChat.findMany({
    where: { groupId: turn.groupTurn.groupId, userId: turn.session.userId },
    orderBy: { groupPosition: "asc" }, select: { sessionId: true, characterId: true, title: true },
  }) : null;
  // Explicit settings are copied once, not ingested as synthetic chat messages.
  // Revisions of the same Turn retain its original user context, including an
  // empty historical snapshot; temporary igrep rebuild isolation does not erase it.
  const contextDirectives = chatContextDirectivesSchema.parse(
    (preservedDirectives ?? await tx.chatContextDirective.findMany({
      where: {
        userId: turn.session.userId,
        characterId: turn.session.characterId,
        status: "active",
        ...(turn.memoryEnabled ? {} : { kind: "custom_instruction" }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, kind: true, content: true, version: true },
    })).filter((item) => turn.memoryEnabled || item.kind === "custom_instruction"),
  );
  const experienceRow = preservedExperience !== undefined ? preservedExperience : await tx.chatExperiencePreference.findUnique({
    where: { sessionId: turn.sessionId },
    select: { responseLength: true, interactionIntensity: true, sceneGeneration: true, conversationProfile: true, version: true },
  });
  const experience = experienceRow
    ? chatExperiencePreferenceSchema.parse({ ...experienceRow, conversationProfile: experienceRow.conversationProfile ?? undefined })
    : preservedExperience === undefined ? DEFAULT_PROFILE_EXPERIENCE : null;
  const mediaHistory = { userId: turn.session.userId, characterId: turn.session.characterId,
    sessionId: turn.sessionId, before: turn.createdAt };
  const recentMedia = await deliveredChatMedia(tx, { ...mediaHistory, limit: 8 });
  const imageEditSourceAssetId = media?.preservedImageEditSourceAssetId !== undefined
    ? media.preservedImageEditSourceAssetId
    : (recentMedia.find(item => item.asset.type === "image")
      ?? (await deliveredChatMedia(tx, { ...mediaHistory, kind: "image", limit: 1 }))[0])?.asset.id ?? null;
  const snapshot = chatExecutionSnapshotSchema.parse({
    version: 1,
    turnId: turn.id,
    sessionId: turn.sessionId,
    userMessageId: turn.userMessageId,
    assistantMessageId: turn.assistantMessageId,
    attempt: turn.attempt,
    userId: turn.session.userId,
    characterId: turn.session.characterId,
    characterContentVersionId:
      turn.characterContentVersionId ?? fail("Chat Turn has no immutable Character content pin"),
    characterReleaseId: turn.characterReleaseId,
    characterVisualProfileId: turn.characterVisualProfileId,
    characterVisualProfileVersion: turn.characterVisualProfileVersion,
    memoryEnabled: turn.memoryEnabled && memoryEnabled,
    contextDirectives,
    ...(experience ? { experience } : {}),
    userPersona: preservedUserPersona === undefined
      ? await userChatPersonaForTurn(tx, turn.session.userId)
      : preservedUserPersona,
    contextRevision: turn.session.contextRevision,
    userContent: turn.userContent,
    imageActionMode: turn.imageActionMode,
    ...(media?.userMessageRevision ? { userMessageRevision: media.userMessageRevision } : {}),
    ...(media?.recoveredMediaAction ? { recoveredMediaAction: media.recoveredMediaAction } : {}),
    ...(turn.groupTurn && groupMembers ? { group: {
      id: turn.groupTurn.groupId,
      ordinal: turn.groupTurn.ordinal,
      members: groupMembers.map(member => ({ sessionId: member.sessionId, characterId: member.characterId, name: member.title ?? "Character" })),
    } } : {}),
    imageEditSourceAssetId,
    hasRecentImageContext: imageEditSourceAssetId !== null,
    recentMedia: recentMedia.map(({ asset, attachment, description, facts, absentFacts, nudity, durationSeconds, hasAudio, editProvenance }) => ({
      mediaAssetId: asset.id, kind: asset.type, turnId: attachment.turnId, description,
      facts, absentFacts, nudity, durationSeconds, hasAudio,
      ...(editProvenance ? { editProvenance } : {}),
    })),
    recentTurns: recent.map((item) => ({
      turnId: item.id,
      userMessageId: item.userMessageId,
      assistantMessageId: item.assistantMessageId,
      userContent: item.userContent,
      assistantContent: item.assistantContent,
      createdAt: item.createdAt.toISOString(),
      ...(turn.groupTurn ? { speaker: { sessionId: item.session.sessionId, characterId: item.session.characterId, name: item.session.title ?? "Character" } } : {}),
      // The directive that triggered a proactive Turn is carried so Chat can
      // replay the Character's words without replaying a user who said nothing.
      ...(item.origin === "proactive" ? { origin: "proactive" as const } : {}),
    })),
    sceneVersion: turn.sceneVersion,
    scene: turn.scene,
  });
  await tx.chatTurn.update({
    where: { id: turn.id },
    data: { executionSnapshot: toJson(snapshot) },
  });
  return snapshot;
}
