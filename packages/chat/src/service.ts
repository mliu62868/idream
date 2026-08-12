// SPEC: chat/web operations (design §3, PRD §8/§9). The web layer re-checks the
// read-only views (never trusts BFF headers), does input moderation + rate limit
// locally, then in ONE transaction writes user msg(sent) + assistant
// placeholder(pending) + bumps session; chat.generate owns pending→generating.
// {assistantMessageId, streamUrl}. NO synchronous generation in the request.
import { createHash } from "node:crypto";
import type { ChatPrismaClient } from "./db.js";
import { Prisma } from "../generated/client/client.js";
import { chatPrisma, chatProjectorPrisma } from "./db.js";
import { characterAvailableToUser } from "./character-eligibility.js";
import { providers } from "./providers.js";
import { createId } from "./id.js";
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import { enqueue } from "./queue.js";
import { streamKey } from "./stream.js";
import { recordOutbox, scheduleOutboxDelivery } from "./outbox.js";
import { recordExchangeCorrection } from "./exchange-corrections.js";
import { advisoryLock, lockUser } from "./turn-lock.js";
import {
  assertNoPendingChatFileMutationsTx,
  runWithProjectedChatFiles,
  withTurnAuthority,
} from "./file-mutations.js";
import { loadSessionLinkage } from "./relationship-authority.js";
import { ChatError } from "./errors.js";
import { assertSessionAccess, lifecycleOf, requireSession } from "./session-access.js";
import { resolvePolicy, snapshotFromView } from "./policy.js";
import type { ChatPolicy } from "./policy.js";
import { logger } from "./logger.js";
import { parseSceneState } from "./scene.js";
import {
  CHAT_QUEUES,
  CHAT_TO_MAIN_EVENTS,
  idempotencyKeys,
  type ChatGeneratePayload,
  type ChatImageRequestedPayload,
} from "@idream/shared/contracts";

export interface ChatContext {
  prisma: ChatPrismaClient;
  projectorPrisma: ChatPrismaClient;
}

export interface CreateSessionHooks {
  beforeAuthorityLock?: () => Promise<void> | void;
}

export interface RegenerateHooks {
  beforeAuthorityLock?: () => Promise<void> | void;
}

function ctx(override?: Partial<ChatContext>): ChatContext {
  return {
    prisma: override?.prisma ?? chatPrisma,
    projectorPrisma:
      override?.projectorPrisma ?? chatProjectorPrisma,
  };
}

/** Verify the user may chat with this character (views are authority). */
async function assertEligible(
  prisma: ChatPrismaClient | Prisma.TransactionClient,
  userId: string,
  characterId: string,
) {
  const user = await prisma.chatUserView.findUnique({ where: { userId } });
  const character = await prisma.chatCharacterView.findUnique({
    where: { characterId },
  });
  const eligibility = await prisma.chatUserEligibilityView.findUnique({
    where: { userId },
  });
  if (!user || user.status !== "active" || user.deletedAt) {
    throw new ChatError("user_inactive", "user not active", 403);
  }
  if (!character) throw new ChatError("character_not_found", "character not found", 404);
  if (!characterAvailableToUser(character, userId)) {
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

async function assertActiveUserAuthority(
  prisma: ChatPrismaClient | Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const user = await prisma.chatUserView.findUnique({ where: { userId } });
  if (!user || user.status !== "active" || user.deletedAt) {
    throw new ChatError("user_inactive", "user not active", 403);
  }
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
  hooks: CreateSessionHooks = {},
) {
  const { prisma, projectorPrisma } = ctx(override);
  await assertEligible(prisma, input.userId, input.characterId);
  const attributionValues = [input.entryExposureId, input.entryJourneyId, input.entryPlacementId];
  const attributionCount = attributionValues.filter(Boolean).length;
  if (attributionCount !== 0 && attributionCount !== attributionValues.length) {
    throw new ChatError("invalid_entry_attribution", "entry attribution must be complete or absent", 400);
  }
  await hooks.beforeAuthorityLock?.();

  // The product exposes one active conversation per user/character pair. The
  // user lock serializes account erasure with the entire read-then-create
  // decision. Re-checking the Main user/character views after that lock means a
  // request that passed preflight before account deletion cannot recreate chat
  // rows after the erasure commits.
  return runWithProjectedChatFiles(
    input.userId,
    () => prisma.$transaction(async (tx) => {
    await lockUser(tx, input.userId);
    await assertNoPendingChatFileMutationsTx(tx, input.userId);
    await advisoryLock(tx, `session:${input.userId}:${input.characterId}`);
    const { character } = await assertEligible(
      tx,
      input.userId,
      input.characterId,
    );
    const existing = await tx.chatSession.findFirst({
      where: { userId: input.userId, characterId: input.characterId, status: "active" },
      orderBy: { lastMessageAt: "desc" },
    });
    if (existing) {
      await materializeOpeningMessage(tx, existing);
      return existing;
    }

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
    await materializeOpeningMessage(tx, created);
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
    }),
    projectorPrisma,
  );
}

async function materializeOpeningMessage(
  tx: Prisma.TransactionClient,
  session: {
    id: string;
    characterId: string;
    characterContentVersionId: string | null;
    characterReleaseId: string | null;
    createdAt: Date;
  },
): Promise<void> {
  if (!session.characterContentVersionId) return;
  const existingMessage = await tx.message.findFirst({
    where: { sessionId: session.id },
    select: { id: true },
  });
  if (existingMessage) return;
  const pinnedContent = await tx.chatCharacterContentVersionView.findUnique({
    where: { contentVersionId: session.characterContentVersionId },
  });
  if (!pinnedContent || pinnedContent.characterId !== session.characterId) return;
  const openingMessage = openingMessageFromSnapshot(
    pinnedContent.openingSnapshot,
  );
  if (!openingMessage) return;
  const messageId = createId("msg");
  const runtimeTrace = {
    schemaVersion: 1,
    attempt: 1,
    messageKind: "opening",
    scene: null,
    outputAuthority: "immutable_opening",
  } satisfies Prisma.InputJsonObject;
  await tx.message.create({
    data: {
      id: messageId,
      sessionId: session.id,
      role: "assistant",
      content: openingMessage,
      status: "sent",
      safetyStatus: "passed",
      memoryAuthority: "disabled",
      characterContentVersionId: session.characterContentVersionId,
      characterReleaseId: session.characterReleaseId,
      runtimeTrace,
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
      versions: {
        create: {
          id: `mv:${messageId}:1`,
          content: openingMessage,
          selected: true,
          attempt: 1,
          runtimeTrace,
          createdAt: session.createdAt,
        },
      },
    },
  });
}

function openingMessageFromSnapshot(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const firstMessage = (value as Record<string, unknown>).firstMessage;
  return typeof firstMessage === "string" && firstMessage.trim()
    ? firstMessage.trim()
    : null;
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
  // 读路径：已归档的会话仍可打开，只有已删除的看不到。入参是 sessionId，用 404 盖住归属。
  const session = await requireSession(prisma, input, {
    require: "not_deleted",
    denial: { kind: "not_found" },
  });
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
      scene: runtimeScene(message.runtimeTrace),
      attachments: byMessage.get(message.id) ?? [],
    })),
  };
}

function runtimeScene(value: unknown): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scene = (value as Record<string, unknown>).scene;
  return scene && typeof scene === "object" && !Array.isArray(scene) ? scene : null;
}

/** Exact, user-authorized assistant bytes consumed by downstream Voice. */
export async function getMessageVoiceAuthority(
  input: { userId: string; sessionId: string; messageId: string },
  override?: Partial<ChatContext>,
) {
  const { prisma } = ctx(override);
  await assertActiveUserAuthority(prisma, input.userId);
  const session = await requireSession(prisma, input, {
    require: "not_deleted",
    denial: { kind: "not_found" },
  });
  const message = await prisma.message.findFirst({
    where: {
      id: input.messageId,
      sessionId: session.id,
      role: "assistant",
      status: "sent",
      deletedAt: null,
    },
    include: {
      versions: { where: { selected: true }, take: 2 },
    },
  });
  if (!message) throw new ChatError("message_not_found", "message not found", 404);
  if (message.versions.length !== 1) {
    throw new ChatError("message_version_ambiguous", "assistant message has no unique selected version", 409);
  }
  const version = message.versions[0]!;
  if (version.content !== message.content) {
    throw new ChatError("message_version_drift", "selected assistant bytes do not match the message", 409);
  }
  const trace = version.runtimeTrace;
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    throw new ChatError("runtime_trace_missing", "assistant attempt runtime trace is missing", 409);
  }
  const traceRecord = trace as Record<string, unknown>;
  if (traceRecord.schemaVersion !== 1 || traceRecord.attempt !== version.attempt) {
    throw new ChatError("runtime_trace_invalid", "assistant attempt runtime trace is invalid", 409);
  }
  const scene = parseSceneState(traceRecord.scene);
  if (traceRecord.scene !== null && !scene) {
    throw new ChatError("runtime_scene_invalid", "assistant attempt Scene is invalid", 409);
  }
  return {
    schemaVersion: 1 as const,
    sessionId: session.id,
    messageId: message.id,
    characterId: session.characterId,
    text: version.content,
    attempt: version.attempt,
    sceneVersion: scene?.version ?? 0,
    scene,
    characterContentVersionId: message.characterContentVersionId,
    characterReleaseId: message.characterReleaseId,
  };
}

export interface SendResult {
  assistantMessageId: string;
  userMessageId: string;
  /** null when the input was blocked — there is no stream to consume (design P0-B). */
  streamUrl: string | null;
  status: "generating" | "blocked";
  safety?: { layer: "input" | "output"; policyCode?: string };
  idempotentReplay?: boolean;
}

export type EditMessageResult = SendResult;

const MAX_MESSAGE_LENGTH = 12_000;
const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const ENGAGEMENT_INACTIVITY_MS_V1 = 30 * 60 * 1_000;

function normalizeMessageContent(value: string): string {
  const content = value.trim();
  if (!content) throw new ChatError("empty_message", "message is empty", 400);
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new ChatError("message_too_long", `message exceeds ${MAX_MESSAGE_LENGTH} characters`, 400);
  }
  return content;
}

function normalizeIdempotencyKey(value: string): string {
  const key = value.trim();
  if (
    key.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new ChatError(
      "invalid_idempotency_key",
      `Idempotency-Key must be ${MIN_IDEMPOTENCY_KEY_LENGTH}-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      400,
    );
  }
  return key;
}

function chatSendRequestHash(sessionId: string, content: string): string {
  return createHash("sha256")
    .update(`idream-chat-send-v1\0${sessionId}\0${content}`)
    .digest("hex");
}

function sendResultFromReceipt(
  receipt: {
    assistantMessageId: string;
    userMessageId: string;
    responseStatus: string;
    safetyPolicyCode: string | null;
  },
  idempotentReplay: boolean,
): SendResult {
  if (receipt.responseStatus === "blocked") {
    return {
      assistantMessageId: receipt.assistantMessageId,
      userMessageId: receipt.userMessageId,
      streamUrl: null,
      status: "blocked",
      safety: {
        layer: "input",
        ...(receipt.safetyPolicyCode
          ? { policyCode: receipt.safetyPolicyCode }
          : {}),
      },
      ...(idempotentReplay ? { idempotentReplay: true } : {}),
    };
  }
  if (receipt.responseStatus !== "generating") {
    throw new ChatError(
      "idempotency_receipt_corrupt",
      "stored send receipt has an invalid response status",
      500,
    );
  }
  return {
    assistantMessageId: receipt.assistantMessageId,
    userMessageId: receipt.userMessageId,
    streamUrl: `/api/v1/chat/messages/${receipt.assistantMessageId}/stream?key=${encodeURIComponent(streamKey(receipt.assistantMessageId))}`,
    status: "generating",
    ...(idempotentReplay ? { idempotentReplay: true } : {}),
  };
}

function assertMatchingSendReceipt(
  receipt: { sessionId: string; requestHash: string },
  input: { sessionId: string; requestHash: string },
): void {
  if (
    receipt.sessionId !== input.sessionId ||
    receipt.requestHash !== input.requestHash
  ) {
    throw new ChatError(
      "idempotency_conflict",
      "Idempotency-Key was already used for a different chat send intent",
      409,
    );
  }
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
  input: {
    userId: string;
    sessionId: string;
    content: string;
    /** Required by the HTTP boundary; trusted in-process callers get a one-shot key. */
    idempotencyKey?: string;
  },
  override?: Partial<ChatContext>,
): Promise<SendResult> {
  const { prisma, projectorPrisma } = ctx(override);
  // 写路径：只有活跃会话能发言。入参是 sessionId，用 404 盖住"存在但不是你的"。
  const session = await requireSession(prisma, input, {
    require: "active",
    denial: { kind: "not_found" },
  });

  const content = normalizeMessageContent(input.content);
  const idempotencyKey = normalizeIdempotencyKey(
    input.idempotencyKey ?? createId("send-request"),
  );
  const requestHash = chatSendRequestHash(session.id, content);
  const existingReceipt = await prisma.chatSendReceipt.findUnique({
    where: {
      userId_idempotencyKey: {
        userId: input.userId,
        idempotencyKey,
      },
    },
  });
  if (existingReceipt) {
    assertMatchingSendReceipt(existingReceipt, {
      sessionId: session.id,
      requestHash,
    });
    return sendResultFromReceipt(existingReceipt, true);
  }

  await assertEligible(prisma, input.userId, session.characterId);

  const entitlement = await prisma.chatEntitlementView.findUnique({ where: { userId: input.userId } });

  // input moderation (design §3 step 4) — block before persisting an assistant turn
  const moderation = await providers.moderation.check({ targetType: "text", content });

  const userMessageId = createId("msg");
  const assistantMessageId = createId("msg");

  const committed = await withTurnAuthority(
    {
      userId: input.userId,
      sessionId: session.id,
      prisma,
      projectorPrisma,
    },
    async (tx) => {
    await advisoryLock(tx, `send:${input.userId}:${idempotencyKey}`);
    await assertEligible(tx, input.userId, session.characterId);
    // 事务内复查：与上面同一条规则、同一个映射，只是换成事务客户端读。
    const currentSession = await requireSession(tx, { sessionId: session.id, userId: input.userId }, {
      require: "active",
      denial: { kind: "not_found" },
    });
    const replay = await tx.chatSendReceipt.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: input.userId,
          idempotencyKey,
        },
      },
    });
    if (replay) {
      assertMatchingSendReceipt(replay, {
        sessionId: session.id,
        requestHash,
      });
      const assistant = await tx.message.findUnique({
        where: { id: replay.assistantMessageId },
        select: { status: true },
      });
      if (!assistant) {
        throw new ChatError(
          "idempotency_receipt_corrupt",
          "stored send receipt does not reference an assistant message",
          500,
        );
      }
      return { receipt: replay, assistantStatus: assistant.status, replayed: true };
    }
    const turnPolicy = resolvePolicy(snapshotFromView(entitlement), {
      memoryEnabled: currentSession.memoryEnabled,
    });
    if (moderation.status !== "blocked") {
      await assertTurnCapacity(tx, input.userId, session.id, turnPolicy);
    }
    const pin = await resolveSessionPin(tx, currentSession);
    const latestScene = await tx.chatSceneRevision.findFirst({
      where: { sessionId: session.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    // INVARIANT: the user turn pins the Scene that existed before this exchange.
    // Later extraction creates a new revision for future turns; regeneration keeps
    // reading this exact anchor instead of today's mutable scene head.
    const sceneVersion = latestScene?.version ?? 0;
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
        sceneVersion,
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
        memoryAuthority: currentSession.memoryEnabled ? "enabled" : "disabled",
        sceneVersion,
        createdAt: turnOccurredAt,
        updatedAt: turnOccurredAt,
      },
    });
    await tx.chatSession.update({
      where: { id: session.id },
      data: {
        lastMessageAt: turnOccurredAt,
        contextRevision: { increment: 1 },
      },
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
    const receipt = await tx.chatSendReceipt.create({
      data: {
        id: createId("send"),
        userId: input.userId,
        sessionId: session.id,
        idempotencyKey,
        requestHash,
        userMessageId,
        assistantMessageId,
        responseStatus:
          moderation.status === "blocked" ? "blocked" : "generating",
        safetyPolicyCode:
          moderation.status === "blocked"
            ? moderation.policyCode ?? null
            : null,
      },
    });
    return {
      receipt,
      assistantStatus:
        moderation.status === "blocked" ? "blocked" : "pending",
      replayed: false,
    };
    },
  );

  // A pending assistant row is the durable queue intent. Replaying after an
  // HTTP timeout or Redis outage re-dispatches that same canonical assistant;
  // deterministic BullMQ job ids collapse concurrent enqueue attempts.
  if (
    committed.receipt.responseStatus === "generating" &&
    committed.assistantStatus === "pending"
  ) {
    await enqueueGeneration({
      sessionId: session.id,
      assistantMessageId: committed.receipt.assistantMessageId,
      userMessageId: committed.receipt.userMessageId,
      attempt: 1,
    });
  }

  return sendResultFromReceipt(committed.receipt, committed.replayed);
}

export async function editUserMessage(
  input: { userId: string; messageId: string; content: string },
  override?: Partial<ChatContext>,
): Promise<EditMessageResult> {
  const { prisma, projectorPrisma } = ctx(override);
  const message = await prisma.message.findUnique({ where: { id: input.messageId } });
  if (!message || message.role !== "user" || message.deletedAt || message.status === "deleted") {
    throw new ChatError("message_not_found", "user message not found", 404);
  }
  // 入参是 messageId：上面那次消息查询已经泄漏了存在性，再假装 404 没有意义 ——
  // 归属不符是 403，生命周期不合是 409。这条分歧是有意的，不是漂移。
  const session = await requireSession(prisma, { sessionId: message.sessionId, userId: input.userId }, {
    require: "active",
    denial: { kind: "owner_forbidden", forbiddenMessage: "not your message" },
  });

  const content = normalizeMessageContent(input.content);

  const latestUser = await prisma.message.findFirst({
    where: { sessionId: session.id, role: "user", deletedAt: null, status: { not: "deleted" } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (latestUser?.id !== message.id) {
    throw new ChatError("message_not_editable", "only the latest user message can be edited", 409);
  }

  const { messages: editMessages, linkage: editLinkage } =
    await loadSessionLinkage(prisma, session.id);
  const ambiguousLinkedAssistants = editLinkage.ambiguousAssistantIds.filter(
    (assistantId) =>
      editLinkage.candidateSourceIds
        .get(assistantId)
        ?.includes(message.id),
  );
  if (ambiguousLinkedAssistants.length > 0) {
    throw new ChatError(
      "message_conflict",
      "message has ambiguous assistant linkage",
      409,
    );
  }
  const linkedAssistants = editMessages.filter(
    (candidate) =>
      candidate.role === "assistant" &&
      !candidate.deletedAt &&
      editLinkage.sources.get(candidate.id)?.id === message.id,
  );
  if (linkedAssistants.length > 1) {
    throw new ChatError(
      "message_conflict",
      "message has ambiguous assistant linkage",
      409,
    );
  }
  let assistant = linkedAssistants[0]
    ? await prisma.message.findUnique({
        where: { id: linkedAssistants[0].id },
      })
    : null;
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

  await withTurnAuthority(
    {
      userId: input.userId,
      sessionId: session.id,
      prisma,
      projectorPrisma,
    },
    async (tx, recordIntent) => {
    await assertActiveUserAuthority(tx, input.userId);
    const currentSession = await tx.chatSession.findUnique({
      where: { id: session.id },
    });
    const currentMessage = await tx.message.findUnique({
      where: { id: message.id },
    });
    const { messages: currentMessages, linkage: currentLinkage } =
      await loadSessionLinkage(tx, session.id);
    const currentLatestUser = await tx.message.findFirst({
      where: {
        sessionId: session.id,
        role: "user",
        deletedAt: null,
        status: { not: "deleted" },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (
      currentLinkage.ambiguousAssistantIds.some((assistantId) =>
        currentLinkage.candidateSourceIds
          .get(assistantId)
          ?.includes(message.id),
      )
    ) {
      throw new ChatError(
        "message_conflict",
        "message has ambiguous assistant linkage",
        409,
      );
    }
    const currentLinkedAssistants = currentMessages.filter(
      (candidate) =>
        candidate.role === "assistant" &&
        !candidate.deletedAt &&
        currentLinkage.sources.get(candidate.id)?.id === message.id,
    );
    if (currentLinkedAssistants.length > 1) {
      throw new ChatError(
        "message_conflict",
        "message has ambiguous assistant linkage",
        409,
      );
    }
    const currentAssistant = currentLinkedAssistants[0]
      ? await tx.message.findUnique({
          where: { id: currentLinkedAssistants[0].id },
        })
      : null;
    // 事务内复查：外层已放行过一次，此处不满足只可能是并发改动 → 一律 409。
    assertSessionAccess(currentSession, input, {
      require: "active",
      denial: { kind: "conflict" },
    });
    if (
      !currentMessage ||
      currentMessage.role !== "user" ||
      currentMessage.deletedAt ||
      currentMessage.status === "deleted" ||
      currentMessage.content !== message.content
    ) {
      throw new ChatError("message_not_found", "user message not found", 404);
    }
    if (currentLatestUser?.id !== currentMessage.id) {
      throw new ChatError(
        "message_not_editable",
        "only the latest user message can be edited",
        409,
      );
    }
    if (
      (assistant &&
        (
          !currentAssistant ||
          currentAssistant.id !== assistant.id ||
          currentAssistant.attempt !== assistant.attempt ||
          currentAssistant.status !== assistant.status
        )) ||
      (!assistant && currentAssistant)
    ) {
      throw new ChatError(
        "message_conflict",
        "message changed before the edit could commit",
        409,
      );
    }
    if (moderation.status !== "blocked") {
      await assertTurnCapacity(tx, input.userId, session.id, policy, assistantMessageId);
    }
    await recordIntent({
      kind: "turn_forget",
      sessionId: currentSession.id,
      characterId: currentSession.characterId,
      messageIds: [
        currentMessage.id,
        ...(currentAssistant ? [currentAssistant.id] : []),
      ],
    });
    await recordIntent({
      kind: "relationship_rebuild",
      characterId: currentSession.characterId,
    });
    await tx.message.update({
      where: { id: currentMessage.id },
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
          sceneVersion: currentMessage.sceneVersion,
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
          sceneVersion: currentMessage.sceneVersion,
          safetyStatus: moderation.status === "blocked" ? "blocked" : "unknown",
          memoryAuthority: currentSession.memoryEnabled
            ? "enabled"
            : "disabled",
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
      data: {
        lastMessageAt: new Date(),
        memorySummary: null,
        contextRevision: { increment: 1 },
      },
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
    },
  );

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
  hooks: RegenerateHooks = {},
): Promise<{ assistantMessageId: string; attempt: number; streamUrl: string }> {
  const { prisma, projectorPrisma } = ctx(override);
  const message = await prisma.message.findUnique({ where: { id: input.messageId } });
  if (!message || message.role !== "assistant") {
    throw new ChatError("message_not_found", "assistant message not found", 404);
  }
  // 同 editUserMessage：入参是 messageId，存在性已泄漏 —— 归属 403、生命周期 409。
  const session = await requireSession(prisma, { sessionId: message.sessionId, userId: input.userId }, {
    require: "active",
    denial: { kind: "owner_forbidden", forbiddenMessage: "not your message" },
  });
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

  const { linkage } = await loadSessionLinkage(prisma, session.id);
  const lastUser = linkage.sources.get(message.id);
  if (!lastUser) {
    throw new ChatError("missing_user_turn", "assistant message has no user turn", 409);
  }
  await hooks.beforeAuthorityLock?.();

  const attempt = await withTurnAuthority(
    {
      userId: input.userId,
      sessionId: session.id,
      prisma,
      projectorPrisma,
    },
    async (tx) => {
    await assertActiveUserAuthority(tx, input.userId);
    await assertTurnCapacity(tx, input.userId, session.id, policy, message.id);
    const currentSession = await tx.chatSession.findUnique({
      where: { id: session.id },
    });
    const current = await tx.message.findUnique({
      where: { id: message.id },
    });
    const currentSource = await tx.message.findUnique({
      where: { id: lastUser.id },
    });
    const { linkage: currentLinkage } = await loadSessionLinkage(
      tx,
      session.id,
    );
    // 事务内复查：外层已放行过一次，此处不满足只可能是并发改动 → 一律 409。
    // （原先这里比别处多查一个 deletedAt —— 现在 lifecycleOf 一律两个字段都看。）
    assertSessionAccess(currentSession, input, {
      require: "active",
      denial: { kind: "conflict" },
    });
    if (
      !current ||
      current.role !== "assistant" ||
      current.sessionId !== currentSession.id ||
      current.deletedAt ||
      ["blocked", "deleted"].includes(current.status)
    ) {
      throw new ChatError(
        "message_not_regenerable",
        "message cannot be regenerated",
        409,
      );
    }
    if (["pending", "generating"].includes(current.status)) {
      throw new ChatError("message_generating", "message is already generating", 409);
    }
    if (
      current.attempt !== message.attempt ||
      current.replyToMessageId !== message.replyToMessageId
    ) {
      throw new ChatError(
        "message_conflict",
        "message changed before regeneration could commit",
        409,
      );
    }
    if (
      !currentSource ||
      currentSource.id !== lastUser.id ||
      currentSource.sessionId !== currentSession.id ||
      currentSource.role !== "user" ||
      currentSource.deletedAt ||
      currentSource.status !== "sent" ||
      currentLinkage.sources.get(current.id)?.id !== currentSource.id ||
      (
        current.replyToMessageId !== null &&
        current.replyToMessageId !== currentSource.id
      )
    ) {
      throw new ChatError(
        "missing_user_turn",
        "assistant message has no active user turn",
        409,
      );
    }
    const nextAttempt = current.attempt + 1;
    await tx.message.update({
      where: { id: message.id },
      data: {
        status: "pending",
        attempt: nextAttempt,
        content: "",
        replyToMessageId: lastUser.id,
      },
    });
    return nextAttempt;
    },
  );

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
  // 这里的会话是 include 出来的，形状和别处不同，但生命周期判定共用同一个入口。
  if (!message || message.session.userId !== input.userId || lifecycleOf(message.session) === "deleted") {
    throw new ChatError("message_not_found", "message not found", 404);
  }
}

export async function archiveSession(
  input: { userId: string; sessionId: string },
  override?: Partial<ChatContext>,
) {
  const { prisma } = ctx(override);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`
        SELECT id
        FROM chat.chat_sessions
        WHERE id = ${input.sessionId}
        FOR UPDATE
      `,
    );
    // BUGFIX: 此前这里只查归属、不查生命周期，于是一个**已被擦除**的会话可以被它的
    // 主人 archive 回来 —— status 从 "deleted" 翻成 "archived"，而 listSessions 只按
    // status 过滤，被擦除的会话就带着空消息列表重新出现在抽屉里。擦除必须是终态。
    const session = await requireSession(tx, input, {
      require: "not_deleted",
      denial: { kind: "not_found" },
    });

    // INVARIANT: a user archive ordered after a moderation removal overrides
    // that exact causal event. Appeal restoration may not revive this session.
    const removalSnapshots = await tx.chatModerationEvent.findMany({
      where: {
        targetType: "session",
        targetId: session.id,
        layer: "main_moderation_removal",
        status: "archived_by_removal",
      },
      select: { details: true },
    });
    const overriddenRemovalEventIds = removalSnapshots.flatMap((snapshot) => {
      const details = snapshot.details;
      if (!details || typeof details !== "object" || Array.isArray(details)) {
        throw new Error("character removal session evidence is invalid");
      }
      const sourceEventId = (details as Record<string, unknown>).sourceEventId;
      if (typeof sourceEventId !== "string" || !sourceEventId) {
        throw new Error("character removal session evidence has no source event");
      }
      return sourceEventId;
    });
    await tx.chatModerationEvent.create({
      data: {
        id: createId("mod"),
        targetType: "session",
        targetId: session.id,
        layer: "user_session_lifecycle",
        status: "user_archived",
        details: {
          version: 1,
          overriddenRemovalEventIds: [
            ...new Set(overriddenRemovalEventIds),
          ].sort(),
        },
      },
    });
    return tx.chatSession.update({
      where: { id: session.id },
      data: { status: "archived" },
    });
  });
}

// Title is user-facing; cap at 80 chars so the drawer row never overflows (US-CH-04).
const MAX_TITLE_LENGTH = 80;

export async function renameSession(
  input: { userId: string; sessionId: string; title: string },
  override?: Partial<ChatContext>,
) {
  const { prisma } = ctx(override);
  // 已归档的会话仍可改名；已删除的不行。
  const session = await requireSession(prisma, input, {
    require: "not_deleted",
    denial: { kind: "not_found" },
  });
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
  const { prisma, projectorPrisma } = ctx(override);
  // The same lock as sendMessage gives preference toggles and turn creation a
  // total order. The assistant row then permanently records which side won.
  return withTurnAuthority(
    {
      userId: input.userId,
      sessionId: input.sessionId,
      prisma,
      projectorPrisma,
    },
    async (tx) => {
      await assertActiveUserAuthority(tx, input.userId);
      // BUGFIX: 同 archiveSession —— 此前不查生命周期，已擦除的会话还能被切记忆开关，
      // 而那次写入会 increment contextRevision，等于在一个终态对象上继续留痕。
      const session = await requireSession(tx, input, {
        require: "not_deleted",
        denial: { kind: "not_found" },
      });
      return tx.chatSession.update({
        where: { id: session.id },
        data: {
          memoryEnabled: input.memoryEnabled,
          ...(!input.memoryEnabled ? { memorySummary: null } : {}),
          contextRevision: { increment: 1 },
        },
      });
    },
  );
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
    characterReleaseId?: unknown;
    sourceUserMessageId?: unknown;
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
    exchangeId:
      typeof plannedControls.sourceUserMessageId === "string"
        ? plannedControls.sourceUserMessageId
        : undefined,
    messageId: attachment.messageId,
    userId: session.userId,
    characterId: session.characterId,
    characterReleaseId:
      attachmentReleaseIdForRetry(plannedControls, session.characterReleaseId) ?? undefined,
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

export function attachmentReleaseIdForRetry(
  metadata: { readonly characterReleaseId?: unknown },
  sessionCharacterReleaseId: string | null,
) {
  return typeof metadata.characterReleaseId === "string" &&
    metadata.characterReleaseId.trim().length > 0
    ? metadata.characterReleaseId
    : sessionCharacterReleaseId;
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

async function assertTurnCapacity(
  tx: Prisma.TransactionClient,
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
