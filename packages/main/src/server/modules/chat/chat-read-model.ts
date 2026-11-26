// Public projections of sessions, messages and attachments.
import { publicReplyVersions } from "./turn-alternatives";
import type { ChatExecutionSnapshot } from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { isSyntheticMediaAsset } from "@/server/lib/media-asset-authority";
import { MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES } from "@/server/events/main-outbox-transport";
import { isReusablePlatformAssetWhere } from "@/server/modules/ourdream/chat-image-reuse";
import { canCancelGenerationBeforeProviderEntry } from "@/server/ai/generation-request-lifecycle";
import { readGenerationQueueStandings } from "@/server/modules/ourdream/generation-queue-standing";
import { effectiveGenerationJobStatus, generationExecutionErrorCode } from "@/server/modules/ourdream/generation-job-read-model";
import { generationPreparationPreventsRetry } from "@/server/modules/generation/generation-attempt-authority";
import { attachmentAttempt } from "./turn-scope";
import { ACTIVE_ASSISTANT_STATES, attachmentCost, isRecord, jsonRecord, streamUrl } from "./turn-ledger-support";
import { chatSessionContinuation } from "./chat-session-authority";

export interface BegunChatTurn {
  duplicate: boolean;
  blocked: boolean;
  snapshot: ChatExecutionSnapshot | null;
  userMessage: ReturnType<typeof publicUserMessage>;
  assistant: ReturnType<typeof publicAssistantMessage>;
  streamUrl: string | null;
  safety?: { layer: "input"; policyCode?: string };
}

/**
 * SPEC: transcript reads are paged by Turn. `limit` defaults to
 * {@link DEFAULT_CHAT_PAGE_TURNS} and is capped at {@link MAX_CHAT_PAGE_TURNS};
 * without `beforeTurnId` the latest page is returned, otherwise the Turns
 * strictly before that Turn. Messages within a page stay in ascending order and
 * the response carries `page: { hasEarlier, earliestTurnId }`.
 */
export const DEFAULT_CHAT_PAGE_TURNS = 50;
export const MAX_CHAT_PAGE_TURNS = 200;

export type ChatTranscriptPage = { limit?: number; beforeTurnId?: string };

export function parseChatTranscriptPage(query: URLSearchParams): ChatTranscriptPage {
  const rawLimit = query.get("limit");
  const beforeTurnId = query.get("beforeTurnId")?.trim() || undefined;
  if (rawLimit === null) return { beforeTurnId };
  if (!/^[1-9]\d{0,3}$/u.test(rawLimit) || Number(rawLimit) > MAX_CHAT_PAGE_TURNS) {
    throw Errors.badRequest(`limit must be an integer between 1 and ${MAX_CHAT_PAGE_TURNS}`);
  }
  return { limit: Number(rawLimit), beforeTurnId };
}

function pageLimit(page: ChatTranscriptPage | undefined): number {
  const limit = page?.limit ?? DEFAULT_CHAT_PAGE_TURNS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHAT_PAGE_TURNS) {
    throw Errors.badRequest(`limit must be an integer between 1 and ${MAX_CHAT_PAGE_TURNS}`);
  }
  return limit;
}

/** Exactly what the public projection reads. Never the execution snapshot. */
export const PUBLIC_TURN_SELECT = {
  id: true,
  sessionId: true,
  idempotencyKey: true,
  userMessageId: true,
  assistantMessageId: true,
  userContent: true,
  userStatus: true,
  origin: true,
  assistantContent: true,
  assistantStatus: true,
  terminalEvidence: true,
  attempt: true,
  sceneVersion: true,
  scene: true,
  createdAt: true,
  memoryEnabled: true,
  attachments: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true, kind: true, status: true, generationJobId: true, mediaAssetId: true,
      promptHint: true, width: true, height: true, errorCode: true, metadata: true,
    },
  },
  // Only the latest Turn keeps versions (a newer Turn or an edit retires them).
  alternatives: { orderBy: { ordinal: "asc" }, select: { ordinal: true, assistantContent: true } },
} satisfies Prisma.ChatTurnSelect;

async function directTranscriptPage(sessionId: string, page: ChatTranscriptPage | undefined) {
  const limit = pageLimit(page);
  let before: Prisma.ChatTurnWhereInput = {};
  if (page?.beforeTurnId) {
    const anchor = await prisma.chatTurn.findFirst({
      where: { id: page.beforeTurnId, sessionId },
      select: { id: true, createdAt: true },
    });
    if (!anchor) throw Errors.badRequest("beforeTurnId does not belong to this chat");
    before = { OR: [
      { createdAt: { lt: anchor.createdAt } },
      { createdAt: anchor.createdAt, id: { lt: anchor.id } },
    ] };
  }
  const rows = await prisma.chatTurn.findMany({
    where: { sessionId, ...before },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: PUBLIC_TURN_SELECT,
  });
  const hasEarlier = rows.length > limit;
  const turns = rows.slice(0, limit).reverse();
  return { turns, page: { hasEarlier, earliestTurnId: turns[0]?.id ?? null } };
}

export async function getChatSession(userId: string, sessionId: string, transcriptPage?: ChatTranscriptPage) {
  const session = await prisma.recentChat.findFirst({
    where: { sessionId, userId },
    select: {
      sessionId: true, characterId: true, title: true, status: true, memoryEnabled: true,
      lastMessageAt: true, proactiveUnreadAt: true, proactiveEnabled: true, createdAt: true,
      groupId: true, openingMessage: true, characterReleaseId: true,
      character: { select: { name: true, creatorId: true, imageAsset: { select: { url: true, thumbnailUrl: true } } } },
    },
  });
  if (!session) throw Errors.notFound("Chat session not found");
  // A group member's session is one voice of the group; read as a one-to-one
  // chat it would hide the other speakers and let a send bypass the group.
  if (session.groupId) throw Errors.conflict("Open this conversation from its group chat", { reason: "group_conversation" });
  const { turns, page } = await directTranscriptPage(session.sessionId, transcriptPage);
  // The greeting precedes every Turn, so it belongs to the earliest page only.
  const messages = await enrichAttachmentMedia(publicMessages({
    ...session,
    openingMessage: page.hasEarlier ? null : session.openingMessage,
    turns,
  }), userId);
  if (session.proactiveUnreadAt) {
    // Opening the session is reading it. Scoped by the timestamp we just read so
    // a proactive reply that lands during this request stays unread.
    await prisma.recentChat.updateMany({
      where: { sessionId, userId, proactiveUnreadAt: { lte: session.proactiveUnreadAt } },
      data: { proactiveUnreadAt: null },
    });
  }
  return {
    ...publicSession(session, session.character.name),
    ownerScope: `user:${userId}`,
    continuation: await chatSessionContinuation(prisma, userId, session),
    // The open page polls for a check-in only while one can arrive.
    proactiveEnabled: session.proactiveEnabled,
    character: {
      name: session.character.name,
      canUpdateIdentity: session.character.creatorId === userId,
      // 聊天页头像：与角色卡同一张封面，小图优先。
      image: session.character.imageAsset?.thumbnailUrl ?? session.character.imageAsset?.url ?? null,
    },
    messages,
    page,
  };
}

/** Group transcript page: same contract, ordered by the group's ordinal. */
export async function groupTranscriptPage(groupId: string, transcriptPage: ChatTranscriptPage | undefined) {
  const limit = pageLimit(transcriptPage);
  let beforeOrdinal: number | undefined;
  if (transcriptPage?.beforeTurnId) {
    const anchor = await prisma.groupChatTurn.findFirst({
      where: { groupId, turnId: transcriptPage.beforeTurnId },
      select: { ordinal: true },
    });
    if (!anchor) throw Errors.badRequest("beforeTurnId does not belong to this group chat");
    beforeOrdinal = anchor.ordinal;
  }
  const rows = await prisma.groupChatTurn.findMany({
    where: { groupId, ...(beforeOrdinal === undefined ? {} : { ordinal: { lt: beforeOrdinal } }) },
    orderBy: { ordinal: "desc" },
    take: limit + 1,
    select: { turn: { select: PUBLIC_TURN_SELECT } },
  });
  const hasEarlier = rows.length > limit;
  const turns = rows.slice(0, limit).reverse().map((row) => row.turn);
  return { turns, page: { hasEarlier, earliestTurnId: turns[0]?.id ?? null } };
}

/** Local stream existence is execution evidence; Main decides whether it may be delivered. */
export async function chatStreamAuthority(userId: string, assistantMessageId: string, expectedAttempt?: number) {
  if (expectedAttempt !== undefined && (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 1)) {
    throw Errors.badRequest("Stream requires a positive integer attempt");
  }
  const turn = await prisma.chatTurn.findFirst({
    where: { assistantMessageId, session: { userId } },
    select: { attempt: true, admittedAt: true, assistantStatus: true },
  });
  if (!turn) throw Errors.notFound("Chat message not found");
  if (expectedAttempt !== undefined && turn.attempt !== expectedAttempt) {
    throw Errors.conflict("Stream belongs to a superseded Chat attempt", { reason: "version_mismatch" });
  }
  // A lost admission ACK leaves Main pending and cancellation can still release
  // its unused quota. No local text may escape in that state. A committed sent
  // terminal is sufficient evidence even when it arrived before the admission ACK.
  if (!turn.admittedAt && turn.assistantStatus !== "sent") {
    throw Errors.conflict("Chat attempt has not been confirmed for delivery");
  }
  return { attempt: turn.attempt };
}

export async function chatVoiceAuthority(userId: string, sessionId: string, messageId: string) {
  if (messageId === `opening:${sessionId}`) {
    const session = await prisma.recentChat.findFirst({ where: { sessionId, userId } });
    if (!session?.openingMessage?.trim()) throw Errors.notFound("Message not found");
    // INVARIANT: the greeting belongs to the immutable Session snapshot, not
    // the Character's current draft and not a caller-provided voice text.
    return {
      schemaVersion: 1 as const,
      sessionId,
      messageId,
      characterId: session.characterId,
      text: session.openingMessage,
      attempt: 1,
      sceneVersion: 0,
      scene: null,
      characterContentVersionId: session.characterContentVersionId,
      characterReleaseId: session.characterReleaseId,
    };
  }
  const turn = await prisma.chatTurn.findFirst({
    where: { sessionId, assistantMessageId: messageId, session: { userId } },
    include: { session: true },
  });
  if (!turn || turn.assistantStatus !== "sent") throw Errors.notFound("Message not found");
  return {
    schemaVersion: 1 as const,
    sessionId,
    messageId,
    characterId: turn.session.characterId,
    text: turn.assistantContent,
    attempt: turn.attempt,
    sceneVersion: turn.sceneVersion,
    scene: turn.scene,
    characterContentVersionId: turn.characterContentVersionId,
    characterReleaseId: turn.characterReleaseId,
  };
}

export async function chatTurnForEffect(turnId: string) {
  const turn = await prisma.chatTurn.findUnique({
    where: { id: turnId },
    include: { session: true },
  });
  if (!turn) throw Errors.notFound("Chat turn not found");
  return turn;
}

export function begunResult(
  turn: {
    id: string;
    userMessageId: string;
    assistantMessageId: string;
    attempt: number;
    userContent: string;
    idempotencyKey?: string;
    userStatus: string;
    assistantContent: string;
    assistantStatus: string;
    terminalEvidence?: Prisma.JsonValue;
    createdAt: Date;
    memoryEnabled: boolean;
    sceneVersion: number;
    scene: Prisma.JsonValue | null;
  },
  duplicate: boolean,
  snapshot: ChatExecutionSnapshot | null,
  policyCode?: string,
): BegunChatTurn {
  const blocked = turn.assistantStatus === "blocked";
  const active = ACTIVE_ASSISTANT_STATES.includes(turn.assistantStatus);
  return {
    duplicate,
    blocked,
    snapshot: active ? snapshot : null,
    userMessage: publicUserMessage(turn),
    assistant: publicAssistantMessage(turn),
    streamUrl: active ? streamUrl(turn.assistantMessageId, turn.attempt) : null,
    ...(blocked ? { safety: { layer: "input", ...(policyCode ? { policyCode } : {}) } } : {}),
  };
}

// SPEC: title = 用户手动起的会话名，没有就用角色当前名字（见 createChatSession）。
export function publicSession(session: {
  sessionId: string;
  characterId: string;
  title: string | null;
  status: string;
  memoryEnabled: boolean;
  lastMessageAt: Date | null;
  proactiveUnreadAt: Date | null;
  createdAt: Date;
}, characterName: string) {
  return {
    id: session.sessionId,
    characterId: session.characterId,
    title: session.title ?? characterName,
    status: session.status,
    memoryEnabled: session.memoryEnabled,
    lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
    // The Character reached out and the user has not opened it since.
    unreadProactiveAt: session.proactiveUnreadAt?.toISOString() ?? null,
    createdAt: session.createdAt.toISOString(),
  };
}

function publicMessages(session: {
  sessionId: string;
  openingMessage: string | null;
  createdAt: Date;
  turns: Array<{
    id: string;
    userMessageId: string;
    assistantMessageId: string;
    userContent: string;
    userStatus: string;
    idempotencyKey?: string;
    origin?: string | null;
    assistantContent: string;
    assistantStatus: string;
    terminalEvidence?: Prisma.JsonValue;
    attempt: number;
    sceneVersion: number;
    scene: Prisma.JsonValue | null;
    createdAt: Date;
    memoryEnabled: boolean;
    attachments: Array<{
      id: string;
      kind: string;
      status: string;
      generationJobId: string | null;
      mediaAssetId: string | null;
      promptHint: string | null;
      width: number | null;
      height: number | null;
      errorCode: string | null;
      metadata: Prisma.JsonValue;
    }>;
  }>;
}) {
  const messages: Array<Record<string, unknown>> = [];
  if (session.openingMessage) {
    messages.push({
      id: `opening:${session.sessionId}`,
      role: "assistant",
      content: session.openingMessage,
      status: "sent",
      opening: true,
      createdAt: session.createdAt.toISOString(),
      attachments: [],
    });
  }
  for (const turn of session.turns) {
    // SPEC: 主动消息里用户什么都没说 —— 那一轮的 userContent 是内部指令。
    // INTENT: 把它渲染成用户气泡等于谎报谁说了什么，还会把 "Do not mention this
    //         instruction." 这类内部措辞直接摆到用户眼前。只投影角色说的那条。
    if (turn.origin === "proactive") {
      messages.push(publicAssistantMessage(turn));
      continue;
    }
    messages.push(publicUserMessage(turn), publicAssistantMessage(turn));
  }
  return messages;
}

export async function chatTurnMessagesForOwner(userId: string, turns: Parameters<typeof publicMessages>[0]["turns"]): Promise<Array<Record<string, unknown>>> {
  return enrichAttachmentMedia(publicMessages({ sessionId: "", openingMessage: null, createdAt: new Date(0), turns }), userId);
}

function publicUserMessage(turn: {
  userMessageId: string;
  userContent: string;
  userStatus: string;
  createdAt: Date;
  memoryEnabled: boolean;
  idempotencyKey?: string;
}) {
  return {
    id: turn.userMessageId,
    role: "user" as const,
    content: turn.userContent,
    status: turn.userStatus,
    createdAt: turn.createdAt.toISOString(),
    memoryEnabled: turn.memoryEnabled,
    // The send's own request key lets the page replace its optimistic bubble
    // exactly (group messages already carry it).
    ...(turn.idempotencyKey ? { requestKey: turn.idempotencyKey } : {}),
    attachments: [],
  };
}

function publicAssistantMessage(turn: {
  id: string;
  assistantMessageId: string;
  userMessageId: string;
  assistantContent: string;
  assistantStatus: string;
  terminalEvidence?: Prisma.JsonValue;
  alternatives?: Array<{ ordinal: number; assistantContent: string }>;
  attempt: number;
  sceneVersion: number;
  scene: Prisma.JsonValue | null;
  createdAt: Date;
  memoryEnabled: boolean;
  attachments?: Array<{
    id: string;
    kind: string;
    status: string;
    generationJobId: string | null;
    mediaAssetId: string | null;
    promptHint: string | null;
    width: number | null;
    height: number | null;
    errorCode: string | null;
    metadata: Prisma.JsonValue;
  }>;
}) {
  return {
    id: turn.assistantMessageId,
    turnId: turn.id,
    role: "assistant" as const,
    content: turn.assistantContent,
    status: turn.assistantStatus,
    ...(turn.assistantStatus === "sent" && jsonRecord(turn.terminalEvidence ?? null).finishReason === "length"
      ? { replyLimitReached: true } : {}),
    ...(turn.assistantStatus === "failed" && jsonRecord(turn.terminalEvidence ?? null).failureCode === "agent_run_interrupted"
      ? { replyInterrupted: true } : {}),
    ...(turn.assistantStatus === "failed" ? publicFailureCode(turn.terminalEvidence ?? null) : {}),
    ...(() => {
      const versions = publicReplyVersions({ ...turn, terminalEvidence: turn.terminalEvidence ?? null });
      return versions ? { replyVersions: versions.versions } : {};
    })(),
    attempt: turn.attempt,
    replyToMessageId: turn.userMessageId,
    sceneVersion: turn.sceneVersion,
    scene: turn.scene,
    createdAt: turn.createdAt.toISOString(),
    memoryEnabled: turn.memoryEnabled,
    attachments: (turn.attachments ?? [])
      .filter((attachment) => attachmentAttempt(attachment.metadata) === turn.attempt)
      .map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        status: attachment.status,
        ...(attachment.kind === "generated_image" ? {
          imageSubject: jsonRecord(jsonRecord(attachment.metadata).request ?? null).subject === "scene" ? "scene" : "companion",
        } : {}),
        generationJobId: attachment.generationJobId,
        mediaAssetId: attachment.mediaAssetId,
        promptHint: attachment.promptHint,
        width: attachment.width,
        height: attachment.height,
        errorCode: attachment.errorCode,
        // SPEC: 聊天里出的图要说清这次扣了多少币。
        // INTENT: 币是在 generation-job-authority 的受理事务里连同这条 metadata 一起
        //   预留的（见该文件写入 costDreamcoins 处），公开契约也早就声明了这个字段，
        //   只有这层投影把它丢掉——用户于是只能事后去 Profile 对账。语音有报价确认卡，
        //   图片至少要有账目。
        costDreamcoins: attachmentCost(attachment.metadata),
        ...(attachment.status === "awaiting_confirmation"
          ? {
              confirmationKind:
                jsonRecord(attachment.metadata).confirmationKind === "paid_media_quote"
                  ? "paid_media_quote"
                  : "local_image_edit",
            }
          : {}),
        ...(attachment.status === "accepted"
          && attachment.mediaAssetId === null
          && attachment.generationJobId === null
          && jsonRecord(attachment.metadata).paidCuratedDelivery === true
          ? { deliveryStage: "sending" as const }
          : {}),
        // Do not leak internal library fulfillment source before reveal (`mediaAssetId` set).
        ...(attachment.mediaAssetId !== null && ["library", "previous_media"].includes(String(jsonRecord(attachment.metadata).source))
          ? { source: jsonRecord(attachment.metadata).source } : {}),
      })),
  };
}

// SPEC: the failure codes a page may explain. Everything else in the terminal
// evidence (provider names, model errors, timings) stays internal.
const PUBLIC_FAILURE_CODES = new Set([
  "admission_expired", "agent_run_interrupted", "agent_run_deadline_timeout", "agent_run_failed",
  "provider_first_token_timeout", "provider_idle_timeout", "rate_limited", "context_length_exceeded",
  "input_budget_exceeded", "image_paid_authorization_required", "media_library_only", "reply_cancelled",
]);

function publicFailureCode(evidence: Prisma.JsonValue | null): { failureCode?: string } {
  const code = jsonRecord(evidence).failureCode;
  return typeof code === "string" && PUBLIC_FAILURE_CODES.has(code) ? { failureCode: code } : {};
}

async function enrichAttachmentMedia(messages: Array<Record<string, unknown>>, userId: string) {
  const ids = new Set<string>();
  const jobIds = new Set<string>();
  for (const message of messages) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    for (const attachment of attachments) {
      if (!isRecord(attachment)) continue;
      const mediaAssetId = typeof attachment.mediaAssetId === "string" ? attachment.mediaAssetId : null;
      if (mediaAssetId) ids.add(mediaAssetId);
      if (typeof attachment.generationJobId === "string" && ["requesting", "accepted", "queued", "running", "failed", "refunded"].includes(String(attachment.status))) {
        jobIds.add(attachment.generationJobId);
      }
    }
  }
  if (ids.size === 0 && jobIds.size === 0) return messages;

  const jobs = jobIds.size ? await prisma.generationJob.findMany({
    where: { id: { in: [...jobIds] }, userId },
    select: { id: true, status: true, errorCode: true, sourceType: true },
  }) : [];
  const attempts = jobs.length ? await prisma.generationAttempt.findMany({
    where: { requestId: { in: jobs.map(job => job.id) } },
    select: { id: true, requestId: true, status: true, startedAt: true, errorCode: true, retryability: true },
    orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
  }) : [];
  const latestAttempts = new Map<string, (typeof attempts)[number]>();
  for (const attempt of attempts) if (!latestAttempts.has(attempt.requestId)) latestAttempts.set(attempt.requestId, attempt);
  const videoJobs = jobs.filter(job => job.sourceType === "chat_video");
  const dispatches = videoJobs.length ? await prisma.mainOutboxEvent.findMany({
    where: { aggregateType: "generation_request", aggregateId: { in: videoJobs.map(job => job.id) }, eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] } },
    select: { aggregateId: true, payload: true },
  }) : [];
  const dispatchesByJob = new Map<string, typeof dispatches>();
  for (const dispatch of dispatches) {
    const rows = dispatchesByJob.get(dispatch.aggregateId);
    if (rows) rows.push(dispatch);
    else dispatchesByJob.set(dispatch.aggregateId, [dispatch]);
  }
  const standings = await readGenerationQueueStandings(
    jobs.filter(job => job.status === "queued" && latestAttempts.get(job.id)?.status === "queued").map(job => job.id),
  );
  const jobProjections = new Map(jobs.map((job) => [
    job.id, {
      standing: standings.get(job.id) ?? null,
      status: effectiveGenerationJobStatus(job.status, latestAttempts.get(job.id)?.status ?? null),
      errorCode: generationExecutionErrorCode(job.status, latestAttempts.get(job.id)?.status ?? null, job.errorCode),
      canRetry: job.status === "failed" && !generationPreparationPreventsRetry(latestAttempts.get(job.id)),
      canCancel: job.sourceType === "chat_video" && canCancelGenerationBeforeProviderEntry(job, latestAttempts.get(job.id) ?? null, dispatchesByJob.get(job.id) ?? []),
    },
  ]));

  const assets = await prisma.mediaAsset.findMany({
    where: {
      id: { in: [...ids] },
      deletedAt: null,
      ...isReusablePlatformAssetWhere(userId),
    },
    select: {
      id: true,
      characterId: true,
      url: true,
      thumbnailUrl: true,
      width: true,
      height: true,
      metadata: true,
    },
  });
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return messages.map((message) => {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    return {
      ...message,
      attachments: attachments.map((attachment) => {
        if (!isRecord(attachment)) return attachment;
        const job = typeof attachment.generationJobId === "string"
          ? jobProjections.get(attachment.generationJobId)
          : null;
        // Liveness, retry and cancellation are read projections; delivery remains the
        // persisted attachment authority, including its terminal and media facts.
        const activeVideo = attachment.kind === "generated_video" && ["requesting", "accepted", "queued", "running"].includes(String(attachment.status));
        const mediaAttachment = ["generated_image", "generated_video"].includes(String(attachment.kind));
        const projected: Record<string, unknown> = {
          ...attachment,
          ...(mediaAttachment ? { canRetry: ["failed", "refunded"].includes(String(attachment.status)) && job?.canRetry === true } : {}),
          ...(mediaAttachment && job?.standing ? { queueAhead: job.standing.queueAhead, queueEtaSeconds: job.standing.queueEtaSeconds } : {}),
          ...(attachment.kind === "generated_video" ? { canCancel: activeVideo && job?.canCancel === true, ...(activeVideo && job?.status === "running" ? { status: "running" } : {}) } : {}),
        };
        if (job?.errorCode === "provider_outcome_unknown") return { ...projected, errorCode: job.errorCode };
        const mediaAssetId = typeof projected.mediaAssetId === "string" ? projected.mediaAssetId : null;
        const asset = mediaAssetId ? byId.get(mediaAssetId) : null;
        return asset
          ? {
              ...projected,
              // The delivered asset also covers edits whose request metadata
              // contains only the edit instruction, not a new subject choice.
              ...(projected.kind === "generated_image" ? { imageSubject: asset.characterId ? "companion" : "scene" } : {}),
              mediaUrl: asset.url,
              thumbnailUrl: asset.thumbnailUrl ?? asset.url,
              width: projected.width ?? asset.width,
              height: projected.height ?? asset.height,
              isSynthetic: isSyntheticMediaAsset(asset.metadata),
            }
          : projected;
      }),
    };
  });
}
