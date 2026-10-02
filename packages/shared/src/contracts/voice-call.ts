import { z } from "zod";

export const voiceCallStartSchema = z.object({
  id: z.uuid(), language: z.literal("en"),
  clientLeaseToken: z.uuid(),
  maxCostDreamcoins: z.number().int().min(0).max(100),
  maxDurationMs: z.number().int().min(15_000).max(300_000).default(180_000),
  quoteToken: z.string().min(1).max(8192).optional(),
}).strict();

export const voiceCallSchema = z.object({
  id: z.uuid(), sessionId: z.string(), characterId: z.string(),
  status: z.enum(["active", "muted", "disconnected", "ended"]), language: z.literal("en"),
  leaseToken: z.string(), leaseExpiresAt: z.string(), deadlineAt: z.string(),
  startedAt: z.string(), endedAt: z.string().nullable(), connectedMs: z.number().int().nonnegative(),
  maxCostDreamcoins: z.number().int().nonnegative(), costDreamcoins: z.number().int().nonnegative(),
  voiceDurationMs: z.number().int().nonnegative(), endReason: z.string().nullable(),
});
export type VoiceCall = z.infer<typeof voiceCallSchema>;
