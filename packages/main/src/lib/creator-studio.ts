import { z } from "zod";

const count = z.number().int().nonnegative();
export const creatorLevelSchema = z.object({
  level: count,
  label: z.string().trim().min(1).max(80),
  publicWorks: count.max(1_000_000),
  followers: count.max(1_000_000),
}).strict();

export const creatorLevelDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  definitionVersion: z.number().int().positive(),
  levels: z.array(creatorLevelSchema).min(1).max(10),
}).strict().superRefine(({ levels }, ctx) => {
  for (const [index, level] of levels.entries()) {
    const previous = levels[index - 1];
    if (level.level !== index || (index === 0 && (level.publicWorks !== 0 || level.followers !== 0)) ||
      (previous && (level.publicWorks < previous.publicWorks || level.followers < previous.followers ||
        (level.publicWorks === previous.publicWorks && level.followers === previous.followers)))) {
      ctx.addIssue({ code: "custom", message: "Levels must begin at zero and have increasing requirements", path: ["levels", index] });
    }
  }
});

export const creatorLevelProgramSchema = z.object({
  state: z.enum(["published", "unavailable", "ineligible"]),
  definitionVersion: z.number().int().positive().nullable(),
  level: creatorLevelSchema.nullable(),
  nextLevel: creatorLevelSchema.extend({ remainingPublicWorks: count, remainingFollowers: count }).nullable(),
  publicWorks: count,
  followers: count,
}).strict();

const inventory = z.object({ total: count, publicAvailable: count, byStatus: z.record(z.string(), count) }).strict();
export const creatorStudioItemSchema = z.object({
  id: z.string().min(1), title: z.string(), status: z.string(),
  visibility: z.enum(["private", "unlisted", "public"]).nullable(),
  updatedAt: z.iso.datetime(), href: z.string().startsWith("/"),
}).strict();
export const creatorStudioSummarySchema = z.object({
  schemaVersion: z.literal(1), viewerId: z.string().min(1), asOf: z.iso.datetime(),
  counts: z.object({
    drafts: count, characters: count, publicCharacters: count,
    comics: inventory, packs: inventory,
    followers: count, packClaims: count, packClaimants: count,
  }).strict(),
  publicCharacterQualification: z.object({ available: count, awaiting: count, paused: count }).strict(),
  program: creatorLevelProgramSchema,
  recent: z.object({
    // Drafts have no other inventory page; all owner metadata remains reachable.
    drafts: z.array(creatorStudioItemSchema), characters: z.array(creatorStudioItemSchema).max(6),
    comics: z.array(creatorStudioItemSchema).max(6), packs: z.array(creatorStudioItemSchema).max(6),
  }).strict(),
}).strict();
export type CreatorLevelDefinition = z.infer<typeof creatorLevelDefinitionSchema>;
export type CreatorLevelProgram = z.infer<typeof creatorLevelProgramSchema>;
export type CreatorStudioSummary = z.infer<typeof creatorStudioSummarySchema>;
export type CreatorStudioItem = z.infer<typeof creatorStudioItemSchema>;
