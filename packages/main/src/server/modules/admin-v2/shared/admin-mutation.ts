import { Prisma } from "@prisma/client";
import {
  ADMIN_V2_API_OPERATIONS,
  findAdminV2ApiOperation,
  requireExecutableAdminV2Contract,
  type AdminV2ApiOperation,
  type AdminV2DeclaredOperation,
  type AdminV2DeclaredOperationId,
  type AdminV2DeclaredRequestRef,
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

export type AdminMutationOperationDefinition = {
  // INTENT: the declared union, not the widened operation — it keeps `contract.request` a ref
  // the manifest actually owns, which is what `jsonBody` now demands.
  readonly operation: AdminV2DeclaredOperation & {
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
  // SPEC: 只有 atomic 执行模式的操作走这条入口。
  // INTENT: durable 命令的受理协议（accept → 队列 → executor → 回执）只有
  // `commands/authoritative.ts` 一份实现，它返回 `adminCommandAcceptedSchema` 要求的受理回执。
  // 这里曾经有第二份 durable 分支，返回 `{commandId, status, replayed}`——那个形状过不了
  // `.strict()` 的受理回执契约，任何 durable 操作接到这条入口上都会「命令已受理但响应永远 500」。
  // 与其修好一条没人用的第二实现，不如让它接不上。
  if (operation.mutation.executionMode !== "atomic") {
    throw Errors.internal("Durable Admin command must be accepted by the control-plane handler", {
      operationId,
      executionMode: operation.mutation.executionMode,
    });
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

// SPEC: only an operation id the manifest declares may drive a mutation.
// INTENT: `requireAdminMutationOperation` already fails closed at runtime, but a caller that
// mistypes an id should never reach runtime — the union makes the typo a compile error, and
// the same key already selects the request contract, so nothing else has to agree.
export async function executeAdminMutation<Body, Prepared = undefined>(
  operationId: AdminV2DeclaredOperationId,
  request: Request,
  options: {
    readonly params: Readonly<Record<string, string>>;
    readonly permission?: Parameters<typeof requireActorPermission>[2];
    readonly resource?: { readonly characterId?: string };
    readonly target: (
      context: AdminMutationContext<Body>,
    ) => { readonly type: string; readonly id: string };
    readonly expectedVersion?: (body: Body) => number;
    readonly prepare?: (
      context: AdminMutationContext<Body>,
    ) => Promise<Prepared>;
    readonly mutate: (
      tx: Prisma.TransactionClient,
      context: AdminMutationContext<Body>,
      prepared: Prepared,
    ) => Promise<unknown>;
    readonly decorateResult?: (result: unknown, replayed: boolean) => unknown;
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

  // SPEC: 响应契约在事务内校验，校验失败连同领域写入一起回滚。
  // INTENT: 校验曾经写在这个函数的最后一行，也就是事务提交之后。admin-v2 的响应契约是
  // `.strict()` 且列名与 Prisma 行不同，service 直接 return Prisma 行时：写已提交 → 这里抛
  // → 500；用户重试 → 同一个幂等键取回那条未经校验的 result → 再 500，永远好不了。把校验
  // 交给事务内的 `validateResult`，「写已提交但响应不可表达」这个状态就不存在。
  const validateResult = (value: unknown) => definition.response.schema.parse(value);

  if (idempotencyKey) {
    return await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: metadata.commandType,
      target,
      expectedVersion,
      payload: body,
      prepare: options.prepare ? () => options.prepare!(context) : undefined,
      mutate: (tx, prepared) => options.mutate(tx, context, prepared),
      decorateResult: options.decorateResult,
      validateResult,
    });
  }
  const prepared = options.prepare
    ? await options.prepare(context)
    : undefined as Prepared;
  return await prisma.$transaction(
    async (tx) => validateResult(await options.mutate(tx, context, prepared)),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
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

async function mutationBody(request: Request, contract: AdminV2DeclaredRequestRef) {
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
