import { z } from "zod";
import { createHash } from "node:crypto";
import { generationQualitySchema } from "./payloads";

export const durableEventEnvelopeSchema = z.object({
  sourceService: z.string().min(1),
  sourceEventId: z.string().min(1),
  eventType: z.string().min(1),
  schemaVersion: z.number().int().positive().default(1),
  occurredAt: z.string().datetime(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export const durableAckSchema = z.discriminatedUnion("status", [
  z.object({
    acknowledged: z.literal(true),
    status: z.literal("persisted"),
    receiptId: z.string().min(1),
  }).strict(),
  z.object({
    acknowledged: z.literal(true),
    status: z.literal("duplicate"),
    receiptId: z.string().min(1),
  }).strict(),
  z.object({
    acknowledged: z.literal(false),
    status: z.literal("quarantined"),
    receiptId: z.string().min(1).nullable(),
  }).strict(),
  z.object({
    acknowledged: z.literal(false),
    status: z.literal("discarded_target_missing"),
    receiptId: z.string().min(1),
  }).strict(),
]);

const generationTerminalAssetSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  key: z.string().min(1),
  contentType: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  seconds: z.number().positive().optional(),
  providerKey: z.string().nullable(),
  quality: generationQualitySchema.optional(),
});

export const generationProviderAccountingSchema = z.object({
  usage: z.record(z.string(), z.unknown()),
  latencyMs: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative().safe().nullable(),
  pricingVersion: z.string().min(1).nullable(),
}).superRefine((accounting, context) => {
  if (accounting.costMicros !== null && accounting.pricingVersion === null) {
    context.addIssue({
      code: "custom",
      path: ["pricingVersion"],
      message: "priced provider cost requires an authoritative pricing version",
    });
  }
});

const generationTerminalRecordBaseSchema = z.object({
  version: z.literal(1),
  attemptId: z.string().min(1),
  attemptNo: z.number().int().positive(),
  transportAttemptNo: z.number().int().positive().default(1),
  providerIdempotencyKey: z.string().min(1).optional(),
  requestId: z.string().min(1),
  generationJobId: z.string().min(1),
  mode: z.enum(["image", "video"]),
  provider: z.string().min(1),
  // INVARIANT: Main may project provider transport/usage only when Gen actually
  // crossed the provider invocation boundary.
  providerInvoked: z.boolean(),
  model: z.string().min(1).optional(),
  providerRequestId: z.string().nullable(),
  completedAt: z.string().datetime(),
  usage: z.record(z.string(), z.unknown()),
  accounting: generationProviderAccountingSchema.optional(),
});

const generationTerminalErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryability: z.enum(["retryable", "not_retryable", "operator_retry"]),
});

export const generationTerminalRecordSchema = z.discriminatedUnion("outcome", [
  generationTerminalRecordBaseSchema.extend({
    outcome: z.literal("succeeded"),
    assets: z.array(generationTerminalAssetSchema).min(1),
  }),
  generationTerminalRecordBaseSchema.extend({
    outcome: z.literal("failed"),
    error: generationTerminalErrorSchema,
  }),
  generationTerminalRecordBaseSchema.extend({
    outcome: z.literal("blocked"),
    block: z.object({
      policyCode: z.string().min(1),
      message: z.string().min(1),
      layer: z.enum(["input", "output", "provider"]),
    }),
  }),
  generationTerminalRecordBaseSchema.extend({
    outcome: z.literal("unknown"),
    error: generationTerminalErrorSchema,
  }),
]).superRefine((record, context) => {
  const blockedAtInput =
    record.outcome === "blocked" && record.block.layer === "input";
  if (blockedAtInput && record.providerInvoked) {
    context.addIssue({
      code: "custom",
      path: ["providerInvoked"],
      message: "input moderation must block before provider invocation",
    });
  }
  if (!record.providerInvoked && !blockedAtInput) {
    context.addIssue({
      code: "custom",
      path: ["providerInvoked"],
      message: "only an input-moderation block may precede provider invocation",
    });
  }
  if (!record.providerInvoked && record.providerRequestId !== null) {
    context.addIssue({
      code: "custom",
      path: ["providerRequestId"],
      message: "a non-invoked provider cannot have a provider request id",
    });
  }
  if (!record.providerInvoked && record.accounting !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["accounting"],
      message: "a non-invoked provider cannot have provider accounting",
    });
  }
  if (record.providerInvoked && !record.providerIdempotencyKey) {
    context.addIssue({
      code: "custom",
      path: ["providerIdempotencyKey"],
      message: "a provider invocation requires its immutable idempotency key",
    });
  }
  if (record.outcome === "succeeded") {
    const requiredPrefix = `${record.mode}/`;
    record.assets.forEach((asset, index) => {
      if (!asset.contentType.startsWith(requiredPrefix)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "contentType"],
          message: `${record.mode} terminal assets require ${requiredPrefix}* content type`,
        });
      }
    });
  }
});

export const generationTransportExecutionEventSchema = z.object({
  version: z.literal(1),
  attemptId: z.string().min(1),
  attemptNo: z.number().int().positive(),
  generationJobId: z.string().min(1),
  transportAttemptNo: z.number().int().positive(),
  provider: z.string().min(1),
  model: z.string().min(1),
  providerRequestId: z.string().nullable(),
  idempotencyKey: z.string().min(1),
  status: z.enum(["running", "failed", "unknown"]),
  occurredAt: z.string().datetime(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).nullable().default(null),
  accounting: generationProviderAccountingSchema.optional(),
});

export const generationTerminalRecordIngestSchema = z.object({
  terminalRecordRef: z.string().min(1),
  terminalRecordChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  terminalRecord: generationTerminalRecordSchema,
});

export type DurableEventEnvelope = z.infer<typeof durableEventEnvelopeSchema>;
export type DurableAck = z.infer<typeof durableAckSchema>;
export type GenerationTerminalRecord = z.infer<typeof generationTerminalRecordSchema>;
export type GenerationTerminalRecordIngest = z.infer<typeof generationTerminalRecordIngestSchema>;
export type GenerationTransportExecutionEvent = z.infer<typeof generationTransportExecutionEventSchema>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** The receiver hashes the complete immutable envelope, excluding only its identity key. */
export function durableEnvelopeHash(envelope: DurableEventEnvelope): string {
  return createHash("sha256")
    .update(canonicalJson({
      eventType: envelope.eventType,
      schemaVersion: envelope.schemaVersion,
      occurredAt: envelope.occurredAt,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      payload: envelope.payload,
    }))
    .digest("hex");
}

export function generationTerminalRecordChecksum(record: GenerationTerminalRecord): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}
