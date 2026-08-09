import {
  ADMIN_V2_API_OPERATIONS_BY_ID,
  requireAdminV2ContractSchema,
  type AdminPermissionKey,
  type AdminV2ApiOperation,
  type AdminV2ContractSchemaFor,
  type AdminV2DeclaredOperationId,
  type AdminV2DeclaredRequestRefFor,
  type AdminV2DeclaredResponseRefFor,
  type AdminV2DeclaredRouteFor,
} from "@idream/shared/admin";
import { adminV2Request } from "./admin-v2-api";

// SPEC: 按 manifest 声明的 operation id 寻址一次请求；信封解码仍然只有 admin-v2-api 一份。
// INTENT: 单独一个模块而不是塞回 admin-v2-api，是因为它必须**经过** `adminV2Request` 的模块
//         导出去调用 —— 十几个挂载测试正是在这个导出上换桩来驱动真实响应的。写在同一个文件
//         里就成了模块内部调用，桩换不到，整片测试只能改成打 fetch。

/**
 * SPEC: 路由模板里的 `:param` 名字 —— 这是「漏传路径参数 = 编译错」的全部依据。
 */
type PathParamNames<Route extends string> =
  Route extends `${string}:${infer Rest}`
    ? Rest extends `${infer Param}/${infer Tail}`
      ? Param | PathParamNames<Tail>
      : Rest
    : never;

type PathArgument<Route extends string> = [PathParamNames<Route>] extends [never]
  ? { readonly path?: undefined }
  : { readonly path: { readonly [Name in PathParamNames<Route>]: string } };

/**
 * SPEC: manifest 的 request ref 后缀（`+idempotency-key` / `+if-match`）就是写入许可的
 *       传输要求；声明了就必填。
 * INTENT: 幂等键漏传时服务端会拒，但那要等到运营点下按钮才知道；后缀是静态的，编译期就能问。
 */
type RequiresIdempotencyKey<Ref extends string> =
  Ref extends `${string}+idempotency-key${string}` ? true : false;
type RequiresIfMatch<Ref extends string> =
  Ref extends `${string}+if-match` | "if-match" ? true : false;

type TransportArgument<Ref extends string> =
  & (RequiresIdempotencyKey<Ref> extends true
      ? { readonly idempotencyKey: string }
      : { readonly idempotencyKey?: string })
  & (RequiresIfMatch<Ref> extends true
      ? { readonly ifMatch: number }
      : { readonly ifMatch?: number });

export type AdminV2OperationOptions<Id extends AdminV2DeclaredOperationId> =
  & PathArgument<AdminV2DeclaredRouteFor<Id>>
  & TransportArgument<AdminV2DeclaredRequestRefFor<Id>>
  & {
    readonly body?: unknown;
    readonly form?: FormData;
    readonly query?: string | URLSearchParams;
    readonly signal?: AbortSignal;
  };

/**
 * INTENT: 结构化地从 schema 的 `parse` 反推出响应类型，而不是 `z.output<>` —— admin 包没有
 *         自己的 zod 依赖，裸写 `from "zod"` 会解析到仓库外一个不相干的 zod 并整片报错。
 */
type SchemaOutput<Schema> = Schema extends { parse: (value: unknown) => infer Output }
  ? Output
  : never;

export type AdminV2OperationResponse<Id extends AdminV2DeclaredOperationId> =
  SchemaOutput<AdminV2ContractSchemaFor<AdminV2DeclaredResponseRefFor<Id>>>;

/** 一次「已经配好、还没发出」的操作；把 id 和它的参数绑在一起传递。 */
export type AdminV2OperationRequest<Id extends AdminV2DeclaredOperationId> = {
  readonly operationId: Id;
  readonly options: AdminV2OperationOptions<Id>;
};

/**
 * SPEC: 一组 effective permission 够不够发起某个 operation —— 用来决定要不要给运营这个入口。
 * INTENT: nav 曾经把 `GET /characters/:id` 的 authorization 声明逐字抄一遍再 `as` 强转成
 *         AdminPermissionKey，抄漏一个键就是少一个入口，而且抄错也没人报错。
 * INVARIANT: 只回答静态声明能不能过。resource 维度的 one_of 最终由服务端按具体目标裁决，
 *            这里给的是「值不值得把按钮点亮」，不是授权结论。
 */
export function adminV2OperationAllowed(
  id: AdminV2DeclaredOperationId,
  permissions: ReadonlySet<AdminPermissionKey>,
): boolean {
  const operation: AdminV2ApiOperation = ADMIN_V2_API_OPERATIONS_BY_ID[id];
  const { authorization } = operation;
  if (authorization.kind === "bootstrap") return true;
  if (authorization.kind === "all_of") {
    return authorization.permissions.every((permission) => permissions.has(permission));
  }
  if (authorization.kind === "one_of_by_resource") {
    return authorization.permissions.some((permission) => permissions.has(permission));
  }
  return authorization.always.every((permission) => permissions.has(permission)) &&
    authorization.oneOf.some((permission) => permissions.has(permission));
}

export type AdminV2OperationPathParams<Id extends AdminV2DeclaredOperationId> =
  AdminV2OperationOptions<Id>["path"];

/**
 * SPEC: 一条 operation 的具体 URL。
 * INTENT: 给那些必须持有 URL 字符串本身、而不是直接发请求的调用方 —— 命令日志会把 endpoint
 *         落盘再重放，路由仍然只能出自 manifest。
 */
export function adminV2OperationEndpoint<Id extends AdminV2DeclaredOperationId>(
  id: Id,
  path: AdminV2OperationPathParams<Id>,
): string {
  return adminV2OperationPath(ADMIN_V2_API_OPERATIONS_BY_ID[id].route, path);
}

export function adminV2OperationPath(
  route: string,
  path?: Readonly<Record<string, string>>,
) {
  return route.replaceAll(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const value = path?.[name];
    if (value === undefined) {
      throw new Error(`Admin v2 route ${route} is missing path parameter ${name}`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * SPEC: 按 manifest 声明的 operation id 发一次请求。方法、路由模板、响应契约全部来自
 *       `ADMIN_V2_API_OPERATIONS`，调用方只提供路径参数、查询串和请求体。
 * INTENT: 客户端曾经手写 46 条裸路由字符串并各自手配响应 schema —— 路由拼错、schema 配成
 *         另一个端点的，编译期都不报，要等运营在生产里点到才知道。id 是唯一入口之后，
 *         这两类错误都成了编译错，而 server 侧本来就已经由同一份 manifest 收口。
 */
export function adminV2Operation<Id extends AdminV2DeclaredOperationId>(
  id: Id,
  options: AdminV2OperationOptions<Id>,
): Promise<AdminV2OperationResponse<Id>> {
  const operation: AdminV2ApiOperation = ADMIN_V2_API_OPERATIONS_BY_ID[id];
  const query = options.query
    ? `?${typeof options.query === "string" ? options.query.replace(/^\?/, "") : options.query.toString()}`
    : "";
  return adminV2Request(
    `${adminV2OperationPath(operation.route, options.path)}${query}`,
    {
      method: operation.method,
      schema: requireAdminV2ContractSchema(operation.contract.response),
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.form ? { form: options.form } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  ) as Promise<AdminV2OperationResponse<Id>>;
}
