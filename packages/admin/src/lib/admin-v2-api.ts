type ApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export async function adminV2Request<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH";
    body?: unknown;
    idempotencyKey?: string;
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
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!payload.ok) throw new Error(payload.error.message ?? payload.error.code ?? "Admin request failed");
  return payload.data;
}

export function setWorkspaceUrl(params: URLSearchParams) {
  if (typeof window === "undefined") return;
  const next = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}`;
  window.history.replaceState(null, "", next);
}
