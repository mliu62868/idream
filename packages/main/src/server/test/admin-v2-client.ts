/* eslint-disable @typescript-eslint/no-explicit-any */
// SPEC: Admin v2 Route Handler 的测试客户端 —— 按 Route Handler 的真实签名调用它。
// INTENT: 和 `helpers.ts` 的 `api()` 对称：那边走 dispatchV1，这边走具体的 route 文件。
//   经 route 而不是直接调 authority 模块，是因为 `adminV2Route` 的契约收口只在这条路径上
//   生效 —— 绕过它的测试证明不了「发出去的东西符合 manifest 声明」。

export type AdminV2RouteHandler<
  Params extends Record<string, string> = Record<string, string>,
> = (
  request: Request,
  context: { params: Promise<Params> },
) => Promise<Response> | Response;

export type AdminV2Result<T = any> = {
  readonly status: number;
  readonly ok: boolean;
  readonly data: T;
  readonly error?: { code?: string; message?: string; details?: unknown };
};

export async function callAdminV2<
  T = any,
  Params extends Record<string, string> = Record<string, string>,
>(
  handler: AdminV2RouteHandler<Params>,
  input: {
    readonly url: string;
    readonly actor: { readonly userId: string; readonly role: string };
    readonly method?: string;
    readonly body?: unknown;
    readonly params?: Params;
    readonly query?: Record<string, string | undefined>;
    readonly headers?: Record<string, string>;
  },
): Promise<AdminV2Result<T>> {
  const url = new URL(input.url, "http://localhost");
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {
    "x-idream-user-id": input.actor.userId,
    "x-idream-role": input.actor.role,
    ...input.headers,
  };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  const response = await handler(
    new Request(url, {
      method: input.method ?? (input.body === undefined ? "GET" : "POST"),
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    }),
    { params: Promise.resolve((input.params ?? {}) as Params) },
  );
  const text = await response.text();
  const json = text ? (JSON.parse(text) as { ok?: boolean; data?: T; error?: AdminV2Result["error"] }) : null;
  return {
    status: response.status,
    ok: Boolean(json?.ok),
    data: json?.data as T,
    error: json?.error,
  };
}

export function expectAdminV2Ok(result: AdminV2Result) {
  if (!result.ok) {
    throw new Error(
      `Expected Admin v2 success, got ${result.status}: ${JSON.stringify(result.error)}`,
    );
  }
  return result;
}
