import type { Prisma } from "@prisma/client";
import type {
  ContentPlacementCreateRequest,
  ContentPlacementPatchRequest,
  ContentPlacementQuery,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { mediaAssetPlatformStatus } from "@/server/lib/media-asset-authority";
import {
  assertMediaAssetCustomerPublishable,
  resolveMediaAssetAuthorityMap,
  type ResolvedMediaAssetAuthority,
} from "@/server/lib/media-asset-authority-query";
import { mediaAssetDTO } from "@/server/lib/media-asset-dto";
import {
  operationalMediaAssetPlacementWhere,
  operationalMediaAssetWhere,
} from "@/server/modules/metric-data-scope";
import type { AdminActor } from "../shared/authority";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  parseIsoCursorKey,
} from "../shared/list-cursor";
import { toInputJson } from "../shared/prisma-json";
import { contentAuditData } from "./audit";

// SPEC: legacy Placement 编辑器。只创建非运行时 draft，并以 pause / archive（archive 为终态）
//       管理它。
// INTENT: 客户可见的投放权威早已收归 Character Release（角色图位）与 Creative Run
//         staging + runtime verification（Campaign）。这里保留的是尚未迁移的运营草稿面，
//         因此 published 与 release 所属槽位一律 fail closed，Run 托管的 placement 也拒绝
//         从这个入口改动。

const releaseOwnedPlacementSlots = new Set([
  "character_avatar",
  "character_hero",
  "character_chat",
]);

const placementInclude = {
  mediaAsset: true,
  createdBy: { select: { id: true, email: true, displayName: true, name: true } },
} satisfies Prisma.MediaAssetPlacementInclude;

type PlacementWithRelations = Prisma.MediaAssetPlacementGetPayload<{
  include: typeof placementInclude;
}>;

export async function listPlacements(query: ContentPlacementQuery) {
  const { status, slot, targetId, search, limit } = query;
  const queryIdentity = { status, slot, targetId, search, sort: "created_desc" };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "placements", queryIdentity)
    : null;
  const [cursorAt, cursorId] = cursorKeys
    ? [parseIsoCursorKey(cursorKeys[0], "placements"), cursorText(cursorKeys[1])]
    : [null, null];
  const placements = await prisma.mediaAssetPlacement.findMany({
    where: operationalMediaAssetPlacementWhere({
      status,
      slot,
      targetId,
      ...(search ? { OR: [
        { id: { contains: search, mode: "insensitive" as const } },
        { mediaAssetId: { contains: search, mode: "insensitive" as const } },
        { targetId: { contains: search, mode: "insensitive" as const } },
        { targetType: { contains: search, mode: "insensitive" as const } },
        { slot: { contains: search, mode: "insensitive" as const } },
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
  return {
    items: page.map((placement) =>
      placementDTO(placement, mediaAuthorityById.get(placement.mediaAssetId))),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("placements", queryIdentity, [
            last.createdAt.toISOString(),
            last.id,
          ])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh" as const,
  };
}

export async function getPlacement(id: string) {
  const placement = await prisma.mediaAssetPlacement.findFirst({
    where: operationalMediaAssetPlacementWhere({ id }),
    include: placementInclude,
  });
  if (!placement) throw Errors.notFound("Placement not found");
  const authority = (
    await resolveMediaAssetAuthorityMap(prisma, [placement.mediaAsset])
  ).get(placement.mediaAssetId);
  return { placement: placementDTO(placement, authority) };
}

export async function createPlacement(input: {
  tx: Prisma.TransactionClient;
  request: Request;
  actor: AdminActor;
  body: ContentPlacementCreateRequest;
}) {
  const { tx, request, actor, body } = input;
  assertLegacyPlacementAuthority(body.slot, body.status);
  validatePlacementTarget(body.slot, body.targetType);
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
    data: contentAuditData(request, actor, {
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
  const placement = await tx.mediaAssetPlacement.findUniqueOrThrow({
    where: { id: created.id },
    include: placementInclude,
  });
  const authority = (
    await resolveMediaAssetAuthorityMap(tx, [placement.mediaAsset])
  ).get(placement.mediaAssetId);
  return { placement: placementDTO(placement, authority) };
}

export async function patchPlacement(input: {
  tx: Prisma.TransactionClient;
  request: Request;
  actor: AdminActor;
  id: string;
  expectedVersion: number;
  body: ContentPlacementPatchRequest;
}) {
  const { tx, request, actor, id, expectedVersion, body } = input;
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match placement");
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legacy-placement:${id}`}))`;
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
    throw Errors.conflict(
      "Creative Run placements are immutable through the legacy Placement editor",
      {
        code: "creative_run_placement_required",
        repairPath: managedRunId ? `/admin/creative/runs/${managedRunId}` : "/admin/creative/runs",
      },
    );
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
    where: { id, status: before.status, version: expectedVersion },
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
    include: placementInclude,
  });
  await tx.adminAuditLog.create({
    data: contentAuditData(request, actor, {
      action: `content.placement.${body.status}`,
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
  const authority = (
    await resolveMediaAssetAuthorityMap(tx, [updated.mediaAsset])
  ).get(updated.mediaAssetId);
  return { placement: placementDTO(updated, authority) };
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
  db: Prisma.TransactionClient,
  mediaAssetId: string,
) {
  const item = await db.contentProductionItem.findFirst({
    where: {
      mediaAssetId,
      status: { in: ["approved", "published"] },
      mediaAsset: { is: operationalMediaAssetWhere({ deletedAt: null }) },
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
  const asset = mediaAssetDTO(placement.mediaAsset, authority);
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
    scheduledAt: placement.scheduledAt?.toISOString() ?? null,
    publishedAt: placement.publishedAt?.toISOString() ?? null,
    pausedAt: placement.pausedAt?.toISOString() ?? null,
    archivedAt: placement.archivedAt?.toISOString() ?? null,
    createdById: placement.createdById,
    createdByEmail: placement.createdBy.email,
    metadata: placement.metadata,
    createdAt: placement.createdAt.toISOString(),
    updatedAt: placement.updatedAt.toISOString(),
    asset: { ...asset, createdAt: asset.createdAt.toISOString() },
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cursorText(value: unknown) {
  if (typeof value !== "string" || !value) {
    throw Errors.badRequest("Invalid placements cursor");
  }
  return value;
}
