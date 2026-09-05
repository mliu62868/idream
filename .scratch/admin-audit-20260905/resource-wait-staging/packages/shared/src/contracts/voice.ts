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
