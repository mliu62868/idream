import {
  incrementCounter,
  findAdminV2ApiOperation,
  adminV2BinaryResponseHeaders,
  narrowAdminV2BinaryResponse,
  narrowAdminV2ResponseEnvelope,
  observeHistogram,
} from "@idream/shared";
import { BFF_HEADER, BFF_USER_HEADER, signBffContext } from "@idream/shared/bff";
import { randomUUID } from "node:crypto";
import {
  adminCutoverDomainForPath,
  canonicalMainBaseUrl,
  isAdminReadMethod,
  resolveAdminDomainReadRoute,
  type AdminCutoverDomain,
  type AdminDomainReadAuthority,
} from "./domain-cutover";

type AdminProxyAuthority =
  | AdminDomainReadAuthority
  | "unavailable"
  | "global_kill_switch"
  | "canonical_write"
  | "legacy_v1"
  | "not_applicable";

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

// SPEC: 请求体上限。上传走 multipart（Main 单文件最大 100MB 视频），其余都是 JSON。
// INTENT: 这里在任何会话校验之前就要把整个 body 读进内存（HMAC 要签它），不设上限等于允许匿名
//         请求让 Admin 和 Main 各缓冲一份任意大的 body。模型导入是唯一例外：它有自己的上限，
//         而且只在工程诊断环境开放。
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const MAX_MULTIPART_BODY_BYTES = 128 * 1024 * 1024;

// SPEC: 上游只等到响应头。超时后走既有的 503，客户端按「是否已写入未知」处理。
// INTENT: fetch 没有任何超时时，一个挂住的 Main 会把 Admin 的请求一直占着。计时器在响应头到达后
//         就清掉，否则下载慢的视频会被中途掐断。
const UPSTREAM_READ_TIMEOUT_MS = 120_000;
const UPSTREAM_WRITE_TIMEOUT_MS = 300_000;

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
  const domain = adminCutoverDomainForPath(pathname);
  if (isCrossSiteWrite(request)) {
    recordProxyMetrics(request.method, "cross_site_rejected", surface, routeClass, startedAt, domain, "not_applicable");
    return Response.json(
      { ok: false, error: { code: "admin_cross_site_write_rejected", message: "Cross-site Admin writes are not allowed" } },
      { status: 403, headers: provenanceHeaders(domain, "not_applicable") },
    );
  }
  const killSwitch = activeAdminV2KillSwitch(pathname, request.method);
  if (killSwitch) {
    incrementCounter(
      "admin_proxy_kill_switch_total",
      "Admin v2 requests rejected by the fail-closed cutover kill switch",
      { domain: domain ?? "unscoped", readAuthority: "global_kill_switch", scope: killSwitch },
    );
    recordProxyMetrics(request.method, "kill_switch", surface, routeClass, startedAt, domain, "global_kill_switch");
    return Response.json(
      {
        ok: false,
        error: {
          code: `admin_v2_${killSwitch}_kill_switch_active`,
          message: `Admin v2 ${killSwitch} traffic is temporarily disabled by release control`,
        },
      },
      {
        status: 503,
        headers: provenanceHeaders(domain, "global_kill_switch", { "retry-after": "0" }),
      },
    );
  }

  const readRoute = resolveAdminDomainReadRoute({
    method: request.method,
    pathname,
    environment: process.env,
  });
  if (readRoute.kind === "unavailable") {
    recordProxyMetrics(request.method, "read_unavailable", surface, routeClass, startedAt, readRoute.domain, readRoute.readAuthority);
    return Response.json(
      {
        ok: false,
        error: {
          code: readRoute.code,
          message: readRoute.message,
          details: { domain: readRoute.domain, readAuthority: readRoute.readAuthority },
        },
      },
      {
        status: 503,
        headers: provenanceHeaders(readRoute.domain, readRoute.readAuthority, { "retry-after": "0" }),
      },
    );
  }

  const readAuthority = readRoute.kind === "selected"
    ? readRoute.readAuthority
    : isAdminReadMethod(request.method)
      ? surface === "legacy_v1" ? "legacy_v1" : surface === "admin_v2" ? "canonical_v2" : "not_applicable"
      : domain ? "canonical_write" : "not_applicable";
  const upstreamBaseUrl = readRoute.kind === "selected"
    ? readRoute.upstreamBaseUrl
    : canonicalMainBaseUrl(process.env);
  if (!upstreamBaseUrl) {
    recordProxyMetrics(request.method, "configuration_error", surface, routeClass, startedAt, domain, readAuthority);
    return Response.json(
      {
        ok: false,
        error: {
          code: "admin_main_authority_url_invalid",
          message: "Admin canonical authority URL is invalid",
        },
      },
      { status: 503, headers: provenanceHeaders(domain, readAuthority) },
    );
  }
  const incomingURL = new URL(request.url);
  const upstreamURL = new URL(pathname, `${upstreamBaseUrl}/`);
  upstreamURL.search = incomingURL.search;

  const headers = new Headers(request.headers);
  for (const name of requestHopByHopHeaders) headers.delete(name);
  headers.delete(BFF_HEADER);
  headers.delete(BFF_USER_HEADER);
  headers.delete("x-idream-admin-domain");
  headers.delete("x-idream-admin-read-authority");
  addProvenanceHeaders(headers, domain, readAuthority);
  headers.set("x-forwarded-host", incomingURL.host);
  headers.set("x-forwarded-proto", incomingURL.protocol.replace(":", ""));
  // 客户端的 UUID 要留着——运营转给工程的 requestId 就是它；任意字符串则不能进审计。
  if (!REQUEST_ID_PATTERN.test(headers.get("x-request-id") ?? "")) headers.set("x-request-id", randomUUID());
  // 审计的 ipHash 把整个头拿去算，客户端自带的前缀可以任意改写它。只留下最近一跳可信的（同 rate-limit.ts）。
  const forwardedFor = headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await readLimitedBody(request, pathname);
  if (body === "too_large") {
    recordProxyMetrics(request.method, "body_too_large", surface, routeClass, startedAt, domain, readAuthority);
    return Response.json(
      { ok: false, error: { code: "admin_request_body_too_large", message: "Request body is too large" } },
      { status: 413, headers: provenanceHeaders(domain, readAuthority) },
    );
  }
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
    recordProxyMetrics(request.method, "configuration_error", surface, routeClass, startedAt, domain, readAuthority);
    return Response.json(
      {
        ok: false,
        error: {
          code: "admin_bff_signing_unconfigured",
          message: "Admin authority transport is not configured",
        },
      },
      { status: 503, headers: provenanceHeaders(domain, readAuthority) },
    );
  }

  const upstreamAbort = new AbortController();
  const readOnly = isAdminReadMethod(request.method);
  const upstreamTimer = setTimeout(
    () => upstreamAbort.abort(),
    readOnly ? UPSTREAM_READ_TIMEOUT_MS : UPSTREAM_WRITE_TIMEOUT_MS,
  );
  // 只有读会随客户端断开而取消：写一旦发出，中途掐断只会让结果更难核对。
  const cancelOnDisconnect = () => upstreamAbort.abort();
  if (readOnly) request.signal.addEventListener("abort", cancelOnDisconnect, { once: true });
  try {
    const upstream = await fetch(upstreamURL, {
      method: request.method,
      headers,
      body: body ?? undefined,
      cache: "no-store",
      redirect: "manual",
      signal: upstreamAbort.signal,
    });
    clearTimeout(upstreamTimer);
    let responseBody: BodyInit | null = upstream.body;
    const operation = surface === "admin_v2"
      ? findAdminV2ApiOperation(request.method, pathname)
      : null;
    const binaryResponse = operation?.responseBody === "binary";
    if (surface === "admin_v2" && upstream.ok) {
      const rawBody = binaryResponse ? null : await upstream.text();
      const binaryValidation = binaryResponse ? narrowAdminV2BinaryResponse(operation, upstream) : null;
      const violation = binaryValidation
        ? binaryValidation.ok ? null : binaryValidation.violation
        : validateAdminV2SuccessResponse(request.method, pathname, rawBody ?? "");
      if (violation) {
        recordProxyMetrics(request.method, "contract_violation", surface, routeClass, startedAt, domain, readAuthority);
        return Response.json(
          {
            ok: false,
            error: {
              code: "admin_v2_response_contract_violation",
              message: "Admin authority returned a response outside its declared contract",
              operationId: violation.operationId,
              contractRef: violation.contractRef,
            },
          },
          { status: 502, headers: provenanceHeaders(domain, readAuthority) },
        );
      }
      if (!binaryResponse) responseBody = rawBody;
    }
    const responseHeaders = binaryResponse
      ? adminV2BinaryResponseHeaders(upstream)
      : new Headers(upstream.headers);
    for (const name of responseHopByHopHeaders) responseHeaders.delete(name);
    // Fetch has decoded compressed upstream bodies (including error streams).
    // These headers describe the old wire bytes, not the body relayed here.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    // 带会话的 JSON（客户 PII、导出）不能落进浏览器磁盘缓存或共享缓存；二进制响应由 manifest 自带策略。
    if (surface === "admin_v2" && !binaryResponse && !responseHeaders.get("cache-control")?.includes("no-store")) {
      responseHeaders.set("cache-control", "no-store");
    }
    recordProxyMetrics(request.method, upstream.status < 500 ? "completed" : "upstream_error", surface, routeClass, startedAt, domain, readAuthority);
    addProvenanceHeaders(responseHeaders, domain, readAuthority);
    return new Response(responseBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    clearTimeout(upstreamTimer);
    recordProxyMetrics(request.method, "unavailable", surface, routeClass, startedAt, domain, readAuthority);
    return Response.json(
      {
        ok: false,
        error: {
          code: "admin_upstream_unavailable",
          message: "Admin authority is temporarily unavailable",
        },
      },
      { status: 503, headers: provenanceHeaders(domain, readAuthority) },
    );
  }
}

/**
 * INTENT: the judgement is `shared`'s, not the proxy's — the producing route now applies the
 * same one before the bytes leave Main. Keeping a second copy here would let the two ends
 * disagree about which responses are admissible while both looked correct in isolation.
 */
function validateAdminV2SuccessResponse(method: string, pathname: string, rawBody: string) {
  const narrowed = narrowAdminV2ResponseEnvelope(method, pathname, rawBody);
  return narrowed.ok ? null : narrowed.violation;
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SPEC: 非读请求必须来自 Admin 自己的页面。
// INTENT: 会话 cookie 是 SameSite=Lax，同站的其它源（兄弟子域、开发时的任意 localhost 端口）发的
//         text/plain POST 不需要预检、也带 cookie；有 22 个写操作没有自定义头，erase、审批都在其中。
//         确认码是目标 id，猜得到，不算令牌。
// INVARIANT: 没有这两个头的请求放行——只有浏览器才会自动附带 cookie，而浏览器一定发 Origin。
function isCrossSiteWrite(request: Request) {
  if (isAdminReadMethod(request.method)) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite !== "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

async function readLimitedBody(request: Request, pathname: string): Promise<Uint8Array<ArrayBuffer> | "too_large"> {
  const limit = pathname.startsWith("/api/v2/admin/generation/model-imports")
    ? Number.POSITIVE_INFINITY
    : request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")
      ? MAX_MULTIPART_BODY_BYTES
      : MAX_JSON_BODY_BYTES;
  if (Number(request.headers.get("content-length")) > limit) return "too_large";
  if (!request.body) return new Uint8Array(await request.arrayBuffer());
  // Content-Length 可以不发（分块传输），所以边读边数。
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// SPEC: 开关只有 未设置 / 空 / "false" 算关，其余任何值都算开。
// INTENT: 事故中有人写 =1 或 =TRUE，严格等于 "true" 的判断会让写流量继续跑，而且毫无迹象。
function killSwitchEngaged(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized) && normalized !== "false";
}

function activeAdminV2KillSwitch(pathname: string, method: string): "read" | "write" | null {
  const readOnly = isAdminReadMethod(method);
  // 读开关也要盖住媒体：/user-content 同样会把私有客户内容交给运营。
  if (readOnly && pathname.startsWith("/user-content")) {
    return killSwitchEngaged(process.env.ADMIN_V2_READ_KILL_SWITCH) ? "read" : null;
  }
  if (!pathname.startsWith("/api/v2/admin")) return null;
  if (readOnly && killSwitchEngaged(process.env.ADMIN_V2_READ_KILL_SWITCH)) return "read";
  if (!readOnly && killSwitchEngaged(process.env.ADMIN_V2_WRITE_KILL_SWITCH)) return "write";
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

function recordProxyMetrics(
  method: string,
  outcome: string,
  surface: string,
  routeClass: string,
  startedAt: number,
  domain: AdminCutoverDomain | null,
  readAuthority: AdminProxyAuthority,
) {
  const labels = { domain: domain ?? "unscoped", method, outcome, readAuthority, routeClass, surface };
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

function provenanceHeaders(
  domain: AdminCutoverDomain | null,
  readAuthority: AdminProxyAuthority,
  initial: HeadersInit = {},
) {
  const headers = new Headers(initial);
  addProvenanceHeaders(headers, domain, readAuthority);
  return headers;
}

function addProvenanceHeaders(
  headers: Headers,
  domain: AdminCutoverDomain | null,
  readAuthority: AdminProxyAuthority,
) {
  if (domain) headers.set("x-idream-admin-domain", domain);
  headers.set("x-idream-admin-read-authority", readAuthority);
  const sourceRevision =
    process.env.IDREAM_SOURCE_REVISION?.trim() ||
    process.env.SENTRY_RELEASE?.trim();
  if (sourceRevision) {
    headers.set("x-idream-admin-source-revision", sourceRevision);
  }
}
