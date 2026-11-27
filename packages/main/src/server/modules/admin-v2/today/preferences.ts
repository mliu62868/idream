import {
  operationalWorkPreferenceSchema,
  type AdminPermissionKey,
  type TodaySourceType,
} from "@idream/shared/admin";
import { effectiveCharacterIdsForPermission } from "@/server/admin/effective-permissions";
import type { ActorRole } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { assertIncidentReadable } from "@/server/modules/admin-v2/incidents/scope";
import { assertCharacterInScope } from "@/server/modules/admin-v2/shared/authority";
import { creativeRunCharacterId } from "@/server/modules/admin-v2/creative/run-scope";
import { commandReadScopes } from "@/server/modules/admin-v2/commands/query";
import { updateWorkPreference } from "../shared/work-preferences";

type Actor = { id: string; role: string };

/**
 * SPEC: 持有 `permission` 且角色范围覆盖 `characterId`；范围外（或目标解析不到角色）是与
 *       `assertCharacterInScope` 同形的 403。全局授予的人原样放行。
 */
async function assertCharacterScopedRead(
  actor: Actor,
  permissions: ReadonlySet<AdminPermissionKey>,
  permission: AdminPermissionKey,
  characterId: string | null,
) {
  if (!permissions.has(permission)) throw Errors.forbidden("Target is outside the actor's read scope", { permission });
  const scope = await effectiveCharacterIdsForPermission(actor.id, actor.role as ActorRole, permission);
  assertCharacterInScope(scope, permission, characterId);
}

/**
 * SPEC: 角色级 creative.run.read 只够得着被分配角色下的 Run；范围外（含非角色目标、或 Run 不存在）
 *       是与 `assertCharacterInScope` 同形的 403。全局授予的人原样放行，Run 不存在时返回 null。
 */
async function creativeRunInReadScope(actor: Actor, runId: string) {
  const run = await prisma.contentProductionBatch.findUnique({
    where: { id: runId },
    select: { targetType: true, targetId: true },
  });
  const scope = await effectiveCharacterIdsForPermission(actor.id, actor.role as ActorRole, "creative.run.read");
  assertCharacterInScope(scope, "creative.run.read", run ? creativeRunCharacterId(run) : null);
  return run;
}

async function assertReadableSource(
  actor: Actor,
  permissions: ReadonlySet<AdminPermissionKey>,
  sourceType: TodaySourceType,
  sourceId: string,
) {
  if (sourceType === "collaboration_mention") {
    const activity = await prisma.adminCollaborationActivity.findUnique({
      where: { id: sourceId },
      select: { targetType: true, targetId: true, mentionedIds: true },
    });
    if (!activity) throw Errors.notFound("Mention not found");
    if (!activity.mentionedIds.includes(actor.id)) {
      throw Errors.forbidden("Mention is outside the actor's read scope");
    }
    if (activity.targetType === "case") {
      return assertReadableSource(actor, permissions, "admin_case", activity.targetId);
    }
    if (activity.targetType === "incident") {
      return assertReadableSource(actor, permissions, "ops_incident", activity.targetId);
    }
    if (activity.targetType === "creative_run") {
      return assertReadableSource(actor, permissions, "creative_run", activity.targetId);
    }
    throw Errors.forbidden("Mention target is outside the actor's read scope");
  }
  if (sourceType === "admin_case") {
    if (!permissions.has("case.read")) throw Errors.forbidden("Case is outside the actor's read scope");
    const row = await prisma.adminCase.findUnique({ where: { id: sourceId }, select: { type: true } });
    if (!row) throw Errors.notFound("Case not found");
    if (actor.role === "support" && !["support_request", "billing_dispute"].includes(row.type)) {
      throw Errors.forbidden("Case subtype is outside the actor's permission scope");
    }
    return;
  }
  if (sourceType === "ops_incident") {
    if (!permissions.has("ops.incident.read")) throw Errors.forbidden("Incident is outside the actor's read scope");
    const row = await prisma.opsIncident.findUnique({ where: { id: sourceId }, select: { id: true } });
    if (!row) throw Errors.notFound("Incident not found");
    if (!await assertIncidentReadable(prisma, actor, sourceId)) {
      throw Errors.forbidden("Incident is outside the actor's permission scope");
    }
    return;
  }
  if (sourceType === "control_plane_command") {
    const row = await prisma.controlPlaneCommand.findUnique({
      where: { id: sourceId },
      select: { id: true, targetType: true, targetId: true, actorId: true, requestPayload: true },
    });
    if (!row) throw Errors.notFound("Command not found");
    if (row.actorId !== actor.id) throw Errors.forbidden("Command is outside the actor's read scope");
    // SPEC: 与 GET /commands/:id 同一份目标读权限与角色解析（commandReadScopes）：
    //       角色类目标（Release / Serving / Run / Project / 会话）按目标所属角色核对范围。
    const scope = (await commandReadScopes(prisma, [row])).get(row.id);
    if (!scope) {
      // 未声明读权限的目标类型：沿用全局审计读权限。
      if (!permissions.has("audit.read")) throw Errors.forbidden("Command is outside the actor's read scope");
      return;
    }
    if (scope.characterId !== undefined) {
      await assertCharacterScopedRead(actor, permissions, scope.permission, scope.characterId);
      return;
    }
    if (!permissions.has(scope.permission)) throw Errors.forbidden("Command is outside the actor's read scope");
    return;
  }
  if (sourceType === "character_release") {
    if (!permissions.has("character.release.read")) throw Errors.forbidden("Character Release is outside the actor's read scope");
    const release = await prisma.characterRelease.findUnique({ where: { id: sourceId }, select: { projectId: true } });
    const project = release
      ? await prisma.characterProject.findUnique({ where: { id: release.projectId }, select: { characterId: true } })
      : null;
    // INVARIANT: 角色级 character.release.read 只够得着被分配角色的 Release；范围检查先于存在性判断，
    //            受限账号看不出范围外的 Release 是否存在。
    await assertCharacterScopedRead(actor, permissions, "character.release.read", project?.characterId ?? null);
    if (!release) throw Errors.notFound("Character Release not found");
    return;
  }
  if (!permissions.has("creative.run.read")) throw Errors.forbidden("Creative Run is outside the actor's read scope");
  if (!await creativeRunInReadScope(actor, sourceId)) throw Errors.notFound("Creative Run not found");
}

export async function updateOperationalWorkPreference(input: {
  actor: Actor;
  permissions: ReadonlySet<AdminPermissionKey>;
  sourceType: TodaySourceType;
  sourceId: string;
  watching?: boolean;
  pinned?: boolean;
  snoozedUntil?: Date | null;
  requestId: string;
  expectedVersion: number;
}) {
  await assertReadableSource(input.actor, input.permissions, input.sourceType, input.sourceId);
  return prisma.$transaction(async (tx) => {
    const { before: prior, preference } = await updateWorkPreference(tx, { ...input, actorId: input.actor.id });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "today.preference.updated",
        targetType: input.sourceType,
        targetId: input.sourceId,
        before: prior ? toInputJson({ watching: prior.watching, pinned: prior.pinned, snoozedUntil: prior.snoozedUntil, version: prior.version }) : undefined,
        after: toInputJson({ watching: preference.watching, pinned: preference.pinned, snoozedUntil: preference.snoozedUntil, version: preference.version }),
        requestId: input.requestId,
      },
    });
    return operationalWorkPreferenceSchema.parse({
      sourceType: preference.sourceType,
      sourceId: preference.sourceId,
      watching: preference.watching,
      pinned: preference.pinned,
      snoozedUntil: preference.snoozedUntil?.toISOString() ?? null,
      version: preference.version,
    });
  });
}
