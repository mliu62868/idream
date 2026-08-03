// SPEC: 公开发现面 —— Feed 信息流、Community 榜单/活动/创作者、以及把两者串起来的
// 关注图与创作者主页。对应 v1 路由：/feed/**、/community/**、/users/{id}/follow、
// /creators/{id}。
//
// INTENT: 这些是"没登录也能看"的读路径，它们的正确性由**受众过滤**决定，而不是由
// 每个 handler 各自记得加条件决定。把它们放在一个文件里，是让
// publicCharacterAudienceWhere / publicCollectionAudienceWhere / activeCustomerUserWhere
// 这三个过滤器在同一屏内被反复看见 —— 漏一个就是把未审核或已删除的内容推上首页。
//
// INVARIANT: 所有出站投影只经 characterDTO / mediaCollectionDTO 等公开 DTO，绝不直出
// Prisma row；creator 相关只出 displayName / image / 聚合计数，不出 email、状态、
// 内部 id 之外的任何账号事实。
//
// INVARIANT: Feed 游标是**签名且带快照时刻**的。首页那次请求决定了 snapshotAt 与
// excludedCharacterIds，之后的翻页只在那个快照里前进 —— 客户端改 limit 也不会重算
// 预算、不会重复或漏掉条目。签名用 INTERNAL_TOKEN，校验走 timingSafeEqual；解不开、
// 版本不对、超 TTL 一律 fail closed（400 / 410），不降级成"当作第一页"。
//
// NOTE: 反向 import ./service 的一批是共用的公开读模型（characterInclude / characterDTO /
// mediaCollectionDTO / mediaViewUrl / formatCount…）与两个跨面 helper（submitReport /
// isCustomerEngagementActor）。它们是下一刀该抽的东西（一个 public read model 模块），
// 这轮没做 —— 见提交说明。
import { Prisma } from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getAuthCtx,
  requireAgeGate,
  requireUser,
} from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { AppError, Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  ExperimentRuntimeError,
  assignExperiment,
} from "@/server/modules/admin-v2/experiments/runtime";
import {
  parseCommunityCampaignAuthoredCopy,
  resolveCommunityCampaignPlacements,
} from "./community-campaigns";
import {
  issueExposureContext,
  metricExposureSubject,
} from "./exposure-context";
import {
  FEATURED_SETTING_KEY,
  parseFeaturedSetting,
} from "./featured-setting";
import {
  activeCustomerUserWhere,
  publicCharacterAudienceWhere,
  publicCollectionAudienceWhere,
} from "./public-content-audience";
import {
  characterDTO,
  characterInclude,
  clampInt,
  cryptoRandomId,
  formatCount,
  isCustomerEngagementActor,
  mediaCollectionDTO,
  mediaCollectionInclude,
  mediaViewUrl,
  numberFromDb,
  submitReport,
  trackEvent,
  type CharacterWithPublicRelations,
  type MediaCollectionWithRelations,
} from "./service";

export async function feed(request: Request, segments: string[]) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const [, action, itemId, subAction] = segments;
  if (request.method === "GET") {
    // 运营策展：feed.featured（AppSetting）里仍 public+approved 的角色仅在首页置顶；
    // recent public collections are interleaved on the first page so Feed is not just a catalog mirror.
    const url = new URL(request.url);
    const limit = clampInt(url.searchParams.get("limit"), 1, 60, 20);
    const cursorState = decodeFeedCursor(url.searchParams.get("cursor"));
    const requestedScopeItemId = feedScopeItemId(url.searchParams.get("item"));
    if (
      cursorState &&
      requestedScopeItemId &&
      cursorState.scopeItemId !== requestedScopeItemId
    ) {
      throw Errors.badRequest("Feed cursor does not match the requested item");
    }
    const requestedItemId =
      cursorState?.scopeItemId ?? requestedScopeItemId;
    const publicWhere = publicCharacterAudienceWhere;

    if (cursorState) {
      const stablePage = await prisma.character.findMany({
        where: {
          AND: [
            publicWhere,
            { createdAt: { lte: cursorState.snapshotAt } },
            cursorState.excludedCharacterIds.length > 0
              ? { id: { notIn: cursorState.excludedCharacterIds } }
              : {},
            cursorState.lastCreatedAt && cursorState.lastId
              ? {
                  OR: [
                    { createdAt: { lt: cursorState.lastCreatedAt } },
                    {
                      createdAt: cursorState.lastCreatedAt,
                      id: { lt: cursorState.lastId },
                    },
                  ],
                }
              : {},
          ],
        },
        include: characterInclude(ctx.userId),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const page = stablePage.slice(0, limit);
      const lastCharacter = page.at(-1);
      return ok({
        items: page.map(feedCharacterItemDTO),
        focusedItemId: null,
        nextCursor:
          stablePage.length > limit && lastCharacter
            ? encodeFeedCursor({
                scopeItemId: cursorState.scopeItemId,
                snapshotAt: cursorState.snapshotAt,
                expiresAt: cursorState.expiresAt,
                excludedCharacterIds: cursorState.excludedCharacterIds,
                lastCreatedAt: lastCharacter.createdAt,
                lastId: lastCharacter.id,
              })
            : null,
      });
    }

    const snapshotAt = new Date();
    const focusedCharacterId = requestedItemId ? feedCharacterId(requestedItemId) : null;
    const focusedCollectionId = requestedItemId ? feedCollectionId(requestedItemId) : null;
    const snapshotPublicWhere = {
      AND: [publicWhere, { createdAt: { lte: snapshotAt } }],
    } satisfies Prisma.CharacterWhereInput;
    const [featuredSetting, focusedCharacter, focusedCollection] = await Promise.all([
      prisma.appSetting.findUnique({
        where: { key: FEATURED_SETTING_KEY },
      }),
      focusedCharacterId
        ? prisma.character.findFirst({
            where: { AND: [snapshotPublicWhere, { id: focusedCharacterId }] },
            include: characterInclude(ctx.userId),
          })
        : null,
      focusedCollectionId
        ? prisma.mediaCollection.findFirst({
            where: {
              AND: [
                feedPublicCollectionWhere([], focusedCollectionId),
                { createdAt: { lte: snapshotAt } },
              ],
            },
            include: mediaCollectionInclude(true),
          })
        : null,
    ]);
    const focusedItem = focusedCharacter
      ? feedCharacterItemDTO(focusedCharacter)
      : focusedCollection
        ? feedCollectionItemDTO(focusedCollection)
        : null;
    const focusedItemSlotCount = focusedItem ? 1 : 0;
    const collectionLimit = Math.min(
      2,
      Math.floor(limit / 4),
      Math.max(0, limit - focusedItemSlotCount),
    );
    const characterBudget = Math.max(
      0,
      limit - focusedItemSlotCount - collectionLimit,
    );
    const featuredIds = parseFeaturedSetting(featuredSetting?.value).characterIds;
    // Keep at least one live-ranked character in a character-bearing first page.
    // The immutable continuation cursor owns every first-page exclusion, so later
    // requests never recalculate this budget when the client changes `limit`.
    const maxPinnedFeatured = Math.max(0, characterBudget - 1);
    const pinnedFeaturedIds = [
      ...new Set(featuredIds.filter((id) => id !== focusedCharacter?.id)),
    ].slice(0, maxPinnedFeatured);
    const excludedFirstQueryIds = [
      ...new Set(
        [...pinnedFeaturedIds, focusedCharacter?.id].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
    const [popular, featured, recentCollections, publicCharacterCount] = await Promise.all([
      prisma.character.findMany({
        where: {
          AND: [
            snapshotPublicWhere,
            excludedFirstQueryIds.length > 0
              ? { id: { notIn: excludedFirstQueryIds } }
              : {},
          ],
        },
        include: characterInclude(ctx.userId),
        orderBy: [{ stats: { chatsCount: "desc" } }, { createdAt: "desc" }, { id: "desc" }],
        take: characterBudget + 1,
      }),
      pinnedFeaturedIds.length > 0
        ? prisma.character.findMany({
            where: {
              AND: [
                snapshotPublicWhere,
                { id: { in: pinnedFeaturedIds } },
              ],
            },
            include: characterInclude(ctx.userId),
          })
        : [],
      collectionLimit > 0
        ? prisma.mediaCollection.findMany({
            where: {
              AND: [
                feedPublicCollectionWhere(
                  focusedCollection ? [focusedCollection.id] : [],
                ),
                { createdAt: { lte: snapshotAt } },
              ],
            },
            include: mediaCollectionInclude(true),
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: collectionLimit,
          })
        : [],
      prisma.character.count({ where: snapshotPublicWhere }),
    ]);
    const featuredById = new Map(featured.map((character) => [character.id, character]));
    const orderedFeatured = pinnedFeaturedIds
      .map((id) => featuredById.get(id))
      .filter((character): character is (typeof featured)[number] => character !== undefined)
      .slice(0, characterBudget);
    const popularPage = popular.slice(
      0,
      Math.max(0, characterBudget - orderedFeatured.length),
    );
    const characterItems = [...orderedFeatured, ...popularPage].map(feedCharacterItemDTO);
    const collectionItems = recentCollections.map(feedCollectionItemDTO);
    const items = [
      ...(focusedItem ? [focusedItem] : []),
      ...interleaveFeedItems(characterItems, collectionItems),
    ];
    const renderedCharacterIds = [
      ...new Set(
        items.flatMap((item) =>
          item.type === "character" ? [item.character.id] : [],
        ),
      ),
    ];
    return ok({
      items,
      focusedItemId: focusedItem?.id ?? null,
      nextCursor:
        publicCharacterCount > renderedCharacterIds.length
          ? encodeFeedCursor({
              scopeItemId: requestedScopeItemId,
              snapshotAt,
              expiresAt: new Date(snapshotAt.getTime() + FEED_CURSOR_TTL_MS),
              excludedCharacterIds: renderedCharacterIds,
              lastCreatedAt: null,
              lastId: null,
            })
          : null,
    });
  }
  if (request.method === "POST" && action === "restart") return ok({ cursor: null });
  if (action === "items" && itemId && subAction === "like") {
    const character = await feedPublicCharacterByItemId(itemId);
    if (!character) throw Errors.notFound("Feed item not found");
    const characterId = character.id;
    if (request.method === "POST") {
      const user = requireUser(ctx);
      const countsAsEngagement = await isCustomerEngagementActor(user.id);
      // 幂等且并发安全：只有真正插入 like 行的请求才推进统计。
      const createdCount = await prisma.$transaction(async (tx) => {
        const created = await tx.characterLike.createMany({
          data: [{ userId: user.id, characterId }],
          skipDuplicates: true,
        });
        if (created.count > 0 && countsAsEngagement) {
          await tx.characterStats.upsert({
            where: { characterId },
            update: { likesCount: { increment: 1 } },
            create: { characterId, likesCount: 1 },
          });
        }
        return created.count;
      });
      if (createdCount > 0) {
        await trackEvent("feed_item_liked", { itemId }, ctx);
      }
      return ok({ liked: true });
    }
    if (request.method === "DELETE") {
      const user = requireUser(ctx);
      const countsAsEngagement = await isCustomerEngagementActor(user.id);
      // 对称：仅当确实删除了一行 like 才 -1，且永不低于 0。
      const removed = await prisma.characterLike.deleteMany({
        where: { userId: user.id, characterId },
      });
      if (removed.count > 0 && countsAsEngagement) {
        await prisma.characterStats.updateMany({
          where: { characterId, likesCount: { gt: 0 } },
          data: { likesCount: { decrement: 1 } },
        });
      }
      return ok({ liked: false });
    }
  }
  if (request.method === "POST" && action === "items" && itemId && subAction === "remix") {
    const character = await feedPublicCharacterByItemId(itemId);
    if (!character) throw Errors.notFound("Feed item not found");
    const characterId = character.id;
    await trackEvent("feed_item_remixed", { itemId, characterId }, ctx);
    const params = new URLSearchParams({
      characterId,
      remixFeedItemId: `character:${characterId}`,
    });
    return ok({
      remixUrl: `/generate?${params.toString()}`,
      characterId,
      remixFeedItemId: `character:${characterId}`,
    });
  }
  if (request.method === "POST" && action === "items" && itemId && subAction === "share") {
    const canonicalItemId = await canonicalPublicFeedItemId(itemId);
    if (!canonicalItemId) throw Errors.notFound("Feed item not found");
    await trackEvent("feed_item_shared", { itemId: canonicalItemId }, ctx);
    return ok({ shareUrl: `/feed?item=${encodeURIComponent(canonicalItemId)}` });
  }
  if (request.method === "POST" && action === "items" && itemId && subAction === "report") {
    return submitReport(request, {
      targetType: "feed_item",
      targetId: (await canonicalPublicFeedItemId(itemId)) ?? itemId,
    });
  }
  throw Errors.notFound("Feed route not found", {
    path: `/${segments.join("/")}`,
  });
}

export function feedCharacterId(itemId: string) {
  let decoded = itemId;
  try {
    decoded = decodeURIComponent(itemId);
  } catch {
    return null;
  }
  return decoded.startsWith("character:") ? decoded.slice("character:".length) : null;
}

function feedScopeItemId(value: string | null) {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  const isCharacter =
    normalized.startsWith("character:") &&
    normalized.length > "character:".length;
  const isCollection =
    normalized.startsWith("collection:") &&
    normalized.length > "collection:".length;
  if (normalized.length > 512 || (!isCharacter && !isCollection)) {
    throw Errors.badRequest("Invalid Feed item scope");
  }
  return normalized;
}

type FeedCursorState = {
  scopeItemId: string | null;
  snapshotAt: Date;
  expiresAt: Date;
  excludedCharacterIds: string[];
  lastCreatedAt: Date | null;
  lastId: string | null;
};

const FEED_CURSOR_TTL_MS = 30 * 60 * 1_000;

function decodeFeedCursor(value: string | null): FeedCursorState | null {
  if (!value) return null;
  if (value.length > 8_192) {
    throw Errors.badRequest("Invalid or expired Feed cursor");
  }
  try {
    const [encodedPayload, suppliedSignature, extra] = value.split(".");
    if (!encodedPayload || !suppliedSignature || extra) {
      throw Errors.badRequest("Invalid or expired Feed cursor");
    }
    const expected = Buffer.from(feedCursorSignature(encodedPayload));
    const supplied = Buffer.from(suppliedSignature);
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    ) {
      throw Errors.badRequest("Invalid or expired Feed cursor");
    }
    const decoded: unknown = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw Errors.badRequest("Invalid or expired Feed cursor");
    }
    const candidate = decoded as Record<string, unknown>;
    if (candidate.v !== 2) {
      throw Errors.badRequest("Invalid or expired Feed cursor");
    }
    const scopeItemId =
      candidate.scopeItemId === null
        ? null
        : typeof candidate.scopeItemId === "string" &&
            candidate.scopeItemId.length > 0 &&
            candidate.scopeItemId.length <= 512
        ? feedScopeItemId(candidate.scopeItemId)
        : undefined;
    const snapshotAt =
      typeof candidate.snapshotAt === "string"
        ? new Date(candidate.snapshotAt)
        : new Date(Number.NaN);
    const expiresAt =
      typeof candidate.expiresAt === "string"
        ? new Date(candidate.expiresAt)
        : new Date(Number.NaN);
    const lastCreatedAt =
      candidate.lastCreatedAt === null
        ? null
        : typeof candidate.lastCreatedAt === "string"
          ? new Date(candidate.lastCreatedAt)
          : new Date(Number.NaN);
    const lastId =
      candidate.lastId === null
        ? null
        : typeof candidate.lastId === "string" &&
            candidate.lastId.length > 0 &&
            candidate.lastId.length <= 512
          ? candidate.lastId
          : undefined;
    const excludedCharacterIds = Array.isArray(candidate.excludedCharacterIds)
      ? candidate.excludedCharacterIds
      : null;
    if (
      scopeItemId === undefined ||
      !Number.isFinite(snapshotAt.getTime()) ||
      snapshotAt.getTime() > Date.now() + 60_000 ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= snapshotAt ||
      expiresAt.getTime() - snapshotAt.getTime() > FEED_CURSOR_TTL_MS ||
      !excludedCharacterIds ||
      excludedCharacterIds.length > 60 ||
      excludedCharacterIds.some(
        (id) => typeof id !== "string" || id.length === 0 || id.length > 512,
      ) ||
      new Set(excludedCharacterIds).size !== excludedCharacterIds.length ||
      lastId === undefined ||
      !Number.isFinite(lastCreatedAt?.getTime() ?? snapshotAt.getTime()) ||
      (lastCreatedAt === null) !== (lastId === null) ||
      (lastCreatedAt !== null && lastCreatedAt > snapshotAt)
    ) {
      throw Errors.badRequest("Invalid or expired Feed cursor");
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw Errors.gone("Feed cursor expired; refresh the Feed");
    }
    return {
      scopeItemId,
      snapshotAt,
      expiresAt,
      excludedCharacterIds: excludedCharacterIds as string[],
      lastCreatedAt,
      lastId,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw Errors.badRequest("Invalid or expired Feed cursor");
  }
}

function encodeFeedCursor(state: {
  scopeItemId: string | null;
  snapshotAt: Date;
  expiresAt: Date;
  excludedCharacterIds: string[];
  lastCreatedAt: Date | null;
  lastId: string | null;
}) {
  const encodedPayload = Buffer.from(
    JSON.stringify({
      v: 2,
      scopeItemId: state.scopeItemId,
      snapshotAt: state.snapshotAt.toISOString(),
      expiresAt: state.expiresAt.toISOString(),
      excludedCharacterIds: state.excludedCharacterIds,
      lastCreatedAt: state.lastCreatedAt?.toISOString() ?? null,
      lastId: state.lastId,
    }),
    "utf8",
  ).toString("base64url");
  return `${encodedPayload}.${feedCursorSignature(encodedPayload)}`;
}

function feedCursorSignature(encodedPayload: string) {
  return createHmac("sha256", env.INTERNAL_TOKEN)
    .update(`feed-pagination-v2\n${encodedPayload}`)
    .digest("base64url");
}

export async function feedPublicCharacterByItemId(itemId: string) {
  const characterId = feedCharacterId(itemId);
  if (!characterId) return null;
  return prisma.character.findFirst({
    where: {
      AND: [
        publicCharacterAudienceWhere,
        { id: characterId },
      ],
    },
    select: {
      id: true,
      creatorId: true,
      name: true,
    },
  });
}

export function feedCollectionId(itemId: string) {
  let decoded = itemId;
  try {
    decoded = decodeURIComponent(itemId);
  } catch {
    return null;
  }
  return decoded.startsWith("collection:") ? decoded.slice("collection:".length) : null;
}

function feedPublicCollectionWhere(excludedIds: string[] = [], id?: string) {
  const idFilter = id ? { id } : excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {};
  return {
    AND: [
      publicCollectionAudienceWhere,
      idFilter,
      {
        items: {
          some: {
            mediaAsset: {
              deletedAt: null,
              safetyStatus: "passed",
              visibility: { in: ["public_pack", "unlisted"] },
            },
          },
        },
      },
    ],
  } satisfies Prisma.MediaCollectionWhereInput;
}

async function canonicalPublicFeedItemId(itemId: string) {
  const character = await feedPublicCharacterByItemId(itemId);
  if (character) return `character:${character.id}`;

  const collectionId = feedCollectionId(itemId);
  if (!collectionId) return null;
  const collection = await prisma.mediaCollection.findFirst({
    where: feedPublicCollectionWhere([], collectionId),
    select: { id: true },
  });
  return collection ? `collection:${collection.id}` : null;
}

function feedCharacterItemDTO(character: CharacterWithPublicRelations) {
  return {
    id: `character:${character.id}`,
    type: "character" as const,
    character: characterDTO(character),
  };
}

function feedCollectionItemDTO(collection: MediaCollectionWithRelations) {
  return {
    id: `collection:${collection.id}`,
    type: "collection" as const,
    collection: mediaCollectionDTO(collection),
  };
}

function interleaveFeedItems<T, U>(primary: T[], secondary: U[]) {
  const items: Array<T | U> = [];
  let secondaryIndex = 0;
  primary.forEach((item, index) => {
    items.push(item);
    if ((index + 1) % 3 === 0 && secondaryIndex < secondary.length) {
      items.push(secondary[secondaryIndex]);
      secondaryIndex += 1;
    }
  });
  while (secondaryIndex < secondary.length) {
    items.push(secondary[secondaryIndex]);
    secondaryIndex += 1;
  }
  return items;
}

export async function community(request: Request, segments: string[]) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const [, view] = segments;
  const url = new URL(request.url);

  if (view === "collections") {
    const focusedCollectionId = url.searchParams.get("collection")?.trim() ?? "";
    const [recentCollections, focusedCollection] = await Promise.all([
      prisma.mediaCollection.findMany({
        where: publicCollectionAudienceWhere,
        include: mediaCollectionInclude(true),
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      focusedCollectionId
        ? prisma.mediaCollection.findFirst({
            where: {
              AND: [
                publicCollectionAudienceWhere,
                { id: focusedCollectionId },
              ],
            },
            include: mediaCollectionInclude(true),
          })
        : Promise.resolve(null),
    ]);
    const collections =
      focusedCollection &&
      !recentCollections.some((collection) => collection.id === focusedCollection.id)
        ? [...recentCollections, focusedCollection]
        : recentCollections;
    return ok({ collections: collections.map(mediaCollectionDTO) });
  }

  if (view === "campaigns") {
    const campaigns = await resolveCommunityCampaignPlacements(prisma);
    return ok({
      campaigns: campaigns.flatMap((placement) => {
        const campaign = communityCampaignDTO(placement);
        return campaign ? [campaign] : [];
      }),
    });
  }

  const exposureSubject = metricExposureSubject(ctx.userId, ctx.anonymousId);
  let rankingAssignment: Awaited<ReturnType<typeof assignExperiment>> | null = null;
  if (exposureSubject) {
    try {
      rankingAssignment = await assignExperiment(prisma, "community.character-ranking.v1", {
        subjectType: exposureSubject.subjectType,
        subjectId: exposureSubject.subjectId,
        eligibilitySnapshot: { surface: "community.leaderboard" },
      });
    } catch (error) {
      if (!(error instanceof ExperimentRuntimeError) || error.code !== "definition_not_running") throw error;
    }
  }
  const publicCharacterWhere = publicCharacterAudienceWhere;
  const followedCreatorIds = ctx.userId ? await communityFollowedCreatorIds(ctx.userId) : [];
  const [characters, topDreamerRows, followedDreamerRows] = await Promise.all([
    prisma.character.findMany({
      where: {
        ...publicCharacterWhere,
        gender: url.searchParams.get("gender") ?? undefined,
        style: url.searchParams.get("style") ?? undefined,
        createdAt:
          url.searchParams.get("release") === "30d"
            ? { gte: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30) }
            : undefined,
      },
      include: characterInclude(ctx.userId),
      orderBy: [{ stats: { likesCount: "desc" } }],
      take: 20,
    }),
    communityDreamerRows(),
    followedCreatorIds.length
      ? communityDreamerRows({ creatorIds: followedCreatorIds, limit: followedCreatorIds.length })
      : Promise.resolve([]),
  ]);
  const rankedCharacters = rankingAssignment?.status === "assigned" && rankingAssignment.variant === "relationship_first"
    ? [...characters].sort((left, right) =>
        (right.stats?.chatsCount ?? 0) - (left.stats?.chatsCount ?? 0) ||
        (right.stats?.likesCount ?? 0) - (left.stats?.likesCount ?? 0) ||
        left.id.localeCompare(right.id),
      )
    : characters;
  const dreamerRows = mergeCommunityDreamerRows(followedDreamerRows, topDreamerRows);
  const followingIds = new Set(followedCreatorIds);
  const dreamers = dreamerRows.map((dreamer) => ({
    id: dreamer.id,
    displayName: dreamer.displayName,
    image: dreamer.image,
    characters: numberFromDb(dreamer.characters),
    followers: numberFromDb(dreamer.followers),
    likes: formatCount(numberFromDb(dreamer.likes)),
    chats: formatCount(numberFromDb(dreamer.chats)),
    likesCount: numberFromDb(dreamer.likes),
    chatsCount: numberFromDb(dreamer.chats),
    isFollowing: followingIds.has(dreamer.id),
  }));
  const exposureJourneyId = `community-journey-${cryptoRandomId("journey")}`;
  return ok({
    leaderboards: {
      characters: rankedCharacters.map((character) => ({
        ...characterDTO(character, ctx.userId),
        exposureContext: exposureSubject && character.serving?.state === "live" &&
          character.serving.currentRelease?.status === "published"
          ? issueExposureContext({
              ...exposureSubject,
              characterId: character.id,
              characterContentVersionId: character.serving.currentRelease.characterContentVersionId,
              characterReleaseId: character.serving.currentRelease.id,
              servingVersion: character.serving.version,
              placementId: "community.leaderboard",
              journeyId: exposureJourneyId,
            }, env.BETTER_AUTH_SECRET)
          : null,
      })),
      dreamers,
      collections: [],
    },
    experimentAssignment: rankingAssignment?.status === "assigned" &&
      rankingAssignment.assignmentId &&
      (rankingAssignment.variant === "control" || rankingAssignment.variant === "relationship_first")
      ? {
          assignmentId: rankingAssignment.assignmentId,
          variant: rankingAssignment.variant,
          exposureId: `experiment-exposure-${cryptoRandomId("community-ranking")}`,
          surface: "community.leaderboard",
        }
      : null,
  });
}

type CommunityCampaignPlacement = Prisma.MediaAssetPlacementGetPayload<{
  include: { mediaAsset: true };
}>;

function communityCampaignDTO(placement: CommunityCampaignPlacement) {
  const copy = parseCommunityCampaignAuthoredCopy(placement.metadata);
  if (!copy) return null;
  const image = placement.mediaAsset.storageKey
    ? mediaViewUrl(placement.mediaAsset)
    : (placement.mediaAsset.thumbnailUrl ?? placement.mediaAsset.url);
  return {
    id: placement.id,
    eyebrow: copy.eyebrow,
    title: copy.title,
    ctaLabel: copy.ctaLabel,
    href: copy.href,
    image,
    source: "authority" as const,
  };
}

type CommunityDreamerRow = {
  id: string;
  displayName: string;
  image: string | null;
  characters: number | bigint;
  followers: number | bigint;
  likes: number | bigint;
  chats: number | bigint;
};

export async function communityFollowedCreatorIds(userId: string) {
  const rows = await prisma.follow.findMany({
    where: { followerId: userId },
    orderBy: { createdAt: "desc" },
    select: { followeeId: true },
  });
  return rows.map((row) => row.followeeId);
}

function mergeCommunityDreamerRows(...groups: CommunityDreamerRow[][]) {
  const rows: CommunityDreamerRow[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const row of group) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
      if (rows.length >= 20) return rows;
    }
  }
  return rows;
}

async function communityDreamerRows(options: { creatorIds?: string[]; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 40));
  const creators = await prisma.user.findMany({
    where: {
      ...activeCustomerUserWhere,
      ...(options.creatorIds?.length
        ? { id: { in: options.creatorIds } }
        : {}),
      charactersCreated: { some: publicCharacterAudienceWhere },
    },
    select: {
      id: true,
      displayName: true,
      name: true,
      image: true,
      createdAt: true,
      charactersCreated: {
        where: publicCharacterAudienceWhere,
        select: {
          stats: {
            select: {
              likesCount: true,
              chatsCount: true,
            },
          },
        },
      },
      _count: {
        select: {
          followers: {
            where: {
              follower: {
                is: activeCustomerUserWhere,
              },
            },
          },
        },
      },
    },
  });
  return creators
    .map((creator) => {
      const totals = creator.charactersCreated.reduce(
        (sum, character) => ({
          likes: sum.likes + (character.stats?.likesCount ?? 0),
          chats: sum.chats + (character.stats?.chatsCount ?? 0),
        }),
        { likes: 0, chats: 0 },
      );
      return {
        id: creator.id,
        displayName: creator.displayName ?? creator.name ?? "Dreamer",
        image: creator.image,
        characters: creator.charactersCreated.length,
        followers: creator._count.followers,
        likes: totals.likes,
        chats: totals.chats,
        createdAt: creator.createdAt,
      };
    })
    .sort((left, right) =>
      (right.likes + right.chats) - (left.likes + left.chats) ||
      right.characters - left.characters ||
      right.createdAt.getTime() - left.createdAt.getTime()
    )
    .slice(0, limit)
    .map((creator): CommunityDreamerRow => ({
      id: creator.id,
      displayName: creator.displayName,
      image: creator.image,
      characters: creator.characters,
      followers: creator.followers,
      likes: creator.likes,
      chats: creator.chats,
    }));
}

export async function followUser(request: Request, targetId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  if (targetId === user.id) throw Errors.badRequest("Cannot follow yourself");
  const target = await prisma.user.findFirst({
    where: {
      id: targetId,
      ...activeCustomerUserWhere,
      charactersCreated: { some: publicCharacterAudienceWhere },
    },
  });
  if (!target) throw Errors.notFound("User not found");
  await prisma.follow.upsert({
    where: { followerId_followeeId: { followerId: user.id, followeeId: targetId } },
    update: {},
    create: { followerId: user.id, followeeId: targetId },
  });
  return ok({
    following: true,
    followers: await activeFollowerCount(targetId),
  });
}

export async function unfollowUser(request: Request, targetId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.follow.deleteMany({
    where: { followerId: user.id, followeeId: targetId },
  });
  return ok({
    following: false,
    followers: await activeFollowerCount(targetId),
  });
}

function activeFollowerCount(targetId: string) {
  return prisma.follow.count({
    where: {
      followeeId: targetId,
      follower: { is: activeCustomerUserWhere },
    },
  });
}

// SPEC: public creator profile — displayName + totals + their public/approved characters.
// INTENT: gives Community/Feed a place to lead to (§G); read-only, age-gated, no private data.
export async function creatorProfile(request: Request, creatorId: string) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const creator = await prisma.user.findFirst({
    where: {
      id: creatorId,
      ...activeCustomerUserWhere,
      charactersCreated: { some: publicCharacterAudienceWhere },
    },
    select: { id: true, displayName: true, name: true, image: true, createdAt: true },
  });
  if (!creator) throw Errors.notFound("Creator not found");
  const publicCreatorCharacterWhere: Prisma.CharacterWhereInput = {
    AND: [
      publicCharacterAudienceWhere,
      { creatorId },
    ],
  };
  const [characters, characterCount, characterTotals, followers, following] = await Promise.all([
    prisma.character.findMany({
      where: publicCreatorCharacterWhere,
      include: characterInclude(ctx.userId),
      orderBy: [{ stats: { likesCount: "desc" } }, { createdAt: "desc" }],
      take: 24,
    }),
    prisma.character.count({ where: publicCreatorCharacterWhere }),
    prisma.characterStats.aggregate({
      where: { character: { is: publicCreatorCharacterWhere } },
      _sum: { likesCount: true, chatsCount: true },
    }),
    prisma.follow.count({
      where: {
        followeeId: creatorId,
        follower: {
          is: {
            dataClass: "customer",
            status: "active",
            deletedAt: null,
          },
        },
      },
    }),
    ctx.userId
      ? prisma.follow.findFirst({
          where: { followerId: ctx.userId, followeeId: creatorId },
          select: { followerId: true },
        })
      : null,
  ]);
  const totalLikes = characterTotals._sum.likesCount ?? 0;
  const totalChats = characterTotals._sum.chatsCount ?? 0;
  return ok({
    creator: {
      id: creator.id,
      displayName: creator.displayName ?? creator.name ?? "Dreamer",
      image: creator.image,
      createdAt: creator.createdAt,
      isFollowing: Boolean(following),
      isSelf: ctx.userId === creator.id,
      stats: {
        characters: characterCount,
        followers,
        likes: formatCount(totalLikes),
        chats: formatCount(totalChats),
        likesCount: totalLikes,
        chatsCount: totalChats,
      },
    },
    characters: characters.map((character) => characterDTO(character, ctx.userId)),
  });
}
