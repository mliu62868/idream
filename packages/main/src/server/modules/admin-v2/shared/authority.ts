import type { z } from "zod";
import type * as adminContracts from "@idream/shared/admin/contracts";
import {
  ADMIN_V2_API_OPERATIONS,
  ADMIN_V2_HTTP_METHODS,
  findAdminV2ApiOperation,
  resolveAdminV2ManifestAuthorization,
  type AdminV2ApiOperation,
  type AdminV2DeclaredOperationId,
  type AdminV2DeclaredRequestRef,
  type AdminV2DeclaredRequestRefFor,
  type AdminV2RequestContractRef,
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

type AdminContracts = typeof adminContracts;

/** `caseDecisionRequestSchema+idempotency-key` -> `caseDecisionRequestSchema`. */
type ContractBaseRef<Ref extends string> = Ref extends `${infer Base}+${string}`
  ? Base
  : Ref;

/**
 * SPEC: every body the manifest can hand a handler, keyed by the ref that names it.
 * INTENT: bounded to the refs the manifest declares. Indexing the whole contract barrel by a
 * ref that is still generic — as a caller that keys by operation id does — expands to every
 * export the barrel has, which tsc rejects as "union type too complex".
 */
type AdminV2DeclaredBody = {
  [Name in ContractBaseRef<AdminV2DeclaredRequestRef>]: Name extends keyof AdminContracts
    ? AdminContracts[Name] extends z.ZodType<infer Output> ? Output : unknown
    : unknown;
};

/**
 * SPEC: the body a handler receives is whatever the manifest's request ref names,
 * resolved through the same contract barrel `contract-registry` executes against.
 * INTENT: transport-only refs (`none` / `if-match` / `limit-query` / `path:*`) carry no
 * parsed body, so they stay `unknown` instead of pretending to be a domain shape.
 */
export type AdminV2RequestBody<Ref extends AdminV2RequestContractRef> =
  ContractBaseRef<Ref> extends keyof AdminV2DeclaredBody
    ? AdminV2DeclaredBody[ContractBaseRef<Ref> & keyof AdminV2DeclaredBody]
    : unknown;

/** `POST /api/v2/admin/today/claim` reads as an operation id; a contract ref never does. */
function isDeclaredOperationId(declared: string): boolean {
  return ADMIN_V2_HTTP_METHODS.some((method) => declared.startsWith(`${method} /api/v2/admin/`));
}

/**
 * SPEC: parses an Admin write body exactly once, with the schema the manifest declares.
 * INTENT: `declared` names the manifest entry, never a second source of truth — a value the
 * manifest does not own for this method+path fails closed as `internal`, so a handler can no
 * longer quietly narrow the body with a different schema.
 * INTENT: two doors on purpose. Module handlers key by `operationId`, the same key
 * `executeAdminMutation` already takes, so the schema is never an input at all. Route Handlers
 * that are not routed through `executeAdminMutation` key by contract ref, because a Route
 * Handler file has no operation id of its own — its method plus its directory *is* the id.
 * Both keys are unions of what the manifest declares, so a name that does not exist is a
 * compile error either way.
 * INVARIANT: the manifest check runs before the per-Request cache, so two calls that
 * name different contracts cannot share one parse.
 */
export function jsonBody(request: Request): Promise<unknown>;
export function jsonBody<const Id extends AdminV2DeclaredOperationId>(
  request: Request,
  operationId: Id,
): Promise<AdminV2RequestBody<AdminV2DeclaredRequestRefFor<Id>>>;
export function jsonBody<const Ref extends AdminV2DeclaredRequestRef>(
  request: Request,
  contract: Ref,
): Promise<AdminV2RequestBody<Ref>>;
export async function jsonBody(request: Request, declared?: string): Promise<unknown> {
  const pathname = new URL(request.url).pathname;
  const operation = findAdminV2ApiOperation(request.method, pathname);
  if (declared !== undefined) {
    const owned = isDeclaredOperationId(declared)
      ? operation?.id
      : operation?.contract.request;
    if (owned !== declared) {
      throw Errors.internal("Admin v2 handler declared a request contract the manifest does not own", {
        method: request.method,
        pathname,
        declared,
        manifest: owned ?? null,
      });
    }
  }
  const cached = parsedAdminBodies.get(request);
  if (cached) return cached;
  const parsed = parseManifestBody(request, pathname, operation);
  parsedAdminBodies.set(request, parsed);
  return parsed;
}

/** The read half of the manifest — the only operations that carry a contract in the URL. */
type AdminV2DeclaredReadOperationId = Extract<AdminV2DeclaredOperationId, `GET ${string}`>;

/**
 * SPEC: parses an Admin read query with the schema the manifest declares for `operationId`.
 * INTENT: `jsonBody`'s twin for the other half of the request line. A GET carries its contract
 * in the URL, so the body door cannot serve it, and without this every GET module held its own
 * imported schema — a second authority nothing reconciled with the manifest.
 * INTENT: one door, keyed by operation id. A GET Route Handler delegates the read to a module
 * and it is the module that needs the query, so there is no Route-Handler-shaped caller to serve.
 * INTENT: takes the URL carrier rather than a `Request`, because one module receives only
 * `request.url` across an in-process seam and a query needs nothing else. The method is not an
 * input either: the id type admits GET operations only.
 * INVARIANT: the manifest owns the schema; the URL only cross-checks the id. A pathname that
 * resolves to a different operation is a module reading someone else's query and fails closed.
 * A pathname the manifest does not own carries no claim that could contradict the id.
 */
export function queryParams<const Id extends AdminV2DeclaredReadOperationId>(
  source: { readonly url: string },
  operationId: Id,
): AdminV2RequestBody<AdminV2DeclaredRequestRefFor<Id>> {
  const declared = ADMIN_V2_API_OPERATIONS.find((operation) => operation.id === operationId);
  if (!declared) {
    throw Errors.internal("Admin v2 handler read a query the manifest does not declare", {
      operationId,
    });
  }
  const url = new URL(source.url);
  const concrete = findAdminV2ApiOperation("GET", url.pathname);
  if (concrete && concrete.id !== operationId) {
    throw Errors.internal("Admin v2 handler read the query of a different operation", {
      declared: operationId,
      resolved: concrete.id,
    });
  }
  const contract = requireExecutableAdminV2Contract(declared.contract.request);
  if (contract.kind !== "zod") {
    throw Errors.internal("Admin v2 operation declares no query contract", {
      operationId,
      contract: declared.contract.request,
    });
  }
  return contract.schema.parse(
    Object.fromEntries(url.searchParams),
  ) as AdminV2RequestBody<AdminV2DeclaredRequestRefFor<Id>>;
}

async function parseManifestBody(
  request: Request,
  pathname: string,
  operation: AdminV2ApiOperation | null,
): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const text = await request.text();
  const raw = text ? JSON.parse(text) as unknown : {};
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
