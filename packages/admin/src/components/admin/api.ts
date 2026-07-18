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

export class AdminApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AdminApiRequestError";
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!payload.ok) {
    throw new AdminApiRequestError(
      formatApiError(payload.error, "Request failed"),
      response.status,
      payload.error.code,
      payload.error.details,
    );
  }
  return payload.data;
}

export async function apiWrite<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT",
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!payload.ok) {
    throw new AdminApiRequestError(
      formatApiError(payload.error, "Request failed"),
      response.status,
      payload.error.code,
      payload.error.details,
    );
  }
  return payload.data;
}

export async function apiDelete<T>(
  path: string,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(path, { method: "DELETE", headers });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!payload.ok) {
    throw new AdminApiRequestError(
      formatApiError(payload.error, "Request failed"),
      response.status,
      payload.error.code,
      payload.error.details,
    );
  }
  return payload.data;
}

export async function apiForm<T>(path: string, body: FormData): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    body,
  });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!payload.ok) {
    throw new AdminApiRequestError(
      formatApiError(payload.error, "Request failed"),
      response.status,
      payload.error.code,
      payload.error.details,
    );
  }
  return payload.data;
}

export function formatApiError(error: ApiError, fallback: string) {
  const base = error.message ?? error.code ?? fallback;
  const detail = apiErrorDetailsText(error.details);
  return detail ? `${base}: ${detail}` : base;
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
