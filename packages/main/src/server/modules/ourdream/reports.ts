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

// SPEC: underage 举报会立即下架目标内容。这是既定的合规动作，但它是破坏性的、
// 面向公开目录的，所以执行权限必须与「提交举报」分开：举报渠道对匿名开放（未登录
// 用户也要能举报），下架只授予可追溯的已认证举报者。
// INTENT: 不收紧 targetType 的宽容度 —— 未知 surface 仍要能被举报并进人工队列。
const AUTO_TAKEDOWN_DECISION = "auto_takedown_underage";
const AUTO_TAKEDOWN_REVIEWER = "system:underage_auto_takedown";
// INVARIANT: 单个举报者在窗口内能触发的自动下架次数有上限，否则一个免费账号就能
// 清空整个公开目录。超限的举报仍以 priority 1 落库并进 Case，只是不再自行下架。
const AUTO_TAKEDOWN_WINDOW_MS = 60 * 60 * 1000;
const AUTO_TAKEDOWN_MAX_PER_REPORTER = 3;

type AutoTakedownAuthority =
  | { granted: true }
  | { granted: false; withheldBecause: "unauthenticated" | "age_gate_required" | "reporter_rate_limited" };

/**
 * 谁可以让一条举报直接下架内容。匿名请求永远不能 —— 那是一个无需凭据的破坏性
 * 操作，等于把公开目录的删除键放到互联网上。
 */
async function autoTakedownAuthority(ctx: {
  userId?: string;
  ageGateAccepted: boolean;
}): Promise<AutoTakedownAuthority> {
  if (!ctx.userId) return { granted: false, withheldBecause: "unauthenticated" };
  if (!ctx.ageGateAccepted) {
    return { granted: false, withheldBecause: "age_gate_required" };
  }
  const recent = await prisma.moderationReview.count({
    where: {
      decision: AUTO_TAKEDOWN_DECISION,
      createdAt: { gte: new Date(Date.now() - AUTO_TAKEDOWN_WINDOW_MS) },
      report: { is: { reporterId: ctx.userId } },
    },
  });
  if (recent >= AUTO_TAKEDOWN_MAX_PER_REPORTER) {
    return { granted: false, withheldBecause: "reporter_rate_limited" };
  }
  return { granted: true };
}

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

  // INTENT: 无法解析目标、或举报者无下架权限时，仍保留优先级 1 的举报与 Case，由人工接管。
  if (underage) {
    const authority = await autoTakedownAuthority(ctx);
    if (authority.granted) {
      try {
        await applyModerationAction(targetType, targetId, body.category, report.id);
      } catch (error) {
        logger.error(
          { error, targetType, targetId },
          "underage auto-takedown could not resolve target; escalating via triage",
        );
      }
    } else {
      logger.warn(
        {
          targetType,
          targetId,
          reportId: report.id,
          reporterId: ctx.userId ?? null,
          withheldBecause: authority.withheldBecause,
        },
        "underage auto-takedown withheld; report escalated for human review",
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
  policyCode: string | undefined,
  reportId: string,
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
    // INVARIANT: 自动下架必须留下一条可申诉的裁决。申诉链路要求存在关联该举报的
    // ModerationReview，缺了它内容所有者会被下架且申诉无门（原实现只写
    // ContentReport + ModerationEvent + Case，所以申诉一律 400）。
    // 它同时是 autoTakedownAuthority 的速率计数依据，只在动作真正生效时写入。
    await tx.moderationReview.create({
      data: {
        reportId,
        reviewerId: AUTO_TAKEDOWN_REVIEWER,
        decision: AUTO_TAKEDOWN_DECISION,
        policyCode,
        notes: `Automatic takedown of ${targetType}:${targetId} on an underage report.`,
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
