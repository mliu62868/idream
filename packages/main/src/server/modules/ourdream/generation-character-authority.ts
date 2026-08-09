import type { CharacterVisualProfile, Prisma } from "@prisma/client";
import { loadLockedLiveEditorialLegacyGenerationAuthority } from "@/server/modules/generation/attempt-dispatch";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { isRecord, toInputJson } from "@/server/lib/request-json";
import { invalidateCharacterDraftAssetPack } from "@/server/modules/admin-v2/characters/draft-asset-authority";
import { lockCharacterGenerationAuthority } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import {
  IDENTITY_ASSEMBLER_VERSION,
  assembleIdentityPrompt,
  toTraitRecord,
  type IdentityTraits,
} from "./identity-assembler";
import { publicCharacterAudienceWhere } from "./public-content-audience";

export interface GenerationPromptCharacter {
  id: string;
  imageAssetId: string | null;
  name: string;
  age: number;
  description: string;
  relationship: string | null;
  style: string | null;
  gender: string | null;
  appearance: Prisma.JsonValue;
  advancedDetails: Prisma.JsonValue;
}

export type GenerationVisualProfile = CharacterVisualProfile;

export async function readableCharacter(id: string, userId: string) {
  const character = await prisma.character.findFirst({
    where: {
      id,
      deletedAt: null,
      OR: [publicCharacterAudienceWhere, { creatorId: userId }],
    },
  });
  if (!character) throw Errors.notFound("Character not found");
  return character;
}

export async function generationCharacter(id: string, userId: string) {
  const character = await readableCharacter(id, userId);
  // readableCharacter 的 creatorId 分支绕开了公开受众谓词，所以这里是创作者自有角色的唯一年龄闸，
  // 不是 publicCharacterAudienceWhere 的重复。
  if (character.age < 18) {
    throw Errors.badRequest("Character is not eligible for generation", {
      policyCode: "UNDERAGE",
    });
  }
  if (character.status !== "approved") {
    throw Errors.forbidden("Character is not approved for generation", {
      status: character.status,
    });
  }
  return character;
}

export async function publishedGenerationVideoCharacter(id: string) {
  const character = await prisma.character.findFirst({
    where: {
      AND: [{ id }, publicCharacterAudienceWhere],
    },
  });
  if (!character) throw Errors.notFound("Character not found");
  return character;
}

export async function resolveGenerationVisualProfile(
  character: GenerationPromptCharacter,
  requestedProfileId?: string,
  opts: {
    fallbackToActiveOnStale?: boolean;
    bootstrapIfMissing?: boolean;
  } = {},
): Promise<CharacterVisualProfile | null> {
  if (requestedProfileId) {
    const profile = await prisma.characterVisualProfile.findFirst({
      where: { id: requestedProfileId, characterId: character.id },
      orderBy: { version: "desc" },
    });
    if (!profile) {
      if (opts.fallbackToActiveOnStale) {
        return resolveActiveVisualProfile(character, {
          bootstrapIfMissing: opts.bootstrapIfMissing,
        });
      }
      throw Errors.notFound("Character visual profile not found");
    }
    if (profile.status === "archived") {
      if (opts.fallbackToActiveOnStale) {
        return resolveActiveVisualProfile(character, {
          bootstrapIfMissing: opts.bootstrapIfMissing,
        });
      }
      throw Errors.badRequest("Character visual profile is archived", {
        visualProfileId: requestedProfileId,
      });
    }
    return profile;
  }

  return resolveActiveVisualProfile(character, {
    bootstrapIfMissing: opts.bootstrapIfMissing,
  });
}

export async function resolveGenerationLook(
  userId: string,
  characterId: string | null,
  visualProfileId: string | null,
  lookId?: string,
) {
  if (!lookId) return null;
  if (!characterId || !visualProfileId) {
    throw Errors.badRequest(
      "A Character Look requires character image generation",
    );
  }
  const look = await prisma.characterLook.findFirst({
    where: { id: lookId, ownerId: userId, characterId, status: "active" },
    include: {
      referenceAsset: {
        select: {
          id: true,
          ownerId: true,
          characterId: true,
          type: true,
          deletedAt: true,
          safetyStatus: true,
          storageKey: true,
          url: true,
          metadata: true,
        },
      },
    },
  });
  if (!look) throw Errors.notFound("Character Look not found");
  if (look.visualProfileId !== visualProfileId) {
    throw Errors.badRequest(
      "Character Look must be rebased to the active identity",
      {
        lookId,
        lookVisualProfileId: look.visualProfileId,
        activeVisualProfileId: visualProfileId,
      },
    );
  }
  if (
    look.referenceAssetId &&
    (!look.referenceAsset ||
      look.referenceAsset.ownerId !== userId ||
      look.referenceAsset.characterId !== characterId ||
      look.referenceAsset.type !== "image" ||
      look.referenceAsset.deletedAt !== null ||
      look.referenceAsset.safetyStatus !== "passed" ||
      !isMediaAssetOperationalForAuthority(look.referenceAsset.metadata) ||
      !hasHydratableMediaBlobAuthority(look.referenceAsset))
  ) {
    throw Errors.conflict(
      "Character Look reference is unavailable. Update or rebase the Look before generating.",
      { lookId: look.id, referenceAssetId: look.referenceAssetId },
    );
  }
  return look;
}

async function resolveActiveVisualProfile(
  character: GenerationPromptCharacter,
  options: { bootstrapIfMissing?: boolean } = {},
): Promise<CharacterVisualProfile | null> {
  const legacyReleaseAuthority = await prisma.$transaction((tx) =>
    loadLockedLiveEditorialLegacyGenerationAuthority(tx, character.id),
  );
  if (legacyReleaseAuthority) return null;
  const active = await prisma.characterVisualProfile.findFirst({
    where: { characterId: character.id, status: "active" },
    orderBy: { version: "desc" },
  });
  if (active) return active;
  if (options.bootstrapIfMissing === false) return null;
  return bootstrapCharacterVisualProfile(character);
}

async function bootstrapCharacterVisualProfile(
  character: GenerationPromptCharacter,
): Promise<CharacterVisualProfile | null> {
  return prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, character.id);
    const active = await tx.characterVisualProfile.findFirst({
      where: { characterId: character.id, status: "active" },
      orderBy: { version: "desc" },
    });
    if (active) return active;
    await assertCharacterIdentityAuthorityMutable(tx, character.id);
    const profile = await tx.characterVisualProfile.create({
      data: characterVisualProfileCreateData({
        characterId: character.id,
        version: 1,
        status: "active",
        style: character.style ?? "realistic",
        name: character.name,
        age: character.age,
        description: character.description,
        gender: character.gender ?? "female",
        appearance: character.appearance,
        advancedDetails: character.advancedDetails,
        anchorAssetIds: [],
        createdFrom: "generation_bootstrap",
      }),
    });
    await invalidateCharacterDraftAssetPack(tx, character.id);
    return profile;
  });
}

export function characterVisualProfileCreateData(input: {
  characterId: string;
  version: number;
  status: "draft" | "active" | "archived";
  style: string;
  name: string;
  age: number;
  description: string;
  gender: string;
  appearance: Prisma.JsonValue;
  advancedDetails: Prisma.JsonValue;
  anchorAssetIds: string[];
  createdFrom: string;
}) {
  const faceTraits = extractVisualTraitRecord(input.appearance, "face");
  const hairTraits = extractVisualTraitRecord(input.appearance, "hair");
  const bodyTraits = extractVisualTraitRecord(input.appearance, "body");
  const signatureTraits = extractVisualTraitRecord(
    input.advancedDetails,
    "signature",
  );
  const styleTraits = {
    style: input.style,
    gender: input.gender,
    age: String(input.age),
    name: input.name,
    description: input.description,
  };
  const traits: IdentityTraits = {
    face: toTraitRecord(faceTraits),
    hair: toTraitRecord(hairTraits),
    body: toTraitRecord(bodyTraits),
    signature: toTraitRecord(signatureTraits),
    style: toTraitRecord(styleTraits),
  };
  const { identityPrompt, traitsHash } = assembleIdentityPrompt(traits);
  const negativeIdentityPrompt =
    "different face, different hairstyle, different eye color, identity drift, inconsistent age presentation";
  return {
    characterId: input.characterId,
    version: input.version,
    status: input.status,
    style: input.style,
    identityPrompt,
    negativeIdentityPrompt,
    faceTraits: toInputJson(faceTraits),
    hairTraits: toInputJson(hairTraits),
    bodyTraits: toInputJson(bodyTraits),
    signatureTraits: toInputJson(signatureTraits),
    styleTraits: toInputJson(styleTraits),
    anchorAssetIds: toInputJson(input.anchorAssetIds),
    defaultSeed: `character:${input.characterId}:visual:${input.version}`,
    adapterRefs: toInputJson({
      identity: {
        traitsHash,
        assemblerVersion: IDENTITY_ASSEMBLER_VERSION,
        source: "derived",
      },
    }),
    immutableHash: characterVisualProfileSnapshotHash({
      version: input.version,
      style: input.style,
      identityPrompt,
      negativeIdentityPrompt,
      faceTraits,
      hairTraits,
      bodyTraits,
      signatureTraits,
      styleTraits,
    }),
    evidenceState: "candidate",
    createdFrom: input.createdFrom,
  };
}

function extractVisualTraitRecord(
  value: Prisma.JsonValue,
  preferredKey: string,
) {
  if (!isRecord(value)) return {};
  const direct = value[preferredKey];
  if (isRecord(direct)) return direct;
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) =>
      ["string", "number", "boolean"].includes(typeof child),
    ),
  );
}

export async function assertCharacterIdentityAuthorityMutable(
  tx: Prisma.TransactionClient,
  characterId: string,
) {
  const serving = await tx.characterServing.findUnique({
    where: { characterId },
    select: { currentReleaseId: true, scheduledReleaseId: true },
  });
  if (serving?.currentReleaseId || serving?.scheduledReleaseId) {
    throw Errors.conflict(
      "Withdraw or replace serving Character Release authority before changing Visual Identity or Reference Set",
      {
        currentReleaseId: serving.currentReleaseId,
        scheduledReleaseId: serving.scheduledReleaseId,
        deepLink: `/admin/characters/${characterId}?tab=release`,
      },
    );
  }
  const projects = await tx.characterProject.findMany({
    where: { characterId },
    select: { id: true },
  });
  if (projects.length === 0) return;
  const activeRelease = await tx.characterRelease.findFirst({
    where: {
      projectId: { in: projects.map((project) => project.id) },
      status: { in: ["draft", "validating", "in_review", "approved"] },
    },
    select: { id: true, status: true },
  });
  if (!activeRelease) return;
  throw Errors.conflict(
    "Withdraw or finish the active Character Release before changing Visual Identity or Reference Set authority",
    {
      releaseId: activeRelease.id,
      releaseStatus: activeRelease.status,
      deepLink: `/admin/characters/${characterId}?tab=release`,
    },
  );
}
