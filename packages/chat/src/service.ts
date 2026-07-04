// SPEC: chat/web operations (design §3, PRD §8/§9). The web layer re-checks the
// read-only views (never trusts BFF headers), does input moderation + rate limit
// locally, then in ONE transaction writes user msg(sent) + assistant
// placeholder(generating) + bumps session, enqueues chat.generate, returns
// {assistantMessageId, streamUrl}. NO synchronous generation in the request.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { providers } from "./providers.js";
import { createId } from "./id.js";
import { FREE_DAILY_MESSAGES } from "./limits.js";
import { enqueue } from "./queue.js";
import { streamKey } from "./stream.js";
import { recordOutbox, scheduleOutboxDelivery } from "./outbox.js";
import { resolvePolicy, snapshotFromView } from "./policy.js";
import {
  CHAT_QUEUES,
  CHAT_TO_MAIN_EVENTS,
  idempotencyKeys,
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
  if (character.status !== "approved" && character.creatorId !== userId) {
    throw new ChatError("character_unavailable", "character not available", 403);
  }
  if (character.age < 18) throw new ChatError("character_underage", "character not allowed", 403);
  if (eligibility?.restrictedReason) {
    throw new ChatError("restricted", eligibility.restrictedReason, 403);
  }
  return { user, character };
}

export async function createSession(
  input: { userId: string; characterId: string; title?: string },
  override?: Partial<ChatContext>,
) {
  const { prisma } = ctx(override);
  await assertEligible(prisma, input.userId, input.characterId);

  // reuse an active session for (user, character) if present
  const existing = await prisma.chatSession.findFirst({
    where: { userId: input.userId, characterId: input.characterId, status: "active" },
    orderBy: { lastMessageAt: "desc" },
  });
  if (existing) return existing;

  const id = createId("sess");
  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.chatSession.create({
      data: { id, userId: input.userId, characterId: input.characterId, title: input.title ?? null },
    });
    await recordOutbox(tx, {
      eventType: CHAT_TO_MAIN_EVENTS.sessionCreated,
      aggregateType: "session",
      aggregateId: id,
      payload: { userId: input.userId, characterId: input.characterId },
    });
    return created;
  });
  return session;
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
  const messages = await prisma.message.findMany({
    where: { sessionId: session.id, deletedAt: null, status: { not: "deleted" } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const attachments = await prisma.messageAttachment.findMany({
    where: { sessionId: session.id },
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

  const content = input.content.trim();
  if (!content) throw new ChatError("empty_message", "message is empty", 400);

  // rate limit / quota (local judgment, design §3 step 3)
  const entitlement = await prisma.chatEntitlementView.findUnique({ where: { userId: input.userId } });
  const policy = resolvePolicy(snapshotFromView(entitlement), { memoryEnabled: session.memoryEnabled });
  if (!policy.unlimitedMessages) {
    const used = await currentUsage(prisma, input.userId);
    if (used >= FREE_DAILY_MESSAGES) {
      throw new ChatError("quota_exceeded", "Daily free message limit reached.", 402);
    }
  }

  // input moderation (design §3 step 4) — block before persisting an assistant turn
  const moderation = await providers.moderation.check({ targetType: "text", content });

  const userMessageId = createId("msg");
  const assistantMessageId = createId("msg");

  await prisma.$transaction(async (tx) => {
    await tx.message.create({
      data: {
        id: userMessageId,
        sessionId: session.id,
        role: "user",
        content,
        status: moderation.status === "blocked" ? "blocked" : "sent",
        safetyStatus: moderation.status === "blocked" ? "blocked" : "passed",
      },
    });
    await tx.message.create({
      data: {
        id: assistantMessageId,
        sessionId: session.id,
        role: "assistant",
        content: "",
        status: moderation.status === "blocked" ? "blocked" : "generating",
        attempt: 1,
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

  await enqueue({
    queue: CHAT_QUEUES.generate,
    payload: { sessionId: session.id, assistantMessageId, userMessageId, attempt: 1 },
    dedupeKey: idempotencyKeys.chatGenerate(assistantMessageId, 1),
  });

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

  const content = input.content.trim();
  if (!content) throw new ChatError("empty_message", "message is empty", 400);

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
  if (!policy.unlimitedMessages) {
    const used = await currentUsage(prisma, input.userId);
    if (used >= FREE_DAILY_MESSAGES) {
      throw new ChatError("quota_exceeded", "Daily free message limit reached.", 402);
    }
  }

  const moderation = await providers.moderation.check({ targetType: "text", content });
  const assistantMessageId = assistant?.id ?? createId("msg");
  const attempt = (assistant?.attempt ?? 0) + 1;

  await prisma.$transaction(async (tx) => {
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
          status: moderation.status === "blocked" ? "blocked" : "generating",
          attempt,
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
          status: moderation.status === "blocked" ? "blocked" : "generating",
          attempt,
          safetyStatus: moderation.status === "blocked" ? "blocked" : "unknown",
        },
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

  await enqueue({
    queue: CHAT_QUEUES.generate,
    payload: { sessionId: session.id, assistantMessageId, userMessageId: message.id, attempt },
    dedupeKey: idempotencyKeys.chatGenerate(assistantMessageId, attempt),
  });

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
  if (message.status === "generating") {
    throw new ChatError("message_generating", "message is already generating", 409);
  }

  // Regenerate is a fresh generation: finalize() still increments usage, so it MUST
  // pass the same gates as sendMessage. Without this a free user at the daily cap —
  // or a suspended/restricted user — could regenerate without limit (design P0-C).
  await assertEligible(prisma, input.userId, session.characterId);
  const entitlement = await prisma.chatEntitlementView.findUnique({ where: { userId: input.userId } });
  const policy = resolvePolicy(snapshotFromView(entitlement), { memoryEnabled: session.memoryEnabled });
  if (!policy.unlimitedMessages) {
    const used = await currentUsage(prisma, input.userId);
    if (used >= FREE_DAILY_MESSAGES) {
      throw new ChatError("quota_exceeded", "Daily free message limit reached.", 402);
    }
  }

  const lastUser = await prisma.message.findFirst({
    // user + assistant placeholder are inserted in the same transaction, so
    // PostgreSQL now() can give them the same created_at.
    where: { sessionId: session.id, role: "user", createdAt: { lte: message.createdAt }, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!lastUser) {
    throw new ChatError("missing_user_turn", "assistant message has no user turn", 409);
  }

  const attempt = message.attempt + 1;
  await prisma.message.update({
    where: { id: message.id },
    data: { status: "generating", attempt, content: "" },
  });

  // dedupeKey carries :attempt so regenerate is NOT swallowed (PLAN §3, the bug fix).
  await enqueue({
    queue: CHAT_QUEUES.generate,
    payload: {
      sessionId: session.id,
      assistantMessageId: message.id,
      userMessageId: lastUser?.id ?? "",
      attempt,
    },
    dedupeKey: idempotencyKeys.chatGenerate(message.id, attempt),
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
  };
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
    },
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
async function currentUsage(prisma: ChatPrismaClient, userId: string): Promise<number> {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const row = await prisma.chatUsage.findUnique({
    where: { userId_periodStart: { userId, periodStart } },
  });
  return row?.messagesUsed ?? 0;
}
