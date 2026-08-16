// SPEC: calls an Admin v2 Route Handler the way Next.js would — resolve the operation from
//       (method, pathname), load that route module, hand it the request and its path params.
// INTENT: the v1 suite reached every admin endpoint through one `dispatchV1(request, segments)`
//         seam. v2 deliberately has no dispatcher: each operation is a file, and the manifest is
//         the only routing table. Tests still need one call site, so this rebuilds the seam from
//         the manifest instead of from a second hand-written route table.
// INVARIANT: an operation the manifest does not declare, or a route file that does not export
//            the method, throws here rather than silently returning 404 — a test that addresses
//            a non-existent endpoint should fail loudly.
import { randomUUID } from "node:crypto";
import { findAdminV2ApiOperation } from "@idream/shared/admin";

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { readonly eager: true }): Record<string, T>;
  }
}

type AdminV2RouteHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response> | Response;

type AdminV2RouteModule = Partial<Record<string, AdminV2RouteHandler>>;

const routeModules = import.meta.glob<AdminV2RouteModule>(
  "../../app/api/v2/admin/**/route.ts",
  { eager: true },
);

export type AdminV2CallOptions = {
  readonly userId?: string;
  readonly role?: string;
  readonly body?: unknown;
  readonly form?: FormData;
  readonly idempotencyKey?: string | null;
  readonly ifMatch?: number;
  readonly headers?: Record<string, string>;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly cookie?: string;
};

/** Structurally the v1 suite's `ApiResult`, so `expectOk` / `expectError` accept both. */
export type AdminV2Result<T = any> = {
  status: number;
  ok: boolean;
  data: T;
  error: { code?: string; message?: string; details?: any } | undefined;
  json: any;
  headers: Headers;
  setCookies: string[];
};

function moduleKey(route: string) {
  return `../../app${route.replace(/:([^/]+)/g, "[$1]")}/route.ts`;
}

function routeParams(route: string, pathname: string): Record<string, string> {
  const declared = route.split("/");
  const actual = pathname.split("/");
  const params: Record<string, string> = {};
  for (const [index, segment] of declared.entries()) {
    if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(actual[index] ?? "");
  }
  return params;
}

/**
 * SPEC: `pathname` is either the full `/api/v2/admin/...` path or the part after that prefix
 * (`moderation/queue`); a query string is allowed either way, as is a `query` object.
 *
 * INTENT: the two call conventions come from two helpers that were written in parallel and then
 * had to merge. Normalising here costs three lines and lets one seam serve every call site —
 * the alternative was keeping a second route table alive purely to spell paths differently.
 */
export async function adminV2<T = any>(
  method: string,
  pathname: string,
  options: AdminV2CallOptions = {},
): Promise<AdminV2Result<T>> {
  const absolute = pathname.startsWith("/api/v2/admin")
    ? pathname
    : `/api/v2/admin/${pathname.replace(/^\//, "")}`;
  const url = new URL(absolute, "http://localhost");
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const operation = findAdminV2ApiOperation(method, url.pathname);
  if (!operation) throw new Error(`Admin v2 manifest declares no ${method} ${url.pathname}`);
  const handler = routeModules[moduleKey(operation.route)]?.[method];
  if (!handler) throw new Error(`Admin v2 route ${operation.id} exports no ${method} handler`);

  const headers: Record<string, string> = { ...options.headers };
  if (options.userId) headers["x-idream-user-id"] = options.userId;
  if (options.role) headers["x-idream-role"] = options.role;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.ifMatch !== undefined) headers["if-match"] = `"${options.ifMatch}"`;
  if (options.cookie) headers["cookie"] = options.cookie;
  const needsIdempotency = operation.mutation?.transport.includes("idempotency_key");
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  else if (needsIdempotency && options.idempotencyKey !== null) {
    headers["idempotency-key"] = randomUUID();
  }

  const response = await handler(
    new Request(url.toString(), {
      method,
      headers,
      body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    }),
    { params: Promise.resolve(routeParams(operation.route, url.pathname)) },
  );
  const text = await response.text();
  const json = text ? (JSON.parse(text) as { ok?: boolean; data?: T; error?: AdminV2Result["error"] }) : null;
  return {
    status: response.status,
    ok: Boolean(json?.ok),
    data: json?.data as T,
    error: json?.error,
    json,
    headers: response.headers,
    setCookies: response.headers.getSetCookie(),
  };
}
