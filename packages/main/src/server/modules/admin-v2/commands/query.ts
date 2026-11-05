import {
  ADMIN_COMMAND_TARGET_READ_PERMISSIONS,
  adminCommandStatusSchema,
  type AdminCommandTargetType,
} from "@idream/shared/admin";
import { AppError, Errors } from "@/server/lib/errors";
import { fail, ok } from "@/server/lib/http";
import { prisma } from "@/server/lib/db";
import {
  actorWithPermission,
  requireActorPermission,
} from "@/server/modules/admin-v2/shared/authority";
import type { PermissionKey } from "@/server/admin/permissions";

function isAdminCommandTargetType(targetType: string): targetType is AdminCommandTargetType {
  return Object.hasOwn(ADMIN_COMMAND_TARGET_READ_PERMISSIONS, targetType);
}

export function commandTargetReadPermission(targetType: string): PermissionKey {
  if (!isAdminCommandTargetType(targetType)) {
    throw Errors.internal("Command target type has no declared read authority", { targetType });
  }
  return ADMIN_COMMAND_TARGET_READ_PERMISSIONS[targetType];
}

// Never a Character id, so an unresolvable target can only pass for an actor with global scope.
const UNRESOLVED_CHARACTER_TARGET = "unresolved-command-target";

function payloadCharacterId(payload: unknown) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const { characterId } = payload as { characterId?: unknown };
  return typeof characterId === "string" && characterId ? characterId : null;
}

// SPEC: The Character a command acted on, resolved from its target rather than from the actor's
// input, so that Character scope applies to reading a command as it did to issuing it.
async function commandTargetCharacterId(command: {
  readonly targetType: string;
  readonly targetId: string;
  readonly requestPayload: unknown;
}) {
  if (command.targetType === "character_serving") return command.targetId;
  if (command.targetType === "chat_session") {
    const session = await prisma.recentChat.findUnique({
      where: { sessionId: command.targetId },
      select: { characterId: true },
    });
    return session?.characterId ?? payloadCharacterId(command.requestPayload);
  }
  if (command.targetType === "character_project") {
    const project = await prisma.characterProject.findUnique({
      where: { id: command.targetId },
      select: { characterId: true },
    });
    return project?.characterId ?? payloadCharacterId(command.requestPayload);
  }
  if (command.targetType === "character_release") {
    const release = await prisma.characterRelease.findUnique({
      where: { id: command.targetId },
      select: { projectId: true },
    });
    const project = release && await prisma.characterProject.findUnique({
      where: { id: release.projectId },
      select: { characterId: true },
    });
    return project?.characterId ?? payloadCharacterId(command.requestPayload);
  }
  return payloadCharacterId(command.requestPayload);
}

function verificationState(status: string) {
  if (status === "verifying") return "verifying" as const;
  if (status === "succeeded") return "passed" as const;
  if (status === "failed" || status === "cancelled") return "failed" as const;
  return "pending" as const;
}

export async function getControlPlaneCommand(request: Request, commandId: string) {
  try {
    // Authenticate before looking up the target so unauthenticated callers
    // cannot use 401/404 differences to enumerate command identifiers.
    const actor = await actorWithPermission(request, "dashboard.read");
    const command = await prisma.controlPlaneCommand.findUnique({ where: { id: commandId } });
    if (!command) throw Errors.notFound("Admin command not found", { commandId });
    const permission = commandTargetReadPermission(command.targetType);
    await requireActorPermission(
      request,
      actor,
      permission,
      permission.startsWith("character.")
        ? { characterId: await commandTargetCharacterId(command) ?? UNRESOLVED_CHARACTER_TARGET }
        : undefined,
    );
    const data = adminCommandStatusSchema.parse({
      commandId: command.id,
      requestId: command.requestId,
      commandType: command.commandType,
      target: { type: command.targetType, id: command.targetId },
      status: command.status,
      verificationState: verificationState(command.status),
      needsReconciliation: command.needsReconciliation,
      ...(command.error === null ? {} : { error: command.error }),
      createdAt: command.createdAt.toISOString(),
      updatedAt: command.updatedAt.toISOString(),
    });
    return ok(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    throw error;
  }
}
