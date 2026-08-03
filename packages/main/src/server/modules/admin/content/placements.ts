import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { creativeRunCreateRequestSchema } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { mediaAssetPlatformStatus } from "@/server/lib/media-asset-authority";
import { mediaAssetDTO } from "@/server/lib/media-asset-dto";
import {
  assertMediaAssetCustomerPublishable,
  resolveMediaAssetAuthorityMap,
  type ResolvedMediaAssetAuthority,
} from "@/server/lib/media-asset-authority-query";
import { auditedTransaction } from "@/server/modules/admin-v2/shared/audited-transaction";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  parseIsoCursorKey,
} from "@/server/modules/admin-v2/shared/list-cursor";
import {
  operationalMediaAssetPlacementWhere,
  operationalMediaAssetWhere,
} from "@/server/modules/metric-data-scope";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
  type AdminActor,
} from "../shared/legacy-primitives";

// SPEC: legacy Placement 编辑器 —— `/api/v1/admin/content/placements*`。只创建
// 非运行时 draft，并以 pause / archive（archive 为终态）管理它。
// INTENT: 客户可见的投放权威早已收归 Character Release（角色图位）与 Creative Run
// staging + runtime verification（Campaign）。这里保留的是尚未迁移的运营草稿面，
// 因此 published 与 release 所属槽位一律 fail closed，Run 托管的 placement 也拒绝
// 从这个入口改动。

const productionTargetTypeSchema = creativeRunCreateRequestSchema.shape.targetType;

const placementSlotSchema = z.enum([
  "character_avatar",
  "character_hero",
  "character_chat",
  "feed_card",
  "homepage_strip",
  "seo_article",
  "template_cover",
  "campaign",
]);

const releaseOwnedPlacementSlots = new Set(["character_avatar", "character_hero", "character_chat"]);

const placementCreateSchema = z.object({
  mediaAssetId: z.string().trim().min(1).max(180),
  slot: placementSlotSchema,
  targetType: productionTargetTypeSchema.exclude(["none"]),
  targetId: z.string().trim().min(1).max(180),
  status: z.literal("draft").default("draft"),
  metadata: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().trim().min(3).max(2_000),
});

const placementPatchSchema = z.object({
  status: z.enum(["paused", "archived"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

function requirePlacementVersion(request: Request) {
  const value = request.headers
    .get("if-match")
    ?.trim()
    .replace(/^W\//, "")
    .replace(/^"|"$/g, "");
  if (!value || !/^\d+$/.test(value)) {
    throw Errors.badRequest("If-Match must contain the current Placement version");
  }
  return Number(value);
}

const placementInclude = {
  mediaAsset: true,
  createdBy: { select: { id: true, email: true, displayName: true, name: true } },
} satisfies Prisma.MediaAssetPlacementInclude;

type PlacementWithRelations = Prisma.MediaAssetPlacementGetPayload<{
  include: typeof placementInclude;
}>;

export async function listPlacements(request: Request) {
  await actorWithPermission(request, "creative.placement.read");
  const url = new URL(request.url);
  const status = url.searchParams.get("status")?.trim() || undefined;
  const slot = placementSlotSchema.safeParse(url.searchParams.get("slot")).data;
  const targetId = url.searchParams.get("targetId")?.trim() || undefined;
  const search = url.searchParams.get("search")?.trim() || undefined;
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
  const queryIdentity = { status, slot, targetId, search, sort: "created_desc" };
  const cursorKeys = url.searchParams.get("cursor")
    ? decodeAdminListCursor(url.searchParams.get("cursor")!, "placements", queryIdentity)
    : null;
  const [cursorAt, cursorId] = cursorKeys
    ? [parseIsoCursorKey(cursorKeys[0], "placements"), z.string().min(1).parse(cursorKeys[1])]
    : [null, null];
  const placements = await prisma.mediaAssetPlacement.findMany({
    where: operationalMediaAssetPlacementWhere({
      status,
      slot,
      targetId,
      ...(search ? { OR: [
        { id: { contains: search, mode: "insensitive" } },
        { mediaAssetId: { contains: search, mode: "insensitive" } },
        { targetId: { contains: search, mode: "insensitive" } },
        { targetType: { contains: search, mode: "insensitive" } },
        { slot: { contains: search, mode: "insensitive" } },
      ] } : {}),
      ...(cursorAt && cursorId ? { AND: [{ OR: [
        { createdAt: { lt: cursorAt } },
        { createdAt: cursorAt, id: { lt: cursorId } },
      ] }] } : {}),
    }),
    include: placementInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasNextPage = placements.length > limit;
  const page = placements.slice(0, limit);
  const last = page.at(-1);
  const mediaAuthorityById = await resolveMediaAssetAuthorityMap(
    prisma,
    page.map((placement) => placement.mediaAsset),
  );
  return ok({
    items: page.map((placement) =>
      placementDTO(
        placement,
        mediaAuthorityById.get(placement.mediaAssetId),
      ),
    ),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("placements", queryIdentity, [last.createdAt.toISOString(), last.id])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

export async function getPlacement(request: Request, id: string) {
  await actorWithPermission(request, "creative.placement.read");
  const placement = await prisma.mediaAssetPlacement.findFirst({
    where: operationalMediaAssetPlacementWhere({ id }),
    include: placementInclude,
  });
  if (!placement) throw Errors.notFound("Placement not found");
  const authority = (
    await resolveMediaAssetAuthorityMap(prisma, [placement.mediaAsset])
  ).get(placement.mediaAssetId);
  return ok({ placement: placementDTO(placement, authority) });
}

export async function createPlacement(request: Request) {
  const actor = await actorWithPermission(request, "creative.placement.publish");
  const body = placementCreateSchema.parse(await jsonBody(request));
  assertLegacyPlacementAuthority(body.slot, body.status);
  validatePlacementTarget(body.slot, body.targetType);
  const idempotencyKey = requireIdempotencyKey(request);
  const commandScope = `${env.APP_ENV}:${actor.id}:content.placement.create`;
  const requestHash = canonicalSha256({
    commandType: "content.placement.create",
    payload: body,
  });
  const placementIdFromCommand = (command: {
    id: string;
    status: string;
    requestHash: string;
    result: Prisma.JsonValue | null;
  }) => {
    if (command.requestHash !== requestHash) {
      throw Errors.conflict(
        "Idempotency key was reused with a different Placement request",
        { commandId: command.id },
      );
    }
    const result = jsonRecord(command.result);
    if (
      command.status !== "succeeded" ||
      typeof result.placementId !== "string"
    ) {
      throw Errors.conflict(
        "The original Placement create command has not completed",
        { commandId: command.id, status: command.status },
      );
    }
    return result.placementId;
  };
  const existing = await prisma.controlPlaneCommand.findUnique({
    where: {
      scope_idempotencyKey: {
        scope: commandScope,
        idempotencyKey,
      },
    },
  });
  if (existing) {
    const placementId = placementIdFromCommand(existing);
    const replayedPlacement = await prisma.mediaAssetPlacement.findFirst({
      where: operationalMediaAssetPlacementWhere({ id: placementId }),
      include: placementInclude,
    });
    if (!replayedPlacement) {
      throw Errors.conflict(
        "The idempotent Placement result is no longer operational",
        { commandId: existing.id, placementId },
      );
    }
    const authority = (
      await resolveMediaAssetAuthorityMap(prisma, [
        replayedPlacement.mediaAsset,
      ])
    ).get(replayedPlacement.mediaAssetId);
    return ok({
      placement: placementDTO(replayedPlacement, authority),
      replayed: true,
    });
  }
  let replayed = false;
  const placement = await auditedTransaction("content.placement.create", async (tx) => {
    await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext(${`${commandScope}:${idempotencyKey}`}))`;
    const concurrentExisting = await tx.controlPlaneCommand.findUnique({
      where: {
        scope_idempotencyKey: {
          scope: commandScope,
          idempotencyKey,
        },
      },
    });
    if (concurrentExisting) {
      replayed = true;
      const placementId = placementIdFromCommand(concurrentExisting);
      return tx.mediaAssetPlacement.findFirstOrThrow({
        where: operationalMediaAssetPlacementWhere({ id: placementId }),
        include: placementInclude,
      });
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${body.mediaAssetId}`}))`;
    await assertApprovedAsset(tx, body.mediaAssetId);
    const created = await tx.mediaAssetPlacement.create({
      data: {
        mediaAssetId: body.mediaAssetId,
        slot: body.slot,
        targetType: body.targetType,
        targetId: body.targetId,
        status: body.status,
        createdById: actor.id,
        metadata: toInputJson(body.metadata),
      },
    });
    await tx.adminAuditLog.create({
      data: transactionAuditData(request, actor, {
        action: "content.placement.create",
        targetType: "media_asset_placement",
        targetId: created.id,
        reason: body.reason,
        after: {
          mediaAssetId: created.mediaAssetId,
          slot: created.slot,
          targetType: created.targetType,
          targetId: created.targetId,
          status: created.status,
        },
      }),
    });
    await tx.controlPlaneCommand.create({
      data: {
        scope: commandScope,
        idempotencyKey,
        commandType: "content.placement.create",
        targetType: "media_asset_placement",
        targetId: created.id,
        actorId: actor.id,
        requestId:
          request.headers.get("x-request-id") ?? crypto.randomUUID(),
        requestHash,
        requestPayload: toInputJson(body),
        retryMode: "idempotent",
        status: "succeeded",
        result: toInputJson({ placementId: created.id }),
        finishedAt: new Date(),
      },
    });
    return tx.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: created.id },
      include: placementInclude,
    });
  });
  const authority = (
    await resolveMediaAssetAuthorityMap(prisma, [placement.mediaAsset])
  ).get(placement.mediaAssetId);
  return ok({ placement: placementDTO(placement, authority), replayed });
}

export async function patchPlacement(request: Request, id: string) {
  const actor = await actorWithPermission(request, "creative.placement.publish");
  const body = placementPatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match placement");
  }
  const idempotencyKey = requireIdempotencyKey(request);
  const expectedVersion = requirePlacementVersion(request);
  const commandScope = `${env.APP_ENV}:${actor.id}:content.placement.patch:${id}`;
  const requestHash = canonicalSha256({
    commandType: "content.placement.patch",
    targetId: id,
    expectedVersion,
    payload: body,
  });
  const placementIdFromCommand = (command: {
    id: string;
    status: string;
    requestHash: string;
    result: Prisma.JsonValue | null;
  }) => {
    if (command.requestHash !== requestHash) {
      throw Errors.conflict(
        "Idempotency key was reused with a different Placement transition",
        { commandId: command.id },
      );
    }
    const result = jsonRecord(command.result);
    if (
      command.status !== "succeeded" ||
      result.placementId !== id
    ) {
      throw Errors.conflict(
        "The original Placement transition has not completed",
        { commandId: command.id, status: command.status },
      );
    }
    return id;
  };
  const existing = await prisma.controlPlaneCommand.findUnique({
    where: {
      scope_idempotencyKey: {
        scope: commandScope,
        idempotencyKey,
      },
    },
  });
  if (existing) {
    const placementId = placementIdFromCommand(existing);
    const replayedPlacement = await prisma.mediaAssetPlacement.findFirst({
      where: operationalMediaAssetPlacementWhere({ id: placementId }),
      include: placementInclude,
    });
    if (!replayedPlacement) {
      throw Errors.conflict(
        "The idempotent Placement transition result is no longer operational",
        { commandId: existing.id, placementId },
      );
    }
    const authority = (
      await resolveMediaAssetAuthorityMap(prisma, [replayedPlacement.mediaAsset])
    ).get(replayedPlacement.mediaAssetId);
    return ok({
      placement: placementDTO(replayedPlacement, authority),
      replayed: true,
    });
  }
  let replayed = false;
  const placement = await auditedTransaction("content.placement.update", async (tx) => {
    await tx.$queryRaw`
      SELECT 1::int AS locked
      FROM pg_advisory_xact_lock(hashtext(${`${commandScope}:${idempotencyKey}`}))
    `;
    const concurrentExisting = await tx.controlPlaneCommand.findUnique({
      where: {
        scope_idempotencyKey: {
          scope: commandScope,
          idempotencyKey,
        },
      },
    });
    if (concurrentExisting) {
      replayed = true;
      const placementId = placementIdFromCommand(concurrentExisting);
      return tx.mediaAssetPlacement.findFirstOrThrow({
        where: operationalMediaAssetPlacementWhere({ id: placementId }),
        include: placementInclude,
      });
    }
    await tx.$queryRaw`
      SELECT 1::int AS locked
      FROM pg_advisory_xact_lock(hashtext(${`legacy-placement:${id}`}))
    `;
    const before = await tx.mediaAssetPlacement.findFirst({
      where: operationalMediaAssetPlacementWhere({ id }),
    });
    if (!before) throw Errors.notFound("Placement not found");
    const beforeMetadata = jsonRecord(before.metadata);
    const managedRunId = typeof beforeMetadata.creativeRunId === "string"
      ? beforeMetadata.creativeRunId
      : null;
    if (
      managedRunId ||
      typeof beforeMetadata.creativeRunItemId === "string" ||
      Object.hasOwn(beforeMetadata, "customerMediaAuthority")
    ) {
      throw Errors.conflict("Creative Run placements are immutable through the legacy Placement editor", {
        code: "creative_run_placement_required",
        repairPath: managedRunId ? `/admin/creative/runs/${managedRunId}` : "/admin/creative/runs",
      });
    }
    if (before.version !== expectedVersion) {
      throw Errors.conflict("Placement changed after this operator view was loaded", {
        code: "legacy_placement_version_mismatch",
        expectedVersion,
        currentVersion: before.version,
        currentStatus: before.status,
      });
    }
    assertLegacyPlacementAuthority(before.slot, body.status);
    assertLegacyPlacementTransition(before.status, body.status);
    const changed = await tx.mediaAssetPlacement.updateMany({
      where: {
        id,
        status: before.status,
        version: expectedVersion,
      },
      data: {
        status: body.status,
        pausedAt: body.status === "paused" ? new Date() : undefined,
        archivedAt: body.status === "archived" ? new Date() : undefined,
        metadata: body.metadata ? toInputJson(body.metadata) : undefined,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      throw Errors.conflict("Legacy Placement changed during transition", {
        code: "legacy_placement_transition_changed",
        currentStatus: before.status,
        nextStatus: body.status,
        expectedVersion,
      });
    }
    const updated = await tx.mediaAssetPlacement.findUniqueOrThrow({
      where: { id },
    });
    await tx.adminAuditLog.create({
      data: transactionAuditData(request, actor, {
        action: body.status ? `content.placement.${body.status}` : "content.placement.update",
        targetType: "media_asset_placement",
        targetId: id,
        reason: body.reason,
        before: {
          status: before.status,
          mediaAssetId: before.mediaAssetId,
          slot: before.slot,
          targetId: before.targetId,
        },
        after: {
          status: updated.status,
          mediaAssetId: updated.mediaAssetId,
          slot: updated.slot,
          targetId: updated.targetId,
        },
      }),
    });
    await tx.controlPlaneCommand.create({
      data: {
        scope: commandScope,
        idempotencyKey,
        coordinationKey: `legacy-placement:${id}`,
        commandType: "content.placement.patch",
        targetType: "media_asset_placement",
        targetId: id,
        actorId: actor.id,
        requestId:
          request.headers.get("x-request-id") ?? crypto.randomUUID(),
        requestHash,
        requestPayload: toInputJson({ body, expectedVersion }),
        expectedVersion,
        retryMode: "idempotent",
        status: "succeeded",
        result: toInputJson({
          placementId: id,
          status: updated.status,
          version: updated.version,
        }),
        finishedAt: new Date(),
      },
    });
    return tx.mediaAssetPlacement.findUniqueOrThrow({
      where: { id },
      include: placementInclude,
    });
  });
  const authority = (
    await resolveMediaAssetAuthorityMap(prisma, [placement.mediaAsset])
  ).get(placement.mediaAssetId);
  return ok({ placement: placementDTO(placement, authority), replayed });
}

function transactionAuditData(
  request: Request,
  actor: AdminActor,
  input: {
    action: string;
    targetType: string;
    targetId: string;
    reason?: string;
    before?: unknown;
    after?: unknown;
  },
) {
  return {
    actorId: actor.id,
    actorRole: actor.role,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    before: input.before === undefined ? undefined : toInputJson(input.before),
    after: input.after === undefined ? undefined : toInputJson(input.after),
    requestId: request.headers.get("x-request-id"),
  };
}

function assertLegacyPlacementAuthority(slot: string, nextStatus?: string) {
  if (!releaseOwnedPlacementSlots.has(slot) && nextStatus !== "published") return;
  throw Errors.conflict(
    releaseOwnedPlacementSlots.has(slot)
      ? "Character image placements are owned by immutable Character Release commands"
      : "Customer-visible placements require a verified runtime authority",
    {
      code: releaseOwnedPlacementSlots.has(slot)
        ? "character_release_authority_required"
        : "creative_placement_verification_required",
      repairPath: releaseOwnedPlacementSlots.has(slot) ? "/admin/characters" : "/admin/creative/runs",
    },
  );
}

function assertLegacyPlacementTransition(
  currentStatus: string,
  nextStatus: "paused" | "archived",
) {
  const allowed = nextStatus === "archived"
    ? currentStatus !== "archived"
    : !["paused", "archived"].includes(currentStatus);
  if (allowed) return;
  throw Errors.conflict("Legacy Placement transition is not allowed", {
    code: "legacy_placement_transition_invalid",
    currentStatus,
    nextStatus,
  });
}

async function assertApprovedAsset(
  db: typeof prisma | Prisma.TransactionClient,
  mediaAssetId: string,
) {
  const item = await db.contentProductionItem.findFirst({
    where: {
      mediaAssetId,
      status: { in: ["approved", "published"] },
      mediaAsset: {
        is: operationalMediaAssetWhere({ deletedAt: null }),
      },
    },
    include: { mediaAsset: true },
  });
  const latestDecision = item
    ? await db.creativeReviewDecision.findFirst({
        where: { runItemId: item.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
    : null;
  const platformStatus = item?.mediaAsset
    ? mediaAssetPlatformStatus(item.mediaAsset.metadata)
    : null;
  if (
    !item?.mediaAsset ||
    (typeof platformStatus === "string" && ["archived", "rejected"].includes(platformStatus)) ||
    !latestDecision ||
    latestDecision.artifactId !== mediaAssetId ||
    latestDecision.decision !== "approved"
  ) {
    throw Errors.badRequest("Only approved content assets can be placed");
  }
  await assertMediaAssetCustomerPublishable(db, item.mediaAsset);
}

function validatePlacementTarget(slot: string, targetType: string) {
  if ((slot === "character_avatar" || slot === "character_hero") && targetType !== "character") {
    throw Errors.badRequest("Character image placements require character target type");
  }
  if (slot === "template_cover" && targetType !== "template") {
    throw Errors.badRequest("Template cover placements require template target type");
  }
}

function placementDTO(
  placement: PlacementWithRelations,
  authority?: ResolvedMediaAssetAuthority,
) {
  const metadata = jsonRecord(placement.metadata);
  return {
    id: placement.id,
    mediaAssetId: placement.mediaAssetId,
    slot: placement.slot,
    targetType: placement.targetType,
    targetId: placement.targetId,
    status: placement.status,
    version: placement.version,
    verificationState: placement.verificationState,
    managedRunId: typeof metadata.creativeRunId === "string" ? metadata.creativeRunId : null,
    scheduledAt: placement.scheduledAt,
    publishedAt: placement.publishedAt,
    pausedAt: placement.pausedAt,
    archivedAt: placement.archivedAt,
    createdById: placement.createdById,
    createdByEmail: placement.createdBy.email,
    metadata: placement.metadata,
    createdAt: placement.createdAt,
    updatedAt: placement.updatedAt,
    asset: mediaAssetDTO(placement.mediaAsset, authority),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
