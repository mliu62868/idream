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
