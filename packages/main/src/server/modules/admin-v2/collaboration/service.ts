import {
  collaborationTargetTypeSchema,
  savedViewDeleteSchema,
  savedViewUpdateSchema,
  type AdminPermissionKey,
  type CollaborationTargetType,
} from "@idream/shared/admin";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, jsonBody, queryParams, type AdminActor } from "@/server/modules/admin-v2/shared/authority";
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

type AuthorityDb = Pick<
  Prisma.TransactionClient,
  "adminCase" | "characterProject" | "contentProductionBatch" | "opsIncident"
>;

type CollaborationAuthority = {
  readonly ownerId: string | null;
  readonly version: number;
};

async function collaborationAuthority(
  db: AuthorityDb,
  targetType: CollaborationTargetType,
  targetId: string,
): Promise<CollaborationAuthority | null> {
  if (targetType === "character_project") {
    return db.characterProject.findUnique({ where: { id: targetId }, select: { ownerId: true, version: true } });
  }
  if (targetType === "creative_run") {
    return db.contentProductionBatch.findUnique({ where: { id: targetId }, select: { ownerId: true, version: true } });
  }
  if (targetType === "case") {
    return db.adminCase.findUnique({ where: { id: targetId }, select: { ownerId: true, version: true } });
  }
  return db.opsIncident.findUnique({ where: { id: targetId }, select: { ownerId: true, version: true } });
}

async function transferCollaborationAuthority(
  tx: Prisma.TransactionClient,
  input: {
    readonly targetType: CollaborationTargetType;
    readonly targetId: string;
    readonly expectedVersion: number;
    readonly ownerId: string;
  },
) {
  const where = { id: input.targetId, version: input.expectedVersion };
  const data = { ownerId: input.ownerId, version: { increment: 1 } };
  const updated = input.targetType === "character_project"
    ? await tx.characterProject.updateMany({ where, data })
    : input.targetType === "creative_run"
      ? await tx.contentProductionBatch.updateMany({ where, data })
      : input.targetType === "case"
        ? await tx.adminCase.updateMany({ where, data })
        : await tx.opsIncident.updateMany({ where, data });
  if (updated.count !== 1) throw Errors.conflict("Collaboration target changed; reload before handing it off");
  return { ownerId: input.ownerId, version: input.expectedVersion + 1 } satisfies CollaborationAuthority;
}

function activityRequestHash(activity: { requestHash: string | null; metadata: Prisma.JsonValue }) {
  return activity.requestHash ?? asRecord(activity.metadata)._requestHash;
}

function activityAuthorityReceipt(activity: { metadata: Prisma.JsonValue }): CollaborationAuthority | null {
  const value = asRecord(activity.metadata)._authority;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const authority = value as Record<string, unknown>;
  if ((typeof authority.ownerId !== "string" && authority.ownerId !== null) || typeof authority.version !== "number") return null;
  return { ownerId: authority.ownerId, version: authority.version };
}

function replayActivity(
  activity: Awaited<ReturnType<PrismaClient["adminCollaborationActivity"]["findFirstOrThrow"]>>,
  hash: string,
) {
  if (activityRequestHash(activity) !== hash) {
    throw Errors.conflict("Idempotency key was reused with a different activity");
  }
  const authority = activityAuthorityReceipt(activity);
  return ok({ activity: activityDto(activity), authority, duplicate: true });
}

async function targetAccess(
  actor: AdminActor,
  targetType: CollaborationTargetType,
  targetId: string,
): Promise<"allowed" | "forbidden" | "missing"> {
  if (targetType === "case") {
    const target = await prisma.adminCase.findUnique({ where: { id: targetId }, select: { type: true } });
    if (!target) return "missing";
    return actor.role === "support" && !["support_request", "billing_dispute"].includes(target.type)
      ? "forbidden"
      : "allowed";
  }
  if (targetType === "incident") {
    const target = await prisma.opsIncident.findUnique({ where: { id: targetId }, select: { ownerId: true } });
    if (!target) return "missing";
    return actor.role === "support" && target.ownerId !== actor.id ? "forbidden" : "allowed";
  }
  return await targetDescriptors[targetType].exists(targetId) ? "allowed" : "missing";
}

async function assertTarget(actor: AdminActor, targetType: CollaborationTargetType, targetId: string) {
  const access = await targetAccess(actor, targetType, targetId);
  if (access === "missing") throw Errors.notFound("Collaboration target was not found");
  if (access === "forbidden") {
    throw Errors.forbidden("Collaboration target is outside the actor's effective permission scope");
  }
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
    metadata: {
      attachments: Array.isArray(metadata.attachments) ? metadata.attachments : [],
      ...(typeof metadata.handoffToActorId === "string" ? { handoffToActorId: metadata.handoffToActorId } : {}),
      checklistItems: Array.isArray(metadata.checklistItems) ? metadata.checklistItems : [],
    },
    parentId: row.parentId,
    createdAt: row.createdAt.toISOString(),
  };
}

// SPEC: 只为本页真正出现过的 actorId 解析显示名，查不到的一律不返回。
// INTENT: 前端在缺名字时回落到 ID —— 返回一条"名字就是 ID"的假记录会让运营以为那是真名。
async function resolveCollaborationActors(actorIds: readonly string[]) {
  const ids = [...new Set(actorIds)];
  if (ids.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true, name: true, email: true },
  });
  return users
    .map((user) => ({
      id: user.id,
      displayName: (user.displayName ?? user.name ?? user.email ?? "").trim(),
    }))
    .filter((actor) => actor.displayName.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function listActivity(request: Request, rawTargetType: string, targetId: string) {
  const targetType = collaborationTargetTypeSchema.parse(rawTargetType);
  const actor = await actorWithPermission(request, targetDescriptors[targetType].read);
  await assertTarget(actor, targetType, targetId);
  const query = queryParams(
    request,
    "GET /api/v2/admin/collaboration/:targetType/:targetId/activity",
  );
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
  const preferences = await prisma.operationalWorkPreference.findMany({
    where: { sourceType: targetType, sourceId: targetId, watching: true },
    select: { actorId: true },
    orderBy: { actorId: "asc" },
  });
  return ok({
    items,
    actors: await resolveCollaborationActors([
      ...items.flatMap((item) => [
        item.actorId,
        ...item.mentionedIds,
        ...(item.metadata.handoffToActorId ? [item.metadata.handoffToActorId] : []),
      ]),
      ...preferences.map((preference) => preference.actorId),
    ]),
    watching: preferences.some((preference) => preference.actorId === actor.id),
    watcherIds: preferences.map((preference) => preference.actorId),
    pageInfo: { hasNextPage: rows.length > query.limit, endCursor: rows.length > query.limit ? items.at(-1)?.id ?? null : null },
    asOf: new Date().toISOString(),
  });
}

export async function createActivity(request: Request, rawTargetType: string, targetId: string) {
  const targetType = collaborationTargetTypeSchema.parse(rawTargetType);
  const actor = await actorWithPermission(request, targetDescriptors[targetType].write);
  const input = await jsonBody(
    request,
    "POST /api/v2/admin/collaboration/:targetType/:targetId/activity",
  );
  const key = requireIdempotencyKey(request);
  const hash = canonicalJsonHash({ targetType, targetId, input });
  const existing = await prisma.adminCollaborationActivity.findUnique({
    where: { actorId_idempotencyKey: { actorId: actor.id, idempotencyKey: key } },
  });
  if (existing) return replayActivity(existing, hash);
  await assertTarget(actor, targetType, targetId);
  const referencedActorIds = [...new Set([
    ...input.mentionedIds,
    ...(input.metadata.handoffToActorId ? [input.metadata.handoffToActorId] : []),
    ...input.metadata.checklistItems.flatMap((item) => item.ownerId ? [item.ownerId] : []),
  ])];
  const mentionedIds = [...new Set([
    ...input.mentionedIds,
    ...(input.metadata.handoffToActorId ? [input.metadata.handoffToActorId] : []),
  ].filter((id) => id !== actor.id))].sort();
  if (referencedActorIds.length > 0) {
    const referencedUsers = await prisma.user.count({ where: { id: { in: referencedActorIds }, status: "active" } });
    if (referencedUsers !== referencedActorIds.length) throw Errors.badRequest("Every referenced actor must be an active user");
  }
  if (input.parentId) {
    const parent = await prisma.adminCollaborationActivity.findFirst({ where: { id: input.parentId, targetType, targetId }, select: { id: true } });
    if (!parent) throw Errors.badRequest("Parent activity must belong to the same collaboration target");
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      const before = input.kind === "handoff"
        ? await collaborationAuthority(tx, targetType, targetId)
        : null;
      if (input.kind === "handoff" && !before) throw Errors.notFound("Collaboration target was not found");
      const activity = await tx.adminCollaborationActivity.create({
        data: {
          targetType,
          targetId,
          kind: input.kind,
          actorId: actor.id,
          body: input.body,
          mentionedIds,
          metadata: {
            ...input.metadata,
            _requestHash: hash,
          } as Prisma.InputJsonValue,
          parentId: input.parentId,
          idempotencyKey: key,
          requestHash: hash,
        },
      });
      if (input.kind === "handoff" && before?.version !== input.expectedVersion) {
        throw Errors.conflict("Collaboration target changed; reload before handing it off");
      }
      if (input.kind === "handoff" && before?.ownerId === input.metadata.handoffToActorId) {
        throw Errors.badRequest("The target actor already owns this collaboration target");
      }
      const authority = input.kind === "handoff"
        ? await transferCollaborationAuthority(tx, {
            targetType,
            targetId,
            expectedVersion: input.expectedVersion!,
            ownerId: input.metadata.handoffToActorId!,
          })
        : before;
      if (authority) {
        await tx.adminCollaborationActivity.update({
          where: { id: activity.id },
          data: {
            metadata: {
              ...input.metadata,
              _requestHash: hash,
              _authority: authority,
            } as Prisma.InputJsonValue,
          },
        });
      }
      if (input.kind === "handoff" && before && authority) {
        const evidence = {
          activityId: activity.id,
          targetType,
          targetId,
          fromOwnerId: before.ownerId,
          toOwnerId: authority.ownerId,
          fromVersion: before.version,
          toVersion: authority.version,
          requestHash: hash,
          reason: input.body,
        };
        await tx.adminAuditLog.create({
          data: {
            actorId: actor.id,
            actorRole: actor.role,
            action: "collaboration.handoff",
            targetType,
            targetId,
            reason: input.body,
            before: { ownerId: before.ownerId, version: before.version },
            after: { ownerId: authority.ownerId, version: authority.version, activityId: activity.id },
            requestId: key,
          },
        });
        await tx.mainOutboxEvent.create({
          data: {
            eventType: "admin.collaboration.handoff.v2",
            aggregateType: targetType,
            aggregateId: targetId,
            payload: evidence,
          },
        });
      }
      return { activity, authority };
    });
    return ok({ activity: activityDto(result.activity), authority: result.authority, duplicate: false }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.adminCollaborationActivity.findUnique({
        where: { actorId_idempotencyKey: { actorId: actor.id, idempotencyKey: key } },
      });
      if (raced) return replayActivity(raced, hash);
    }
    throw error;
  }
}

export async function setWatching(request: Request, rawTargetType: string, targetId: string) {
  const targetType = collaborationTargetTypeSchema.parse(rawTargetType);
  const actor = await actorWithPermission(request, targetDescriptors[targetType].read);
  await assertTarget(actor, targetType, targetId);
  const input = await jsonBody(
    request,
    "PUT /api/v2/admin/collaboration/:targetType/:targetId/watch",
  );
  const key = requireIdempotencyKey(request);
  const hash = canonicalJsonHash({ targetType, targetId, input });
  const result = await prisma.$transaction(async (tx) => {
    const previous = await tx.adminCollaborationActivity.findUnique({
      where: { actorId_idempotencyKey: { actorId: actor.id, idempotencyKey: key } },
    });
    if (previous) {
      if (activityRequestHash(previous) !== hash) throw Errors.conflict("Idempotency key was reused with a different watch request");
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
        requestHash: hash,
      },
    });
    return { preference, duplicate: false };
  });
  return ok({ watching: result.preference.watching, duplicate: result.duplicate });
}

export async function listMentions(request: Request) {
  const actor = await actorWithPermission(request, "dashboard.read");
  const actorPermissions = await effectivePermissions(actor.id, actor.role);
  const query = queryParams(request, "GET /api/v2/admin/collaboration/mentions");
  const rows = await prisma.adminCollaborationActivity.findMany({
    where: { mentionedIds: { has: actor.id }, ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
    orderBy: { id: "desc" },
    take: query.limit + 1,
  });
  const visibleRows = (await Promise.all(rows.map(async (row) => {
      const targetType = collaborationTargetTypeSchema.safeParse(row.targetType);
      if (!targetType.success || !actorPermissions.has(targetDescriptors[targetType.data].read)) return null;
      return await targetAccess(actor, targetType.data, row.targetId) === "allowed" ? row : null;
    }))).filter((row): row is NonNullable<typeof row> => row !== null);
  const items = visibleRows
    .slice(0, query.limit)
    .map(activityDto);
  return ok({ items, pageInfo: { hasNextPage: rows.length > query.limit, endCursor: rows.length > query.limit ? items.at(-1)?.id ?? null : null } });
}

function viewDto(view: Awaited<ReturnType<typeof prisma.adminSavedView.findFirstOrThrow>>) {
  return { id: view.id, scope: view.scope, label: view.label, queryState: view.queryState ?? view.filters, version: view.version, createdAt: view.createdAt.toISOString(), updatedAt: view.updatedAt.toISOString() };
}

export async function listSavedViewsV2(request: Request) {
  const { scope } = queryParams(request, "GET /api/v2/admin/saved-views");
  const actor = await actorWithPermission(request, targetDescriptors[scope].read);
  const views = await prisma.adminSavedView.findMany({ where: { ownerId: actor.id, scope }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
  return ok({ items: views.map(viewDto) });
}

export async function createSavedViewV2(request: Request) {
  const input = await jsonBody(request, "POST /api/v2/admin/saved-views");
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
  // SPEC: the only Admin v2 write still parsing its own body instead of naming its
  // operation id.
  // INTENT: the manifest declares `savedViewUpdateSchema+if-match`, so `jsonBody` would
  // start demanding an If-Match header — and the shipped console (SavedViewsControl
  // `updateSelected`) sends the version in `expectedVersion` only. Wiring this one would
  // 400 every Saved View rename in production. Stale writes are already rejected: the
  // `updateMany` below is version-scoped. Retire this branch by having the console pass
  // `ifMatch: current.version`, then key it like the rest.
  const input = savedViewUpdateSchema.parse(await jsonBody(request));
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
  return ok(savedViewDeleteSchema.parse({ deleted: true }));
}
