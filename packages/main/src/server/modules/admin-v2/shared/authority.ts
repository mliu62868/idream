import {
  findAdminV2ApiOperation,
  resolveAdminV2ManifestAuthorization,
} from "@idream/shared/admin/api-manifest";
import { requireExecutableAdminV2Contract } from "@idream/shared/admin";
import type { PermissionKey } from "@/server/admin/permissions";
import {
  effectiveCharacterIdsForPermission,
  effectivePermissions,
} from "@/server/admin/effective-permissions";
import { getAuthCtx, requireUser, type ActorRole } from "@/server/lib/auth";
import { Errors } from "@/server/lib/errors";
import { verifyAdminBffRequest } from "./admin-bff";

export type AdminActor = { id: string; role: ActorRole };

const parsedAdminBodies = new WeakMap<Request, Promise<unknown>>();

export async function authenticatedAdminActor(
  request: Request,
): Promise<AdminActor> {
  const bff = await verifyAdminBffRequest(request);
  if (!bff.ok) {
    throw Errors.unauthorized("Admin BFF authentication failed", { reason: bff.reason });
  }
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  return { id: user.id, role: user.role };
}

export async function requireActorPermission(
  request: Request,
  actor: AdminActor,
  permission: PermissionKey,
  resource?: { readonly characterId?: string },
): Promise<AdminActor> {
  const effective = await effectivePermissions(actor.id, actor.role);
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
    const allowedCharacterIds = await effectiveCharacterIdsForPermission(
      actor.id,
      actor.role,
      permission,
    );
    if (allowedCharacterIds !== null && !allowedCharacterIds.has(resource.characterId)) {
      throw Errors.forbidden("Character is outside the effective permission scope", {
        permission,
        characterId: resource.characterId,
      });
    }
  }
  return actor;
}

export async function actorWithPermission(
  request: Request,
  permission: PermissionKey,
  resource?: { readonly characterId?: string },
): Promise<AdminActor> {
  const actor = await authenticatedAdminActor(request);
  return requireActorPermission(request, actor, permission, resource);
}

export async function jsonBody(request: Request): Promise<unknown> {
  const cached = parsedAdminBodies.get(request);
  if (cached) return cached;
  const parsed = parseManifestBody(request);
  parsedAdminBodies.set(request, parsed);
  return parsed;
}

async function parseManifestBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const text = await request.text();
  const raw = text ? JSON.parse(text) as unknown : {};
  const pathname = new URL(request.url).pathname;
  const operation = findAdminV2ApiOperation(request.method, pathname);
  if (!operation) {
    if (pathname.startsWith("/api/v2/admin/")) {
      throw Errors.internal("Admin v2 operation is missing from the authority manifest", {
        method: request.method,
        pathname,
      });
    }
    return raw;
  }
  if (operation.mutation) {
    assertMutationTransportHeaders(request, operation.mutation.transport);
  }
  const contract = requireExecutableAdminV2Contract(operation.contract.request);
  if (contract.kind === "transport") return raw;
  const parsed = contract.schema.parse(raw);
  if (
    operation.mutation?.transport.includes("if_match") &&
    parsed !== null &&
    typeof parsed === "object" &&
    "entityVersion" in parsed &&
    typeof (parsed as { entityVersion?: unknown }).entityVersion === "number"
  ) {
    const ifMatch = parseIfMatch(request);
    if (ifMatch !== (parsed as { entityVersion: number }).entityVersion) {
      throw Errors.badRequest("If-Match and request body identify different authority versions");
    }
  }
  return parsed;
}

function assertMutationTransportHeaders(
  request: Request,
  transport: "idempotency_key" | "if_match" | "idempotency_key_and_if_match",
) {
  if (transport.includes("idempotency_key")) {
    const key = request.headers.get("idempotency-key")?.trim();
    if (!key) throw Errors.badRequest("Idempotency-Key header is required");
  }
  if (transport.includes("if_match")) parseIfMatch(request);
}

function parseIfMatch(request: Request) {
  const value = request.headers
    .get("if-match")
    ?.trim()
    .replace(/^W\//, "")
    .replace(/^"|"$/g, "");
  if (!value || !/^\d+$/.test(value)) {
    throw Errors.badRequest("If-Match must contain an authority version");
  }
  return Number(value);
}
