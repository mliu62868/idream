import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  MAIN_TO_CHAT_EVENTS,
  characterModerationRemovalEventId,
  characterModerationRemovedPayloadSchema,
  characterModerationRestorationEventId,
  characterModerationRestorationPayloadSchema,
} from "@idream/shared/contracts";
import { recordMainToChatEvent } from "@/processes/chat-outbox";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  lockCharacterGenerationAuthority,
  lockMediaAssetAuthority,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";

/**
 * SPEC: 一条 "actioned" 裁决对目标做了什么，以及一条 overturned 申诉如何精确撤销它。
 * INTENT: 撤销必须回到**这条裁决动手前**的状态，不是回到某个约定的「正常值」。所以每次动手
 *         都落一份 before/after 快照，并把「目标当前归谁管」记在 effect owner 上；申诉撤销时
 *         先核对 owner 仍是自己，再按快照回滚。没有这两样，两条先后裁决叠加后撤销任意一条都会
 *         把目标带到一个谁都没批准过的状态。
 */

const mediaModerationStateSchema = z
  .object({
    safetyStatus: z.string().min(1),
    visibility: z.string().min(1),
  })
  .strict();

const characterModerationActionSnapshotSchema = z
  .object({
    version: z.literal(1),
    targetType: z.literal("character"),
    moderationDecisionId: z.string().min(1),
    previousModerationDecisionId: z.string().min(1).nullable(),
    before: z.object({ status: z.string().min(1) }).strict(),
    after: z.object({ status: z.literal("removed") }).strict(),
  })
  .strict();

const moderationEffectOwnerDetailsSchema = z
  .object({
    version: z.literal(1),
    moderationDecisionId: z.string().min(1).nullable(),
  })
  .strict();

const mediaModerationActionSnapshotSchema = z
  .object({
    version: z.literal(1),
    moderationDecisionId: z.string().min(1),
    previousModerationDecisionId: z.string().min(1).nullable(),
    before: mediaModerationStateSchema,
    after: mediaModerationStateSchema,
  })
  .strict();

type ModerationDatabase = Prisma.TransactionClient | typeof prisma;

export type ModerationTargetRestoration = {
  targetRestored: boolean;
  restoredTargetType?: string;
  restoredTargetId?: string;
  restoreReason?: string;
};

function mediaModerationActionSnapshotId(moderationDecisionId: string) {
  return `moderation_action_snapshot_${moderationDecisionId}`;
}

function moderationEffectOwnerId(targetType: string, targetId: string) {
  return `moderation_effect_owner:${targetType}:${targetId}`;
}

async function currentModerationEffectOwner(
  db: ModerationDatabase,
  targetType: string,
  targetId: string,
) {
  const owner = await db.moderationEvent.findUnique({
    where: { id: moderationEffectOwnerId(targetType, targetId) },
  });
  if (!owner) return null;
  if (
    owner.targetType !== targetType ||
    owner.targetId !== targetId ||
    owner.layer !== "admin_decision_effect_owner"
  ) {
    throw Errors.conflict("Moderation effect owner authority is inconsistent");
  }
  const details = moderationEffectOwnerDetailsSchema.safeParse(owner.details);
  if (!details.success) {
    throw Errors.conflict("Moderation effect owner authority is invalid");
  }
  if (owner.status === "cleared") return null;
  if (owner.status !== "active" || !details.data.moderationDecisionId) {
    throw Errors.conflict("Moderation effect owner authority is invalid");
  }
  return details.data.moderationDecisionId;
}

async function setModerationEffectOwner(
  db: ModerationDatabase,
  input: {
    targetType: string;
    targetId: string;
    moderationDecisionId: string | null;
  },
) {
  const details = moderationEffectOwnerDetailsSchema.parse({
    version: 1,
    moderationDecisionId: input.moderationDecisionId,
  });
  await db.moderationEvent.upsert({
    where: { id: moderationEffectOwnerId(input.targetType, input.targetId) },
    create: {
      id: moderationEffectOwnerId(input.targetType, input.targetId),
      targetType: input.targetType,
      targetId: input.targetId,
      layer: "admin_decision_effect_owner",
      status: input.moderationDecisionId ? "active" : "cleared",
      policyCode: "moderation_effect_owner_v1",
      details: toInputJson(details),
    },
    update: {
      status: input.moderationDecisionId ? "active" : "cleared",
      details: toInputJson(details),
    },
  });
}

export async function applyModerationAction(
  targetType: string,
  targetId: string,
  moderationDecisionId: string,
  db: ModerationDatabase = prisma,
) {
  // INVARIANT: "actioned" must actually take content down. Feed items wrap a
  // character, so resolve and remove it; unknown target types throw so the
  // decision transaction rolls back instead of marking a report falsely handled.
  if (targetType === "character") {
    await applyCharacterModerationAction(db, targetId, moderationDecisionId);
    return;
  }
  if (targetType === "media") {
    await lockMediaAssetAuthority(db, targetId);
    const asset = await db.mediaAsset.findFirst({
      where: { id: targetId, deletedAt: null },
      select: { safetyStatus: true, visibility: true },
    });
    if (!asset) throw Errors.conflict("Moderation media target no longer exists");
    const previousModerationDecisionId = await currentModerationEffectOwner(
      db,
      "media",
      targetId,
    );
    const snapshot = mediaModerationActionSnapshotSchema.parse({
      version: 1,
      moderationDecisionId,
      previousModerationDecisionId,
      before: {
        safetyStatus: asset.safetyStatus,
        visibility: asset.visibility,
      },
      after: { safetyStatus: "blocked", visibility: "private" },
    });
    await db.moderationEvent.create({
      data: {
        id: mediaModerationActionSnapshotId(moderationDecisionId),
        targetType: "media",
        targetId,
        layer: "admin_decision_effect",
        status: "actioned",
        policyCode: "moderation_action_snapshot_v1",
        details: toInputJson(snapshot),
      },
    });
    const updated = await db.mediaAsset.updateMany({
      where: {
        id: targetId,
        deletedAt: null,
        safetyStatus: snapshot.before.safetyStatus,
        visibility: snapshot.before.visibility,
      },
      data: { safetyStatus: "blocked", visibility: "private" },
    });
    if (updated.count !== 1) {
      throw Errors.conflict("Moderation media target changed before action");
    }
    await setModerationEffectOwner(db, {
      targetType: "media",
      targetId,
      moderationDecisionId,
    });
    return;
  }
  if (targetType === "feed_item") {
    const characterId = feedItemCharacterId(targetId);
    if (!characterId) {
      throw Errors.badRequest(`Cannot resolve feed_item moderation target: ${targetId}`);
    }
    await applyCharacterModerationAction(
      db,
      characterId,
      moderationDecisionId,
    );
    return;
  }
  throw Errors.badRequest(`Unsupported moderation target type: ${targetType}`);
}

async function applyCharacterModerationAction(
  db: ModerationDatabase,
  characterId: string,
  moderationDecisionId: string,
) {
  await lockCharacterGenerationAuthority(db, characterId);
  const character = await db.character.findFirst({
    where: { id: characterId, deletedAt: null },
    select: { status: true },
  });
  if (!character) {
    throw Errors.conflict("Moderation Character target no longer exists");
  }
  const previousModerationDecisionId = await currentModerationEffectOwner(
    db,
    "character",
    characterId,
  );
  const snapshot = characterModerationActionSnapshotSchema.parse({
    version: 1,
    targetType: "character",
    moderationDecisionId,
    previousModerationDecisionId,
    before: { status: character.status },
    after: { status: "removed" },
  });
  await db.moderationEvent.create({
    data: {
      id: mediaModerationActionSnapshotId(moderationDecisionId),
      targetType: "character",
      targetId: characterId,
      layer: "admin_decision_effect",
      status: "actioned",
      policyCode: "moderation_action_snapshot_v1",
      details: toInputJson(snapshot),
    },
  });
  const removed = await db.character.updateMany({
    where: {
      id: characterId,
      deletedAt: null,
      status: snapshot.before.status,
    },
    data: { status: snapshot.after.status },
  });
  if (removed.count !== 1) {
    throw Errors.conflict("Moderation Character target changed before action");
  }
  await setModerationEffectOwner(db, {
    targetType: "character",
    targetId: characterId,
    moderationDecisionId,
  });
  await recordCharacterRemoved(
    db,
    characterId,
    moderationDecisionId,
    previousModerationDecisionId,
  );
}

async function recordCharacterRemoved(
  db: ModerationDatabase,
  characterId: string,
  moderationDecisionId: string,
  previousModerationDecisionId: string | null,
) {
  const payload = characterModerationRemovedPayloadSchema.parse({
    version: 1,
    binding: "moderation_decision",
    characterId,
    moderationDecisionId,
    previousRemovalEventId: previousModerationDecisionId
      ? characterModerationRemovalEventId(previousModerationDecisionId)
      : null,
  });
  await recordMainToChatEvent({
    eventId: characterModerationRemovalEventId(moderationDecisionId),
    eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
    aggregateType: "character",
    aggregateId: characterId,
    payload,
  }, db);
}

async function restoreAppealTarget(
  targetType: string,
  targetId: string,
  db: ModerationDatabase = prisma,
  moderationDecisionId?: string,
): Promise<ModerationTargetRestoration> {
  if (targetType === "character") {
    if (moderationDecisionId) {
      return restoreCharacterModerationAction(
        db,
        targetId,
        moderationDecisionId,
        targetType,
      );
    }
    const result = await db.character.updateMany({
      where: { id: targetId },
      data: { status: "approved" },
    });
    return {
      targetRestored: result.count > 0,
      restoredTargetType: targetType,
      restoredTargetId: targetId,
    };
  }
  if (targetType === "feed_item") {
    const characterId = feedItemCharacterId(targetId);
    if (!characterId) {
      return { targetRestored: false, restoredTargetType: targetType, restoreReason: "unresolvable_feed_item" };
    }
    if (moderationDecisionId) {
      return restoreCharacterModerationAction(
        db,
        characterId,
        moderationDecisionId,
        targetType,
      );
    }
    const result = await db.character.updateMany({
      where: { id: characterId },
      data: { status: "approved" },
    });
    return { targetRestored: result.count > 0, restoredTargetType: targetType, restoredTargetId: characterId };
  }
  if (targetType === "media") {
    await lockMediaAssetAuthority(db, targetId);
    if (moderationDecisionId) {
      const currentOwner = await currentModerationEffectOwner(
        db,
        "media",
        targetId,
      );
      if (currentOwner !== moderationDecisionId) {
        throw Errors.conflict(
          "Another action or owner mutation superseded this Media decision",
        );
      }
      const evidence = await db.moderationEvent.findUnique({
        where: { id: mediaModerationActionSnapshotId(moderationDecisionId) },
      });
      if (
        !evidence ||
        evidence.targetType !== "media" ||
        evidence.targetId !== targetId ||
        evidence.layer !== "admin_decision_effect" ||
        evidence.status !== "actioned"
      ) {
        throw Errors.conflict("Media moderation action snapshot is unavailable");
      }
      const parsed = mediaModerationActionSnapshotSchema.safeParse(
        evidence.details,
      );
      if (
        !parsed.success ||
        parsed.data.moderationDecisionId !== moderationDecisionId
      ) {
        throw Errors.conflict("Media moderation action snapshot is inconsistent");
      }
      const snapshot = parsed.data;
      const result = await db.mediaAsset.updateMany({
        where: {
          id: targetId,
          deletedAt: null,
          safetyStatus: snapshot.after.safetyStatus,
          visibility: snapshot.after.visibility,
        },
        data: {
          safetyStatus: snapshot.before.safetyStatus,
          visibility: snapshot.before.visibility,
        },
      });
      if (result.count !== 1) {
        throw Errors.conflict(
          "Media changed after the moderation action; the appeal was not applied",
        );
      }
      await setModerationEffectOwner(db, {
        targetType: "media",
        targetId,
        moderationDecisionId: snapshot.previousModerationDecisionId,
      });
      return {
        targetRestored: true,
        restoredTargetType: targetType,
        restoredTargetId: targetId,
      };
    }
    const result = await db.mediaAsset.updateMany({
      where: { id: targetId },
      data: { safetyStatus: "passed" },
    });
    return {
      targetRestored: result.count > 0,
      restoredTargetType: targetType,
      restoredTargetId: targetId,
    };
  }
  if (targetType === "user_profile") {
    const result = await db.user.updateMany({
      where: { id: targetId, status: { not: "deleted" } },
      data: { status: "active" },
    });
    return {
      targetRestored: result.count > 0,
      restoredTargetType: targetType,
      restoredTargetId: targetId,
    };
  }
  return { targetRestored: false, restoredTargetType: targetType, restoreReason: "manual_followup_required" };
}

async function restoreCharacterModerationAction(
  db: ModerationDatabase,
  characterId: string,
  moderationDecisionId: string,
  restoredTargetType: "character" | "feed_item",
): Promise<ModerationTargetRestoration> {
  await lockCharacterGenerationAuthority(db, characterId);
  const currentOwner = await currentModerationEffectOwner(
    db,
    "character",
    characterId,
  );
  if (currentOwner !== moderationDecisionId) {
    throw Errors.conflict(
      "Another action or owner mutation superseded this Character decision",
    );
  }
  const evidence = await db.moderationEvent.findUnique({
    where: { id: mediaModerationActionSnapshotId(moderationDecisionId) },
  });
  if (
    !evidence ||
    evidence.targetType !== "character" ||
    evidence.targetId !== characterId ||
    evidence.layer !== "admin_decision_effect" ||
    evidence.status !== "actioned"
  ) {
    throw Errors.conflict("Character moderation action snapshot is unavailable");
  }
  const parsed = characterModerationActionSnapshotSchema.safeParse(
    evidence.details,
  );
  if (
    !parsed.success ||
    parsed.data.moderationDecisionId !== moderationDecisionId
  ) {
    throw Errors.conflict("Character moderation action snapshot is inconsistent");
  }
  const restored = await db.character.updateMany({
    where: {
      id: characterId,
      deletedAt: null,
      status: parsed.data.after.status,
    },
    data: { status: parsed.data.before.status },
  });
  if (restored.count !== 1) {
    throw Errors.conflict(
      "Character changed after the moderation action; the appeal was not applied",
    );
  }
  await setModerationEffectOwner(db, {
    targetType: "character",
    targetId: characterId,
    moderationDecisionId: parsed.data.previousModerationDecisionId,
  });
  return {
    targetRestored: true,
    restoredTargetType,
    restoredTargetId: characterId,
  };
}

export async function restoreCanonicalAppealTarget(
  appeal: {
    id: string;
    targetType: string;
    targetId: string;
    originalDecisionId: string | null;
  },
  db: ModerationDatabase = prisma,
): Promise<ModerationTargetRestoration> {
  const decisionId = appeal.originalDecisionId ??
    (appeal.targetType === "moderation_decision" ? appeal.targetId : null);
  if (!decisionId) {
    return restoreAppealTarget(appeal.targetType, appeal.targetId, db);
  }

  const decision = await db.moderationReview.findUnique({
    where: { id: decisionId },
    select: {
      id: true,
      report: { select: { targetType: true, targetId: true } },
    },
  });
  if (!decision?.report) {
    throw Errors.conflict("Appeal moderation decision is no longer available");
  }
  if (
    appeal.targetType === "moderation_decision" &&
    appeal.targetId !== decision.id
  ) {
    throw Errors.conflict("Appeal does not match its moderation decision");
  }
  if (
    appeal.targetType !== "moderation_decision" &&
    (appeal.targetType !== decision.report.targetType ||
      appeal.targetId !== decision.report.targetId)
  ) {
    throw Errors.conflict("Appeal target does not match its moderation decision");
  }
  const restored = await restoreAppealTarget(
    decision.report.targetType,
    decision.report.targetId,
    db,
    decision.id,
  );
  if (
    restored.targetRestored &&
    (decision.report.targetType === "character" ||
      decision.report.targetType === "feed_item") &&
    restored.restoredTargetId
  ) {
    await recordCharacterModerationRestoration(db, {
      appealId: appeal.id,
      characterId: restored.restoredTargetId,
      moderationDecisionId: decision.id,
    });
  }
  return restored;
}

async function recordCharacterModerationRestoration(
  db: ModerationDatabase,
  input: {
    appealId: string;
    characterId: string;
    moderationDecisionId: string;
  },
) {
  const removalEventId = characterModerationRemovalEventId(
    input.moderationDecisionId,
  );
  const removal = await db.mainOutboxEvent.findUnique({
    where: { id: removalEventId },
    select: { eventType: true, aggregateType: true, aggregateId: true },
  });
  // INVARIANT: an older aggregate-only removal cannot authorize a successful
  // Appeal. Returning success here would approve Main while Chat remains
  // archived, so the whole Appeal transaction must stay open for manual work.
  if (
    !removal ||
    removal.eventType !== MAIN_TO_CHAT_EVENTS.characterRemoved ||
    removal.aggregateType !== "character" ||
    removal.aggregateId !== input.characterId
  ) {
    throw Errors.conflict(
      "Character removal has no deterministic Chat restoration authority",
    );
  }
  const payload = characterModerationRestorationPayloadSchema.parse({
    version: 1,
    binding: "removal_event",
    appealId: input.appealId,
    characterId: input.characterId,
    moderationDecisionId: input.moderationDecisionId,
    removalEventId,
  });
  await recordMainToChatEvent({
    eventId: characterModerationRestorationEventId(input.appealId),
    eventType: MAIN_TO_CHAT_EVENTS.characterModerationRestorationRequested,
    aggregateType: "character",
    aggregateId: input.characterId,
    payload,
  }, db);
}

// Feed item ids are encoded as `character:<id>` (see ourdream feed handlers).
function feedItemCharacterId(itemId: string) {
  const decoded = decodeURIComponent(itemId);
  return decoded.startsWith("character:") ? decoded.slice("character:".length) : null;
}
