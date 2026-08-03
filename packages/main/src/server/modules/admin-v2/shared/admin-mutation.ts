import { Prisma } from "@prisma/client";
import {
  ADMIN_V2_API_OPERATIONS,
  findAdminV2ApiOperation,
  requireExecutableAdminV2Contract,
  type AdminV2ApiOperation,
  type AdminV2RequestContractRef,
  type ExecutableAdminV2Contract,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { executeAtomicIdempotentMutation } from "./atomic-mutation";
import {
  authenticatedAdminActor,
  jsonBody,
  requireActorPermission,
  type AdminActor,
} from "./authority";
import { acceptControlPlaneCommand } from "./control-plane-command";

export type AdminMutationOperationDefinition = {
  readonly operation: AdminV2ApiOperation & {
    readonly mutation: NonNullable<AdminV2ApiOperation["mutation"]>;
  };
  readonly request: ExecutableAdminV2Contract;
  readonly response: ExecutableAdminV2Contract;
};

export function requireAdminMutationOperation(
  operationId: string,
): AdminMutationOperationDefinition {
  const operation = ADMIN_V2_API_OPERATIONS.find(({ id }) => id === operationId);
  if (!operation) throw Errors.internal("Unknown Admin mutation operation", { operationId });
  if (!operation.mutation) {
    throw Errors.internal("Admin operation is not a mutation", { operationId });
  }
  const request = requireExecutableAdminV2Contract(operation.contract.request);
  const response = requireExecutableAdminV2Contract(operation.contract.response);
  const transport = transportFromRequirements(request.requirements);
  if (transport !== operation.mutation.transport) {
    throw Errors.internal("Admin mutation transport does not match its request contract", {
      operationId,
      manifestTransport: operation.mutation.transport,
      contractTransport: transport,
    });
  }
  return {
    operation: operation as AdminMutationOperationDefinition["operation"],
    request,
    response,
  };
}

export type AdminMutationContext<Body> = {
  readonly actor: AdminActor;
  readonly body: Body;
  readonly params: Readonly<Record<string, string>>;
  readonly requestId: string;
  readonly idempotencyKey?: string;
  readonly expectedVersion?: number;
};

export async function executeAdminMutation<Body, Prepared = undefined>(
  operationId: string,
  request: Request,
  options: {
    readonly params: Readonly<Record<string, string>>;
    readonly permission?: Parameters<typeof requireActorPermission>[2];
    readonly resource?: { readonly characterId?: string };
    readonly target: (
      context: AdminMutationContext<Body>,
    ) => { readonly type: string; readonly id: string };
    readonly expectedVersion?: (body: Body) => number;
    readonly reason?: (body: Body) => string;
    readonly prepare?: (
      context: AdminMutationContext<Body>,
    ) => Promise<Prepared>;
    readonly mutate?: (
      tx: Prisma.TransactionClient,
      context: AdminMutationContext<Body>,
      prepared: Prepared,
    ) => Promise<unknown>;
    readonly decorateResult?: (result: unknown, replayed: boolean) => unknown;
    readonly coordinationKey?: (
      context: AdminMutationContext<Body>,
    ) => string | undefined;
    readonly maxAttempts?: number;
  },
) {
  const definition = requireAdminMutationOperation(operationId);
  const concrete = findAdminV2ApiOperation(request.method, new URL(request.url).pathname);
  if (concrete?.id !== definition.operation.id) {
    throw Errors.internal("Admin mutation operation does not match the HTTP route", {
      declared: definition.operation.id,
      resolved: concrete?.id ?? null,
    });
  }

  // INVARIANT: authentication and permission checks happen before body parsing.
  const actor = await authenticatedAdminActor(request);
  const permission = options.permission ?? staticPermission(definition.operation);
  await requireActorPermission(request, actor, permission, options.resource);

  const body = definition.request.schema.parse(
    await mutationBody(request, definition.operation.contract.request),
  ) as Body;
  const idempotencyKey = definition.request.requirements.includes("idempotency-key")
    ? requiredIdempotencyKey(request)
    : undefined;
  const headerVersion = definition.request.requirements.includes("if-match")
    ? requiredIfMatch(request)
    : undefined;
  const bodyVersion = options.expectedVersion?.(body);
  if (headerVersion !== undefined && bodyVersion !== undefined && headerVersion !== bodyVersion) {
    throw Errors.badRequest("If-Match and request body identify different authority versions");
  }
  const expectedVersion = bodyVersion ?? headerVersion;
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  const context: AdminMutationContext<Body> = {
    actor,
    body,
    params: options.params,
    requestId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  };
  const target = options.target(context);
  const metadata = definition.operation.mutation;

  let result: unknown;
  if (metadata.executionMode === "durable") {
    if (!idempotencyKey) {
      throw Errors.internal("Durable Admin mutation is missing idempotency transport");
    }
    result = await acceptControlPlaneCommand(prisma, {
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      commandType: metadata.commandType,
      target,
      expectedVersion,
      payload: body,
      reason: options.reason?.(body) ?? requiredReason(body),
      requestId,
      coordinationKey: options.coordinationKey?.(context),
      maxAttempts: options.maxAttempts,
    });
  } else if (idempotencyKey) {
    if (!options.mutate) {
      throw Errors.internal("Atomic Admin mutation is missing its domain callback");
    }
    result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: metadata.commandType,
      target,
      expectedVersion,
      payload: body,
      prepare: options.prepare ? () => options.prepare!(context) : undefined,
      mutate: (tx, prepared) => options.mutate!(tx, context, prepared),
      decorateResult: options.decorateResult,
    });
  } else {
    if (!options.mutate) {
      throw Errors.internal("Atomic Admin mutation is missing its domain callback");
    }
    const prepared = options.prepare
      ? await options.prepare(context)
      : undefined as Prepared;
    result = await prisma.$transaction(
      (tx) => options.mutate!(tx, context, prepared),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
  return definition.response.schema.parse(result);
}

function transportFromRequirements(
  requirements: ExecutableAdminV2Contract["requirements"],
) {
  const idempotency = requirements.includes("idempotency-key");
  const ifMatch = requirements.includes("if-match");
  if (idempotency && ifMatch) return "idempotency_key_and_if_match" as const;
  if (idempotency) return "idempotency_key" as const;
  if (ifMatch) return "if_match" as const;
  return null;
}

function staticPermission(operation: AdminV2ApiOperation) {
  const authorization = operation.authorization;
  if (authorization.kind === "bootstrap") {
    throw Errors.internal("Bootstrap cannot execute an Admin mutation");
  }
  if (authorization.kind === "all_of") return authorization.permissions[0];
  throw Errors.internal("Resource-sensitive Admin mutation must declare its resolved permission", {
    operationId: operation.id,
    resolver: authorization.resolver,
  });
}

async function mutationBody(request: Request, contract: AdminV2RequestContractRef) {
  return request.method === "DELETE" ? {} : jsonBody(request, contract);
}

function requiredIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) throw Errors.badRequest("Idempotency-Key header is required");
  return value;
}

function requiredIfMatch(request: Request) {
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

function requiredReason(body: unknown) {
  const reason = body && typeof body === "object" && "reason" in body
    ? (body as { reason?: unknown }).reason
    : undefined;
  if (typeof reason !== "string" || !reason.trim()) {
    throw Errors.badRequest("Durable Admin mutation requires a reason");
  }
  return reason.trim();
}
