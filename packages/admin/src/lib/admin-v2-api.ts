type ApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

type RuntimeSchema<T> = {
  parse(value: unknown): T;
};

export class AdminV2RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AdminV2RequestError";
  }
}

export async function adminV2Request<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    body?: unknown;
    idempotencyKey?: string;
    ifMatch?: number;
    schema?: RuntimeSchema<T>;
    signal?: AbortSignal;
  } = {},
) {
  const headers = new Headers();
  headers.set("x-request-id", crypto.randomUUID());
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
  if (options.ifMatch !== undefined) headers.set("if-match", `"${options.ifMatch}"`);
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    signal: options.signal,
  });
  const raw = await response.text();
  let payload: ApiEnvelope<T>;
  try {
    payload = JSON.parse(raw) as ApiEnvelope<T>;
  } catch {
    throw new Error(`Admin authority request failed (${response.status})`);
  }
  if (!payload.ok) {
    throw new AdminV2RequestError(
      payload.error.message ?? payload.error.code ?? "Admin request failed",
      response.status,
      payload.error.code,
      payload.error.details,
    );
  }
  return options.schema ? options.schema.parse(payload.data) : payload.data;
}

export async function adminV2FormRequest<T>(
  path: string,
  options: {
    form: FormData;
    idempotencyKey: string;
    schema?: RuntimeSchema<T>;
    signal?: AbortSignal;
  },
) {
  const headers = new Headers({
    "x-request-id": crypto.randomUUID(),
    "idempotency-key": options.idempotencyKey,
  });
  const response = await fetch(path, {
    method: "POST",
    headers,
    body: options.form,
    cache: "no-store",
    signal: options.signal,
  });
  const raw = await response.text();
  let payload: ApiEnvelope<T>;
  try {
    payload = JSON.parse(raw) as ApiEnvelope<T>;
  } catch {
    throw new Error(`Admin authority request failed (${response.status})`);
  }
  if (!payload.ok) {
    throw new AdminV2RequestError(
      payload.error.message ?? payload.error.code ?? "Admin request failed",
      response.status,
      payload.error.code,
      payload.error.details,
    );
  }
  return options.schema ? options.schema.parse(payload.data) : payload.data;
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
