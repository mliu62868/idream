import {
  findAdminV2ApiOperation,
  resolveAdminV2ManifestAuthorization,
} from "@idream/shared/admin/api-manifest";
import type { PermissionKey } from "@/server/admin/permissions";
import {
  effectiveCharacterIdsForPermission,
  effectivePermissions,
} from "@/server/admin/effective-permissions";
import { getAuthCtx, requireUser, type ActorRole } from "@/server/lib/auth";
import { Errors } from "@/server/lib/errors";
import { verifyAdminBffRequest } from "./admin-bff";

export type AdminActor = { id: string; role: ActorRole };

export async function actorWithPermission(
  request: Request,
  permission: PermissionKey,
  resource?: { readonly characterId?: string },
): Promise<AdminActor> {
  const bff = await verifyAdminBffRequest(request);
  if (!bff.ok) {
    throw Errors.unauthorized("Admin BFF authentication failed", { reason: bff.reason });
  }
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const effective = await effectivePermissions(user.id, user.role);
  const pathname = new URL(request.url).pathname;
  const manifestOperation = findAdminV2ApiOperation(request.method, pathname);
  if (pathname.startsWith("/api/v2/admin/") && !manifestOperation && process.env.APP_ENV === "production") {
    throw Errors.internal("Admin v2 operation is missing from the authority manifest", {
      method: request.method,
      pathname,
    });
  }
  const requiredPermissions = manifestOperation
    ? resolveAdminV2ManifestAuthorization(manifestOperation, permission)
    : [permission];
  if (!requiredPermissions) {
    throw Errors.internal("Admin v2 handler asserted an undeclared permission", {
      operation: manifestOperation?.id,
      permission,
    });
  }
  const missingPermission = requiredPermissions.find((required) => !effective.has(required));
  if (missingPermission) {
    throw Errors.forbidden("Missing admin permission", { permission: missingPermission });
  }
  if (resource?.characterId && permission.startsWith("character.")) {
    const allowedCharacterIds = await effectiveCharacterIdsForPermission(user.id, user.role, permission);
    if (allowedCharacterIds !== null && !allowedCharacterIds.has(resource.characterId)) {
      throw Errors.forbidden("Character is outside the effective permission scope", {
        permission,
        characterId: resource.characterId,
      });
    }
  }
  return { id: user.id, role: user.role };
}

export async function jsonBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}
