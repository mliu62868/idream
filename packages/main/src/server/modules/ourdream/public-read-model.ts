// SPEC: 一个 Character / MediaCollection / MediaAsset 对外（v1 公开面）长什么样。
// 三件事在这里是同一个判断的三个面，必须一起改：
//   - `*Include`  决定从库里读哪些关联；
//   - `*DTO`      决定往线上发哪些字段；
//   - `mediaViewUrl` / `mediaFileExtension` 决定媒体地址与文件名怎么拼。
//
// INTENT: 这三者分开住就会漂移成两类线上事故 —— include 了但 DTO 没发（白读一次库、
// 前台拿不到字段），或者 DTO 发了但 include 没读（`undefined` 直接进 wire）。
// 它们此前散在 service.ts 的三个区段里，discovery.ts 反向 import service 就是为了拿
// 这一组符号；把它们收成一个模块，service 与 discovery 才能同向依赖同一份读模型，
// 而不是互相 import。
//
// INVARIANT: 本模块是**纯的** —— 不 import prisma client、不碰 auth、不返回 Response。
// 输入是一行已经读出来的 row，输出是 wire 形状。受众过滤（谁能被看见）不在这里，
// 在 `./public-content-audience`；两者的分工是「能不能看见」与「看见了长什么样」。
//
// INVARIANT: 这里的字段名与取值就是 v1 的对外契约，改动等于改 API。
import { Prisma } from "@prisma/client";
// 直接引原处而不是 ./public-content-audience 的再导出：那个模块要连 prisma client
// 才能判定 actor，读模型不需要，也不该因为一个 where 常量被拖进运行时依赖。
import { nonSyntheticMediaAssetWhere } from "@/server/lib/media-asset-authority";

const missingCharacterImage = "/images/ourdream/character-placeholder.svg";

export function characterInclude(userId?: string) {
  return {
    imageAsset: true,
    stats: true,
    tags: { include: { tag: true } },
    visualProfiles: {
      where: { status: "active" },
      orderBy: { version: "desc" },
      take: 1,
      // 参考图数量对外走 active Reference Set（唯一权威），不读 profile 上的影子列。
      include: {
        referenceSetRevisions: {
          where: { status: "active" },
          orderBy: { revision: "desc" },
          take: 1,
          select: { references: { select: { mediaAssetId: true } } },
        },
      },
    },
    creator: { select: { id: true, displayName: true, name: true } },
    serving: { include: { currentRelease: true } },
    likes: userId ? { where: { userId }, select: { userId: true } } : false,
  } satisfies Prisma.CharacterInclude;
}

export type CharacterWithPublicRelations = Prisma.CharacterGetPayload<{
  include: ReturnType<typeof characterInclude>;
}>;

export function characterDTO(character: CharacterWithPublicRelations, viewerId?: string | null) {
  const visualProfile = character.visualProfiles[0] ?? null;
  const image = character.imageAsset?.url ?? missingCharacterImage;
  const official = character.source === "official";
  const creatorName = official
    ? "Official"
    : (character.creator?.displayName ?? character.creator?.name ?? null);
  return {
    id: character.id,
    name: character.name,
    title: character.name,
    age: String(character.age),
    description: character.description,
    visibility: character.visibility,
    status: character.status,
    source: official ? "official" : "user",
    creatorType: official ? "official" : "user",
    style: character.style,
    gender: character.gender,
    relationship: character.relationship,
    creatorId: official ? null : character.creatorId,
    creator: creatorName ?? "Creator",
    creatorName,
    canEditIdentity: Boolean(!official && viewerId && character.creatorId === viewerId),
    image,
    imageAssetId: character.imageAsset?.id ?? null,
    thumbnailUrl: character.imageAsset?.thumbnailUrl ?? image,
    hasImage: Boolean(character.imageAsset?.url),
    likes: formatCount(character.stats?.likesCount ?? 0),
    chats: formatCount(character.stats?.chatsCount ?? 0),
    likesCount: character.stats?.likesCount ?? 0,
    chatsCount: character.stats?.chatsCount ?? 0,
    views: character.stats?.viewsCount ?? 0,
    vivid: character.vivid,
    liked: Array.isArray(character.likes) ? character.likes.length > 0 : false,
    visualProfile: visualProfile
      ? visualProfileDTO(
          visualProfile,
          visualProfile.referenceSetRevisions[0]?.references
            .map((reference) => reference.mediaAssetId) ?? [],
        )
      : null,
    tags: character.tags.map(({ tag }) => tag),
    createdAt: character.createdAt,
  };
}

// INTENT: 只声明这份投影真正读的六个字段，而不是 import service.ts 里那个
// `GenerationVisualProfile`（那是生成侧的类型，identityPrompt / adapterRefs 之类
// 永远不该出现在公开面上）。结构化类型让两侧继续互通，方向却只剩一条。
type VisualProfileProjectionSource = {
  id: string;
  version: number;
  status: string;
  style: string;
  anchorAssetIds: Prisma.JsonValue;
  defaultSeed: string | null;
};

// referenceAssetIds 由调用方从 active Reference Set 取（唯一权威）；字段名对外不变，
// 前台 GeneratorWorkspace 用它显示参考图数量。
export function visualProfileDTO(
  profile: VisualProfileProjectionSource,
  referenceAssetIds: readonly string[],
) {
  return {
    id: profile.id,
    version: profile.version,
    status: profile.status,
    style: profile.style,
    anchorAssetIds: profile.anchorAssetIds,
    referenceAssetIds: [...referenceAssetIds],
    defaultSeed: profile.defaultSeed,
  };
}

export function mediaCollectionInclude(publicOnly = false) {
  const mediaAssetWhere: Prisma.MediaAssetWhereInput = {
    deletedAt: null,
    safetyStatus: "passed",
    ...(publicOnly
      ? {
          ...nonSyntheticMediaAssetWhere,
          visibility: { in: ["public_pack", "unlisted"] },
        }
      : {}),
  };
  return {
    items: {
      where: { mediaAsset: { is: mediaAssetWhere } },
      orderBy: { sortOrder: "asc" as const },
      take: 4,
      include: {
        mediaAsset: {
          select: {
            id: true,
            thumbnailUrl: true,
            url: true,
            storageKey: true,
            contentType: true,
            type: true,
            deletedAt: true,
            safetyStatus: true,
            visibility: true,
          },
        },
      },
    },
    owner: { select: { id: true, displayName: true, name: true } },
    _count: {
      select: {
        items: { where: { mediaAsset: { is: mediaAssetWhere } } },
      },
    },
  } satisfies Prisma.MediaCollectionInclude;
}

export type MediaCollectionWithRelations = Prisma.MediaCollectionGetPayload<{
  include: ReturnType<typeof mediaCollectionInclude>;
}>;

export function mediaCollectionDTO(collection: MediaCollectionWithRelations) {
  const official = collection.source === "official";
  return {
    id: collection.id,
    name: collection.name,
    visibility: collection.visibility,
    source: official ? "official" : "user",
    ownerType: official ? "official" : "user",
    ownerId: official ? null : collection.ownerId,
    ownerName: official
      ? "Official collection"
      : (collection.owner.displayName ?? collection.owner.name),
    itemCount: collection._count.items,
    previews: collection.items
      .map(({ mediaAsset }) =>
        mediaAsset.storageKey ? mediaViewUrl(mediaAsset) : (mediaAsset.thumbnailUrl ?? mediaAsset.url),
      )
      .filter((url): url is string => Boolean(url)),
    createdAt: collection.createdAt.toISOString(),
  };
}

export function mediaViewUrl(asset: {
  id: string;
  type: string;
  contentType?: string | null;
  storageKey?: string | null;
  url: string;
}) {
  const extension = mediaFileExtension(asset) || (asset.type === "image" ? ".png" : "");
  return `/user-content/${mediaRouteToken(asset.id)}/content${extension}`;
}

function mediaRouteToken(id: string) {
  return Buffer.from(id, "utf8").toString("base64url");
}

// INTENT: 与 mediaViewUrl 同住。view URL 的后缀和下载文件名的后缀必须是同一个答案，
// 拆成两份就会出现「浏览器按 .png 渲染、下载下来叫 .webp」这种货不对板。
export function mediaFileExtension(asset: {
  contentType?: string | null;
  storageKey?: string | null;
  url: string;
}) {
  const byContentType: Record<string, string> = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "audio/flac": ".flac",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  if (asset.contentType && byContentType[asset.contentType]) {
    return byContentType[asset.contentType];
  }

  const source = asset.storageKey ?? asset.url;
  const match = /\.(flac|gif|jpe?g|mp3|mp4|ogg|png|wav|webm|webp)(?:[?#]|$)/i.exec(source);
  return match ? `.${match[1].toLowerCase().replace("jpeg", "jpg")}` : "";
}

// INTENT: 计数在公开面上是**展示字符串**（"1.2k"），原始数字另发 `*Count` 字段。
// 属于 DTO 契约的一部分：feed / community / 角色卡三处必须格式化成同一种写法。
export function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
