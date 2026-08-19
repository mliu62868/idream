/* eslint-disable @typescript-eslint/no-explicit-any */

// SPEC: 用真实 Route Handler 驱动一个 /api/v2/admin 端点，返回解好的 {ok,data}|{ok,error} 信封。
// INTENT: v2 没有 dispatch 表，契约是「method + pathname」共同解析出来的，所以测试必须把
// handler 和它自己的 URL 一起给出来 —— 拿列表 URL 去调详情 handler 在生产里不可能发生。
// INVARIANT: 只在 APP_ENV=test 下有效，靠 dev auth 头（x-idream-*）冒充操作者。

// `any` on the params payload is deliberate: each Route Handler declares its own literal
// param shape, and a test client that names one shape cannot drive the others.
type RouteHandler = (
  request: Request,
  context: { params: Promise<any> },
) => Promise<Response> | Response;

export interface AdminV2RouteOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path under /api/v2/admin/, without a leading slash. */
  path: string;
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  userId?: string;
  role?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Writes get a random Idempotency-Key unless one is supplied, or `false` to omit it. */
  idempotencyKey?: string | false;
}

/** Structurally an `ApiResult`, so `expectOk` / `expectError` work unchanged. */
export interface AdminV2RouteResult {
  status: number;
  ok: boolean;
  data: any;
  error: { code?: string; message?: string; details?: any } | undefined;
  json: any;
  headers: Headers;
  setCookies: string[];
}

export async function adminV2Route(
  handler: RouteHandler,
  options: AdminV2RouteOptions,
): Promise<AdminV2RouteResult> {
  const method = options.method ?? "GET";
  const url = new URL(`http://localhost/api/v2/admin/${options.path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.userId) headers["x-idream-user-id"] = options.userId;
  if (options.role) headers["x-idream-role"] = options.role;
  const hasIdempotencyKey = Object.keys(headers).some(
    (name) => name.toLowerCase() === "idempotency-key",
  );
  if (
    method !== "GET" &&
    options.idempotencyKey !== false &&
    !hasIdempotencyKey
  ) {
    headers["idempotency-key"] = options.idempotencyKey ?? crypto.randomUUID();
  }
  const response = await handler(
    new Request(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    { params: Promise.resolve(options.params ?? {}) },
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
