import { Prisma } from "@prisma/client";
import type { ContentFeaturedUpdateRequest } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  isSyntheticMediaAsset,
  mediaAssetPlatformStatus,
} from "@/server/lib/media-asset-authority";
import {
  FEATURED_SETTING_KEY,
  parseFeaturedSetting,
} from "@/server/modules/ourdream/featured-setting";
import { publicCharacterAudienceWhere } from "@/server/modules/ourdream/public-content-audience";
import { operationalCharacterWhere } from "@/server/modules/metric-data-scope";
import type { AdminActor } from "../shared/authority";
import { toInputJson } from "../shared/prisma-json";
import { writeCommandSideEffects } from "./merchandising";

// SPEC: 精选位（AppSetting `feed.featured`）的读写权威。
// INTENT: 「配置顺序」与「运行时真的在精选位上」是两件事，读侧同时给出两者以及每个未生效
//         条目的 blockers —— 这正是 v1 已经建立的语义，搬迁时一字未改。

const featuredCharacterSelect = {
  id: true,
  name: true,
  visibility: true,
  status: true,
  source: true,
  deletedAt: true,
  creator: {
    select: { id: true, dataClass: true, role: true, status: true, deletedAt: true },
  },
  imageAsset: {
    select: {
      id: true,
      type: true,
      visibility: true,
      safetyStatus: true,
      deletedAt: true,
      metadata: true,
    },
  },
  serving: {
    select: {
      state: true,
      currentRelease: {
        select: {
          id: true,
          status: true,
          publishedAt: true,
          readiness: true,
          legacy: true,
          publicCatalogQualification: {
            select: { kind: true, validationRunId: true, revokedAt: true },
          },
        },
      },
    },
  },
} as const satisfies Prisma.CharacterSelect;

type FeaturedCharacter = Prisma.CharacterGetPayload<{
  select: typeof featuredCharacterSelect;
}>;

type FeaturedRuntimeBlocker = {
  code: string;
  message: string;
  repairDeepLink: string;
};

export async function getFeaturedCharacters() {
  return prisma.$transaction(async (tx) => {
    const setting = await tx.appSetting.findUnique({ where: { key: FEATURED_SETTING_KEY } });
    const parsedSetting = parseFeaturedSetting(setting?.value);
    const configuredCharacterIds = parsedSetting.characterIds;
    const characters = configuredCharacterIds.length
      ? await tx.character.findMany({
          where: operationalCharacterWhere({ id: { in: configuredCharacterIds } }),
          select: featuredCharacterSelect,
        })
      : [];
    const effectiveCharacters = configuredCharacterIds.length
      ? await tx.character.findMany({
          where: { ...publicCharacterAudienceWhere, id: { in: configuredCharacterIds } },
          select: { id: true },
        })
      : [];
    const byId = new Map(characters.map((character) => [character.id, character]));
    const effectiveSet = new Set(effectiveCharacters.map((character) => character.id));
    const effectiveCharacterIds = configuredCharacterIds.filter((id) => effectiveSet.has(id));
    const items = configuredCharacterIds.map((id, configuredPosition) => {
      const character = byId.get(id);
      const effective = effectiveSet.has(id);
      return {
        id,
        name: character?.name ?? null,
        visibility: character?.visibility ?? null,
        status: character?.status ?? null,
        configuredPosition,
        configured: true as const,
        effective,
        blockers: effective ? [] : featuredRuntimeBlockers(id, character),
      };
    });
    return {
      // `characterIds` remains as a compatibility alias for the saved order.
      // It must never be interpreted as the runtime-visible Featured audience.
      characterIds: configuredCharacterIds,
      configuredCharacterIds,
      effectiveCharacterIds,
      settingVersion: setting?.version ?? 0,
      settingDiagnostics: parsedSetting.diagnostics,
      items,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

function featuredRuntimeBlockers(
  characterId: string,
  character: FeaturedCharacter | undefined,
): FeaturedRuntimeBlocker[] {
  const merchandisingRepairDeepLink =
    `/admin/growth/merchandising?view=featured&search=${encodeURIComponent(characterId)}`;
  const assetRepairDeepLink = `/admin/characters/${encodeURIComponent(characterId)}?tab=assets`;
  const releaseRepairDeepLink = `/admin/characters/${encodeURIComponent(characterId)}?tab=release`;
  if (!character) {
    return [{
      code: "character_not_operational",
      message: "Character is missing or outside the operational inventory.",
      repairDeepLink: merchandisingRepairDeepLink,
    }];
  }

  const blockers: FeaturedRuntimeBlocker[] = [];
  if (character.deletedAt !== null) {
    blockers.push({
      code: "character_deleted",
      message: "Character is deleted.",
      repairDeepLink: merchandisingRepairDeepLink,
    });
  }
  if (character.visibility !== "public") {
    blockers.push({
      code: "character_not_public",
      message: "Character visibility is not public.",
      repairDeepLink: merchandisingRepairDeepLink,
    });
  }
  if (character.status !== "approved") {
    blockers.push({
      code: "character_not_approved",
      message: "Character status is not approved.",
      repairDeepLink: merchandisingRepairDeepLink,
    });
  }
  if (character.source === "user") {
    const creator = character.creator;
    if (
      !creator ||
      creator.dataClass !== "customer" ||
      creator.role !== "user" ||
      creator.status !== "active" ||
      creator.deletedAt !== null
    ) {
      blockers.push({
        code: "creator_not_publicly_eligible",
        message: "Character creator is not an active customer user.",
        repairDeepLink: merchandisingRepairDeepLink,
      });
    }
  } else if (character.source !== "official") {
    blockers.push({
      code: "character_source_ineligible",
      message: "Character source is not eligible for the public audience.",
      repairDeepLink: merchandisingRepairDeepLink,
    });
  }

  const imageAsset = character.imageAsset;
  if (!imageAsset) {
    blockers.push({
      code: "avatar_missing",
      message: "No primary character image is assigned.",
      repairDeepLink: assetRepairDeepLink,
    });
  } else {
    if (imageAsset.type !== "image") {
      blockers.push({
        code: "avatar_not_image",
        message: "The primary character asset is not an image.",
        repairDeepLink: assetRepairDeepLink,
      });
    }
    if (imageAsset.deletedAt !== null) {
      blockers.push({
        code: "avatar_deleted",
        message: "The primary character image is deleted.",
        repairDeepLink: assetRepairDeepLink,
      });
    }
    if (imageAsset.visibility !== "public_pack") {
      blockers.push({
        code: "avatar_not_public",
        message: "The primary character image is not public.",
        repairDeepLink: assetRepairDeepLink,
      });
    }
    if (imageAsset.safetyStatus !== "passed") {
      blockers.push({
        code: "avatar_not_passed",
        message: "The primary character image has not passed review.",
        repairDeepLink: assetRepairDeepLink,
      });
    }
    if (isSyntheticMediaAsset(imageAsset.metadata)) {
      blockers.push({
        code: "avatar_synthetic",
        message: "The primary character image is synthetic test output.",
        repairDeepLink: assetRepairDeepLink,
      });
    }
    const platformStatus = mediaAssetPlatformStatus(imageAsset.metadata);
    if (
      platformStatus === "archived" ||
      platformStatus === "rejected" ||
      platformStatus === "blocked"
    ) {
      blockers.push({
        code: "avatar_platform_ineligible",
        message: `The primary character image is ${platformStatus} in the Image Library.`,
        repairDeepLink: assetRepairDeepLink,
      });
    }
  }

  const serving = character.serving;
  if (!serving || serving.state !== "live") {
    blockers.push({
      code: "serving_not_live",
      message: "Character Serving is not live.",
      repairDeepLink: releaseRepairDeepLink,
    });
  }
  const release = serving?.currentRelease;
  if (!release) {
    blockers.push({
      code: "current_release_missing",
      message: "Character Serving has no current Release.",
      repairDeepLink: releaseRepairDeepLink,
    });
  } else {
    if (release.status !== "published" || release.publishedAt === null) {
      blockers.push({
        code: "current_release_not_published",
        message: "The current Character Release is not published.",
        repairDeepLink: releaseRepairDeepLink,
      });
    }
    if (!release.legacy && release.readiness !== "ready") {
      blockers.push({
        code: "current_release_not_ready",
        message: "The current generated Character Release is not ready.",
        repairDeepLink: releaseRepairDeepLink,
      });
    }
    const qualification = release.publicCatalogQualification;
    if (!qualification) {
      blockers.push({
        code: "qualification_missing",
        message: "The current Character Release has no public catalog qualification.",
        repairDeepLink: releaseRepairDeepLink,
      });
    } else {
      if (qualification.revokedAt !== null) {
        blockers.push({
          code: "qualification_revoked",
          message: "The current Character Release qualification is revoked.",
          repairDeepLink: releaseRepairDeepLink,
        });
      }
      const qualificationKindValid = release.legacy
        ? qualification.kind === "editorial_import"
        : qualification.kind === "generated_release" &&
          qualification.validationRunId !== null;
      if (!qualificationKindValid) {
        blockers.push({
          code: "qualification_invalid",
          message: "The current Character Release qualification does not match its release type.",
          repairDeepLink: releaseRepairDeepLink,
        });
      }
    }
  }

  return blockers.length > 0
    ? blockers
    : [{
        code: "runtime_audience_ineligible",
        message: "Character does not satisfy the current public audience authority.",
        repairDeepLink: releaseRepairDeepLink,
      }];
}

export async function putFeaturedCharacters(input: {
  tx: Prisma.TransactionClient;
  request: Request;
  actor: AdminActor;
  requestId: string;
  body: ContentFeaturedUpdateRequest;
}) {
  const { tx, request, actor, requestId, body } = input;
  const unique = parseFeaturedSetting({ characterIds: body.characterIds }).characterIds;
  const expected = unique.length ? unique.join(",") : "CLEAR";
  if (body.confirmation !== expected) {
    throw Errors.badRequest("Confirmation did not match featured target");
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`app-setting:${FEATURED_SETTING_KEY}`}))`;
  const before = await tx.appSetting.findUnique({ where: { key: FEATURED_SETTING_KEY } });
  const beforeSetting = parseFeaturedSetting(before?.value);
  const currentVersion = before?.version ?? 0;
  if (body.expectedVersion !== currentVersion) {
    throw featuredSettingVersionConflict({
      expectedVersion: body.expectedVersion,
      currentVersion,
      configuredCharacterIds: beforeSetting.characterIds,
      settingDiagnostics: beforeSetting.diagnostics,
    });
  }

  const configurable = unique.length
    ? await tx.character.findMany({
        where: operationalCharacterWhere({ id: { in: unique }, deletedAt: null }),
        select: { id: true },
      })
    : [];
  const configurableSet = new Set(configurable.map((character) => character.id));
  const configuredCharacterIds = unique.filter((id) => configurableSet.has(id));
  const skipped = unique.filter((id) => !configurableSet.has(id));
  const invalid = skipped.map((id) => ({
    id,
    reason: "character_not_found_or_not_configurable" as const,
  }));
  const effective = configuredCharacterIds.length
    ? await tx.character.findMany({
        where: { ...publicCharacterAudienceWhere, id: { in: configuredCharacterIds } },
        select: { id: true },
      })
    : [];
  const effectiveSet = new Set(effective.map((character) => character.id));
  const effectiveCharacterIds = configuredCharacterIds.filter((id) => effectiveSet.has(id));
  const settingVersion = currentVersion + 1;
  if (before) {
    const updated = await tx.appSetting.updateMany({
      where: { key: FEATURED_SETTING_KEY, version: body.expectedVersion },
      data: {
        version: settingVersion,
        value: toInputJson({ characterIds: configuredCharacterIds }),
      },
    });
    if (updated.count !== 1) {
      const current = await tx.appSetting.findUnique({ where: { key: FEATURED_SETTING_KEY } });
      const currentSetting = parseFeaturedSetting(current?.value);
      throw featuredSettingVersionConflict({
        expectedVersion: body.expectedVersion,
        currentVersion: current?.version ?? 0,
        configuredCharacterIds: currentSetting.characterIds,
        settingDiagnostics: currentSetting.diagnostics,
      });
    }
  } else {
    await tx.appSetting.create({
      data: {
        key: FEATURED_SETTING_KEY,
        version: settingVersion,
        value: toInputJson({ characterIds: configuredCharacterIds }),
      },
    });
  }
  await writeCommandSideEffects(tx, request, actor, requestId, {
    action: "content.featured.write",
    targetType: "app_setting",
    targetId: FEATURED_SETTING_KEY,
    reason: body.reason,
    before: {
      settingVersion: currentVersion,
      characterIds: beforeSetting.characterIds,
      settingDiagnostics: beforeSetting.diagnostics,
    },
    after: {
      settingVersion,
      configuredCharacterIds,
      effectiveCharacterIds,
      skipped,
      invalid,
    },
    eventType: "admin.content.featured_updated.v2",
  });
  return {
    // `characterIds` remains a compatibility alias for the saved
    // configuration, never the runtime-effective audience.
    characterIds: configuredCharacterIds,
    configuredCharacterIds,
    effectiveCharacterIds,
    settingVersion,
    settingDiagnostics: [],
    skipped,
    invalid,
  };
}

function featuredSettingVersionConflict(input: {
  expectedVersion: number;
  currentVersion: number;
  configuredCharacterIds: string[];
  settingDiagnostics: ReturnType<typeof parseFeaturedSetting>["diagnostics"];
}) {
  return Errors.conflict("Featured configuration changed before this save was applied", {
    reason: "featured_setting_version_conflict",
    expectedVersion: input.expectedVersion,
    settingVersion: input.currentVersion,
    characterIds: input.configuredCharacterIds,
    configuredCharacterIds: input.configuredCharacterIds,
    settingDiagnostics: input.settingDiagnostics,
  });
}
