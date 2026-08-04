import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { imageOrientations } from "./generation-dimensions";
import { generationQuoteAuthoritySchema } from "./generation-quote-contract";

const generationOrientations = [...imageOrientations, "2:3"] as [
  (typeof imageOrientations)[number] | "2:3",
  ...Array<(typeof imageOrientations)[number] | "2:3">,
];

const generationControlsSchema = z
  .object({
    modePresetId: z.string().trim().min(1).max(120).optional(),
    backgroundPresetId: z.string().trim().min(1).max(120).optional(),
    posePresetId: z.string().trim().min(1).max(120).optional(),
    outfitPresetId: z.string().trim().min(1).max(120).optional(),
    lookId: z.string().trim().min(1).max(120).optional(),
    expression: z.string().trim().min(1).max(240).optional(),
    pose: z.string().trim().min(1).max(240).optional(),
    outfit: z.string().trim().min(1).max(400).optional(),
    camera: z.string().trim().min(1).max(240).optional(),
    lighting: z.string().trim().min(1).max(240).optional(),
    styleDelta: z.string().trim().min(1).max(240).optional(),
    orientation: z.enum(generationOrientations).optional(),
    model: z.string().trim().min(1).max(120).optional(),
    seconds: z.number().int().min(1).max(30).optional(),
  })
  .strict();

export const generationJobSchema = z
  .object({
    mode: z.enum(["image", "video"]).default("image"),
    characterId: z.string().min(1).optional(),
    visualProfileId: z.string().min(1).optional(),
    consistencyMode: z
      .enum(["balanced", "strict", "creative"])
      .default("balanced"),
    seed: z.string().trim().min(1).max(120).optional(),
    freeplay: z.boolean().default(false),
    prompt: z.string().trim().max(2_000).optional(),
    negativePrompt: z.string().trim().max(1_000).optional(),
    controls: generationControlsSchema.default({}),
    presetIds: z.array(z.string()).max(12).default([]),
    orientation: z.enum(generationOrientations).optional(),
    outputCount: z.number().int().min(1).max(8).default(1),
    model: z.string().max(80).optional(),
    remixFeedItemId: z.string().max(180).optional(),
    quoteAuthority: generationQuoteAuthoritySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.characterId) === value.freeplay) {
      ctx.addIssue({
        code: "custom",
        path: ["characterId"],
        message: "Choose exactly one of characterId or freeplay",
      });
    }
    if (value.freeplay && value.visualProfileId) {
      ctx.addIssue({
        code: "custom",
        path: ["visualProfileId"],
        message: "Visual profile can only be used with a character",
      });
    }
    if (
      value.mode === "video" &&
      value.controls.seconds !== undefined &&
      value.controls.seconds !== 4
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["controls", "seconds"],
        message: "LTX 2.3 video generation requires exactly four seconds",
      });
    }
  });

export type GenerationCreateBody = z.infer<typeof generationJobSchema>;

export interface GenerationSource {
  sourceType: string;
  sourceId: string;
  sourceMeta?: Prisma.InputJsonValue;
}

export function isTrustedGenerationPromptSource(sourceType: string | undefined) {
  return sourceType === "chat_image" || sourceType === "media_variation";
}
