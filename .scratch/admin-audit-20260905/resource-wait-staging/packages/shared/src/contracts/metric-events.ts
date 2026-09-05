import { z } from "zod";

export const chatExchangeCompletedV2Schema = z
  .object({
    exchangeId: z.string().min(1),
    userMessageId: z.string().min(1),
    assistantMessageId: z.string().min(1),
    selectedAssistantMessageId: z.string().min(1),
    assistantAttemptNo: z.number().int().positive(),
    isRegeneration: z.boolean(),
    sessionId: z.string().min(1),
    engagementSessionId: z.string().min(1),
    userId: z.string().min(1),
    characterId: z.string().min(1),
    characterContentVersionId: z.string().min(1),
    characterReleaseId: z.string().min(1).nullable(),
    entryExposureId: z.string().min(1).nullable().default(null),
    journeyId: z.string().min(1).nullable().default(null),
    placementId: z.string().min(1).nullable().default(null),
  })
  .superRefine((event, ctx) => {
    const attribution = [event.entryExposureId, event.journeyId, event.placementId];
    const populated = attribution.filter((value) => value !== null).length;
    if (populated !== 0 && populated !== attribution.length) {
      ctx.addIssue({
        code: "custom",
        path: ["entryExposureId"],
        message: "Entry exposure attribution must be complete or absent",
      });
    }
  });

export const chatExchangeCorrectionV2Schema = z
  .object({
    exchangeId: z.string().min(1),
    correctionType: z.enum(["selected", "edited", "deleted", "superseded"]),
    correctionRevision: z.number().int().positive(),
    userId: z.string().min(1),
    selectedAssistantMessageId: z.string().min(1).optional(),
    // Optional privacy authority carried by newer Chat producers. Keeping
    // these optional preserves rolling compatibility with already persisted
    // correction rows; Main can fall back to its exchange fact for old rows.
    sessionId: z.string().min(1).optional(),
    messageIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .superRefine((event, ctx) => {
    if (event.correctionType === "selected" && !event.selectedAssistantMessageId) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedAssistantMessageId"],
        message: "Selection corrections require the selected assistant message id",
      });
    }
  });

export const customerSignupCompletedV2Schema = z.object({
  userId: z.string().min(1),
});

export const subscriptionActivatedV2Schema = z.object({
  subscriptionId: z.string().min(1),
  userId: z.string().min(1),
  planId: z.string().min(1).optional(),
});

export const subscriptionEndedV2Schema = z.object({
  subscriptionId: z.string().min(1),
  userId: z.string().min(1),
  reason: z.string().min(1).optional(),
});

export const supportRequestSubmittedV2Schema = z.object({
  supportRequestId: z.string().min(1),
  userId: z.string().min(1),
  category: z.string().min(1),
});

export const generationDeliveryCompletedV2Schema = z.object({
  requestId: z.string().min(1),
  artifactId: z.string().min(1),
  userId: z.string().min(1),
  expectedOutputCount: z.number().int().positive().default(1),
  deliveredOutputCount: z.number().int().positive().default(1),
  valid: z.boolean(),
  displayable: z.boolean(),
});

export const aiUsageRecordedV2Schema = z.object({
  invocationId: z.string().min(1),
  requestId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  transportExecutionId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  usage: z.record(z.string(), z.unknown()),
  latencyMs: z.number().int().nonnegative().optional(),
  costMicros: z.number().int().nonnegative().optional(),
  pricingVersion: z.string().min(1).nullable().optional(),
}).superRefine((usage, context) => {
  if (usage.costMicros !== undefined && usage.pricingVersion == null) {
    context.addIssue({
      code: "custom",
      path: ["pricingVersion"],
      message: "priced provider cost requires an authoritative pricing version",
    });
  }
});

export const experimentExposedV2Schema = z.object({
  exposureId: z.string().min(1),
  assignmentId: z.string().min(1),
  experimentId: z.string().min(1),
  experimentVersion: z.number().int().positive(),
  assignmentVersion: z.string().min(1),
  subjectType: z.enum(["user", "anonymous"]),
  subjectId: z.string().min(1),
  variant: z.string().min(1),
  eligible: z.boolean(),
  surface: z.string().min(1),
});

export const characterExposureRecordedV2Schema = z
  .object({
    exposureId: z.string().min(1),
    eventType: z.enum(["eligible_impression", "detail_view"]),
    parentExposureId: z.string().min(1).nullable().default(null),
    userId: z.string().min(1).nullable().default(null),
    anonymousId: z.string().min(1).nullable().default(null),
    journeyId: z.string().min(1),
    characterId: z.string().min(1),
    characterContentVersionId: z.string().min(1),
    characterReleaseId: z.string().min(1).nullable(),
    placementId: z.string().min(1).nullable(),
    visibleRatio: z.number().min(0).max(1),
    visibleDurationMs: z.number().int().nonnegative(),
  })
  .superRefine((event, ctx) => {
    if (event.userId === null && event.anonymousId === null) {
      ctx.addIssue({ code: "custom", path: ["userId"], message: "An exposure needs a user or anonymous subject" });
    }
    if (event.eventType === "eligible_impression" && event.parentExposureId !== null) {
      ctx.addIssue({ code: "custom", path: ["parentExposureId"], message: "Impressions are exposure roots" });
    }
    if (event.eventType === "detail_view" && event.parentExposureId === null) {
      ctx.addIssue({ code: "custom", path: ["parentExposureId"], message: "Detail views require an exposure chain" });
    }
  });

export const METRIC_PRODUCT_EVENTS = {
  chatExchangeCompleted: "chat.exchange.completed.v2",
  chatExchangeCorrected: "chat.exchange.corrected.v2",
  customerSignupCompleted: "customer.signup.completed.v2",
  subscriptionActivated: "subscription.activated.v2",
  subscriptionEnded: "subscription.ended.v2",
  generationDeliveryCompleted: "generation.delivery.completed.v2",
  aiUsageRecorded: "ai.usage.recorded.v2",
  experimentExposed: "experiment.exposed.v2",
  characterExposureRecorded: "character.exposure.recorded.v2",
  supportRequestSubmitted: "support.request.submitted.v2",
} as const;

export type ChatExchangeCompletedV2 = z.infer<typeof chatExchangeCompletedV2Schema>;
export type ChatExchangeCorrectionV2 = z.infer<typeof chatExchangeCorrectionV2Schema>;
export type ExperimentExposedV2 = z.infer<typeof experimentExposedV2Schema>;
export type CharacterExposureRecordedV2 = z.infer<typeof characterExposureRecordedV2Schema>;
export type SupportRequestSubmittedV2 = z.infer<typeof supportRequestSubmittedV2Schema>;
