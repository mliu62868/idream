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
import type { PrismaClient } from "@prisma/client";

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

type CommandTarget = {
  readonly id: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly requestPayload: unknown;
};

export type CommandReadScope = {
  readonly permission: PermissionKey;
  readonly characterId?: string;
};

// Resolve scope from the actual target for both the command endpoint and its navigation links.
export async function commandReadScopes(
  db: Pick<PrismaClient, "recentChat" | "characterRelease" | "characterProject">,
  commands: readonly CommandTarget[],
): Promise<ReadonlyMap<string, CommandReadScope>> {
  const targetIds = (type: AdminCommandTargetType) => commands
    .filter((command) => command.targetType === type)
    .map((command) => command.targetId);
  const sessionIds = targetIds("chat_session");
  const releaseIds = targetIds("character_release");
  const [sessions, releases] = await Promise.all([
    sessionIds.length ? db.recentChat.findMany({
      where: { sessionId: { in: sessionIds } }, select: { sessionId: true, characterId: true },
    }) : [],
    releaseIds.length ? db.characterRelease.findMany({
      where: { id: { in: releaseIds } }, select: { id: true, projectId: true },
    }) : [],
  ]);
  const projectIds = [...targetIds("character_project"), ...releases.map((release) => release.projectId)];
  const projects = projectIds.length ? await db.characterProject.findMany({
    where: { id: { in: projectIds } }, select: { id: true, characterId: true },
  }) : [];
  const sessionCharacters = new Map(sessions.map((row) => [row.sessionId, row.characterId]));
  const projectCharacters = new Map(projects.map((row) => [row.id, row.characterId]));
  const releaseProjects = new Map(releases.map((row) => [row.id, row.projectId]));
  return new Map(commands.flatMap((command) => {
    if (!isAdminCommandTargetType(command.targetType)) return [];
    const permission = commandTargetReadPermission(command.targetType);
    if (!permission.startsWith("character.")) return [[command.id, { permission }] as const];
    let characterId: string | undefined;
    switch (command.targetType) {
      case "character_serving": characterId = command.targetId; break;
      case "chat_session": characterId = sessionCharacters.get(command.targetId); break;
      case "character_project": characterId = projectCharacters.get(command.targetId); break;
      case "character_release": {
        const projectId = releaseProjects.get(command.targetId);
        characterId = projectId ? projectCharacters.get(projectId) : undefined;
        break;
      }
    }
    return [[command.id, {
      permission,
      characterId: characterId ?? payloadCharacterId(command.requestPayload) ?? UNRESOLVED_CHARACTER_TARGET,
    }] as const];
  }));
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
    const scope = (await commandReadScopes(prisma, [command])).get(command.id);
    if (!scope) throw Errors.internal("Command target type has no declared read authority", { targetType: command.targetType });
    await requireActorPermission(
      request,
      actor,
      scope.permission,
      scope.characterId ? { characterId: scope.characterId } : undefined,
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
