import { z } from "zod";
import { mainToChatEventType } from "../../contracts/events";
import {
  MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
  mainToChatTargetIdentitySchema,
} from "../../contracts/main-to-chat-authority";
import {
  adminCommandReasonSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
  adminPageInfoSchema,
} from "./common";

export { MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION };

export const MAIN_TO_CHAT_REPLAY_CONFIRMATION =
  "REPLAY_MAIN_TO_CHAT_FAILED" as const;

export const mainToChatOutboxEventQuerySchema = z
  .object({
    status: z.literal("failed").default("failed"),
    eventType: mainToChatEventType.optional(),
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const mainToChatOutboxEventSchema = z
  .object({
    id: adminIdSchema,
    eventType: mainToChatEventType,
    aggregateType: z.string().trim().min(1),
    aggregateId: adminIdSchema,
    status: z.literal("failed"),
    attempts: z.number().int().nonnegative(),
    nextRunAt: adminIsoDateTimeSchema,
    deliveredAt: adminIsoDateTimeSchema.nullable(),
    lastErrorMessage: z.string().trim().min(1).nullable(),
    envelopeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    storedEnvelopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    receiverAuthority: z.object({
      disposition: z.enum([
        "exact_receipt",
        "target_present",
        "expected_target_missing",
        "no_target_required",
        "receiver_hash_conflict",
        "receiver_quarantined",
        "discarded_target_missing",
        "invalid_envelope",
        "invalid_event_payload",
        "unavailable",
      ]),
      target: mainToChatTargetIdentitySchema.nullable(),
      targetStatus: z.string().trim().min(1).nullable(),
      receiptId: adminIdSchema.nullable(),
      receiptStatus: z.string().trim().min(1).nullable(),
      checkedAt: adminIsoDateTimeSchema,
    }).strict(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const mainToChatOutboxEventListResponseSchema =
  adminListResponseSchema(mainToChatOutboxEventSchema);

export const mainToChatOutboxReplayRequestSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            id: adminIdSchema,
            expectedAttempts: z.number().int().nonnegative(),
            expectedUpdatedAt: adminIsoDateTimeSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    reason: adminCommandReasonSchema,
    confirmation: z.literal(MAIN_TO_CHAT_REPLAY_CONFIRMATION),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.events.forEach((event, index) => {
      if (seen.has(event.id)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "id"],
          message: "event ids must be unique",
        });
      }
      seen.add(event.id);
    });
  });

export const mainToChatOutboxReplayOutcomeSchema = z.enum([
  "requeued",
  "already_delivered",
  "already_requeued",
  "stale",
  "invalid_envelope",
  "receiver_target_missing",
  "receiver_conflict",
  "not_found",
]);

export const mainToChatOutboxReplayResultSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            id: adminIdSchema,
            outcome: mainToChatOutboxReplayOutcomeSchema,
            priorAttempts: z.number().int().nonnegative().nullable(),
            envelopeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
            storedEnvelopeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
          })
          .strict(),
      )
      .readonly(),
    requeuedCount: z.number().int().nonnegative(),
    replayed: z.boolean(),
  })
  .strict();

export const mainToChatOutboxTargetMissingDispositionRequestSchema = z
  .object({
    events: z.array(z.object({
      id: adminIdSchema,
      expectedAttempts: z.number().int().nonnegative(),
      expectedUpdatedAt: adminIsoDateTimeSchema,
      expectedEnvelopeHash: z.string().regex(/^[a-f0-9]{64}$/),
      expectedTarget: mainToChatTargetIdentitySchema,
    }).strict()).min(1).max(100),
    reason: adminCommandReasonSchema,
    confirmation: z.literal(MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.events.forEach((event, index) => {
      if (seen.has(event.id)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "id"],
          message: "event ids must be unique",
        });
      }
      seen.add(event.id);
    });
  });

export const mainToChatOutboxTargetMissingDispositionOutcomeSchema = z.enum([
  "discarded_target_missing",
  "already_discarded_target_missing",
  "already_delivered",
  "already_requeued",
  "stale",
  "invalid_envelope",
  "envelope_hash_mismatch",
  "expected_target_mismatch",
  "expected_target_present",
  "receiver_conflict",
  "not_found",
]);

export const mainToChatOutboxTargetMissingDispositionResultSchema = z.object({
  results: z.array(z.object({
    id: adminIdSchema,
    outcome: mainToChatOutboxTargetMissingDispositionOutcomeSchema,
    priorAttempts: z.number().int().nonnegative().nullable(),
    envelopeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    storedEnvelopeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    target: mainToChatTargetIdentitySchema.nullable(),
    receiverReceiptId: adminIdSchema.nullable(),
  }).strict()).readonly(),
  discardedCount: z.number().int().nonnegative(),
  replayed: z.boolean(),
}).strict();

export type MainToChatOutboxEventQuery = z.infer<
  typeof mainToChatOutboxEventQuerySchema
>;
export type MainToChatOutboxEvent = z.infer<
  typeof mainToChatOutboxEventSchema
>;
export type MainToChatOutboxEventListResponse = z.infer<
  typeof mainToChatOutboxEventListResponseSchema
>;
export type MainToChatOutboxReplayRequest = z.infer<
  typeof mainToChatOutboxReplayRequestSchema
>;
export type MainToChatOutboxReplayResult = z.infer<
  typeof mainToChatOutboxReplayResultSchema
>;
export type MainToChatOutboxTargetMissingDispositionRequest = z.infer<
  typeof mainToChatOutboxTargetMissingDispositionRequestSchema
>;
export type MainToChatOutboxTargetMissingDispositionResult = z.infer<
  typeof mainToChatOutboxTargetMissingDispositionResultSchema
>;

/**
 * SPEC: Chat 服务只读运营视图（overview / provider-health / sessions / usage /
 *   moderation-events）经 Main 代理后的公开形状。
 * INTENT: v1 把 Chat 的响应体整个 spread 进信封，Main 对里面有什么没有任何声明。
 *   这些 DTO 就是补上的那份声明 —— 权威仍在 Chat（`packages/chat/src/admin.ts`），
 *   Main 只承诺「过得了这个形状才会发出去」。
 * INVARIANT: Chat 不可达 / 未配置 / 形状对不上时，`configured=false` 且列表为空、
 *   `pageInfo=null`，而不是 500 —— 运营台要能看见「为什么是空的」，
 *   这也是 `diagnostics.reason` 存在的全部理由。
 */
export const chatOpsProxyDiagnosticsSchema = z
  .object({
    reason: z
      .enum([
        "missing_url",
        "unreachable",
        "unauthorized",
        "upstream_error",
        "bad_json",
        "contract_mismatch",
      ])
      .optional(),
    status: z.number().int().optional(),
    serviceUrlConfigured: z.boolean(),
  })
  .strict();

const chatOpsListQueryLimitSchema = z.coerce.number().int().min(1).max(100).default(50);

export const chatOpsSessionQuerySchema = z
  .object({
    userId: z.string().trim().min(1).max(200).optional(),
    characterId: z.string().trim().min(1).max(200).optional(),
    status: z.enum(["active", "archived", "deleted", "all"]).optional(),
    cursor: z.string().trim().min(1).optional(),
    limit: chatOpsListQueryLimitSchema,
  })
  .strict();

export const chatOpsUsageQuerySchema = z
  .object({
    userId: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().trim().min(1).optional(),
    limit: chatOpsListQueryLimitSchema,
  })
  .strict();

export const chatOpsModerationEventQuerySchema = z
  .object({
    status: z.enum(["all", "blocked", "flagged", "passed"]).optional(),
    layer: z.enum(["all", "input", "output"]).optional(),
    policyCode: z.string().trim().min(1).max(200).optional(),
    targetType: z.string().trim().min(1).max(100).optional(),
    targetId: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().trim().min(1).optional(),
    limit: chatOpsListQueryLimitSchema,
  })
  .strict();

const nonNegativeCount = z.number().int().nonnegative();

export const chatOpsOverviewSchema = z
  .object({
    activeSessions: nonNegativeCount,
    archivedSessions: nonNegativeCount,
    deletedSessions: nonNegativeCount,
    messages24h: nonNegativeCount,
    userMessages24h: nonNegativeCount,
    assistantMessages24h: nonNegativeCount,
    moderationEvents24h: nonNegativeCount,
    blockedModeration24h: nonNegativeCount,
    flaggedModeration24h: nonNegativeCount,
    messagesUsedToday: z.number().nonnegative(),
    usersAtDailyLimit: nonNegativeCount,
    unlimitedEntitlements: nonNegativeCount,
    freeDailyLimit: nonNegativeCount,
    windowHours: z.number().int().positive(),
    dataScope: z
      .object({
        userAuthority: z.string().min(1),
        includedUserStatus: z.string().min(1),
        includedDeletedAt: z.null(),
        includedDataClass: z.string().min(1),
        activeAuthorityUsers: nonNegativeCount,
        excluded: z
          .object({
            activeSessions: nonNegativeCount,
            archivedSessions: nonNegativeCount,
            deletedSessions: nonNegativeCount,
            messages24h: nonNegativeCount,
            moderationEvents24h: nonNegativeCount,
            usageRowsToday: nonNegativeCount,
            messagesUsedToday: z.number().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const chatOpsProviderHealthItemSchema = z
  .object({
    provider: z.string().min(1),
    adapter: z.string().min(1),
    status: z.string().min(1),
    ok: z.boolean(),
    model: z.string().nullable(),
    endpoint: z.string().nullable(),
    latencyMs: z.number().nullable(),
    httpStatus: z.number().int().nullable(),
    modelListed: z.boolean().nullable().optional(),
    error: z.string().nullable(),
  })
  .strict();

export const chatOpsSessionSchema = z
  .object({
    id: adminIdSchema,
    userId: adminIdSchema,
    characterId: adminIdSchema,
    title: z.string().nullable(),
    status: z.string().min(1),
    memoryEnabled: z.boolean(),
    messageCount: nonNegativeCount,
    lastMessageId: z.string().nullable(),
    lastMessageRole: z.string().nullable(),
    lastMessageStatus: z.string().nullable(),
    lastSafetyStatus: z.string().nullable(),
    lastModel: z.string().nullable(),
    lastTokenCount: z.number().int().nullable(),
    lastMessageAt: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const chatOpsUsageSchema = z
  .object({
    userId: adminIdSchema,
    sessionId: z.string().nullable(),
    modelTier: z.string().min(1),
    unlimitedMessages: z.boolean(),
    memoryMultiplier: z.number(),
    voiceEnabled: z.boolean(),
    messagesUsed: nonNegativeCount,
    freeDailyLimit: nonNegativeCount,
    freeRemaining: z.number().int().nullable(),
    quotaStatus: z.enum(["unlimited", "free_at_limit", "free_remaining"]),
    activeSessions: nonNegativeCount,
    messages24h: nonNegativeCount,
    periodStart: adminIsoDateTimeSchema,
    periodEnd: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const chatOpsModerationEventSchema = z
  .object({
    id: adminIdSchema,
    targetType: z.string().min(1),
    targetId: adminIdSchema,
    layer: z.string().min(1),
    status: z.string().min(1),
    policyCode: z.string().nullable(),
    confidence: z.number().nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

const chatOpsProxyEnvelope = {
  configured: z.boolean(),
  diagnostics: chatOpsProxyDiagnosticsSchema,
} as const;

export const chatOpsOverviewResponseSchema = z
  .object({
    ...chatOpsProxyEnvelope,
    overview: chatOpsOverviewSchema.nullable(),
  })
  .strict();

export const chatOpsProviderHealthResponseSchema = z
  .object({
    ...chatOpsProxyEnvelope,
    checkedAt: adminIsoDateTimeSchema.nullable(),
    items: z.array(chatOpsProviderHealthItemSchema).readonly(),
  })
  .strict();

export const chatOpsSessionListResponseSchema = z
  .object({
    ...chatOpsProxyEnvelope,
    items: z.array(chatOpsSessionSchema).readonly(),
    pageInfo: adminPageInfoSchema.nullable(),
  })
  .strict();

export const chatOpsUsageListResponseSchema = z
  .object({
    ...chatOpsProxyEnvelope,
    freeDailyLimit: nonNegativeCount.nullable(),
    items: z.array(chatOpsUsageSchema).readonly(),
    pageInfo: adminPageInfoSchema.nullable(),
  })
  .strict();

export const chatOpsModerationEventListResponseSchema = z
  .object({
    ...chatOpsProxyEnvelope,
    items: z.array(chatOpsModerationEventSchema).readonly(),
    pageInfo: adminPageInfoSchema.nullable(),
  })
  .strict();

export type ChatOpsProxyDiagnostics = z.infer<typeof chatOpsProxyDiagnosticsSchema>;
export type ChatOpsOverview = z.infer<typeof chatOpsOverviewSchema>;
export type ChatOpsSession = z.infer<typeof chatOpsSessionSchema>;
export type ChatOpsUsage = z.infer<typeof chatOpsUsageSchema>;
export type ChatOpsModerationEvent = z.infer<typeof chatOpsModerationEventSchema>;
