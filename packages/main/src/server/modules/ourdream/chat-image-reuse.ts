import type { Prisma } from "@prisma/client";
import type { ChatImageRequestedPayload } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { igrep, type IgrepCandidate } from "@/server/lib/igrep";

const REUSABLE_CHAT_PURPOSE = "character_chat";
const REUSABLE_STATUSES = ["approved", "published"] as const;

const reusableAssetInclude = {
  sourceJob: { select: { prompt: true, orientation: true, profileId: true } },
  productionItems: {
    where: {
      status: { in: [...REUSABLE_STATUSES] },
      batch: { purpose: REUSABLE_CHAT_PURPOSE },
    },
    include: {
      batch: {
        select: {
          id: true,
          title: true,
          purpose: true,
          targetType: true,
          targetId: true,
          brief: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 3,
  },
} satisfies Prisma.MediaAssetInclude;

type ReusableChatImageAsset = Prisma.MediaAssetGetPayload<{ include: typeof reusableAssetInclude }>;

export type ReusableChatImageMatch = {
  asset: ReusableChatImageAsset;
  score: number;
  matchedFields: string[];
  tags: string[];
  description: string | null;
};

export async function findReusableChatImage(
  payload: ChatImageRequestedPayload,
): Promise<ReusableChatImageMatch | null> {
  const query = payload.promptHint?.trim() || payload.conversationContext?.trim() || "";
  if (!query.trim()) return null;

  const assets = await prisma.mediaAsset.findMany({
    where: {
      type: "image",
      deletedAt: null,
      safetyStatus: { in: ["passed", "unknown"] },
      productionItems: {
        some: {
          status: { in: [...REUSABLE_STATUSES] },
          batch: {
            purpose: REUSABLE_CHAT_PURPOSE,
            targetType: "character",
            targetId: payload.characterId,
          },
        },
      },
    },
    include: reusableAssetInclude,
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const candidates: Array<IgrepCandidate<ReusableChatImageMatch>> = assets.map((asset) => {
    const tags = assetTags(asset);
    const description = assetDescription(asset);
    return {
      item: {
        asset,
        score: 0,
        matchedFields: [],
        tags,
        description,
      },
      fields: [
        { name: "tags", text: tags.join(" "), weight: 4 },
        { name: "description", text: description ?? "", weight: 3 },
        { name: "operatorBrief", text: asset.productionItems.map((item) => item.batch.brief ?? "").join(" "), weight: 2 },
        { name: "sourcePrompt", text: asset.sourceJob?.prompt ?? asset.prompt ?? "", weight: 1 },
        { name: "batch", text: asset.productionItems.map((item) => item.batch.title).join(" "), weight: 1 },
      ],
    };
  });

  const [match] = igrep(query, candidates, { minScore: 2.8, limit: 1 });
  if (!match) return null;

  return {
    ...match.item,
    score: match.score,
    matchedFields: match.matchedFields,
  };
}

export function isReusablePlatformAssetWhere(userId: string): Prisma.MediaAssetWhereInput {
  return {
    OR: [
      { ownerId: userId },
      {
        productionItems: {
          some: {
            status: { in: [...REUSABLE_STATUSES] },
            batch: { purpose: REUSABLE_CHAT_PURPOSE },
          },
        },
      },
    ],
  };
}

function assetTags(asset: { metadata: Prisma.JsonValue; productionItems: Array<{ tags: Prisma.JsonValue }> }) {
  const tags = new Set<string>();
  for (const item of asset.productionItems) {
    for (const tag of jsonStringArray(item.tags)) tags.add(tag);
  }
  for (const tag of jsonStringArray(platformAssetMetadata(asset).tags)) tags.add(tag);
  return [...tags];
}

function assetDescription(asset: { metadata: Prisma.JsonValue; prompt: string | null }) {
  const platform = platformAssetMetadata(asset);
  return stringValue(platform.description) ?? stringValue(platform.reviewNote) ?? asset.prompt;
}

function platformAssetMetadata(asset: { metadata: Prisma.JsonValue }) {
  return jsonRecord(jsonRecord(asset.metadata).platformAsset);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
