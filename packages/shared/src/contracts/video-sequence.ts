import { z } from "zod";

export const REDGRAFT_VIDEO_DEFAULTS = { orientation: "7:12", quality: "preview" } as const;

// SPEC: A sequence is ordered native clips followed by deterministic packaging.
// Each scene retains its own Generation Request and settlement authority.
export const videoSequenceRequestSchema = z.object({
  characterId: z.string().min(1),
  visualProfileId: z.string().min(1).optional(),
  generationContextToken: z.string().min(1).max(4096).optional(),
  consistencyMode: z.enum(["balanced", "strict", "creative"]).default("balanced"),
  seed: z.string().trim().min(1).max(120).optional(),
  orientation: z.enum(["7:12", "2:3", "1:1"]).default(REDGRAFT_VIDEO_DEFAULTS.orientation),
  quality: z.enum(["preview", "standard"]).default(REDGRAFT_VIDEO_DEFAULTS.quality),
  audio: z.enum(["generated", "silent", "narration"]).default("generated"),
  scenes: z.array(z.object({
    prompt: z.string().trim().min(1).max(2000),
    seconds: z.union([z.literal(3), z.literal(5)]).default(5),
    narration: z.string().trim().max(120).optional(),
  }).strict()).min(1).max(3),
  quoteFingerprint: z.string().length(64).optional(),
}).strict().superRefine((body, ctx) => {
  body.scenes.forEach((scene, index) => {
    if (body.audio === "narration" && !scene.narration) ctx.addIssue({ code: "custom", path: ["scenes", index, "narration"], message: "Enter English narration for each scene" });
    if (body.audio === "narration" && scene.narration && /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(scene.narration)) ctx.addIssue({ code: "custom", path: ["scenes", index, "narration"], message: "This voice supports English narration. Use an English line." });
    if (body.audio !== "narration" && scene.narration) ctx.addIssue({ code: "custom", path: ["scenes", index, "narration"], message: "Choose narration audio to use a script" });
  });
});
export type VideoSequenceRequest = z.infer<typeof videoSequenceRequestSchema>;

const sceneVideoSchema = z.object({ durationSeconds: z.number().positive(), width: z.number().int().positive(), height: z.number().int().positive(), audio: z.enum(["generated", "none"]) });
export const videoSequenceQuoteSchema = z.object({
  fingerprint: z.string().length(64), costDreamcoins: z.number().int().nonnegative(), balance: z.number().nonnegative(),
  audio: z.enum(["generated", "silent", "narration"]), narrationExtendsLastFrame: z.boolean(), narrationExtraCostDreamcoins: z.literal(0),
  costs: z.array(z.object({ ordinal: z.number().int().nonnegative(), costDreamcoins: z.number().int().nonnegative() })).min(1).max(3),
  scenes: z.array(z.object({ ordinal: z.number().int().nonnegative(), video: sceneVideoSchema })).min(1).max(3),
});
export type VideoSequenceQuote = z.infer<typeof videoSequenceQuoteSchema>;
const sceneAssetSchema = z.object({ id: z.string().min(1), url: z.string().min(1), downloadUrl: z.string().min(1) });
export const videoSequenceDtoSchema = z.object({
  id: z.string().min(1), status: z.enum(["generating", "composing", "completed", "failed", "unknown", "composition_failed", "cancelled"]), errorCode: z.string().nullable(),
  request: videoSequenceRequestSchema,
  scenes: z.array(z.object({ ordinal: z.number().int().nonnegative(), narrationState: z.string(),
    job: z.object({ id: z.string().min(1), status: z.string(), controls: z.object({ sourceImageAssetId: z.string().min(1).optional() }), cost: z.object({ charged: z.number(), refunded: z.number(), finalCharge: z.number() }) }), assets: z.array(sceneAssetSchema) })),
  cost: z.object({ charged: z.number().nonnegative(), refunded: z.number().nonnegative(), finalCharge: z.number().nonnegative() }),
  asset: sceneAssetSchema.extend({ width: z.number().nullable(), height: z.number().nullable(), metadata: z.record(z.string(), z.unknown()) }).nullable(),
  createdAt: z.string(), completedAt: z.string().nullable(),
});
export type VideoSequenceDto = z.infer<typeof videoSequenceDtoSchema>;

export const videoSequenceCapabilitiesSchema = z.object({
  options: z.object({ seconds: z.array(z.union([z.literal(3), z.literal(5)])), orientations: z.array(z.enum(["7:12", "2:3", "1:1"])), qualities: z.array(z.enum(["preview", "standard"])) }),
  audio: z.array(z.enum(["generated", "silent", "narration"])),
});

export const REDGRAFT_VIDEO_OPTIONS = {
  version: "redgraft-video-options-v2",
  seconds: [3, 5],
  orientations: ["7:12", "2:3", "1:1"],
  qualities: ["preview", "standard"],
} as const;

export function redgraftVideoEnvelope(input: { seconds: number; orientation: string; quality: string }) {
  if (!(REDGRAFT_VIDEO_OPTIONS.seconds as readonly number[]).includes(input.seconds) ||
      !(REDGRAFT_VIDEO_OPTIONS.orientations as readonly string[]).includes(input.orientation) ||
      !(REDGRAFT_VIDEO_OPTIONS.qualities as readonly string[]).includes(input.quality)) throw new Error("Unsupported RedGraft video envelope");
  // INVARIANT: both stages need 32-pixel latents, so final dimensions are
  // multiples of 64. 448x768 is an exact 7:12 portrait in the 480p tier.
  const width = input.orientation === "7:12"
    ? (input.quality === "preview" ? 448 : 896)
    : (input.quality === "preview" ? 512 : 768);
  const height = input.orientation === "7:12" ? width * 12 / 7
    : input.orientation === "1:1" ? width : width * 3 / 2;
  return { width, height, seconds: input.seconds, frameCount: input.seconds * 24 + 1, fps: 24, expectedDurationSeconds: (input.seconds * 24 + 1) / 24 };
}
