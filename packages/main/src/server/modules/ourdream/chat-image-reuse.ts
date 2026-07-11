import type { Prisma } from "@prisma/client";
import type { ChatImageRequestedPayload } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { igrep, type IgrepCandidate } from "@/server/lib/igrep";
import { imageOrientationForDimensions } from "@/server/modules/ourdream/generation-dimensions";

const REUSABLE_CHAT_PURPOSE = "character_chat";
const REUSABLE_STATUSES = ["approved", "published"] as const;
const REUSE_PAGE_SIZE = 100;
const REUSE_MIN_SCORE = 2.8;
const REUSE_MIN_MATCHED_TOKENS = 2;
const REUSE_MIN_QUERY_COVERAGE = 0.4;

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
  // An edit request is about transforming the user's last image. A generic
  // pre-generated scene may be textually similar, but it cannot preserve that
  // source image, so it must always continue through img2img generation.
  if (payload.controls.sourceImageAssetId) return null;

  const queries = reusableImageQueries(payload);
  if (queries.length === 0) return null;

  let cursor: string | undefined;
  let best: ReusableChatImageMatch | null = null;
  do {
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
      orderBy: { id: "asc" },
      take: REUSE_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const candidates: Array<IgrepCandidate<ReusableChatImageMatch>> = assets
      .filter((asset) => isReusableAssetEligible(asset, payload.controls.orientation))
      .map((asset) => {
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
            {
              name: "operatorBrief",
              text: asset.productionItems.map((item) => item.batch.brief ?? "").join(" "),
              weight: 2,
            },
            { name: "sourcePrompt", text: asset.sourceJob?.prompt ?? asset.prompt ?? "", weight: 1 },
            { name: "batch", text: asset.productionItems.map((item) => item.batch.title).join(" "), weight: 1 },
          ],
        };
      });

    for (const query of queries) {
      const match = igrep(query, candidates, { minScore: REUSE_MIN_SCORE }).find(
        (candidate) =>
          candidate.matchedTokenCount >= REUSE_MIN_MATCHED_TOKENS &&
          candidate.queryCoverage >= REUSE_MIN_QUERY_COVERAGE,
      );
      if (match && (!best || match.score > best.score)) {
        best = {
          ...match.item,
          score: match.score,
          matchedFields: match.matchedFields,
        };
      }
    }

    cursor = assets.at(-1)?.id;
    if (assets.length < REUSE_PAGE_SIZE) break;
  } while (cursor);

  return best;
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

function reusableImageQueries(payload: ChatImageRequestedPayload): string[] {
  const prompt = payload.promptHint?.trim();
  const contextLines = payload.conversationContext?.split("\n") ?? [];
  const lastUserLine = [...contextLines]
    .reverse()
    .find((line) => /^user\s*:/i.test(line))
    ?.replace(/^user\s*:\s*/i, "")
    .trim();
  return [...new Set([prompt, lastUserLine].filter((value): value is string => Boolean(value)))];
}

function isReusableAssetEligible(asset: ReusableChatImageAsset, requestedOrientation: string) {
  // Asset review state and production history may diverge (for example, a
  // published production item can later have its asset rejected or archived).
  // Both sides must explicitly remain reusable.
  const platformStatus = stringValue(platformAssetMetadata(asset).status);
  if (!platformStatus || !REUSABLE_STATUSES.some((status) => status === platformStatus)) {
    return false;
  }

  const assetOrientation =
    asset.sourceJob?.orientation ?? imageOrientationForDimensions(asset.width, asset.height);
  return !assetOrientation || !requestedOrientation || assetOrientation === requestedOrientation;
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
