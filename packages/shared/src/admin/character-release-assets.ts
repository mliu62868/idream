import { z } from "zod";

export const characterReleaseAssetSlotSchema = z.enum([
  "character_avatar",
  "character_hero",
  "character_chat",
]);

export const characterReleaseAssetPlacementSchema = z.object({
  slotKey: characterReleaseAssetSlotSchema,
  assetId: z.string().trim().min(1),
  slotVersion: z.number().int().positive(),
  runId: z.string().trim().min(1),
  itemId: z.string().trim().min(1),
  reviewDecisionId: z.string().trim().min(1),
  generationJobId: z.string().trim().min(1),
  bootstrapIdentity: z.boolean().optional(),
}).strict();

export const characterReleaseAssetManifestSchema = z.object({
  schemaVersion: z.literal(2),
  placements: z.array(characterReleaseAssetPlacementSchema).length(3),
}).strict().superRefine((manifest, ctx) => {
  const expected = new Set(characterReleaseAssetSlotSchema.options);
  const actual = new Set(manifest.placements.map((placement) => placement.slotKey));
  if (actual.size !== expected.size || [...expected].some((slot) => !actual.has(slot))) {
    ctx.addIssue({
      code: "custom",
      path: ["placements"],
      message: "Release asset manifest must contain one avatar, hero, and chat placement",
    });
  }
  const assetIds = manifest.placements.map((placement) => placement.assetId);
  if (new Set(assetIds).size !== assetIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["placements"],
      message: "Release asset manifest must contain three distinct assets",
    });
  }
});

export type CharacterReleaseAssetSlot = z.infer<
  typeof characterReleaseAssetSlotSchema
>;
export type CharacterReleaseAssetPlacement = z.infer<
  typeof characterReleaseAssetPlacementSchema
>;
export type CharacterReleaseAssetManifest = z.infer<
  typeof characterReleaseAssetManifestSchema
>;

export function parseCharacterReleaseAssetManifest(value: unknown) {
  const parsed = characterReleaseAssetManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function characterReleaseAssetPlacement(
  manifest: CharacterReleaseAssetManifest,
  slotKey: CharacterReleaseAssetSlot,
) {
  return manifest.placements.find((placement) => placement.slotKey === slotKey) ?? null;
}
