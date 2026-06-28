// Shared admin client fetch helpers + envelope types (SSoT).
// Server returns the ok()/error envelope from @/server/lib/http; both the main
// console and per-feature *View components read it through these helpers.

export type ApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!payload.ok) {
    throw new Error(payload.error.message ?? payload.error.code ?? "Request failed");
  }
  return payload.data;
}

export async function apiWrite<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT",
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!payload.ok) {
    throw new Error(payload.error.message ?? payload.error.code ?? "Request failed");
  }
  return payload.data;
}
