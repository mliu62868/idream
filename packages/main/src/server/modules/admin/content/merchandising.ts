import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  isSyntheticMediaAsset,
  mediaAssetPlatformStatus,
} from "@/server/lib/media-asset-authority";
import { executeIdempotentDomainCommand } from "@/server/modules/admin/shared/domain-command";
import {
  adminAuditData,
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
} from "@/server/modules/admin/shared/legacy-primitives";
import {
  operationalCharacterWhere,
  operationalContentReportWhere,
  operationalGenerationJobWhere,
} from "@/server/modules/metric-data-scope";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";
import {
  FEATURED_CHARACTER_LIMIT,
  FEATURED_SETTING_KEY,
  parseFeaturedSetting,
} from "@/server/modules/ourdream/featured-setting";
import { publicCharacterAudienceWhere } from "@/server/modules/ourdream/public-content-audience";
import { CHARACTER_VISIBILITY } from "@idream/shared/catalog";

const featuredCharacterSelect = {
  id: true,
  name: true,
  visibility: true,
  status: true,
  source: true,
  deletedAt: true,
  creator: {
    select: {
      id: true,
      dataClass: true,
      role: true,
      status: true,
      deletedAt: true,
    },
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
            select: {
              kind: true,
              validationRunId: true,
              revokedAt: true,
            },
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

const contentVisibilitySchema = z.object({
  visibility: z.enum(CHARACTER_VISIBILITY),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const contentStatusSchema = z.object({
  status: z.enum(["approved", "rejected", "removed", "archived"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

// SPEC: 整组替换角色标签，tagIds 必须是 Tag 表里已存在的行。
// INTENT: 只做"把已有词表挂到角色上"，不隐式建标签 —— 造词属于 Taxonomy 的治理动作，
//         从角色页顺手 upsert 出新标签正是分类法失控的起点。
const contentTagsSchema = z.object({
  tagIds: z.array(z.string().trim().min(1).max(160)).max(24),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const featuredPutSchema = z.object({
  characterIds: z
    .array(z.string().trim().min(1).max(160))
    .max(FEATURED_CHARACTER_LIMIT),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export async function listContentCharacters(request: Request) {
  await actorWithPermission(request, "content.read");
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const visibility = url.searchParams.get("visibility") ?? undefined;
  const creatorId = url.searchParams.get("creatorId") ?? undefined;
  const sort = url.searchParams.get("sort") ?? "recent";
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 60);
  const queryIdentity = { search, status, visibility, creatorId, sort };
  const cursorKeys = cursorKeysFor(url, "content_characters", queryIdentity);
  const cursorId = cursorKeys
    ? cursorString(cursorKeys, 1, "content_characters")
    : null;
  const baseWhere: Prisma.CharacterWhereInput = {
    status,
    visibility,
    creatorId,
    deletedAt: null,
    OR: search
      ? [{ id: { contains: search } }, { name: { contains: search } }]
      : undefined,
  };
  const select = {
    id: true,
    name: true,
    gender: true,
    style: true,
    status: true,
    visibility: true,
    creatorId: true,
    createdAt: true,
    imageAsset: { select: { id: true, url: true, thumbnailUrl: true } },
    visualProfiles: {
      where: { status: "active" },
      orderBy: { version: "desc" },
      take: 1,
      select: { id: true, version: true, status: true, style: true },
    },
    stats: { select: { chatsCount: true, likesCount: true, viewsCount: true } },
  } satisfies Prisma.CharacterSelect;

  const items =
    sort === "popular"
      ? await listPopularCharacters({
          baseWhere,
          cursorKeys,
          cursorId,
          limit,
          select,
        })
      : await prisma.character.findMany({
        where: operationalCharacterWhere({
          ...baseWhere,
          AND: cursorKeys
              ? (() => {
                  const createdAt = cursorDate(
                    cursorKeys,
                    0,
                    "content_characters",
                  );
                  return {
                    OR: [
                      { createdAt: { lt: createdAt } },
                      { createdAt, id: { lt: cursorId ?? "" } },
                    ],
                  };
                })()
            : undefined,
        }),
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          select,
        });
  const page = items.slice(0, limit);
  return ok({
    items: page,
    pageInfo: pageInfo(
      "content_characters",
      queryIdentity,
      page,
      items.length > limit,
      (row) => [
        sort === "popular"
          ? (row.stats?.chatsCount ?? null)
          : row.createdAt.toISOString(),
        row.id,
      ],
    ),
  });
}

async function listPopularCharacters(input: {
  baseWhere: Prisma.CharacterWhereInput;
  cursorKeys: unknown[] | null;
  cursorId: string | null;
  limit: number;
  select: Prisma.CharacterSelect;
}) {
  const { baseWhere, cursorKeys, cursorId, limit, select } = input;
  if (cursorKeys?.[0] === null) {
    return prisma.character.findMany({
      where: operationalCharacterWhere({
        ...baseWhere,
        stats: { is: null },
        id: { lt: cursorId ?? "" },
      }),
      orderBy: { id: "desc" },
      take: limit + 1,
      select,
    });
  }
  const chatsCount = cursorKeys
    ? cursorNumber(cursorKeys, 0, "content_characters")
    : null;
  const ranked = await prisma.character.findMany({
    where: operationalCharacterWhere({
      ...baseWhere,
      stats: { isNot: null },
      ...(chatsCount !== null && cursorId
        ? {
            AND: [
              {
                OR: [
                  { stats: { is: { chatsCount: { lt: chatsCount } } } },
                  { stats: { is: { chatsCount } }, id: { lt: cursorId } },
                ],
              },
            ],
          }
        : {}),
    }),
    orderBy: [{ stats: { chatsCount: "desc" } }, { id: "desc" }],
    take: limit + 1,
    select,
  });
  if (ranked.length > limit) return ranked;
  const unranked = await prisma.character.findMany({
    where: operationalCharacterWhere({
      ...baseWhere,
      stats: { is: null },
    }),
    orderBy: { id: "desc" },
    take: limit + 1 - ranked.length,
    select,
  });
  return [...ranked, ...unranked];
}

export async function getContentCharacter(request: Request, id: string) {
  await actorWithPermission(request, "content.read");
  const character = await prisma.character.findFirst({
    where: operationalCharacterWhere({ id, deletedAt: null }),
    include: {
      stats: true,
      creator: { select: { id: true, email: true, displayName: true } },
      // 带上 Tag 本体：`tags: true` 只给 characterId/tagId，运营界面拿不到标签名。
      tags: { include: { tag: true } },
    },
  });
  if (!character) throw Errors.notFound("Character not found");
  const [reports, recentJobs] = await Promise.all([
    prisma.contentReport.findMany({
      where: operationalContentReportWhere({
        targetType: "character",
        targetId: id,
      }),
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.generationJob.findMany({
      where: operationalGenerationJobWhere({ characterId: id }),
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, mode: true, status: true, createdAt: true },
    }),
  ]);
  const chatImageToolEnabled =
    isRecord(character.advancedDetails) &&
    character.advancedDetails.imageToolEnabled === false
      ? false
      : true;
  return ok({ character, reports, recentJobs, chatImageToolEnabled });
}

export async function setCharacterVisibility(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.takedown.write");
  const body = contentVisibilitySchema.parse(await jsonBody(request));
  if (body.confirmation !== `${id}:visibility:${body.visibility}`) {
    throw Errors.badRequest("Confirmation did not match visibility target");
  }
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "content.visibility.write",
    targetType: "character",
    targetId: id,
    payload: body,
    execute: async (tx, requestId) => {
      const before = await tx.character.findFirst({
        where: operationalCharacterWhere({ id, deletedAt: null }),
      });
      if (!before) throw Errors.notFound("Character not found");
      rejectOfficialCharacter(before.source, id, "visibility");
      const after = await tx.character.update({
        where: { id },
        data: { visibility: body.visibility },
      });
      await writeCommandSideEffects(tx, request, actor, requestId, {
        action: "content.visibility.write",
        targetId: id,
        reason: body.reason,
        before: { visibility: before.visibility },
        after: { visibility: after.visibility },
        eventType: "admin.content.visibility_changed.v2",
      });
      return {
        character: {
          id: after.id,
          visibility: after.visibility,
          status: after.status,
        },
      };
    },
  });
  return ok(result);
}

export async function setCharacterStatus(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.takedown.write");
  const body = contentStatusSchema.parse(await jsonBody(request));
  if (body.confirmation !== `${id}:status:${body.status}`) {
    throw Errors.badRequest("Confirmation did not match status target");
  }
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "content.status.write",
    targetType: "character",
    targetId: id,
    payload: body,
    execute: async (tx, requestId) => {
      const before = await tx.character.findFirst({
        where: operationalCharacterWhere({ id, deletedAt: null }),
      });
      if (!before) throw Errors.notFound("Character not found");
      rejectOfficialCharacter(before.source, id, "status");
      const after = await tx.character.update({
        where: { id },
        data: { status: body.status },
      });
      await writeCommandSideEffects(tx, request, actor, requestId, {
        action: "content.status.write",
        targetId: id,
        reason: body.reason,
        before: { status: before.status },
        after: { status: after.status },
        eventType: "admin.content.status_changed.v2",
      });
      return {
        character: {
          id: after.id,
          visibility: after.visibility,
          status: after.status,
        },
      };
    },
  });
  return ok(result);
}

/**
 * SPEC: 设置某个角色挂载的标签（整组替换）。perm: content.tag.write。
 *
 * INTENT: 补上分类法链路里唯一缺失的一环——「把标签挂到角色上」。此前标签只能在
 * `createCharacterProject` 的 `legacyTagLabels` 里随创建写一次，而唯一传它的入口是官方角色 CMS
 * (`characters/official.ts`)，那套 CMS 全仓没有任何前端调用；官方角色的 profile 编辑还会显式
 * 拒绝改标签并让运营「去 Taxonomy workspace」，但 Taxonomy 只治理词表本身，挂载能力根本不存在。
 * 结果就是 22 个标签、2 条挂载，公开面的标签筛选没有内容可筛。
 *
 * INVARIANT: 与 visibility / status 不同，这里**不** rejectOfficialCharacter —— 需要打标签的恰恰
 * 是 16 个官方目录角色，而 CharacterTag 是扁平关联，不进 content version / release 快照，
 * 不归官方内容流水线管。
 */
export async function setCharacterTags(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.tag.write");
  const body = contentTagsSchema.parse(await jsonBody(request));
  if (body.confirmation !== `${id}:tags`) {
    throw Errors.badRequest("Confirmation did not match tag target");
  }
  const tagIds = [...new Set(body.tagIds)];
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "content.tags.write",
    targetType: "character",
    targetId: id,
    payload: body,
    execute: async (tx, requestId) => {
      const before = await tx.character.findFirst({
        where: operationalCharacterWhere({ id, deletedAt: null }),
        include: { tags: { include: { tag: true } } },
      });
      if (!before) throw Errors.notFound("Character not found");
      const known = await tx.tag.findMany({
        where: { id: { in: tagIds } },
        select: { id: true, label: true },
      });
      if (known.length !== tagIds.length) {
        const missing = tagIds.filter(
          (tagId) => !known.some((tag) => tag.id === tagId),
        );
        throw Errors.badRequest("Unknown tag", { missing });
      }
      await tx.characterTag.deleteMany({ where: { characterId: id } });
      if (tagIds.length > 0) {
        await tx.characterTag.createMany({
          data: tagIds.map((tagId) => ({ characterId: id, tagId })),
        });
      }
      const beforeLabels = before.tags.map((link) => link.tag.label).sort();
      const afterLabels = known.map((tag) => tag.label).sort();
      await writeCommandSideEffects(tx, request, actor, requestId, {
        action: "content.tags.write",
        targetId: id,
        reason: body.reason,
        before: { tags: beforeLabels },
        after: { tags: afterLabels },
        eventType: "admin.content.tags_changed.v1",
      });
      return { character: { id, tags: afterLabels } };
    },
  });
  return ok(result);
}

export async function getFeaturedCharacters(request: Request) {
  await actorWithPermission(request, "content.read");
  const snapshot = await prisma.$transaction(async (tx) => {
    const setting = await tx.appSetting.findUnique({
      where: { key: FEATURED_SETTING_KEY },
    });
    const parsedSetting = parseFeaturedSetting(setting?.value);
    const configuredCharacterIds = parsedSetting.characterIds;
    const characters = configuredCharacterIds.length
      ? await tx.character.findMany({
          where: operationalCharacterWhere({
            id: { in: configuredCharacterIds },
          }),
          select: featuredCharacterSelect,
        })
      : [];
    const effectiveCharacters = configuredCharacterIds.length
      ? await tx.character.findMany({
          where: {
            ...publicCharacterAudienceWhere,
            id: { in: configuredCharacterIds },
          },
          select: { id: true },
        })
      : [];
    const byId = new Map(
      characters.map((character) => [character.id, character]),
    );
    const effectiveSet = new Set(
      effectiveCharacters.map((character) => character.id),
    );
    const effectiveCharacterIds = configuredCharacterIds.filter((id) =>
      effectiveSet.has(id),
    );
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
        blockers: effective
          ? []
          : featuredRuntimeBlockers(id, character),
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
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
  return ok(snapshot);
}

function featuredRuntimeBlockers(
  characterId: string,
  character: FeaturedCharacter | undefined,
): FeaturedRuntimeBlocker[] {
  const merchandisingRepairDeepLink =
    `/admin/growth/merchandising?view=featured&search=${encodeURIComponent(characterId)}`;
  const assetRepairDeepLink =
    `/admin/characters/${encodeURIComponent(characterId)}?tab=assets`;
  const releaseRepairDeepLink =
    `/admin/characters/${encodeURIComponent(characterId)}?tab=release`;
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

export async function putFeaturedCharacters(request: Request) {
  const actor = await actorWithPermission(request, "content.takedown.write");
  const body = featuredPutSchema.parse(await jsonBody(request));
  const unique = parseFeaturedSetting({
    characterIds: body.characterIds,
  }).characterIds;
  const expected = unique.length ? unique.join(",") : "CLEAR";
  if (body.confirmation !== expected) {
    throw Errors.badRequest("Confirmation did not match featured target");
  }
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "content.featured.write",
    targetType: "app_setting",
    targetId: FEATURED_SETTING_KEY,
    payload: body,
    execute: async (tx, requestId) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`app-setting:${FEATURED_SETTING_KEY}`}))`;
      const before = await tx.appSetting.findUnique({
        where: { key: FEATURED_SETTING_KEY },
      });
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
            where: operationalCharacterWhere({
              id: { in: unique },
              deletedAt: null,
            }),
            select: { id: true },
          })
        : [];
      const configurableSet = new Set(
        configurable.map((character) => character.id),
      );
      const configuredCharacterIds = unique.filter((id) =>
        configurableSet.has(id),
      );
      const skipped = unique.filter((id) => !configurableSet.has(id));
      const invalid = skipped.map((id) => ({
        id,
        reason: "character_not_found_or_not_configurable" as const,
      }));
      const effective = configuredCharacterIds.length
        ? await tx.character.findMany({
            where: {
              ...publicCharacterAudienceWhere,
              id: { in: configuredCharacterIds },
            },
            select: { id: true },
          })
        : [];
      const effectiveSet = new Set(
        effective.map((character) => character.id),
      );
      const effectiveCharacterIds = configuredCharacterIds.filter((id) =>
        effectiveSet.has(id),
      );
      const settingVersion = currentVersion + 1;
      if (before) {
        const updated = await tx.appSetting.updateMany({
          where: {
            key: FEATURED_SETTING_KEY,
            version: body.expectedVersion,
          },
          data: {
            version: settingVersion,
            value: toInputJson({
              characterIds: configuredCharacterIds,
            }),
          },
        });
        if (updated.count !== 1) {
          const current = await tx.appSetting.findUnique({
            where: { key: FEATURED_SETTING_KEY },
          });
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
            value: toInputJson({
              characterIds: configuredCharacterIds,
            }),
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
    },
  });
  return ok(result);
}

function featuredSettingVersionConflict(input: {
  expectedVersion: number;
  currentVersion: number;
  configuredCharacterIds: string[];
  settingDiagnostics: ReturnType<typeof parseFeaturedSetting>["diagnostics"];
}) {
  return Errors.conflict(
    "Featured configuration changed before this save was applied",
    {
      reason: "featured_setting_version_conflict",
      expectedVersion: input.expectedVersion,
      settingVersion: input.currentVersion,
      characterIds: input.configuredCharacterIds,
      configuredCharacterIds: input.configuredCharacterIds,
      settingDiagnostics: input.settingDiagnostics,
    },
  );
}

async function writeCommandSideEffects(
  tx: Prisma.TransactionClient,
  request: Request,
  actor: Awaited<ReturnType<typeof actorWithPermission>>,
  requestId: string,
  input: {
    action: string;
    targetType?: string;
    targetId: string;
    reason: string;
    before: unknown;
    after: unknown;
    eventType: string;
  },
) {
  const targetType = input.targetType ?? "character";
  await tx.adminAuditLog.create({
    data: {
      ...adminAuditData(request, actor, {
        action: input.action,
        targetType,
        targetId: input.targetId,
        reason: input.reason,
        before: input.before,
        after: input.after,
      }),
      requestId,
    },
  });
  await tx.mainOutboxEvent.create({
    data: {
      eventType: input.eventType,
      aggregateType: targetType,
      aggregateId: input.targetId,
      payload: toInputJson({
        actorId: actor.id,
        requestId,
        before: input.before,
        after: input.after,
      }),
    },
  });
}

function rejectOfficialCharacter(source: string, id: string, field: string) {
  if (source !== "official") return;
  throw Errors.conflict(
    `Official Character ${field} is controlled by Character Release and Serving commands`,
    { repairDeepLink: `/admin/characters/${id}?tab=release` },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cursorKeysFor(url: URL, scope: string, query: unknown) {
  const cursor = url.searchParams.get("cursor");
  if (!cursor) return null;
  return decodeAdminListCursor(cursor, scope, query);
}

function cursorString(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "string")
    throw Errors.badRequest(`Invalid ${scope} cursor`);
  return value;
}

function cursorNumber(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "number")
    throw Errors.badRequest(`Invalid ${scope} cursor`);
  return value;
}

function cursorDate(keys: readonly unknown[], index: number, scope: string) {
  const value = cursorString(keys, index, scope);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw Errors.badRequest(`Invalid ${scope} cursor`);
  return date;
}

function pageInfo<T>(
  scope: string,
  query: unknown,
  page: T[],
  hasNextPage: boolean,
  keys: (row: T) => Array<string | number | boolean | null>,
) {
  const last = page.at(-1);
  return {
    hasNextPage,
    endCursor:
      hasNextPage && last
        ? encodeAdminListCursor(scope, query, keys(last))
        : null,
  };
}
