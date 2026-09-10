import { z } from "zod";

export const fishAudioDeliveryPresetSchema = z.enum([
  "sensual",
  "intimate",
  "playful",
  "confident",
  "natural",
]);

export const DEFAULT_FISH_AUDIO_DELIVERY = {
  preset: "sensual",
  intensity: 75,
  speed: 0.94,
  temperature: 0.72,
  topP: 0.75,
  topK: 30,
  repetitionPenalty: 1.2,
} as const;

export const fishAudioDeliverySettingsSchema = z
  .object({
    preset: fishAudioDeliveryPresetSchema,
    intensity: z.number().int().min(0).max(100),
    speed: z.number().min(0.7).max(1.3),
    temperature: z.number().min(0.1).max(1.5),
    topP: z.number().min(0.1).max(1),
    topK: z.number().int().min(1).max(100),
    repetitionPenalty: z.number().min(1).max(2),
  })
  .strict();

export type FishAudioDeliverySettings = z.infer<
  typeof fishAudioDeliverySettingsSchema
>;

// The server signs these terms before any billable synthesis. Once accepted,
// the request keeps them across retries even after the quote itself expires.
export const voiceClipBillingAuthoritySchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1),
  requestFingerprint: z.string().min(1),
  intent: z.enum(["play", "prewarm"]),
  pricingFingerprint: z.string().min(1),
  overflowCostDreamcoins: z.number().int().nonnegative(),
  maxCostDreamcoins: z.number().int().nonnegative(),
  allowanceMinutes: z.number().nonnegative(),
  allowanceWindowStartsAt: z.string().datetime(),
  quotedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict().superRefine((terms, ctx) => {
  if (terms.maxCostDreamcoins > terms.overflowCostDreamcoins) {
    ctx.addIssue({ code: "custom", path: ["maxCostDreamcoins"], message: "Accepted cost cannot exceed the quoted overflow rate" });
  }
  if (terms.intent === "prewarm" && terms.maxCostDreamcoins !== 0) {
    ctx.addIssue({ code: "custom", path: ["maxCostDreamcoins"], message: "Automatic prewarm cannot accept a coin charge" });
  }
  if (Date.parse(terms.expiresAt) <= Date.parse(terms.quotedAt) ||
    Date.parse(terms.allowanceWindowStartsAt) > Date.parse(terms.quotedAt)) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Invalid Voice quote validity window" });
  }
});

export type VoiceClipBillingAuthority = z.infer<typeof voiceClipBillingAuthoritySchema>;

export const voiceClipQuoteSchema = z.object({
  quoteToken: z.string().nullable(),
  maxCostDreamcoins: z.number().int().nonnegative(),
  overflowCostDreamcoins: z.number().int().nonnegative(),
  allowanceMinutes: z.number().nonnegative(),
  remainingAllowanceMs: z.number().nonnegative(),
  balance: z.number().int(),
  accepted: z.boolean(),
  alreadyDelivered: z.boolean(),
}).strict();

export type VoiceClipQuote = z.infer<typeof voiceClipQuoteSchema>;
