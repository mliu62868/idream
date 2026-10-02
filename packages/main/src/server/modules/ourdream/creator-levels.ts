import { z } from "zod";
import type { AppSetting, Prisma } from "@prisma/client";
import { creatorLevelDefinitionSchema, type CreatorLevelDefinition, type CreatorLevelProgram } from "@/lib/creator-studio";

export const CREATOR_LEVELS_ACTIVE_KEY = "creator.levels.active";
export const creatorLevelDefinitionKey = (version: number) => `creator.levels.definition:${version}`;
const activeSchema = z.object({ schemaVersion: z.literal(1), definitionVersion: z.number().int().positive() }).strict();
type Setting = Pick<AppSetting, "key" | "value" | "status" | "version">;

// Published definitions are create-only; only the separately versioned pointer moves.
// Missing, unpublished, or inconsistent data never implies default thresholds.
export function publishedCreatorLevelDefinition(pointer: Setting | null, definition: Setting | null): CreatorLevelDefinition | null {
  if (pointer?.key !== CREATOR_LEVELS_ACTIVE_KEY || pointer.status !== "active" || pointer.version < 1) return null;
  const active = activeSchema.safeParse(pointer.value);
  if (!active.success || !definition || definition.status !== "active" ||
    definition.key !== creatorLevelDefinitionKey(active.data.definitionVersion) ||
    definition.version !== active.data.definitionVersion) return null;
  const parsed = creatorLevelDefinitionSchema.safeParse(definition.value);
  return parsed.success && parsed.data.definitionVersion === active.data.definitionVersion ? parsed.data : null;
}

export async function readCreatorLevelDefinition(tx: Pick<Prisma.TransactionClient, "appSetting">) {
  const pointer = await tx.appSetting.findUnique({ where: { key: CREATOR_LEVELS_ACTIVE_KEY } });
  const active = activeSchema.safeParse(pointer?.value);
  const definition = pointer?.status === "active" && active.success
    ? await tx.appSetting.findUnique({ where: { key: creatorLevelDefinitionKey(active.data.definitionVersion) } }) : null;
  return publishedCreatorLevelDefinition(pointer, definition);
}

export function creatorLevelProgram(definition: CreatorLevelDefinition | null, input: {
  eligible: boolean; publicWorks: number; followers: number;
}): CreatorLevelProgram {
  const { eligible, publicWorks, followers } = input;
  const qualified = definition?.levels.filter(level => publicWorks >= level.publicWorks && followers >= level.followers) ?? [];
  const level = eligible && definition ? qualified.at(-1) ?? null : null;
  const next = eligible && definition ? definition.levels.find(candidate => candidate.level > (level?.level ?? -1)) : null;
  return {
    state: !definition ? "unavailable" : eligible ? "published" : "ineligible",
    definitionVersion: definition?.definitionVersion ?? null,
    level,
    nextLevel: next ? { ...next, remainingPublicWorks: Math.max(0, next.publicWorks - publicWorks), remainingFollowers: Math.max(0, next.followers - followers) } : null,
    publicWorks, followers,
  };
}
