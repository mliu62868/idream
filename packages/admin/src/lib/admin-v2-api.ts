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

export async function adminV2Request<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH";
    body?: unknown;
    idempotencyKey?: string;
    schema?: RuntimeSchema<T>;
  } = {},
) {
  const headers = new Headers();
  headers.set("x-request-id", crypto.randomUUID());
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });
  const raw = await response.text();
  let payload: ApiEnvelope<T>;
  try {
    payload = JSON.parse(raw) as ApiEnvelope<T>;
  } catch {
    throw new Error(`Admin authority request failed (${response.status})`);
  }
  if (!payload.ok) throw new Error(payload.error.message ?? payload.error.code ?? "Admin request failed");
  return options.schema ? options.schema.parse(payload.data) : payload.data;
}

export function setWorkspaceUrl(params: URLSearchParams) {
  if (typeof window === "undefined") return;
  const next = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}`;
  window.history.replaceState(null, "", next);
}
