import { randomUUID } from "node:crypto";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { z } from "zod";
import { dispatchPendingChatEvents, recordMainToChatEvent } from "@/processes/chat-outbox";
import { getAuthCtx } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { logger } from "@/server/lib/logger";
import { jsonBody } from "@/server/lib/request-json";
import { ensureReviewCaseForReport } from "@/server/modules/admin-v2/cases/service";
import { lockMediaAssetAuthority } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { feedCharacterId, feedCollectionId } from "./feed-item-id";
import { trackEvent } from "./product-events";

const reportSchema = z.object({
  targetType: z.string().trim().min(1).max(80),
  targetId: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(),
});

export async function submitReport(
  request: Request,
  preset?: { targetType: string; targetId: string },
) {
  const ctx = await getAuthCtx(request);
  const body = reportSchema
    .partial({ targetType: true, targetId: true })
    .parse(await jsonBody(request));
  const targetType = preset?.targetType ?? body.targetType;
  const targetId = preset?.targetId ?? body.targetId;
  if (!targetType || !targetId || !body.category) {
    throw Errors.badRequest("targetType, targetId, and category are required");
  }
  const underage = body.category.includes("underage");
  const priority = underage ? 1 : 3;
  const report = await prisma.$transaction(async (tx) => {
    const created = await tx.contentReport.create({
      data: {
        reporterId: ctx.userId,
        targetType,
        targetId,
        category: body.category,
        description: body.description,
        priority,
      },
    });
    await tx.moderationEvent.create({
      data: {
        targetType,
        targetId,
        layer: "community_report",
        status: "flagged",
        policyCode: body.category,
        confidence: 1,
        details: { reportId: created.id },
      },
    });
    await ensureReviewCaseForReport(tx, created);
    return created;
  });

  // INTENT: 无法解析目标时仍保留优先级 1 的举报与 Case，由人工接管。
  if (underage) {
    try {
      await applyModerationAction(targetType, targetId, body.category);
    } catch (error) {
      logger.error(
        { error, targetType, targetId },
        "underage auto-takedown could not resolve target; escalating via triage",
      );
    }
  }
  await trackEvent(
    "content_reported",
    { targetType, targetId, category: body.category },
    ctx,
  );
  return ok({ report });
}

async function applyModerationAction(
  targetType: string,
  targetId: string,
  policyCode?: string,
) {
  const removedCharacterId = await prisma.$transaction(async (tx) => {
    let characterId: string | null = null;
    if (targetType === "character") {
      const removed = await tx.character.updateMany({
        where: { id: targetId },
        data: { status: "removed" },
      });
      if (removed.count > 0) characterId = targetId;
    } else if (targetType === "media") {
      await lockMediaAssetAuthority(tx, targetId);
      await tx.mediaAsset.updateMany({
        where: { id: targetId },
        data: { safetyStatus: "blocked" },
      });
    } else if (targetType === "feed_item") {
      const feedTargetCharacterId = feedCharacterId(targetId);
      const collectionId = feedCollectionId(targetId);
      if (feedTargetCharacterId) {
        const removed = await tx.character.updateMany({
          where: { id: feedTargetCharacterId },
          data: { status: "removed" },
        });
        if (removed.count > 0) {
          characterId = feedTargetCharacterId;
          await recordMainToChatEvent(
            {
              eventId: `character_removed_${feedTargetCharacterId}_${randomUUID()}`,
              eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
              aggregateType: "character",
              aggregateId: feedTargetCharacterId,
              payload: { characterId: feedTargetCharacterId },
            },
            tx,
          );
        }
      } else if (collectionId) {
        await tx.mediaCollection.updateMany({
          where: { id: collectionId },
          data: { visibility: "private" },
        });
      } else {
        throw Errors.badRequest(
          `Cannot resolve feed_item moderation target: ${targetId}`,
        );
      }
    } else {
      throw Errors.badRequest(
        `Unsupported moderation target type: ${targetType}`,
      );
    }
    await tx.moderationEvent.create({
      data: {
        targetType,
        targetId,
        layer: "human_review",
        status: "blocked",
        policyCode,
        details: {},
      },
    });
    if (characterId && targetType === "character") {
      await recordMainToChatEvent(
        {
          eventId: `character_removed_${characterId}_${randomUUID()}`,
          eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
          aggregateType: "character",
          aggregateId: characterId,
          payload: { characterId },
        },
        tx,
      );
    }
    return characterId;
  });
  if (!removedCharacterId) return;
  try {
    await dispatchPendingChatEvents();
  } catch (error) {
    logger.error(
      { error, characterId: removedCharacterId },
      "failed to dispatch durable Chat character removal",
    );
  }
}
