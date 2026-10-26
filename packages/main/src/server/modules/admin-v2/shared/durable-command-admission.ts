import { randomUUID } from "node:crypto";
import {
  ADMIN_V2_API_OPERATIONS_BY_ID,
  adminCommandAcceptedSchema,
  adminCommandHeadersSchema,
  findAdminV2ApiOperation,
  type AdminV2DeclaredRequestRefFor,
  type AdminV2DurableOperationId,
} from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import {
  actorWithPermission,
  jsonBody,
  parseAdminIfMatch,
  parseRequestInput,
  type AdminV2RequestBody,
} from "./authority";

export type DurableAdminCommandBody<Id extends AdminV2DurableOperationId> =
  AdminV2RequestBody<AdminV2DeclaredRequestRefFor<Id>> & { readonly entityVersion: number };

/** Persisted command identity and retry policy come from the operation, never its URL. */
export function requireDurableAdminCommandOperation(operationId: AdminV2DurableOperationId) {
  const operation = ADMIN_V2_API_OPERATIONS_BY_ID[operationId];
  if (operation.mutation?.executionMode !== "durable") {
    throw Errors.internal("Admin operation does not admit a durable command", { operationId });
  }
  if (operation.authorization.kind !== "all_of") {
    throw Errors.internal("Durable Admin command must declare its admission permission", { operationId });
  }
  return {
    commandType: operation.mutation.commandType,
    retryMode: operation.mutation.retryMode,
    permission: operation.authorization.permissions[0],
  };
}

/**
 * Both standard commands and Incident action plans enter through this seam. The latter
 * keeps its historical receipt hash and atomically changes mitigation when accepting.
 * Authentication precedes input parsing; required headers and optional version agreement
 * are identical regardless of which transaction owns the command admission.
 */
export async function readDurableAdminCommand<const Id extends AdminV2DurableOperationId>(
  request: Request,
  operationId: Id,
  resource?: { readonly characterId?: string },
) {
  const definition = requireDurableAdminCommandOperation(operationId);
  const concrete = findAdminV2ApiOperation(request.method, new URL(request.url).pathname);
  if (concrete?.id !== operationId) {
    throw Errors.internal("Durable Admin command does not match the HTTP route", {
      declared: operationId,
      resolved: concrete?.id ?? null,
    });
  }
  const actor = await actorWithPermission(request, definition.permission, resource);
  const headers = parseRequestInput(adminCommandHeadersSchema, {
    idempotencyKey: request.headers.get("idempotency-key"),
    ifMatch: request.headers.get("if-match") ?? undefined,
    requestId: request.headers.get("x-request-id")?.trim() || randomUUID(),
  });
  const body = await jsonBody(request, operationId) as DurableAdminCommandBody<Id>;
  if (headers.ifMatch) {
    const matchedVersion = parseAdminIfMatch(request);
    if (matchedVersion !== body.entityVersion) {
      throw Errors.badRequest("If-Match must equal body entityVersion", {
        ifMatch: headers.ifMatch,
        entityVersion: body.entityVersion,
      });
    }
  }
  return {
    actor,
    definition,
    body,
    idempotencyKey: headers.idempotencyKey,
    requestId: headers.requestId,
  };
}

export function durableAdminCommandReceipt(command: { readonly id: string; readonly requestId: string }) {
  return adminCommandAcceptedSchema.parse({
    status: "accepted",
    requestId: command.requestId,
    commandId: command.id,
    verificationDeepLink: `/admin/system/audit?commandId=${encodeURIComponent(command.id)}`,
  });
}
