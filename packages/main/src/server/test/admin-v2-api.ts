/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ADMIN_V2_API_OPERATIONS,
  findAdminV2ApiOperation,
  type AdminV2ApiOperation,
} from "@idream/shared/admin";

/**
 * SPEC: 在测试里像 HTTP 客户端一样调用一个 Admin v2 Route Handler。
 *
 * INTENT: v1 有 `api()` —— 一个 `dispatchV1(request, segments)` 就能打到任何后台端点。v2 没有
 * 这样的中心分发器（那正是它的设计），所以每个测试都得手 import 具体的 route module 并自己
 * 拼 params。搬迁一整个域的测试时这条摩擦会被乘以上百次。这里用 manifest 把 pathname 解析回
 * operation，再用 `import.meta.glob` 取到对应的 route module —— 路由表仍然只有 manifest 一份。
 *
 * INVARIANT: 只服务测试。生产路径永远是 Next 自己的文件路由。
 */

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { readonly eager: true }): Record<string, T>;
  }
}

type RouteHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response> | Response;

type RouteModule = Partial<Record<AdminV2ApiOperation["method"], RouteHandler>>;

const routeModules = import.meta.glob<RouteModule>(
  "../../app/api/v2/admin/**/route.ts",
  { eager: true },
);

function moduleKey(operation: AdminV2ApiOperation) {
  const route = operation.route.replace(/:([^/]+)/g, "[$1]");
  return `../../app${route}/route.ts`;
}

function routeParams(operation: AdminV2ApiOperation, pathname: string) {
  const declared = operation.route.split("/");
  const concrete = pathname.replace(/\/$/, "").split("/");
  const params: Record<string, string> = {};
  for (const [index, segment] of declared.entries()) {
    if (segment.startsWith(":")) {
      params[segment.slice(1)] = decodeURIComponent(concrete[index] ?? "");
    }
  }
  return params;
}

export type AdminV2ApiOptions = {
  userId?: string;
  role?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Omit to auto-generate one for every declared idempotent mutation. */
  idempotencyKey?: string | null;
  ifMatch?: number;
};

/** Structurally the same result shape `@/server/test/helpers` `api()` returns, so
 *  `expectOk` / `expectError` accept both without a second assertion vocabulary. */
export type AdminV2ApiResult<T = any> = {
  status: number;
  ok: boolean;
  data: T;
  error: { code?: string; message?: string; details?: any } | undefined;
  json: any;
  headers: Headers;
  setCookies: string[];
};

export async function adminV2Api<T = any>(
  method: AdminV2ApiOperation["method"],
  path: string,
  options: AdminV2ApiOptions = {},
): Promise<AdminV2ApiResult<T>> {
  const url = new URL(path, "http://localhost");
  const operation = findAdminV2ApiOperation(method, url.pathname);
  if (!operation) {
    throw new Error(
      `Admin v2 manifest declares no operation for ${method} ${url.pathname}. Declared: ${
        ADMIN_V2_API_OPERATIONS.filter((candidate) => candidate.method === method)
          .map((candidate) => candidate.route)
          .join(", ")
      }`,
    );
  }
  const handler = routeModules[moduleKey(operation)]?.[method];
  if (!handler) throw new Error(`No Route Handler exported for ${operation.id}`);

  const headers: Record<string, string> = { ...options.headers };
  if (options.userId) headers["x-idream-user-id"] = options.userId;
  if (options.role) headers["x-idream-role"] = options.role;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const transport = operation.mutation?.transport ?? "";
  const hasIdempotencyHeader = Object.keys(headers)
    .some((name) => name.toLowerCase() === "idempotency-key");
  if (
    transport.includes("idempotency_key") &&
    !hasIdempotencyHeader &&
    options.idempotencyKey !== null
  ) {
    headers["idempotency-key"] = options.idempotencyKey ?? crypto.randomUUID();
  }
  if (options.ifMatch !== undefined) headers["if-match"] = `"${options.ifMatch}"`;

  const response = await handler(
    new Request(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    { params: Promise.resolve(routeParams(operation, url.pathname)) },
  );
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return {
    status: response.status,
    ok: Boolean(json?.ok),
    data: json?.data,
    error: json?.error,
    json,
    headers: response.headers,
    setCookies: response.headers.getSetCookie(),
  };
}
