// SPEC: main-event-consumer (design §10). Consumes the chat→main events that the
// chat service delivers to the `main.inbound` queue (its transactional outbox),
// and applies them to main's authority tables: stats, safety, analytics.
// INVARIANT: each origin service + source event has one durable projection
// receipt; its domain effect and processed receipt commit in the same DB TX.
import { Worker } from "bullmq";
import type { RedisOptions } from "ioredis";
import { Prisma } from "@prisma/client";
import { setGauge } from "@idream/shared";
import {
  MAIN_QUEUES,
  MAIN_TO_CHAT_EVENTS,
  CHAT_TO_MAIN_EVENTS,
  chatExchangeCorrectionV2Schema,
  chatImageRequestedPayloadSchema,
  chatSessionReleaseMigrationAppliedPayloadSchema,
} from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { logger } from "@/server/lib/logger";
import { createChatImageGenerationJob } from "@/server/modules/ourdream/service";
import { findReusableChatImage } from "@/server/modules/ourdream/chat-image-reuse";
import {
  dispatchPendingChatEvents,
  recordMainToChatEvent,
} from "./chat-outbox";
import { projectCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/projector";
import { transitionControlPlaneCommandAttempt } from "@/server/modules/admin-v2/shared/control-plane-command-attempt";
import { transitionControlPlaneCommand } from "@/server/modules/admin-v2/shared/control-plane-command-transition";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { activeCustomerUserWhere } from "@/server/modules/ourdream/public-content-audience";
import { updateGenerationRequestSourceMeta } from "@/server/ai/generation-request-transition";

function redisOptions(): RedisOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname !== "/" ? Number.parseInt(url.pathname.slice(1), 10) : 0,
    maxRetriesPerRequest: null,
  };
}

interface InboundEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
  schemaVersion?: number;
  sourceService?: string;
}

type ChatProjectionSkipReason =
  | "chat_projection_customer_authority_missing"
  | "chat_projection_character_authority_missing";

type ChatEventEffectResult =
  | { readonly status: "applied" }
  | {
      readonly status: "skipped";
      readonly reason: ChatProjectionSkipReason;
    };

export type ChatEventApplyResult =
  | ChatEventEffectResult
  | {
      readonly status: "duplicate";
      readonly outcome: "applied" | "skipped";
      readonly reason?: ChatProjectionSkipReason;
    }
  | {
      readonly status: "quarantined";
      readonly reason: "payload_hash_conflict" | "source_event_quarantined";
    };

export interface ChatEventApplyHooks {
  readonly afterEffect?: (sourceEventId: string) => Promise<void> | void;
}

const CHAT_EVENT_APPLIED = { status: "applied" } as const;
const CHAT_PROJECTION_RECEIPT_NAMESPACE = "main.product_projection";

async function resolveChatCustomerAuthority(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<ChatEventEffectResult> {
  const customer = userId
    ? await tx.user.findFirst({
        where: { id: userId, ...activeCustomerUserWhere },
        select: { id: true },
      })
    : null;
  return customer
    ? CHAT_EVENT_APPLIED
    : {
        status: "skipped",
        reason: "chat_projection_customer_authority_missing",
      };
}

async function resolveChatProjectionAuthority(
  tx: Prisma.TransactionClient,
  userId: string,
  characterId: string,
): Promise<ChatEventEffectResult> {
  const [customerAuthority, character] = await Promise.all([
    resolveChatCustomerAuthority(tx, userId),
    characterId
      ? tx.character.findFirst({
          where: { id: characterId, deletedAt: null },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  if (customerAuthority.status === "skipped") return customerAuthority;
  if (!character) {
    return {
      status: "skipped",
      reason: "chat_projection_character_authority_missing",
    };
  }
  return CHAT_EVENT_APPLIED;
}

type ChatImagePrivacyRedactionReason =
  | "logical_exchange_deleted"
  | "logical_exchange_edited"
  | "session_deleted";

async function redactChatImageGenerationSourceMeta(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    sourceEventId: string;
    redactedAt: Date;
    reason: ChatImagePrivacyRedactionReason;
    sessionId?: string;
    exchangeIds?: readonly string[];
    messageIds?: readonly string[];
  },
): Promise<number> {
  if (!input.userId) return 0;
  const selectors: Prisma.GenerationJobWhereInput[] = [
    ...(input.sessionId
      ? [{ sourceMeta: { path: ["sessionId"], equals: input.sessionId } }]
      : []),
    ...[...new Set(input.exchangeIds ?? [])].map((exchangeId) => ({
      sourceMeta: { path: ["exchangeId"], equals: exchangeId },
    })),
    ...[...new Set(input.messageIds ?? [])].map((messageId) => ({
      sourceMeta: { path: ["messageId"], equals: messageId },
    })),
  ];
  if (selectors.length === 0) return 0;

  const jobs = await tx.generationJob.findMany({
    where: {
      userId: input.userId,
      sourceType: "chat_image",
      OR: selectors,
    },
    select: { id: true, sourceMeta: true },
  });
  for (const job of jobs) {
    await updateGenerationRequestSourceMeta(tx, {
      requestId: job.id,
      sourceMeta: {
        ...jsonRecord(job.sourceMeta),
        promptHint: null,
        conversationContext: null,
        privacyRedaction: {
          reason: input.reason,
          sourceEventId: input.sourceEventId,
          redactedAt: input.redactedAt.toISOString(),
        },
      },
    });
  }
  return jobs.length;
}

async function chatImageRequestPrivacyWasRevoked(
  tx: Prisma.TransactionClient,
  payload: ReturnType<typeof chatImageRequestedPayloadSchema.parse>,
): Promise<boolean> {
  const [sessionProjection, exchangeFact] = await Promise.all([
    tx.recentChat.findUnique({
      where: { sessionId: payload.sessionId },
      select: { userId: true, status: true },
    }),
    payload.exchangeId
      ? tx.chatExchangeFact.findUnique({
          where: { exchangeId: payload.exchangeId },
          select: { userId: true, correctionType: true },
        })
      : tx.chatExchangeFact.findFirst({
          where: {
            userId: payload.userId,
            sessionId: payload.sessionId,
            OR: [
              { assistantMessageId: payload.messageId },
              { selectedAssistantMessageId: payload.messageId },
            ],
          },
          select: { userId: true, correctionType: true },
        }),
  ]);
  if (
    sessionProjection?.userId === payload.userId &&
    sessionProjection.status === "deleted"
  ) {
    return true;
  }
  return exchangeFact?.userId === payload.userId &&
    exchangeFact.correctionType !== null &&
    ["edited", "deleted", "superseded"].includes(
      exchangeFact.correctionType,
    );
}

export async function applyChatEvent(
  event: InboundEvent,
  hooks: ChatEventApplyHooks = {},
): Promise<ChatEventApplyResult> {
  const sourceEventId = event.eventId.trim();
  if (!sourceEventId) {
    throw new Error("chat projection source eventId is required");
  }
  const sourceService = `${CHAT_PROJECTION_RECEIPT_NAMESPACE}:${event.sourceService?.trim() || "chat"}`;
  const payloadHash = canonicalSha256({
    eventType: event.eventType,
    schemaVersion: event.schemaVersion ?? 1,
    aggregateId: event.aggregateId,
    occurredAt: normalizedEventOccurredAt(event.occurredAt),
    payload: event.payload,
  });
  const where = {
    sourceService_sourceEventId: {
      sourceService,
      sourceEventId,
    },
  } as const;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${sourceService}:${sourceEventId}`}, 0)
      )
    `;
    const existing = await tx.inboundEventReceipt.findUnique({ where });
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        await tx.inboundEventReceipt.update({
          where,
          data: {
            processingState: "quarantined",
            quarantinedAt: new Date(),
            error: {
              code: "payload_hash_conflict",
              expectedHash: existing.payloadHash,
              receivedHash: payloadHash,
            },
          },
        });
        return {
          status: "quarantined",
          reason: "payload_hash_conflict",
        };
      }
      if (existing.processingState === "quarantined") {
        return {
          status: "quarantined",
          reason: "source_event_quarantined",
        };
      }
      if (existing.processingState === "processed") {
        const evidence = jsonRecord(existing.error);
        const reason = chatProjectionSkipReason(evidence.reason);
        return reason && evidence.outcome === "skipped"
          ? { status: "duplicate", outcome: "skipped", reason }
          : { status: "duplicate", outcome: "applied" };
      }
    }

    const result = await applyChatEventEffect(tx, event);
    await hooks.afterEffect?.(sourceEventId);
    const processedAt = new Date();
    const data = {
      payloadHash,
      processingState: "processed",
      processedAt,
      quarantinedAt: null,
      error: result.status === "skipped"
        ? {
            outcome: "skipped",
            reason: result.reason,
          }
        : Prisma.DbNull,
    } as const;
    if (existing) {
      await tx.inboundEventReceipt.update({ where, data });
    } else {
      await tx.inboundEventReceipt.create({
        data: {
          sourceService,
          sourceEventId,
          ...data,
        },
      });
    }
    return result;
  }, {
    maxWait: 10_000,
    timeout: 60_000,
  });
}

async function applyChatEventEffect(
  tx: Prisma.TransactionClient,
  event: InboundEvent,
): Promise<ChatEventEffectResult> {
  switch (event.eventType) {
    case CHAT_TO_MAIN_EVENTS.sessionCreated: {
      // Seed the library recent-chats projection (chat service owns authority).
      const userId = String(event.payload.userId ?? "");
      const characterId = String(event.payload.characterId ?? "");
      const authority = await resolveChatProjectionAuthority(tx, userId, characterId);
      if (authority.status === "skipped") return authority;
      await tx.recentChat.upsert({
        where: { sessionId: event.aggregateId },
        create: { sessionId: event.aggregateId, userId, characterId, lastMessageAt: eventTime(event) },
        update: {},
      });
      return CHAT_EVENT_APPLIED;
    }
    case CHAT_TO_MAIN_EVENTS.messageCompleted: {
      const characterId = String(event.payload.characterId ?? "");
      const userId = String(event.payload.userId ?? "");
      const authority = await resolveChatProjectionAuthority(tx, userId, characterId);
      if (authority.status === "skipped") return authority;
      await tx.characterStats.updateMany({
        where: { characterId },
        data: { chatsCount: { increment: 1 }, lastActivityAt: eventTime(event) },
      });
      // Bump the projection's recency (upsert: tolerate a missed session.created).
      const sessionId = String(event.payload.sessionId ?? "");
      if (sessionId) {
        await tx.recentChat.upsert({
          where: { sessionId },
          create: { sessionId, userId, characterId, lastMessageAt: eventTime(event), status: "active" },
          update: { lastMessageAt: eventTime(event), status: "active" },
        });
      }
      return CHAT_EVENT_APPLIED;
    }
    case CHAT_TO_MAIN_EVENTS.exchangeCorrectedV2: {
      const payload = chatExchangeCorrectionV2Schema.parse(event.payload);
      if (payload.correctionType === "selected") {
        return CHAT_EVENT_APPLIED;
      }
      const fact = await tx.chatExchangeFact.findUnique({
        where: { exchangeId: payload.exchangeId },
        select: {
          userId: true,
          sessionId: true,
          userMessageId: true,
          assistantMessageId: true,
          selectedAssistantMessageId: true,
        },
      });
      const exactFact = fact?.userId === payload.userId ? fact : null;
      await redactChatImageGenerationSourceMeta(tx, {
        userId: payload.userId,
        sourceEventId: event.eventId,
        redactedAt: eventTime(event),
        reason:
          payload.correctionType === "edited"
            ? "logical_exchange_edited"
            : "logical_exchange_deleted",
        exchangeIds: [payload.exchangeId],
        messageIds: [
          ...(payload.messageIds ?? []),
          payload.exchangeId,
          ...(exactFact
            ? [
                exactFact.userMessageId,
                exactFact.assistantMessageId,
                exactFact.selectedAssistantMessageId,
              ]
            : []),
        ],
      });
      return CHAT_EVENT_APPLIED;
    }
    case CHAT_TO_MAIN_EVENTS.sessionDeleted: {
      await tx.recentChat.updateMany({ where: { sessionId: event.aggregateId }, data: { status: "deleted" } });
      await redactChatImageGenerationSourceMeta(tx, {
        userId: String(event.payload.userId ?? ""),
        sourceEventId: event.eventId,
        redactedAt: eventTime(event),
        reason: "session_deleted",
        sessionId: event.aggregateId,
      });
      return CHAT_EVENT_APPLIED;
    }
    case CHAT_TO_MAIN_EVENTS.safetyFlagged: {
      const authority = await resolveChatCustomerAuthority(
        tx,
        String(event.payload.userId ?? ""),
      );
      if (authority.status === "skipped") return authority;
      await tx.moderationEvent.create({
        data: {
          targetType: "message",
          targetId: event.aggregateId,
          layer: String(event.payload.layer ?? "output"),
          status: "flagged",
          policyCode: (event.payload.policyCode as string) ?? null,
          details: {},
        },
      });
      return CHAT_EVENT_APPLIED;
    }
    case CHAT_TO_MAIN_EVENTS.imageRequested: {
      // Parse INSIDE the try so a schema-mismatched event (e.g. a rolling deploy where an
      // older chat omits a newly-required field) still emits a chat.image.failed callback
      // instead of throwing → dead-lettering with no notification → attachment stuck
      // forever in 'requesting'. Recover the attachmentId best-effort for that callback.
      const attachmentId = String(
        (event.payload as { attachmentId?: unknown }).attachmentId ?? event.aggregateId ?? "",
      );
      try {
        const payload = chatImageRequestedPayloadSchema.parse(event.payload);
        // A retried/late image-request event must not resurrect source text
        // after the logical exchange or whole session has been deleted. The
        // canonical metric projector runs before this product projection and
        // supplies the durable exchange correction tombstone.
        if (await chatImageRequestPrivacyWasRevoked(tx, payload)) {
          return CHAT_EVENT_APPLIED;
        }
        const reusable = await findReusableChatImage(payload);
        if (reusable) {
          await enqueueChatCallback({
            eventId: `chat_image_completed_${payload.attachmentId}_reused_${reusable.asset.id}`,
            eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
            payload: {
              version: 1,
              kind: "chat.image.completed",
              attachmentId: payload.attachmentId,
              generationJobId: null,
              mediaAssetId: reusable.asset.id,
              width: reusable.asset.width,
              height: reusable.asset.height,
              reused: true,
              reuseScore: reusable.score,
              matchedFields: reusable.matchedFields,
              summary: reusable.description ?? (reusable.tags.join(", ") || undefined),
            },
          });
          return CHAT_EVENT_APPLIED;
        }
        const job = await createChatImageGenerationJob(payload);
        await enqueueChatCallback({
          eventId: `chat_image_accepted_${payload.attachmentId}_${job.id}`,
          eventType: MAIN_TO_CHAT_EVENTS.chatImageAccepted,
          payload: {
            version: 1,
            kind: "chat.image.accepted",
            attachmentId: payload.attachmentId,
            generationJobId: job.id,
            costDreamcoins: job.costDreamcoins,
          },
        });
      } catch (error) {
        // INVARIANT: only genuinely PERMANENT errors are 'rejected' (which the chat confirm
        // endpoint refuses to re-confirm). Transient ones — insufficient coins, rate limit,
        // a Redis/DB blip — are 'failed' so the user can retry once the condition clears;
        // marking them 'rejected' would wedge the attachment permanently.
        await enqueueChatCallback({
          eventId: `chat_image_failed_${attachmentId}`,
          eventType: MAIN_TO_CHAT_EVENTS.chatImageFailed,
          payload: {
            version: 1,
            kind: "chat.image.failed",
            attachmentId,
            generationJobId: null,
            status: chatImageFailureStatus(error),
            errorCode: errorCode(error),
          },
        });
      }
      return CHAT_EVENT_APPLIED;
    }
    case CHAT_TO_MAIN_EVENTS.accountErasureCompleted:
      logger.info({ userId: event.aggregateId }, "chat account erasure completed");
      return CHAT_EVENT_APPLIED;
    case CHAT_TO_MAIN_EVENTS.sessionReleaseMigrationApplied: {
      const payload = chatSessionReleaseMigrationAppliedPayloadSchema.parse(event.payload);
      const command = await tx.controlPlaneCommand.findUnique({
        where: { id: payload.commandId },
      });
      if (!command || command.commandType !== "chat.session_release.migrate") return CHAT_EVENT_APPLIED;
      if (command.status === "succeeded") return CHAT_EVENT_APPLIED;
      if (command.status !== "verifying" || command.targetId !== payload.sessionId) {
        throw new Error("session release migration verification does not match command state");
      }
      const expected = jsonRecord(command.requestPayload);
      const expectedMatches =
        expected.characterId === payload.characterId &&
        expected.fromCharacterContentVersionId === payload.fromCharacterContentVersionId &&
        expected.fromCharacterReleaseId === payload.fromCharacterReleaseId &&
        expected.toCharacterContentVersionId === payload.toCharacterContentVersionId &&
        expected.toCharacterReleaseId === payload.toCharacterReleaseId;
      if (!expectedMatches) {
        throw new Error("session release migration verification payload changed");
      }
      const appliedAt = new Date(payload.appliedAt);
      await transitionControlPlaneCommand(tx, {
        commandId: command.id,
        to: "succeeded",
        expected: { from: "verifying", attemptCount: command.attemptCount },
        data: {
          result: {
            sessionId: payload.sessionId,
            characterId: payload.characterId,
            fromCharacterContentVersionId: payload.fromCharacterContentVersionId,
            fromCharacterReleaseId: payload.fromCharacterReleaseId,
            toCharacterContentVersionId: payload.toCharacterContentVersionId,
            toCharacterReleaseId: payload.toCharacterReleaseId,
            verificationState: "passed",
            appliedAt: payload.appliedAt,
          },
          heartbeatAt: appliedAt,
          finishedAt: appliedAt,
        },
      });
      await transitionControlPlaneCommandAttempt(tx, {
        commandId: command.id,
        attemptNo: command.attemptCount,
        to: "succeeded",
        data: { finishedAt: appliedAt },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: command.actorId,
          actorRole: "command_verifier",
          action: "chat.session_release.migrate.applied",
          targetType: "chat_session",
          targetId: payload.sessionId,
          reason: "Chat applied the approved Release pin at the next turn boundary",
          before: {
            characterContentVersionId: payload.fromCharacterContentVersionId,
            characterReleaseId: payload.fromCharacterReleaseId,
          },
          after: {
            characterContentVersionId: payload.toCharacterContentVersionId,
            characterReleaseId: payload.toCharacterReleaseId,
            appliedAt: payload.appliedAt,
          },
          requestId: command.requestId,
        },
      });
      return CHAT_EVENT_APPLIED;
    }
    default:
      // usage.incremented / memory.updated / relationship.updated: analytics-only
      // for now; recording is enough.
      logger.debug({ eventType: event.eventType }, "chat event observed");
      return CHAT_EVENT_APPLIED;
  }
}

function chatProjectionSkipReason(value: unknown): ChatProjectionSkipReason | undefined {
  return value === "chat_projection_customer_authority_missing" ||
    value === "chat_projection_character_authority_missing"
    ? value
    : undefined;
}

function eventTime(event: InboundEvent): Date {
  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
  return Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;
}

function normalizedEventOccurredAt(value: string | undefined): string | null {
  if (!value) return null;
  const occurredAt = new Date(value);
  return Number.isNaN(occurredAt.getTime()) ? value : occurredAt.toISOString();
}

export interface ProductEventDispatchOptions {
  readonly outboxIds?: readonly string[];
}

export async function dispatchPendingProductEvents(
  batch = 100,
  options: ProductEventDispatchOptions = {},
): Promise<{ delivered: number; failed: number }> {
  const now = new Date();
  const pendingWhere: Prisma.MainOutboxEventWhereInput = {
    eventType: "product.event.persisted.v2",
    status: "pending",
    ...(options.outboxIds ? { id: { in: [...new Set(options.outboxIds)] } } : {}),
  };
  const [oldestPending, rows] = await Promise.all([
    prisma.mainOutboxEvent.findFirst({
      where: pendingWhere,
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.mainOutboxEvent.findMany({
      where: { ...pendingWhere, nextRunAt: { lte: now } },
      orderBy: { createdAt: "asc" },
      take: batch,
    }),
  ]);
  setGauge(
    "main_outbox_pending_age_seconds",
    "Age of the oldest pending Main outbox event",
    { queue: "product_event" },
    oldestPending ? Math.max(0, now.getTime() - oldestPending.createdAt.getTime()) / 1_000 : 0,
  );
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    const event = await prisma.analyticsEvent.findUnique({ where: { id: row.aggregateId } });
    if (!event) {
      await prisma.mainOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: "failed",
          attempts: { increment: 1 },
          lastError: {
            outcome: "failed",
            reason: "canonical_product_event_missing",
            canonicalEventId: row.aggregateId,
          },
        },
      });
      failed += 1;
      continue;
    }
    const context = jsonRecord(event.context);
    const chatEvent: InboundEvent = {
      eventId: event.sourceEventId ?? event.id,
      eventType: event.name,
      aggregateId: String(
        context.aggregateId ?? event.sourceEventId ?? event.id,
      ),
      occurredAt: event.occurredAt?.toISOString(),
      payload: jsonRecord(event.props),
      schemaVersion: event.schemaVersion,
      sourceService: event.sourceService,
    };
    try {
      const metricProjection = await projectCanonicalMetricEvent(prisma, {
        id: event.id,
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId ?? event.id,
        name: event.name,
        schemaVersion: event.schemaVersion,
        occurredAt: event.occurredAt ?? event.createdAt,
        ingestedAt: event.ingestedAt,
        environment: event.environment,
        dataClass: event.dataClass,
        trustClass: event.trustClass,
        actor: event.actor,
        context: event.context,
        props: event.props,
      });
      if (metricProjection.status === "deferred") {
        if (event.name === CHAT_TO_MAIN_EVENTS.exchangeCorrectedV2) {
          // Privacy revocation cannot wait for the completed-exchange metric
          // fact. Apply this idempotent product projection now, while keeping
          // the durable outbox pending so the metric correction can catch up
          // if/when its authority fact arrives.
          const privacyProjection = await applyChatEvent(chatEvent);
          if (privacyProjection.status === "quarantined") {
            throw new Error(
              `chat event projection quarantined: ${privacyProjection.reason}`,
            );
          }
        }
        throw new Error(`Metric projection deferred: ${metricProjection.reason}`);
      }
      const chatProjection = await applyChatEvent(chatEvent);
      if (chatProjection.status === "quarantined") {
        await prisma.mainOutboxEvent.update({
          where: { id: row.id },
          data: {
            status: "failed",
            attempts: { increment: 1 },
            lastError: {
              outcome: "quarantined",
              reason: chatProjection.reason,
              sourceService: event.sourceService,
              sourceEventId: event.sourceEventId ?? event.id,
            },
          },
        });
        failed += 1;
        continue;
      }
      const skipReason = effectiveChatProjectionSkipReason(chatProjection);
      await prisma.mainOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: "delivered",
          deliveredAt: new Date(),
          lastError: skipReason
            ? {
                outcome: "skipped",
                reason: skipReason,
              }
            : Prisma.DbNull,
        },
      });
      delivered += 1;
    } catch (error) {
      await prisma.mainOutboxEvent.update({
        where: { id: row.id },
        data: {
          attempts: { increment: 1 },
          nextRunAt: new Date(Date.now() + 30_000 * (row.attempts + 1)),
          lastError: { message: error instanceof Error ? error.message : "projection failed" },
        },
      });
      failed += 1;
    }
  }
  return { delivered, failed };
}

function effectiveChatProjectionSkipReason(
  result: ChatEventApplyResult,
): ChatProjectionSkipReason | undefined {
  if (result.status === "skipped") return result.reason;
  if (result.status === "duplicate" && result.outcome === "skipped") {
    return result.reason;
  }
  return undefined;
}

function jsonRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function enqueueChatCallback(input: {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  await recordMainToChatEvent({
    eventId: input.eventId,
    eventType: input.eventType,
    aggregateId: input.eventId,
    payload: input.payload,
  });
  await dispatchPendingChatEvents().catch(() => undefined);
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "chat_image_rejected";
}

// Permanent AppError codes → 'rejected' (not retryable); everything else (payment_required,
// rate_limited, internal, conflict, parse/unknown) → 'failed' so the user can retry.
const PERMANENT_IMAGE_ERROR_CODES = new Set([
  "bad_request",
  "forbidden",
  "not_found",
  "unauthorized",
]);

function chatImageFailureStatus(error: unknown): "failed" | "rejected" {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  return PERMANENT_IMAGE_ERROR_CODES.has(code) ? "rejected" : "failed";
}

export function startEventConsumer(): Worker {
  const worker = new Worker(
    MAIN_QUEUES.mainInbound,
    async (job) => {
      // The chat producer (packages/chat enqueue) wraps the event envelope as
      // { payload: <envelope>, dedupeKey }. Unwrap to the envelope; tolerate an
      // already-unwrapped shape so either producer convention is consumed.
      const data = job.data as { payload?: InboundEvent } & Partial<InboundEvent>;
      const event = (data.payload ?? data) as InboundEvent;
      const result = await applyChatEvent(event);
      if (result.status === "quarantined") {
        throw new Error(`chat event projection quarantined: ${result.reason}`);
      }
    },
    { connection: redisOptions(), prefix: env.BULLMQ_PREFIX, concurrency: 4 },
  );
  worker.on("ready", () => logger.info("main-event-consumer ready"));
  worker.on("failed", (job, err) => logger.error({ jobId: job?.id, err }, "event consume failed"));
  const projectionTimer = setInterval(() => {
    dispatchPendingProductEvents().catch((err) => logger.error({ err }, "product event projection dispatch failed"));
    dispatchPendingChatEvents().catch((err) => logger.error({ err }, "chat outbox dispatch failed"));
  }, 5_000);
  worker.on("closed", () => clearInterval(projectionTimer));
  return worker;
}

// Entry when run directly (pm2): start + graceful shutdown.
if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = startEventConsumer();
  const shutdown = async () => {
    await worker.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
