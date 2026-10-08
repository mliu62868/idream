import { z } from "zod";

// Product support, independent of the ASR model's multilingual vocabulary.
export const VOICE_INPUT_LANGUAGES = ["en"] as const;
export const VOICE_INPUT_MAX_DURATION_MS = 60_000;
export const VOICE_INPUT_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const VOICE_INPUT_RESULT_TTL_MS = 120_000;
export const voiceInputCapabilitySchema = z.object({
  supported: z.boolean(), available: z.boolean(),
  reason: z.enum(["not_configured", "unavailable"]).optional(),
  ownerScope: z.string().min(1), languages: z.array(z.enum(VOICE_INPUT_LANGUAGES)).length(1),
  maxDurationMs: z.literal(VOICE_INPUT_MAX_DURATION_MS),
  maxUploadBytes: z.literal(VOICE_INPUT_MAX_UPLOAD_BYTES),
  resultTtlMs: z.literal(VOICE_INPUT_RESULT_TTL_MS),
});
export const voiceInputResultSchema = z.discriminatedUnion("status", [
  z.object({ requestId: z.uuid(), status: z.literal("pending"), retryAfterMs: z.number().int().positive() }),
  z.object({ requestId: z.uuid(), status: z.literal("completed"), text: z.string().trim().min(1).max(32_000), audioDurationMs: z.number().nonnegative().max(VOICE_INPUT_MAX_DURATION_MS), expiresAt: z.iso.datetime() }),
  z.object({ requestId: z.uuid(), status: z.literal("cancelled"), expiresAt: z.iso.datetime().optional() }),
  z.object({ requestId: z.uuid(), status: z.literal("failed"), errorCode: z.string().min(1).max(80), expiresAt: z.iso.datetime().optional(), retryAfterMs: z.number().int().positive().optional() }),
]);
export type VoiceInputCapability = z.infer<typeof voiceInputCapabilitySchema>;
export type VoiceInputResult = z.infer<typeof voiceInputResultSchema>;
