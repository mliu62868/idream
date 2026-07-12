import {
  operationalWorkPreferenceSchema,
  type AdminPermissionKey,
  type TodaySourceType,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { assertIncidentReadable } from "@/server/modules/admin-v2/incidents/scope";

type Actor = { id: string; role: string };

function canReadCommand(targetType: string, permissions: ReadonlySet<AdminPermissionKey>) {
  if (targetType === "character_release") return permissions.has("character.release.read");
  if (targetType === "creative_run") return permissions.has("creative.run.read");
  if (targetType === "ops_incident") return permissions.has("ops.incident.read");
  if (targetType === "admin_case") return permissions.has("case.read");
  return permissions.has("audit.read");
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
    if (activity.targetType === "character_project") {
      if (!permissions.has("character.project.read")) {
        throw Errors.forbidden("Character Project mention is outside the actor's read scope");
      }
      if (!await prisma.characterProject.findUnique({ where: { id: activity.targetId }, select: { id: true } })) {
        throw Errors.notFound("Character Project not found");
      }
      return;
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
    const row = await prisma.controlPlaneCommand.findUnique({ where: { id: sourceId }, select: { targetType: true, actorId: true } });
    if (!row) throw Errors.notFound("Command not found");
    if (row.actorId !== actor.id || !canReadCommand(row.targetType, permissions)) {
      throw Errors.forbidden("Command is outside the actor's read scope");
    }
    return;
  }
  if (sourceType === "character_release") {
    if (!permissions.has("character.release.read")) throw Errors.forbidden("Character Release is outside the actor's read scope");
    if (!await prisma.characterRelease.findUnique({ where: { id: sourceId }, select: { id: true } })) {
      throw Errors.notFound("Character Release not found");
    }
    return;
  }
  if (!permissions.has("creative.run.read")) throw Errors.forbidden("Creative Run is outside the actor's read scope");
  if (!await prisma.contentProductionBatch.findUnique({ where: { id: sourceId }, select: { id: true } })) {
    throw Errors.notFound("Creative Run not found");
  }
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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.actor.id}:${input.sourceType}:${input.sourceId}`}))`;
    const prior = await tx.operationalWorkPreference.findUnique({
      where: {
        actorId_sourceType_sourceId: {
          actorId: input.actor.id,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
        },
      },
    });
    if ((prior?.version ?? 0) !== input.expectedVersion) {
      throw Errors.conflict("Today preference version changed", {
        expectedVersion: input.expectedVersion,
        currentVersion: prior?.version ?? 0,
      });
    }
    let preference;
    if (!prior) {
      preference = await tx.operationalWorkPreference.create({
        data: {
          actorId: input.actor.id,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          watching: input.watching ?? false,
          pinned: input.pinned ?? false,
          snoozedUntil: input.snoozedUntil ?? null,
        },
      });
    } else {
      const changed = await tx.operationalWorkPreference.updateMany({
        where: { id: prior.id, version: input.expectedVersion },
        data: {
          watching: input.watching,
          pinned: input.pinned,
          snoozedUntil: input.snoozedUntil,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw Errors.conflict("Today preference version changed");
      preference = await tx.operationalWorkPreference.findUniqueOrThrow({ where: { id: prior.id } });
    }
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
