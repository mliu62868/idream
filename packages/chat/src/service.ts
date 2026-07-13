// SPEC: chat/web operations (design §3, PRD §8/§9). The web layer re-checks the
// read-only views (never trusts BFF headers), does input moderation + rate limit
// locally, then in ONE transaction writes user msg(sent) + assistant
// placeholder(pending) + bumps session; chat.generate owns pending→generating.
// {assistantMessageId, streamUrl}. NO synchronous generation in the request.
import type { ChatPrismaClient } from "./db.js";
import type { Prisma } from "../generated/client/client.js";
import { chatPrisma } from "./db.js";
import { providers } from "./providers.js";
import { createId } from "./id.js";
import { FREE_DAILY_MESSAGES } from "./limits.js";
import { enqueue } from "./queue.js";
import { streamKey } from "./stream.js";
import { recordOutbox, scheduleOutboxDelivery } from "./outbox.js";
import { recordExchangeCorrection } from "./exchange-corrections.js";
import { resolvePolicy, snapshotFromView } from "./policy.js";
import type { ChatPolicy } from "./policy.js";
import { logger } from "./logger.js";
import {
  CHAT_QUEUES,
  CHAT_TO_MAIN_EVENTS,
  idempotencyKeys,
  type ChatGeneratePayload,
  type ChatImageRequestedPayload,
} from "@idream/shared/contracts";

export class ChatError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface ChatContext {
  prisma: ChatPrismaClient;
}

function ctx(override?: Partial<ChatContext>): ChatContext {
  return { prisma: override?.prisma ?? chatPrisma };
}

/** Verify the user may chat with this character (views are authority). */
async function assertEligible(prisma: ChatPrismaClient, userId: string, characterId: string) {
  const [user, character, eligibility] = await Promise.all([
    prisma.chatUserView.findUnique({ where: { userId } }),
    prisma.chatCharacterView.findUnique({ where: { characterId } }),
    prisma.chatUserEligibilityView.findUnique({ where: { userId } }),
  ]);
  if (!user || user.status !== "active" || user.deletedAt) {
    throw new ChatError("user_inactive", "user not active", 403);
  }
  if (!character) throw new ChatError("character_not_found", "character not found", 404);
  if (character.visibility !== "public" && character.creatorId !== userId) {
    throw new ChatError("character_unavailable", "character not available", 403);
  }
  if (character.status !== "approved" && character.creatorId !== userId) {
    throw new ChatError("character_unavailable", "character not available", 403);
  }
  if (character.age < 18) throw new ChatError("character_underage", "character not allowed", 403);
  if (!eligibility?.ageGateAccepted) {
    throw new ChatError("age_gate_required", "age gate acceptance required", 403);
  }
  if (eligibility.restrictedReason) {
    throw new ChatError("restricted", eligibility.restrictedReason, 403);
  }
  return { user, character };
}

export async function createSession(
  input: {
    userId: string;
    characterId: string;
    title?: string;
    entryExposureId?: string;
    entryJourneyId?: string;
    entryPlacementId?: string;
  },
  override?: Partial<ChatContext>,
) {
  const { prisma } = ctx(override);
  const { character } = await assertEligible(prisma, input.userId, input.characterId);
  const attributionValues = [input.entryExposureId, input.entryJourneyId, input.entryPlacementId];
  const attributionCount = attributionValues.filter(Boolean).length;
  if (attributionCount !== 0 && attributionCount !== attributionValues.length) {
    throw new ChatError("invalid_entry_attribution", "entry attribution must be complete or absent", 400);
  }

  // The product exposes one active conversation per user/character pair. The
  // advisory lock makes the read-then-create invariant true under concurrent
  // requests without coupling the independently deployable chat schema to a
  // partial-unique-index-specific error path.
  return prisma.$transaction(async (tx) => {
    await advisoryLock(tx, `session:${input.userId}:${input.characterId}`);
    const existing = await tx.chatSession.findFirst({
      where: { userId: input.userId, characterId: input.characterId, status: "active" },
      orderBy: { lastMessageAt: "desc" },
    });
    if (existing) return existing;

    const id = createId("sess");
    const created = await tx.chatSession.create({
      data: {
        id,
        userId: input.userId,
        characterId: input.characterId,
        title: input.title ?? null,
        characterContentVersionId: character.characterContentVersionId,
        characterReleaseId: character.characterReleaseId,
        releasePinnedAt: character.characterContentVersionId ? new Date() : null,
        entryExposureId: input.entryExposureId ?? null,
        entryJourneyId: input.entryJourneyId ?? null,
        entryPlacementId: input.entryPlacementId ?? null,
      },
    });
    await recordOutbox(tx, {
      eventType: CHAT_TO_MAIN_EVENTS.sessionCreated,
      aggregateType: "session",
      aggregateId: id,
      payload: {
        userId: input.userId,
        characterId: input.characterId,
        characterContentVersionId: character.characterContentVersionId,
        characterReleaseId: character.characterReleaseId,
        entryExposureId: input.entryExposureId ?? null,
        journeyId: input.entryJourneyId ?? null,
        placementId: input.entryPlacementId ?? null,
      },
    });
    return created;
  });
}

export async function listSessions(userId: string, override?: Partial<ChatContext>) {
  const { prisma } = ctx(override);
  return prisma.chatSession.findMany({
    where: { userId, status: { not: "deleted" } },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
  });
}

export async function getSession(
  input: { userId: string; sessionId: string },
  override?: Partial<ChatContext>,
) {
  const { prisma } = ctx(override);
  const session = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
  if (!session || session.userId !== input.userId || session.status === "deleted") {
    throw new ChatError("session_not_found", "session not found", 404);
  }
  const newestMessages = await prisma.message.findMany({
    where: { sessionId: session.id, deletedAt: null, status: { not: "deleted" } },
    // Fetch the tail, not the oldest page. Assistant sorts before user in the
    // DESC query so reversing restores user → assistant for equal TX timestamps.
    orderBy: [{ createdAt: "desc" }, { role: "asc" }],
    take: 200,
  });
  const messages = newestMessages.reverse();
  const attachments = await prisma.messageAttachment.findMany({
    where: { messageId: { in: messages.map((message) => message.id) } },
    orderBy: { createdAt: "asc" },
  });
  const byMessage = new Map<string, typeof attachments>();
  for (const attachment of attachments) {
    byMessage.set(attachment.messageId, [...(byMessage.get(attachment.messageId) ?? []), attachment]);
  }
  return {
    session,
    messages: messages.map((message) => ({
      ...message,
      attachments: byMessage.get(message.id) ?? [],
    })),
  };
}

export interface SendResult {
  assistantMessageId: string;
  userMessageId: string;
  /** null when the input was blocked — there is no stream to consume (design P0-B). */
  streamUrl: string | null;
  status: "generating" | "blocked";
  safety?: { layer: "input" | "output"; policyCode?: string };
}

export type EditMessageResult = SendResult;

const MAX_MESSAGE_LENGTH = 12_000;
const ENGAGEMENT_INACTIVITY_MS_V1 = 30 * 60 * 1_000;

function normalizeMessageContent(value: string): string {
  const content = value.trim();
  if (!content) throw new ChatError("empty_message", "message is empty", 400);
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new ChatError("message_too_long", `message exceeds ${MAX_MESSAGE_LENGTH} characters`, 400);
  }
  return content;
}

async function allocateEngagementSessionId(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: Date,
): Promise<string> {
  const latestSuccessfulAssistant = await tx.message.findFirst({
    where: { sessionId, role: "assistant", status: "sent", deletedAt: null },
    orderBy: { updatedAt: "desc" },
    select: { replyToMessageId: true, updatedAt: true },
  });
  if (
    latestSuccessfulAssistant?.replyToMessageId &&
    now.getTime() - latestSuccessfulAssistant.updatedAt.getTime() < ENGAGEMENT_INACTIVITY_MS_V1
  ) {
    const priorTurn = await tx.message.findUnique({
      where: { id: latestSuccessfulAssistant.replyToMessageId },
      select: { engagementSessionId: true },
    });
    if (priorTurn?.engagementSessionId) return priorTurn.engagementSessionId;
  }
  return createId("eng");
}

interface SessionPin {
  readonly characterContentVersionId: string | null;
  readonly characterReleaseId: string | null;
}

async function resolveSessionPin(
  tx: Prisma.TransactionClient,
  session: {
    readonly id: string;
    readonly characterId: string;
    readonly characterContentVersionId: string | null;
    readonly characterReleaseId: string | null;
  },
): Promise<SessionPin> {
  const pendingMigration = await tx.chatSessionReleaseMigration.findFirst({
    where: { sessionId: session.id, status: "pending" },
    orderBy: { requestedAt: "asc" },
  });
  if (pendingMigration) {
    const sourceStillMatches =
      session.characterContentVersionId === pendingMigration.fromCharacterContentVersionId &&
      session.characterReleaseId === pendingMigration.fromCharacterReleaseId;
    if (!sourceStillMatches) {
      throw new ChatError(
        "session_release_migration_conflict",
        "session release changed after migration approval",
        409,
      );
    }
    const appliedAt = new Date();
    await tx.chatSession.update({
      where: { id: session.id },
      data: {
        characterContentVersionId: pendingMigration.toCharacterContentVersionId,
        characterReleaseId: pendingMigration.toCharacterReleaseId,
        releasePinnedAt: appliedAt,
      },
    });
    await tx.chatSessionReleaseMigration.update({
      where: { id: pendingMigration.id },
      data: { status: "applied", appliedAt },
    });
    await recordOutbox(tx, {
      eventType: CHAT_TO_MAIN_EVENTS.sessionReleaseMigrationApplied,
      schemaVersion: 2,
      aggregateType: "session_release_migration",
      aggregateId: pendingMigration.commandId,
      payload: {
        commandId: pendingMigration.commandId,
        sessionId: session.id,
        characterId: session.characterId,
        fromCharacterContentVersionId: pendingMigration.fromCharacterContentVersionId,
        fromCharacterReleaseId: pendingMigration.fromCharacterReleaseId,
        toCharacterContentVersionId: pendingMigration.toCharacterContentVersionId,
        toCharacterReleaseId: pendingMigration.toCharacterReleaseId,
        appliedAt: appliedAt.toISOString(),
      },
    });
    return {
      characterContentVersionId: pendingMigration.toCharacterContentVersionId,
      characterReleaseId: pendingMigration.toCharacterReleaseId,
    };
  }

  if (session.characterContentVersionId) {
    return {
      characterContentVersionId: session.characterContentVersionId,
      characterReleaseId: session.characterReleaseId,
    };
  }

  // Legacy sessions intentionally remain exact_unattributed for historical
  // turns. Their first post-cutover turn pins the serving snapshot visible at
  // that instant; no earlier Message row is rewritten.
  const current = await tx.chatCharacterView.findUnique({
    where: { characterId: session.characterId },
    select: { characterContentVersionId: true, characterReleaseId: true },
  });
  if (!current?.characterContentVersionId) {
    return { characterContentVersionId: null, characterReleaseId: null };
  }
  const pinnedAt = new Date();
  await tx.chatSession.update({
    where: { id: session.id },
    data: {
      characterContentVersionId: current.characterContentVersionId,
      characterReleaseId: current.characterReleaseId,
      releasePinnedAt: pinnedAt,
    },
  });
  return {
    characterContentVersionId: current.characterContentVersionId,
    characterReleaseId: current.characterReleaseId,
  };
}

export async function sendMessage(
  input: { userId: string; sessionId: string; content: string },
  override?: Partial<ChatContext>,
): Promise<SendResult> {
  const { prisma } = ctx(override);
  const session = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
  if (!session || session.userId !== input.userId || session.status !== "active") {
    throw new ChatError("session_not_found", "session not found", 404);
  }
  await assertEligible(prisma, input.userId, session.characterId);

  const content = normalizeMessageContent(input.content);

  const entitlement = await prisma.chatEntitlementView.findUnique({ where: { userId: input.userId } });
  const policy = resolvePolicy(snapshotFromView(entitlement), { memoryEnabled: session.memoryEnabled });

  // input moderation (design §3 step 4) — block before persisting an assistant turn
  const moderation = await providers.moderation.check({ targetType: "text", content });

  const userMessageId = createId("msg");
  const assistantMessageId = createId("msg");

  await prisma.$transaction(async (tx) => {
    await lockTurn(tx, input.userId, session.id);
    const currentSession = await tx.chatSession.findUnique({ where: { id: session.id } });
    if (!currentSession || currentSession.userId !== input.userId || currentSession.status !== "active") {
      throw new ChatError("session_not_found", "session not found", 404);
    }
    if (moderation.status !== "blocked") {
      await assertTurnCapacity(tx, input.userId, session.id, policy);
    }
    const pin = await resolveSessionPin(tx, currentSession);
    const turnOccurredAt = new Date();
    const engagementSessionId = await allocateEngagementSessionId(tx, session.id, turnOccurredAt);
    await tx.message.create({
      data: {
        id: userMessageId,
        sessionId: session.id,
        role: "user",
        content,
        status: moderation.status === "blocked" ? "blocked" : "sent",
        safetyStatus: moderation.status === "blocked" ? "blocked" : "passed",
        engagementSessionId,
        characterContentVersionId: pin.characterContentVersionId,
        characterReleaseId: pin.characterReleaseId,
        createdAt: turnOccurredAt,
        updatedAt: turnOccurredAt,
      },
    });
    await tx.message.create({
      data: {
        id: assistantMessageId,
        sessionId: session.id,
        role: "assistant",
        content: "",
        status: moderation.status === "blocked" ? "blocked" : "pending",
        attempt: 1,
        replyToMessageId: userMessageId,
        createdAt: turnOccurredAt,
        updatedAt: turnOccurredAt,
      },
    });
    await tx.chatSession.update({
      where: { id: session.id },
      data: { lastMessageAt: new Date() },
    });
    if (moderation.status === "blocked") {
      await tx.chatModerationEvent.create({
        data: {
          id: createId("mod"),
          targetType: "message",
          targetId: userMessageId,
          layer: "input",
          status: "blocked",
          policyCode: moderation.policyCode ?? null,
          confidence: moderation.confidence,
        },
      });
      await recordOutbox(tx, {
        eventType: CHAT_TO_MAIN_EVENTS.safetyFlagged,
        aggregateType: "message",
        aggregateId: userMessageId,
        payload: { sessionId: session.id, userId: input.userId, layer: "input", policyCode: moderation.policyCode },
      });
    }
  });

  // Blocked input never generates: no queue job, no stream. The UI shows a safety
  // notice instead of waiting on an empty EventSource (design P0-B).
  if (moderation.status === "blocked") {
    return {
      assistantMessageId,
      userMessageId,
      streamUrl: null,
      status: "blocked",
      safety: { layer: "input", policyCode: moderation.policyCode },
    };
  }

  await enqueueGeneration({ sessionId: session.id, assistantMessageId, userMessageId, attempt: 1 });

  return {
    assistantMessageId,
    userMessageId,
    streamUrl: `/api/v1/chat/messages/${assistantMessageId}/stream?key=${encodeURIComponent(streamKey(assistantMessageId))}`,
    status: "generating",
  };
}

export async function editUserMessage(
  input: { userId: string; messageId: string; content: string },
  override?: Partial<ChatContext>,
): Promise<EditMessageResult> {
  const { prisma } = ctx(override);
  const message = await prisma.message.findUnique({ where: { id: input.messageId } });
  if (!message || message.role !== "user" || message.deletedAt || message.status === "deleted") {
    throw new ChatError("message_not_found", "user message not found", 404);
  }
  const session = await prisma.chatSession.findUnique({ where: { id: message.sessionId } });
  if (!session || session.userId !== input.userId) {
    throw new ChatError("forbidden", "not your message", 403);
  }
  if (session.status !== "active") {
    throw new ChatError("session_not_active", "session is not active", 409);
  }

  const content = normalizeMessageContent(input.content);

  const latestUser = await prisma.message.findFirst({
    where: { sessionId: session.id, role: "user", deletedAt: null, status: { not: "deleted" } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (latestUser?.id !== message.id) {
    throw new ChatError("message_not_editable", "only the latest user message can be edited", 409);
  }

  let assistant = await prisma.message.findFirst({
    where: {
      sessionId: session.id,
      role: "assistant",
      replyToMessageId: message.id,
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
  });
  // Compatibility for rows created before reply_to_message_id existed.
  assistant ??= await prisma.message.findFirst({
    where: {
      sessionId: session.id,
      role: "assistant",
      replyToMessageId: null,
      deletedAt: null,
      createdAt: { gte: message.createdAt },
    },
    orderBy: { createdAt: "asc" },
  });
  if (assistant && ["generating", "pending"].includes(assistant.status)) {
    throw new ChatError("message_generating", "reply is still generating", 409);
  }

  await assertEligible(prisma, input.userId, session.characterId);
  const entitlement = await prisma.chatEntitlementView.findUnique({ where: { userId: input.userId } });
  const policy = resolvePolicy(snapshotFromView(entitlement), { memoryEnabled: session.memoryEnabled });

  const moderation = await providers.moderation.check({ targetType: "text", content });
  const assistantMessageId = assistant?.id ?? createId("msg");
  const attempt = (assistant?.attempt ?? 0) + 1;
  const assistantHadEligibleExchange = assistant?.status === "sent";

  await prisma.$transaction(async (tx) => {
    await lockTurn(tx, input.userId, session.id);
    if (moderation.status !== "blocked") {
      await assertTurnCapacity(tx, input.userId, session.id, policy, assistantMessageId);
    }
    await tx.message.update({
      where: { id: message.id },
      data: {
        content,
        status: moderation.status === "blocked" ? "blocked" : "sent",
        safetyStatus: moderation.status === "blocked" ? "blocked" : "passed",
      },
    });

    if (assistant) {
      await tx.messageVersion.updateMany({
        where: { messageId: assistant.id, selected: true },
        data: { selected: false },
      });
      await tx.messageAttachment.deleteMany({ where: { messageId: assistant.id } });
      await tx.message.update({
        where: { id: assistant.id },
        data: {
          content: "",
          status: moderation.status === "blocked" ? "blocked" : "pending",
          attempt,
          replyToMessageId: message.id,
          model: null,
          tokenCount: null,
          safetyStatus: moderation.status === "blocked" ? "blocked" : "unknown",
        },
      });
    } else {
      assistant = await tx.message.create({
        data: {
          id: assistantMessageId,
          sessionId: session.id,
          role: "assistant",
          content: "",
          status: moderation.status === "blocked" ? "blocked" : "pending",
          attempt,
          replyToMessageId: message.id,
          safetyStatus: moderation.status === "blocked" ? "blocked" : "unknown",
        },
      });
    }

    if (
      assistantHadEligibleExchange &&
      message.engagementSessionId &&
      message.characterContentVersionId
    ) {
      await recordExchangeCorrection(tx, {
        exchangeId: message.id,
        correctionType: "edited",
        // The correction invalidates the previously completed attempt. The
        // replacement completion uses the next attempt number and may therefore
        // make the exchange eligible again, independent of delivery order.
        correctionRevision: attempt - 1,
        userId: input.userId,
      });
    }

    await tx.chatSession.update({
      where: { id: session.id },
      data: { lastMessageAt: new Date() },
    });

    if (moderation.status === "blocked") {
      await tx.chatModerationEvent.create({
        data: {
          id: createId("mod"),
          targetType: "message",
          targetId: message.id,
          layer: "input",
          status: "blocked",
          policyCode: moderation.policyCode ?? null,
          confidence: moderation.confidence,
        },
      });
      await recordOutbox(tx, {
        eventType: CHAT_TO_MAIN_EVENTS.safetyFlagged,
        aggregateType: "message",
        aggregateId: message.id,
        payload: { sessionId: session.id, userId: input.userId, layer: "input", policyCode: moderation.policyCode },
      });
    }
  });

  if (moderation.status === "blocked") {
    return {
      assistantMessageId,
      userMessageId: message.id,
      streamUrl: null,
      status: "blocked",
      safety: { layer: "input", policyCode: moderation.policyCode },
    };
  }

  await enqueueGeneration({ sessionId: session.id, assistantMessageId, userMessageId: message.id, attempt });

  return {
    assistantMessageId,
    userMessageId: message.id,
    streamUrl: `/api/v1/chat/messages/${assistantMessageId}/stream?key=${encodeURIComponent(streamKey(assistantMessageId))}`,
    status: "generating",
  };
}

export async function regenerate(
  input: { userId: string; messageId: string },
  override?: Partial<ChatContext>,
): Promise<{ assistantMessageId: string; attempt: number; streamUrl: string }> {
  const { prisma } = ctx(override);
  const message = await prisma.message.findUnique({ where: { id: input.messageId } });
  if (!message || message.role !== "assistant") {
    throw new ChatError("message_not_found", "assistant message not found", 404);
  }
  const session = await prisma.chatSession.findUnique({ where: { id: message.sessionId } });
  if (!session || session.userId !== input.userId) {
    throw new ChatError("forbidden", "not your message", 403);
  }
  if (session.status !== "active") {
    throw new ChatError("session_not_active", "session is not active", 409);
  }
  if (message.deletedAt || ["blocked", "deleted"].includes(message.status)) {
    throw new ChatError("message_not_regenerable", "message cannot be regenerated", 409);
  }
  if (["pending", "generating"].includes(message.status)) {
    throw new ChatError("message_generating", "message is already generating", 409);
  }

  // Regenerate is a fresh generation: finalize() still increments usage, so it MUST
  // pass the same gates as sendMessage. Without this a free user at the daily cap —
  // or a suspended/restricted user — could regenerate without limit (design P0-C).
  await assertEligible(prisma, input.userId, session.characterId);
  const entitlement = await prisma.chatEntitlementView.findUnique({ where: { userId: input.userId } });
  const policy = resolvePolicy(snapshotFromView(entitlement), { memoryEnabled: session.memoryEnabled });

  const lastUser = message.replyToMessageId
    ? await prisma.message.findUnique({ where: { id: message.replyToMessageId } })
    : await prisma.message.findFirst({
        // Compatibility for rows created before reply_to_message_id existed.
        where: { sessionId: session.id, role: "user", createdAt: { lte: message.createdAt }, deletedAt: null },
        orderBy: [{ createdAt: "desc" }, { role: "desc" }],
      });
  if (!lastUser) {
    throw new ChatError("missing_user_turn", "assistant message has no user turn", 409);
  }

  const attempt = message.attempt + 1;
  await prisma.$transaction(async (tx) => {
    await lockTurn(tx, input.userId, session.id);
    await assertTurnCapacity(tx, input.userId, session.id, policy, message.id);
    const current = await tx.message.findUnique({ where: { id: message.id } });
    if (!current || ["pending", "generating"].includes(current.status)) {
      throw new ChatError("message_generating", "message is already generating", 409);
    }
    await tx.message.update({
      where: { id: message.id },
      data: {
        status: "pending",
        attempt,
        content: "",
        replyToMessageId: lastUser.id,
      },
    });
  });

  // dedupeKey carries :attempt so regenerate is NOT swallowed (PLAN §3, the bug fix).
  await enqueueGeneration({
    sessionId: session.id,
    assistantMessageId: message.id,
    userMessageId: lastUser.id,
    attempt,
  });

  return {
    assistantMessageId: message.id,
    attempt,
    streamUrl: `/api/v1/chat/messages/${message.id}/stream?key=${encodeURIComponent(streamKey(message.id))}`,
  };
}

export async function assertMessageStreamAccess(
  input: { userId: string; messageId: string },
  override?: Partial<ChatContext>,
): Promise<void> {
  const { prisma } = ctx(override);
  const message = await prisma.message.findUnique({
    where: { id: input.messageId },
    include: { session: true },
  });
  if (!message || message.session.userId !== input.userId || message.session.status === "deleted") {
    throw new ChatError("message_not_found", "message not found", 404);
  }
}

export async function archiveSession(
  input: { userId: string; sessionId: string },
  override?: Partial<ChatContext>,
) {
  const { prisma } = ctx(override);
  const session = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
  if (!session || session.userId !== input.userId) {
    throw new ChatError("session_not_found", "session not found", 404);
  }
  return prisma.chatSession.update({ where: { id: session.id }, data: { status: "archived" } });
}

// Title is user-facing; cap at 80 chars so the drawer row never overflows (US-CH-04).
const MAX_TITLE_LENGTH = 80;

export async function renameSession(
  input: { userId: string; sessionId: string; title: string },
  override?: Partial<ChatContext>,
) {
  const { prisma } = ctx(override);
  const session = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
  if (!session || session.userId !== input.userId || session.status === "deleted") {
    throw new ChatError("session_not_found", "session not found", 404);
  }
  const title = input.title.trim();
  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw new ChatError("bad_request", `title must be 1-${MAX_TITLE_LENGTH} characters`, 400);
  }
  return prisma.chatSession.update({ where: { id: session.id }, data: { title } });
}

export async function setNoMemory(
  input: { userId: string; sessionId: string; memoryEnabled: boolean },
  override?: Partial<ChatContext>,
) {
  const { prisma } = ctx(override);
  const session = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
  if (!session || session.userId !== input.userId) {
    throw new ChatError("session_not_found", "session not found", 404);
  }
  return prisma.chatSession.update({
    where: { id: session.id },
    data: {
      memoryEnabled: input.memoryEnabled,
      ...(!input.memoryEnabled ? { memorySummary: null } : {}),
    },
  });
}

export async function confirmImageAttachment(
  input: { userId: string; attachmentId: string },
  override?: Partial<ChatContext>,
) {
  const { prisma } = ctx(override);
  const attachment = await prisma.messageAttachment.findUnique({ where: { id: input.attachmentId } });
  if (!attachment) throw new ChatError("attachment_not_found", "attachment not found", 404);
  const session = await prisma.chatSession.findUnique({ where: { id: attachment.sessionId } });
  if (!session || session.userId !== input.userId || session.status === "deleted") {
    throw new ChatError("attachment_not_found", "attachment not found", 404);
  }
  await assertEligible(prisma, input.userId, session.characterId);

  if (["requesting", "queued", "running", "completed"].includes(attachment.status)) {
    return attachment;
  }
  if (!["proposed", "failed", "refunded"].includes(attachment.status)) {
    throw new ChatError("attachment_not_confirmable", "attachment cannot be confirmed", 409);
  }

  const recent = await prisma.message.findMany({
    where: { sessionId: session.id, deletedAt: null, status: { not: "deleted" } },
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  // Re-confirm/retry must preserve the controls the agent originally planned (stored in
  // attachment.metadata by generate.ts), not silently downgrade to 4:5 / 1 output. Fall back
  // to the defaults only when no planned controls were recorded.
  const plannedControls = (attachment.metadata ?? {}) as {
    orientation?: unknown;
    outputCount?: unknown;
    // P5 Task 2: the img2img source recorded by generate.ts for edit_last_image;
    // carried through a retry so the resend still targets the same photo.
    editSourceAssetId?: unknown;
  };
  // Re-read the persona fresh rather than trusting anything captured at the original
  // request (attachment.metadata): a retry can land well after the original turn, and
  // the active visual profile may have been re-cast (new version) since then. Using the
  // CURRENT active profile here matches main's chat-path fallback semantics (stale/
  // archived requested ids fall back to active) — a retry should never carry a
  // passport version that's since been superseded.
  const persona = await prisma.chatCharacterView.findUnique({ where: { characterId: session.characterId } });
  const payload: ChatImageRequestedPayload = {
    version: 1,
    kind: "chat.image.requested",
    requestId: createId("chat_img_req"),
    attachmentId: attachment.id,
    sessionId: session.id,
    messageId: attachment.messageId,
    userId: session.userId,
    characterId: session.characterId,
    promptHint: attachment.promptHint,
    conversationContext: [...recent]
      .reverse()
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n")
      .slice(0, 2_000),
    controls: {
      orientation:
        typeof plannedControls.orientation === "string" ? plannedControls.orientation : "4:5",
      outputCount:
        typeof plannedControls.outputCount === "number" ? plannedControls.outputCount : 1,
      ...(typeof plannedControls.editSourceAssetId === "string"
        ? { sourceImageAssetId: plannedControls.editSourceAssetId }
        : {}),
    },
    visualProfileId: persona?.visualProfileId ?? undefined,
    visualProfileVersion: persona?.visualProfileVersion ?? undefined,
  };

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.messageAttachment.findUnique({ where: { id: attachment.id } });
    if (!current || ["requesting", "queued", "running", "completed"].includes(current.status)) {
      return current ?? attachment;
    }
    const row = await tx.messageAttachment.update({
      where: { id: attachment.id },
      data: { status: "requesting", errorCode: null },
    });
    await recordOutbox(tx, {
      eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
      aggregateType: "message_attachment",
      aggregateId: attachment.id,
      payload,
    });
    return row;
  });

  await scheduleOutboxDelivery();
  return updated;
}

// Paid entitlements set unlimitedMessages and short-circuit this check entirely.
async function currentUsage(prisma: Pick<ChatPrismaClient, "chatUsage">, userId: string): Promise<number> {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const row = await prisma.chatUsage.findUnique({
    where: { userId_periodStart: { userId, periodStart } },
  });
  return row?.messagesUsed ?? 0;
}

type TurnTransaction = Prisma.TransactionClient;

async function advisoryLock(tx: TurnTransaction, key: string): Promise<void> {
  await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext(${`idream-chat:${key}`}))`;
}

async function lockTurn(tx: TurnTransaction, userId: string, sessionId: string): Promise<void> {
  // Stable lock order prevents deadlocks when different sessions for one user race.
  await advisoryLock(tx, `user:${userId}`);
  await advisoryLock(tx, `turn:${sessionId}`);
}

async function assertTurnCapacity(
  tx: TurnTransaction,
  userId: string,
  sessionId: string,
  policy: ChatPolicy,
  excludeAssistantMessageId?: string,
): Promise<void> {
  const sessionInFlight = await tx.message.count({
    where: {
      sessionId,
      role: "assistant",
      status: { in: ["pending", "generating"] },
      ...(excludeAssistantMessageId ? { id: { not: excludeAssistantMessageId } } : {}),
    },
  });
  if (sessionInFlight > 0) {
    throw new ChatError("reply_in_progress", "wait for the current reply to finish", 409);
  }

  const pendingReservations = await tx.message.count({
    where: {
      role: "assistant",
      status: { in: ["pending", "generating"] },
      session: { userId },
      ...(excludeAssistantMessageId ? { id: { not: excludeAssistantMessageId } } : {}),
    },
  });
  if (!policy.unlimitedMessages) {
    const used = await currentUsage(tx, userId);
    if (used + pendingReservations >= FREE_DAILY_MESSAGES) {
      throw new ChatError("quota_exceeded", "Daily free message limit reached.", 402);
    }
  }

  const since = new Date(Date.now() - 60 * 60_000);
  const completedAttempts = await tx.messageVersion.count({
    where: { createdAt: { gte: since }, message: { session: { userId } } },
  });
  if (completedAttempts + pendingReservations >= policy.rateLimitPerHour) {
    throw new ChatError("rate_limited", "Hourly chat limit reached.", 429);
  }
}

async function enqueueGeneration(input: {
  sessionId: string;
  assistantMessageId: string;
  userMessageId: string;
  attempt: number;
}): Promise<void> {
  const payload = input satisfies ChatGeneratePayload;
  try {
    await enqueue({
      queue: CHAT_QUEUES.generate,
      payload,
      dedupeKey: idempotencyKeys.chatGenerate(input.assistantMessageId, input.attempt),
    });
  } catch (error) {
    // The pending assistant row is the durable generation intent. Reconcile will
    // re-dispatch it, so a transient Redis outage must not turn a committed user
    // message into an HTTP failure that encourages duplicate resubmission.
    logger.warn({ err: error, assistantMessageId: input.assistantMessageId }, "generation enqueue deferred");
  }
}
