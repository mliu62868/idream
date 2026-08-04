import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { imageOrientations } from "./generation-dimensions";

export async function featureFlagEnabled(key: string) {
  const flag = await prisma.featureFlag.findUnique({
    where: { key },
    select: { enabled: true, rolloutPercent: true },
  });
  return Boolean(flag?.enabled && flag.rolloutPercent === 100);
}

export function supportedProfileOrientations(value: Prisma.JsonValue) {
  return jsonStringArray(value).filter(
    (orientation) =>
      orientation === "2:3" ||
      imageOrientations.includes(
        orientation as (typeof imageOrientations)[number],
      ),
  );
}

export function isExecutableGenerationProfile(profile: {
  readonly allowedOrientations: Prisma.JsonValue;
  readonly maxCount: number;
  readonly rolloutPercent: number;
}) {
  return (
    profile.rolloutPercent === 100 &&
    profile.maxCount >= 1 &&
    profile.maxCount <= 8 &&
    supportedProfileOrientations(profile.allowedOrientations).length > 0
  );
}

export function hasCompleteGenerationRecipeSet(
  recipes: ReadonlyArray<{ readonly useCase: string }>,
) {
  const useCases = new Set(recipes.map((recipe) => recipe.useCase));
  return useCases.has("character") && useCases.has("freeplay");
}

export function hasCharacterGenerationRecipe(
  recipes: ReadonlyArray<{ readonly useCase: string }>,
) {
  return recipes.some((recipe) => recipe.useCase === "character");
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
