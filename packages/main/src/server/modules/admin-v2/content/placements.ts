import type { Prisma } from "@prisma/client";
import type {
  ContentPlacementCreateRequest,
  ContentPlacementPatchRequest,
  ContentPlacementQuery,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  inspectOperatorUploadAuthority,
  mediaAssetPlatformStatus,
} from "@/server/lib/media-asset-authority";
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
import { parseCommunityCampaignAuthoredCopy, UPLOADED_CAMPAIGN_AUTHORITY_SCHEMA } from "@/server/modules/ourdream/community-campaigns";
import { providers } from "@/server/providers";
import { parseAdminImageUpload } from "../shared/image-upload";

// SPEC: 创建草稿，管理暂停/归档；外部上传的 Campaign 经独立 publish 命令核验真实文件后上线。
// INVARIANT: 角色图仍归 Character Release；生成素材仍归 Creative Run verification。
// 上传不伪造生成记录，也不能通过普通 PATCH 绕过发布核验。

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

export function decoratePlacementReplay(result: unknown, replayed: boolean) {
  const value = jsonRecord(result);
  const placement = jsonRecord(value.placement);
  // INTENT: historical create/PATCH receipts predate this required capability field.
  // Only replay gets a conservative value; a fresh GET supplies the current publication eligibility.
  return {
    ...value,
    ...(replayed && !Object.hasOwn(placement, "canPublish")
      ? { placement: { ...placement, canPublish: false } }
      : {}),
    replayed,
  };
}

export async function createPlacement(input: {
  tx: Prisma.TransactionClient;
  request: Request;
  actor: AdminActor;
  body: ContentPlacementCreateRequest;
}) {
  const { tx, request, actor, body } = input;
  assertAuthoredPlacementMetadata(body.metadata);
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
  if (body.status) assertLegacyPlacementTransition(before.status, body.status);
  if (body.metadata) {
    assertAuthoredPlacementMetadata(body.metadata);
    if (!["draft", "paused"].includes(before.status)) throw Errors.conflict("Pause the placement before editing campaign copy");
  }
  const nextMetadata = body.metadata ? { ...beforeMetadata, ...body.metadata } : undefined;
  if (nextMetadata && before.slot === "campaign") {
    // Null explicitly clears the optional CTA; absent patch fields preserve existing copy.
    for (const key of ["ctaLabel", "href"]) if (nextMetadata[key] === null) delete nextMetadata[key];
  }
  const changed = await tx.mediaAssetPlacement.updateMany({
    where: { id, status: before.status, version: expectedVersion },
    data: {
      status: body.status,
      pausedAt: body.status === "paused" ? new Date() : undefined,
      archivedAt: body.status === "archived" ? new Date() : undefined,
      metadata: nextMetadata ? toInputJson(nextMetadata) : undefined,
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
      action: `content.placement.${body.status ?? "update"}`,
      targetType: "media_asset_placement",
      targetId: id,
      reason: body.reason,
      before: {
        status: before.status,
        mediaAssetId: before.mediaAssetId,
        slot: before.slot,
        targetId: before.targetId,
        metadata: before.metadata,
      },
      after: {
        status: updated.status,
        mediaAssetId: updated.mediaAssetId,
        slot: updated.slot,
        targetId: updated.targetId,
        metadata: updated.metadata,
      },
    }),
  });
  const authority = (
    await resolveMediaAssetAuthorityMap(tx, [updated.mediaAsset])
  ).get(updated.mediaAssetId);
  return { placement: placementDTO(updated, authority) };
}

export async function prepareUploadedPlacement(id: string, expectedVersion?: number) {
  const placement = await prisma.mediaAssetPlacement.findFirst({
    where: operationalMediaAssetPlacementWhere({ id }), include: { mediaAsset: true },
  });
  if (!placement) throw Errors.notFound("Placement not found");
  if (placement.version !== expectedVersion) throw Errors.conflict("Placement changed before publication");
  assertUploadedCampaign(placement);
  const asset = placement.mediaAsset;
  if (!providers.blob.getPrivate) throw Errors.unavailable("Publication requires readable stored artwork");
  const stored = await providers.blob.getPrivate({ key: asset.storageKey! });
  if (!stored.ok) throw Errors.conflict("Uploaded artwork is unavailable; upload it again before publishing");
  const form = new FormData();
  form.set("image", new File([Uint8Array.from(stored.data.body)], "campaign.png", { type: asset.contentType ?? "image/png" }));
  const image = await parseAdminImageUpload(form).catch(() => {
    throw Errors.conflict("Uploaded artwork is damaged; upload it again before publishing");
  });
  if (image.sha256 !== jsonRecord(asset.metadata).sha256 || image.width !== asset.width || image.height !== asset.height) {
    throw Errors.conflict("Stored artwork changed after upload; upload it again before publishing");
  }
  return { assetId: asset.id, storageKey: asset.storageKey!, sha256: image.sha256 };
}

export async function publishUploadedPlacement(input: {
  tx: Prisma.TransactionClient; request: Request; actor: AdminActor; id: string;
  expectedVersion: number; reason: string; prepared: Awaited<ReturnType<typeof prepareUploadedPlacement>>;
}) {
  const { tx, request, actor, id, expectedVersion, reason, prepared } = input;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legacy-placement:${id}`}))`;
  const before = await tx.mediaAssetPlacement.findFirst({
    where: operationalMediaAssetPlacementWhere({ id }), include: placementInclude,
  });
  if (!before) throw Errors.notFound("Placement not found");
  if (before.version !== expectedVersion) throw Errors.conflict("Placement changed before publication");
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`creative-placement:${before.slot}:${before.targetType}:${before.targetId}`}))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${before.mediaAssetId}`}))`;
  const asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id: before.mediaAssetId } });
  assertUploadedCampaign({ ...before, mediaAsset: asset });
  if (asset.id !== prepared.assetId || asset.storageKey !== prepared.storageKey || jsonRecord(asset.metadata).sha256 !== prepared.sha256) {
    throw Errors.conflict("Artwork authority changed while publication was being verified");
  }
  const replacing = await tx.mediaAssetPlacement.findMany({ where: {
    id: { not: id }, slot: before.slot, targetType: before.targetType, targetId: before.targetId,
    status: "published", verificationState: "passed",
  } });
  const managed = replacing.filter(placement => ["creativeRunId", "creativeRunItemId", "customerMediaAuthority"]
    .some(key => Object.hasOwn(jsonRecord(placement.metadata), key)));
  if (managed.length) {
    // INVARIANT: only Creative commands may withdraw its live placement and synchronize Run/item authority.
    const runId = jsonRecord(managed[0].metadata).creativeRunId;
    throw Errors.conflict("Withdraw the live placement from its Creative Run before publishing uploaded artwork", {
      code: "creative_placement_withdrawal_required",
      placementIds: managed.map(placement => placement.id),
      repairPath: typeof runId === "string" && runId ? `/admin/creative/runs/${runId}` : "/admin/creative/runs",
    });
  }
  const staged = await tx.mediaAssetPlacement.findFirst({ where: {
    slot: before.slot, targetType: before.targetType, targetId: before.targetId, status: "scheduled", verificationState: "verifying",
  } });
  if (staged) throw Errors.conflict("Another placement is awaiting verification for this campaign");
  const verifiedAt = new Date();
  const proof = { schemaVersion: UPLOADED_CAMPAIGN_AUTHORITY_SCHEMA, ...prepared, verifiedAt: verifiedAt.toISOString() };
  await tx.mediaAsset.update({ where: { id: asset.id }, data: { visibility: "unlisted" } });
  await tx.mediaAssetPlacement.updateMany({ where: { id: { in: replacing.map(p => p.id) } }, data: {
    status: "paused", pausedAt: verifiedAt, version: { increment: 1 },
  } });
  const changed = await tx.mediaAssetPlacement.updateMany({ where: { id, version: expectedVersion, status: before.status }, data: {
    status: "published", verificationState: "passed", verificationEvidence: toInputJson(proof),
    verifiedAt, publishedAt: verifiedAt, pausedAt: null,
    metadata: toInputJson({ ...jsonRecord(before.metadata), uploadedCampaignAuthority: proof }),
    rollbackPlacementId: replacing[0]?.id ?? before.rollbackPlacementId, version: { increment: 1 },
  } });
  if (changed.count !== 1) throw Errors.conflict("Placement changed during publication");
  await tx.adminAuditLog.create({ data: contentAuditData(request, actor, {
    action: "content.placement.publish", targetType: "media_asset_placement", targetId: id, reason,
    before: { status: before.status, version: before.version, replacedPlacementIds: replacing.map(p => p.id) },
    after: { status: "published", version: expectedVersion + 1, mediaAssetId: asset.id, sha256: prepared.sha256 },
  }) });
  const placement = await tx.mediaAssetPlacement.findUniqueOrThrow({ where: { id }, include: placementInclude });
  const authority = (await resolveMediaAssetAuthorityMap(tx, [placement.mediaAsset])).get(asset.id);
  return { placement: placementDTO(placement, authority) };
}

function assertUploadedCampaign(placement: Prisma.MediaAssetPlacementGetPayload<{ include: { mediaAsset: true } }>) {
  const metadata = jsonRecord(placement.metadata);
  if (placement.slot !== "campaign" || placement.targetType !== "campaign" ||
      !["draft", "paused"].includes(placement.status) ||
      ["creativeRunId", "creativeRunItemId", "customerMediaAuthority"].some(key => Object.hasOwn(metadata, key))) {
    throw Errors.conflict("Only an uploaded Campaign draft or paused placement can publish here");
  }
  const asset = placement.mediaAsset;
  if (asset.deletedAt || asset.safetyStatus !== "passed" || !asset.storageKey ||
      mediaAssetPlatformStatus(asset.metadata) !== "approved" || !inspectOperatorUploadAuthority(asset)?.publishable) {
    throw Errors.conflict("Campaign publication requires an available approved operator upload");
  }
  if (!parseCommunityCampaignAuthoredCopy(metadata)) throw Errors.badRequest("Campaign title, eyebrow and destination must be valid before publication");
}

function assertAuthoredPlacementMetadata(metadata: Record<string, unknown>) {
  if (["creativeRunId", "creativeRunItemId", "customerMediaAuthority", "uploadedCampaignAuthority"].some(key => Object.hasOwn(metadata, key))) {
    throw Errors.badRequest("Placement provenance is written by publication commands, not by authored metadata");
  }
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
  if (!item?.mediaAsset) {
    const uploadedAsset = await db.mediaAsset.findFirst({
      where: operationalMediaAssetWhere({ id: mediaAssetId, deletedAt: null }),
    });
    const uploadAuthority = uploadedAsset
      ? inspectOperatorUploadAuthority(uploadedAsset)
      : null;
    if (
      !uploadedAsset ||
      mediaAssetPlatformStatus(uploadedAsset.metadata) !== "approved" ||
      uploadAuthority?.publishable !== true
    ) {
      throw Errors.badRequest("Only approved content assets can be placed");
    }
    await assertMediaAssetCustomerPublishable(db, uploadedAsset);
    return;
  }
  if (
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
    canPublish: placement.slot === "campaign" && placement.targetType === "campaign" &&
      ["draft", "paused"].includes(placement.status) &&
      !["creativeRunId", "creativeRunItemId", "customerMediaAuthority"].some(key => Object.hasOwn(metadata, key)) &&
      !placement.mediaAsset.deletedAt && placement.mediaAsset.safetyStatus === "passed" &&
      mediaAssetPlatformStatus(placement.mediaAsset.metadata) === "approved" && authority?.publishable === true &&
      inspectOperatorUploadAuthority(placement.mediaAsset)?.publishable === true &&
      Boolean(parseCommunityCampaignAuthoredCopy(metadata)),
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
