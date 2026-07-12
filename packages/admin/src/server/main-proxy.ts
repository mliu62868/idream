import { incrementCounter, observeHistogram } from "@idream/shared";
import { BFF_HEADER, BFF_USER_HEADER, signBffContext } from "@idream/shared/bff";
import { randomUUID } from "node:crypto";

const mainWebURL = (process.env.MAIN_WEB_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

const requestHopByHopHeaders = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

const responseHopByHopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

export async function proxyToMain(request: Request, pathname: string): Promise<Response> {
  const startedAt = performance.now();
  const surface = proxySurface(pathname);
  const routeClass = proxyRouteClass(pathname, request.method);
  const killSwitch = activeAdminV2KillSwitch(pathname, request.method);
  if (killSwitch) {
    incrementCounter(
      "admin_proxy_kill_switch_total",
      "Admin v2 requests rejected by the fail-closed cutover kill switch",
      { scope: killSwitch },
    );
    recordProxyMetrics(request.method, "kill_switch", surface, routeClass, startedAt);
    return Response.json(
      {
        ok: false,
        error: {
          code: `admin_v2_${killSwitch}_kill_switch_active`,
          message: `Admin v2 ${killSwitch} traffic is temporarily disabled by release control`,
        },
      },
      { status: 503, headers: { "retry-after": "0" } },
    );
  }
  const incomingURL = new URL(request.url);
  const upstreamURL = new URL(pathname, `${mainWebURL}/`);
  upstreamURL.search = incomingURL.search;

  const headers = new Headers(request.headers);
  for (const name of requestHopByHopHeaders) headers.delete(name);
  headers.delete(BFF_HEADER);
  headers.delete(BFF_USER_HEADER);
  headers.set("x-forwarded-host", incomingURL.host);
  headers.set("x-forwarded-proto", incomingURL.protocol.replace(":", ""));
  if (!headers.has("x-request-id")) headers.set("x-request-id", randomUUID());

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : new Uint8Array(await request.arrayBuffer());
  const signingSecret = process.env.ADMIN_BFF_SIGNING_SECRET;
  if (signingSecret) {
    const signedPath = `${upstreamURL.pathname}${upstreamURL.search}`;
    const { signature, context } = signBffContext({
      secret: signingSecret,
      userId: "admin-bff",
      method: request.method,
      path: signedPath,
      body: body ? Buffer.from(body).toString("base64") : "",
    });
    headers.set(BFF_HEADER, signature);
    headers.set(BFF_USER_HEADER, JSON.stringify(context));
  } else if (process.env.APP_ENV === "production") {
    recordProxyMetrics(request.method, "configuration_error", surface, routeClass, startedAt);
    return Response.json(
      {
        ok: false,
        error: {
          code: "admin_bff_signing_unconfigured",
          message: "Admin authority transport is not configured",
        },
      },
      { status: 503 },
    );
  }

  try {
    const upstream = await fetch(upstreamURL, {
      method: request.method,
      headers,
      body: body ?? undefined,
      cache: "no-store",
      redirect: "manual",
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const name of responseHopByHopHeaders) responseHeaders.delete(name);
    recordProxyMetrics(request.method, upstream.status < 500 ? "completed" : "upstream_error", surface, routeClass, startedAt);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    recordProxyMetrics(request.method, "unavailable", surface, routeClass, startedAt);
    return Response.json(
      {
        ok: false,
        error: {
          code: "admin_upstream_unavailable",
          message: "Admin authority is temporarily unavailable",
        },
      },
      { status: 503 },
    );
  }
}

function activeAdminV2KillSwitch(pathname: string, method: string): "read" | "write" | null {
  if (!pathname.startsWith("/api/v2/admin")) return null;
  const readOnly = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (readOnly && process.env.ADMIN_V2_READ_KILL_SWITCH === "true") return "read";
  if (!readOnly && process.env.ADMIN_V2_WRITE_KILL_SWITCH === "true") return "write";
  return null;
}

function proxySurface(pathname: string) {
  if (pathname.startsWith("/api/v1/admin")) return "legacy_v1";
  if (pathname.startsWith("/api/v2/admin")) return "admin_v2";
  if (pathname.startsWith("/api/admin-auth")) return "auth";
  if (pathname.startsWith("/user-content")) return "media";
  return "other";
}

function proxyRouteClass(pathname: string, method: string) {
  if (pathname.includes("/today")) return "today";
  if (pathname.includes("/search")) return "search";
  if (!["GET", "HEAD", "OPTIONS"].includes(method) || pathname.includes("/commands/") || pathname.includes("/action-plans/")) return "command";
  const segments = pathname.split("/").filter(Boolean);
  if (method === "GET" && segments[0] === "api" && segments[1] === "v2" && segments[2] === "admin" && segments.length >= 5) return "detail";
  return "list";
}

function recordProxyMetrics(method: string, outcome: string, surface: string, routeClass: string, startedAt: number) {
  const labels = { method, outcome, routeClass, surface };
  incrementCounter(
    "admin_http_requests_total",
    "Requests handled by the Admin HTTP BFF",
    labels,
  );
  observeHistogram(
    "admin_http_request_duration_seconds",
    "Admin HTTP BFF request duration in seconds",
    labels,
    Math.max(0, performance.now() - startedAt) / 1_000,
  );
  if (surface === "legacy_v1") {
    incrementCounter(
      "admin_legacy_v1_requests_total",
      "Legacy Admin v1 BFF requests used for sunset observation",
      { method, outcome },
    );
  }
}
