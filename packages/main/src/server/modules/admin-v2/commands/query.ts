import { adminCommandStatusSchema } from "@idream/shared/admin";
import { AppError, Errors } from "@/server/lib/errors";
import { fail, ok } from "@/server/lib/http";
import { prisma } from "@/server/lib/db";
import {
  actorWithPermission,
} from "@/server/modules/admin/service";
import type { PermissionKey } from "@/server/admin/permissions";

function readPermission(targetType: string): PermissionKey {
  if (targetType === "character_release") return "character.release.read";
  if (targetType === "creative_run") return "creative.run.read";
  if (targetType === "ops_incident") return "ops.incident.read";
  if (targetType === "admin_case") return "case.read";
  if (targetType === "chat_session") return "character.release.read";
  return "audit.read";
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
    await actorWithPermission(request, "dashboard.read");
    const command = await prisma.controlPlaneCommand.findUnique({ where: { id: commandId } });
    if (!command) throw Errors.notFound("Admin command not found", { commandId });
    await actorWithPermission(request, readPermission(command.targetType));
    const data = adminCommandStatusSchema.parse({
      commandId: command.id,
      requestId: command.requestId,
      commandType: command.commandType,
      target: { type: command.targetType, id: command.targetId },
      status: command.status,
      verificationState: verificationState(command.status),
      needsReconciliation: command.needsReconciliation,
      createdAt: command.createdAt.toISOString(),
      updatedAt: command.updatedAt.toISOString(),
    });
    return ok(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    throw error;
  }
}
