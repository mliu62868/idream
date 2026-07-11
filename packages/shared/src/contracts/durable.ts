import { z } from "zod";
import { createHash } from "node:crypto";

export const durableEventEnvelopeSchema = z.object({
  sourceService: z.string().min(1),
  sourceEventId: z.string().min(1),
  eventType: z.string().min(1),
  schemaVersion: z.number().int().positive().default(1),
  occurredAt: z.string().datetime(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export const durableAckSchema = z.object({
  acknowledged: z.boolean(),
  status: z.enum(["persisted", "duplicate", "quarantined"]),
  receiptId: z.string().nullable(),
});

const generationManifestAssetSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  key: z.string().min(1),
  contentType: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  seconds: z.number().positive().optional(),
  providerKey: z.string().nullable(),
});

export const generationCompletionManifestSchema = z.object({
  version: z.literal(1),
  attemptId: z.string().min(1),
  attemptNo: z.number().int().positive(),
  requestId: z.string().min(1),
  generationJobId: z.string().min(1),
  mode: z.enum(["image", "video"]),
  provider: z.string().min(1),
  providerRequestId: z.string().nullable(),
  completedAt: z.string().datetime(),
  assets: z.array(generationManifestAssetSchema).min(1),
  usage: z.record(z.string(), z.unknown()),
});

export const generationManifestIngestSchema = z.object({
  manifestRef: z.string().min(1),
  manifestChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  manifest: generationCompletionManifestSchema,
});

export type DurableEventEnvelope = z.infer<typeof durableEventEnvelopeSchema>;
export type DurableAck = z.infer<typeof durableAckSchema>;
export type GenerationCompletionManifest = z.infer<typeof generationCompletionManifestSchema>;
export type GenerationManifestIngest = z.infer<typeof generationManifestIngestSchema>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function generationManifestChecksum(manifest: GenerationCompletionManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}
