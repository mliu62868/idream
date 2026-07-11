import { incrementCounter, observeHistogram } from "@idream/shared";

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
  const incomingURL = new URL(request.url);
  const upstreamURL = new URL(pathname, `${mainWebURL}/`);
  upstreamURL.search = incomingURL.search;

  const headers = new Headers(request.headers);
  for (const name of requestHopByHopHeaders) headers.delete(name);
  headers.set("x-forwarded-host", incomingURL.host);
  headers.set("x-forwarded-proto", incomingURL.protocol.replace(":", ""));

  try {
    const upstream = await fetch(upstreamURL, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      cache: "no-store",
      redirect: "manual",
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const name of responseHopByHopHeaders) responseHeaders.delete(name);
    recordProxyMetrics(request.method, upstream.status < 500 ? "completed" : "upstream_error", surface, startedAt);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    recordProxyMetrics(request.method, "unavailable", surface, startedAt);
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

function proxySurface(pathname: string) {
  if (pathname.startsWith("/api/v1/admin")) return "legacy_v1";
  if (pathname.startsWith("/api/v2/admin")) return "admin_v2";
  if (pathname.startsWith("/api/admin-auth")) return "auth";
  if (pathname.startsWith("/user-content")) return "media";
  return "other";
}

function recordProxyMetrics(method: string, outcome: string, surface: string, startedAt: number) {
  const labels = { method, outcome, surface };
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
