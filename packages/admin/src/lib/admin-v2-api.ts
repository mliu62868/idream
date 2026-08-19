import type { AdminV2HttpMethod } from "@idream/shared/admin";

export type ApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

type RuntimeSchema<T> = {
  parse(value: unknown): T;
};

/**
 * SPEC: 后台每一次 HTTP 失败都是这一个类。
 * INTENT: 曾经 `lib/admin-v2-api` 与 `components/admin/api` 各有一个错误类、各自解一遍
 *         同一个 `{ok,data}|{ok,error}` 信封。角色运营台同时用两套，18 处 `instanceof`
 *         接不住另一套抛的错，状态码敏感的分支（幂等键该不该回收、409 该不该解锁）会静默
 *         落到通用分支。类只能有一个，判等才有意义。
 */
export class AdminV2RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
    /** SPEC: 本次请求发出去的 `x-request-id`。
     * INTENT: 运营把失败转给工程时，唯一能让工程在日志里定位到这一次调用的东西就是它；
     * 不带上，「技术详情」就只剩一句人人都会说的英文报错。 */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "AdminV2RequestError";
  }
}

export type AdminV2FetchOptions<T> = {
  method?: AdminV2HttpMethod;
  /** JSON 请求体；与 `form` 互斥。 */
  body?: unknown;
  /** multipart 请求体；与 `body` 互斥。 */
  form?: FormData;
  idempotencyKey?: string;
  ifMatch?: number;
  headers?: Record<string, string>;
  schema?: RuntimeSchema<T>;
  signal?: AbortSignal;
};

/** 唯一的信封解码实现。 */
export async function adminV2Request<T>(
  path: string,
  options: AdminV2FetchOptions<T> = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has("x-request-id")) headers.set("x-request-id", crypto.randomUUID());
  const requestId = headers.get("x-request-id") ?? undefined;
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
  if (options.ifMatch !== undefined) headers.set("if-match", `"${options.ifMatch}"`);
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    cache: "no-store",
    signal: options.signal,
  });
  const raw = await response.text();
  let payload: ApiEnvelope<T>;
  try {
    payload = JSON.parse(raw) as ApiEnvelope<T>;
  } catch {
    // SPEC: 响应不是 JSON（网关 502 页、鉴权跳转、代理超时）也走同一个错误类。
    // INTENT: 这里以前抛一个裸 Error，运营看到的就是 "Admin authority request failed (502)"
    //         ——一个孤零零的状态码。抛成 AdminV2RequestError，状态码就能被文案表接住，
    //         运营读到人话，requestId 也才跟得上。
    throw new AdminV2RequestError(
      `Authority returned a non-JSON ${response.status} response`,
      response.status,
      undefined,
      undefined,
      requestId,
    );
  }
  if (!payload.ok) {
    throw new AdminV2RequestError(
      formatApiError(payload.error, "Admin request failed"),
      response.status,
      payload.error.code,
      payload.error.details,
      requestId,
    );
  }
  return options.schema ? options.schema.parse(payload.data) : payload.data;
}

/**
 * SPEC: 组装 `AdminV2RequestError.message` —— **工程通道**的文本，只在「技术详情」里出现。
 * INTENT: 它曾经是运营首屏读到的那一句，于是 `?? error.code` 把 `entity_version_conflict`
 *         这种机器码当人话糊了出去。运营看到的那一句现在由 ui/request-error-copy.ts 按
 *         code / status 生成；code 本来就单独传给了构造函数，不必再冒充散文。
 * INVARIANT: 不吞掉后端原文——Zod 的字段级说明留在这里，工程要拿它对日志。
 */
export function formatApiError(error: ApiError, fallback: string) {
  const base = error.message ?? fallback;
  const detail = apiErrorDetailsText(error.details);
  return detail ? `${base}: ${detail}` : base;
}

/**
 * SPEC: 校验失败时被拒的字段名（只要名字，不要 Zod 那句英文）。
 * INTENT: 运营需要知道「哪一格填错了」，但 "String must contain at least 3 character(s)"
 *         永远是英文、也永远不该出现在中文后台的首屏。字段名短、可插进译文、不用翻译。
 */
export function apiErrorFieldNames(details: unknown): string[] {
  if (typeof details !== "object" || details === null) return [];
  const names = new Set<string>();
  const issues = (details as { issues?: unknown }).issues;
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      if (typeof issue !== "object" || issue === null) continue;
      const path = (issue as { path?: unknown }).path;
      if (typeof path === "string" && path) names.add(path);
      else if (Array.isArray(path) && path.length > 0) names.add(path.join("."));
    }
  }
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (typeof fieldErrors === "object" && fieldErrors !== null) {
    for (const [field, value] of Object.entries(fieldErrors as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length > 0) names.add(field);
    }
  }
  return [...names].slice(0, 5);
}

function apiErrorDetailsText(details: unknown) {
  if (typeof details !== "object" || details === null) return "";
  const issues = (details as { issues?: unknown }).issues;
  if (Array.isArray(issues)) {
    const messages = issues
      .flatMap((issue) => {
        if (typeof issue !== "object" || issue === null) return [];
        const path = (issue as { path?: unknown }).path;
        const message = (issue as { message?: unknown }).message;
        if (typeof message !== "string") return [];
        return [
          typeof path === "string" && path
            ? `${path}: ${message}`
            : message,
        ];
      })
      .slice(0, 3);
    if (messages.length > 0) return messages.join("; ");
  }
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (typeof fieldErrors !== "object" || fieldErrors === null) return "";
  const messages = Object.entries(fieldErrors as Record<string, unknown>)
    .flatMap(([field, value]) => {
      if (!Array.isArray(value)) return [];
      return value
        .map((message) => (typeof message === "string" ? `${field}: ${message}` : ""))
        .filter(Boolean);
    })
    .slice(0, 3);
  return messages.join("; ");
}

export type WorkspaceHistoryMode = "push" | "replace";

export function setWorkspaceUrl(
  params: URLSearchParams,
  options: {
    hash?: string;
    mode?: WorkspaceHistoryMode;
    pathname?: string;
  } = {},
) {
  if (typeof window === "undefined") return;
  const hash = options.hash?.replace(/^#/, "");
  const next =
    `${options.pathname ?? window.location.pathname}` +
    `${params.size ? `?${params.toString()}` : ""}` +
    `${hash ? `#${hash}` : ""}`;
  window.history[options.mode === "push" ? "pushState" : "replaceState"](null, "", next);
}
