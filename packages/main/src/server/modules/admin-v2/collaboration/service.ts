import {
  collaborationActivityCreateSchema,
  collaborationQuerySchema,
  collaborationTargetTypeSchema,
  collaborationWatchSchema,
  savedViewCreateSchema,
  savedViewUpdateSchema,
  type AdminPermissionKey,
  type CollaborationTargetType,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/service";
import { canonicalJsonHash, requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { effectivePermissions } from "@/server/admin/effective-permissions";

const targetDescriptors: Record<CollaborationTargetType, { read: AdminPermissionKey; write: AdminPermissionKey; exists: (id: string) => Promise<unknown> }> = {
  character_project: { read: "character.project.read", write: "character.project.write", exists: (id) => prisma.characterProject.findUnique({ where: { id }, select: { id: true } }) },
  creative_run: { read: "creative.run.read", write: "creative.run.write", exists: (id) => prisma.contentProductionBatch.findUnique({ where: { id }, select: { id: true } }) },
  case: { read: "case.read", write: "case.assign", exists: (id) => prisma.adminCase.findUnique({ where: { id }, select: { id: true } }) },
  incident: { read: "ops.incident.read", write: "ops.incident.manage", exists: (id) => prisma.opsIncident.findUnique({ where: { id }, select: { id: true } }) },
};

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function assertTarget(targetType: CollaborationTargetType, targetId: string) {
  const exists = await targetDescriptors[targetType].exists(targetId);
  if (!exists) throw Errors.notFound("Collaboration target was not found");
}

function activityDto(row: Awaited<ReturnType<typeof prisma.adminCollaborationActivity.findFirstOrThrow>>) {
  const metadata = asRecord(row.metadata);
  delete metadata._requestHash;
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    kind: row.kind,
    actorId: row.actorId,
    body: row.body,
    mentionedIds: row.mentionedIds,
    metadata,
    parentId: row.parentId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listActivity(request: Request, rawTargetType: string, targetId: string) {
  const targetType = collaborationTargetTypeSchema.parse(rawTargetType);
  const actor = await actorWithPermission(request, targetDescriptors[targetType].read);
  await assertTarget(targetType, targetId);
  const query = collaborationQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const cursor = query.cursor
    ? await prisma.adminCollaborationActivity.findFirst({ where: { id: query.cursor, targetType, targetId } })
    : null;
  if (query.cursor && !cursor) throw Errors.badRequest("Activity cursor is invalid for this target");
  const rows = await prisma.adminCollaborationActivity.findMany({
    where: {
      targetType,
      targetId,
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
  });
  const items = rows.slice(0, query.limit).map(activityDto);
  const preference = await prisma.operationalWorkPreference.findUnique({
    where: { actorId_sourceType_sourceId: { actorId: actor.id, sourceType: targetType, sourceId: targetId } },
  });
  return ok({
    items,
    watching: preference?.watching ?? false,
    pageInfo: { hasNextPage: rows.length > query.limit, endCursor: rows.length > query.limit ? items.at(-1)?.id ?? null : null },
    asOf: new Date().toISOString(),
  });
}

export async function createActivity(request: Request, rawTargetType: string, targetId: string) {
  const targetType = collaborationTargetTypeSchema.parse(rawTargetType);
  const actor = await actorWithPermission(request, targetDescriptors[targetType].write);
  await assertTarget(targetType, targetId);
  const input = collaborationActivityCreateSchema.parse(await request.json());
  const key = requireIdempotencyKey(request);
  const hash = canonicalJsonHash({ targetType, targetId, input });
  const existing = await prisma.adminCollaborationActivity.findUnique({
    where: { actorId_idempotencyKey: { actorId: actor.id, idempotencyKey: key } },
  });
  if (existing) {
    if (asRecord(existing.metadata)._requestHash !== hash) throw Errors.conflict("Idempotency key was reused with a different activity");
    return ok({ activity: activityDto(existing), duplicate: true });
  }
  const mentionedIds = [...new Set(input.mentionedIds.filter((id) => id !== actor.id))];
  if (mentionedIds.length > 0) {
    const mentionedUsers = await prisma.user.count({ where: { id: { in: mentionedIds }, status: "active" } });
    if (mentionedUsers !== mentionedIds.length) throw Errors.badRequest("Every mentioned actor must be an active user");
  }
  if (input.parentId) {
    const parent = await prisma.adminCollaborationActivity.findFirst({ where: { id: input.parentId, targetType, targetId }, select: { id: true } });
    if (!parent) throw Errors.badRequest("Parent activity must belong to the same collaboration target");
  }
  const activity = await prisma.adminCollaborationActivity.create({
      data: {
        targetType,
        targetId,
        kind: input.kind,
        actorId: actor.id,
        body: input.body,
        mentionedIds,
        metadata: { ...input.metadata, _requestHash: hash } as Prisma.InputJsonValue,
        parentId: input.parentId,
        idempotencyKey: key,
      },
  });
  return ok({ activity: activityDto(activity), duplicate: false }, { status: 201 });
}

export async function setWatching(request: Request, rawTargetType: string, targetId: string) {
  const targetType = collaborationTargetTypeSchema.parse(rawTargetType);
  const actor = await actorWithPermission(request, targetDescriptors[targetType].read);
  await assertTarget(targetType, targetId);
  const input = collaborationWatchSchema.parse(await request.json());
  const key = requireIdempotencyKey(request);
  const hash = canonicalJsonHash({ targetType, targetId, input });
  const result = await prisma.$transaction(async (tx) => {
    const previous = await tx.adminCollaborationActivity.findUnique({
      where: { actorId_idempotencyKey: { actorId: actor.id, idempotencyKey: key } },
    });
    if (previous) {
      if (asRecord(previous.metadata)._requestHash !== hash) throw Errors.conflict("Idempotency key was reused with a different watch request");
      const preference = await tx.operationalWorkPreference.findUniqueOrThrow({
        where: { actorId_sourceType_sourceId: { actorId: actor.id, sourceType: targetType, sourceId: targetId } },
      });
      return { preference, duplicate: true };
    }
    const preference = await tx.operationalWorkPreference.upsert({
      where: { actorId_sourceType_sourceId: { actorId: actor.id, sourceType: targetType, sourceId: targetId } },
      create: { actorId: actor.id, sourceType: targetType, sourceId: targetId, watching: input.watching },
      update: { watching: input.watching },
    });
    await tx.adminCollaborationActivity.create({
      data: {
        targetType,
        targetId,
        kind: "status_change",
        actorId: actor.id,
        body: input.watching ? "Started watching" : "Stopped watching",
        metadata: { watching: input.watching, _requestHash: hash },
        idempotencyKey: key,
      },
    });
    return { preference, duplicate: false };
  });
  return ok({ watching: result.preference.watching, duplicate: result.duplicate });
}

export async function listMentions(request: Request) {
  const actor = await actorWithPermission(request, "dashboard.read");
  const actorPermissions = await effectivePermissions(actor.id, actor.role);
  const query = collaborationQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const rows = await prisma.adminCollaborationActivity.findMany({
    where: { mentionedIds: { has: actor.id }, ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
    orderBy: { id: "desc" },
    take: query.limit + 1,
  });
  const items = rows
    .filter((row) => {
      const targetType = collaborationTargetTypeSchema.safeParse(row.targetType);
      return targetType.success && actorPermissions.has(targetDescriptors[targetType.data].read);
    })
    .slice(0, query.limit)
    .map(activityDto);
  return ok({ items, pageInfo: { hasNextPage: rows.length > query.limit, endCursor: rows.length > query.limit ? items.at(-1)?.id ?? null : null } });
}

function viewDto(view: Awaited<ReturnType<typeof prisma.adminSavedView.findFirstOrThrow>>) {
  return { id: view.id, scope: view.scope, label: view.label, queryState: view.queryState ?? view.filters, version: view.version, createdAt: view.createdAt.toISOString(), updatedAt: view.updatedAt.toISOString() };
}

export async function listSavedViewsV2(request: Request) {
  const scope = collaborationTargetTypeSchema.parse(new URL(request.url).searchParams.get("scope"));
  const actor = await actorWithPermission(request, targetDescriptors[scope].read);
  const views = await prisma.adminSavedView.findMany({ where: { ownerId: actor.id, scope }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
  return ok({ items: views.map(viewDto) });
}

export async function createSavedViewV2(request: Request) {
  const input = savedViewCreateSchema.parse(await request.json());
  const actor = await actorWithPermission(request, targetDescriptors[input.scope].read);
  const key = requireIdempotencyKey(request);
  const existing = await prisma.adminSavedView.findUnique({ where: { ownerId_idempotencyKey: { ownerId: actor.id, idempotencyKey: key } } });
  if (existing) {
    if (canonicalJsonHash(existing.queryState) !== canonicalJsonHash(input.queryState) || existing.label !== input.label || existing.scope !== input.scope) throw Errors.conflict("Idempotency key was reused with a different saved view");
    return ok({ view: viewDto(existing), duplicate: true });
  }
  const view = await prisma.adminSavedView.create({ data: { ownerId: actor.id, scope: input.scope, label: input.label, filters: input.queryState.filters as Prisma.InputJsonValue, queryState: input.queryState as Prisma.InputJsonValue, idempotencyKey: key } });
  return ok({ view: viewDto(view), duplicate: false }, { status: 201 });
}

export async function updateSavedViewV2(request: Request, id: string) {
  const input = savedViewUpdateSchema.parse(await request.json());
  const current = await prisma.adminSavedView.findUnique({ where: { id } });
  if (!current) throw Errors.notFound("Saved view not found");
  const scope = collaborationTargetTypeSchema.parse(current.scope);
  const actor = await actorWithPermission(request, targetDescriptors[scope].read);
  if (current.ownerId !== actor.id) throw Errors.notFound("Saved view not found");
  const result = await prisma.adminSavedView.updateMany({
    where: { id, ownerId: actor.id, version: input.expectedVersion },
    data: { label: input.label, queryState: input.queryState as Prisma.InputJsonValue | undefined, filters: input.queryState?.filters as Prisma.InputJsonValue | undefined, version: { increment: 1 } },
  });
  if (result.count !== 1) throw Errors.conflict("Saved view changed; reload before applying edits");
  return ok({ view: viewDto(await prisma.adminSavedView.findUniqueOrThrow({ where: { id } })) });
}

export async function deleteSavedViewV2(request: Request, id: string) {
  const current = await prisma.adminSavedView.findUnique({ where: { id } });
  if (!current) throw Errors.notFound("Saved view not found");
  const scope = collaborationTargetTypeSchema.parse(current.scope);
  const actor = await actorWithPermission(request, targetDescriptors[scope].read);
  const expectedVersion = Number(request.headers.get("if-match"));
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw Errors.badRequest("If-Match must contain the saved view version");
  const deleted = await prisma.adminSavedView.deleteMany({ where: { id, ownerId: actor.id, version: expectedVersion } });
  if (deleted.count !== 1) throw Errors.conflict("Saved view changed; reload before deleting");
  return ok({ deleted: true });
}
