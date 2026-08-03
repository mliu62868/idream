import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ProbeReportOf, WebSurfaceProbeEvidence } from "./readiness/evidence";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";

type ProbeOptions = {
  report: string | null;
  mainUrl: string | null;
  adminUrl: string | null;
};

export type WebSurfaceProbeRuntime = {
  fetch?: AssetFetch;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
};

type PageEvidence = {
  ok: boolean;
  status?: number;
  bytes?: number;
  contentType?: string | null;
  containsBrand?: boolean;
  containsGenerator?: boolean;
  nextErrorShell?: boolean;
  assets?: LinkedAssetEvidence;
  error?: string | null;
};

export type LinkedAssetFailure = {
  url: string;
  status?: number;
  bytes?: number;
  contentType?: string | null;
  error: string;
};

export type LinkedAssetEvidence = {
  ok: boolean;
  checked: number;
  failures: LinkedAssetFailure[];
};

export type AssetFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ApiAgeGateEvidence = {
  ok: boolean;
  status?: number;
  code?: string | null;
  reason?: string | null;
  error?: string | null;
};

type AdminApiEvidence = {
  ok: boolean;
  status?: number;
  code?: string | null;
  error?: string | null;
};

type AdminEvidence = {
  ok: boolean;
  status?: number;
  bytes?: number;
  contentType?: string | null;
  protected?: boolean;
  protectedReason?: "access_denied" | "dev_login_wall" | null;
  nextErrorShell?: boolean;
  assets?: LinkedAssetEvidence;
  error?: string | null;
};

// SPEC: 写出的 JSON 由 launch gate 的 evidence 契约约束，两端共用 readiness/evidence.ts。
// INTENT: 只把顶层收到契约上 —— 上面那几个嵌套类型比契约更精确（protectedReason 是字面量联合、
//         LinkedAssetFailure 的 url/error 必填），赋值时由 tsc 校验它们能落进契约，精度不丢。
type WebSurfaceProbeReport = ProbeReportOf<WebSurfaceProbeEvidence>;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 45_000;

export function isAdminDevLoginWallHtml(html: string) {
  if (html.includes('data-admin-auth-wall="dev-login-v1"')) return true;
  const hasEnvironmentMarker =
    html.includes("DEV ONLY") ||
    html.includes("仅限开发环境");
  const hasLoginHeading =
    html.includes("Admin login") ||
    html.includes("后台登录");
  const hasPasswordControl =
    /<input\b[^>]*\btype\s*=\s*(?:"password"|'password')[^>]*>/i.test(html);
  return hasEnvironmentMarker && hasLoginHeading && hasPasswordControl;
}

export function isAdminAccessDeniedHtml(html: string) {
  return (
    html.includes('data-admin-auth-wall="access-denied-v1"') ||
    html.includes("Admin access denied") ||
    html.includes("无后台访问权限")
  );
}

function readOptions(): ProbeOptions {
  return {
    report: probeReportPath("webSurfaceProbe"),
    mainUrl:
      probeCliArg("main-url") ??
      process.env.MAIN_WEB_URL ??
      process.env.BETTER_AUTH_URL ??
      null,
    adminUrl: probeCliArg("admin-url") ?? process.env.ADMIN_WEB_URL ?? null,
  };
}

export async function main() {
  const options = readOptions();
  const report = await runProbe(options);

  if (options.report) {
    await writeProbeReport(options.report, report);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

export async function runProbe(
  options: ProbeOptions,
  runtime: WebSurfaceProbeRuntime = {},
): Promise<WebSurfaceProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const requestTimeoutMs = positiveTimeout(
    runtime.requestTimeoutMs ??
      Number(process.env.WEB_SURFACE_PROBE_REQUEST_TIMEOUT_MS),
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const totalTimeoutMs = positiveTimeout(
    runtime.totalTimeoutMs ??
      Number(process.env.WEB_SURFACE_PROBE_TOTAL_TIMEOUT_MS),
    DEFAULT_TOTAL_TIMEOUT_MS,
  );
  const totalSignal = AbortSignal.timeout(totalTimeoutMs);
  const checks = runProbeChecks(options, {
    fetch: runtime.fetch ?? fetch,
    requestTimeoutMs,
    totalSignal,
    checkedAt,
    startedAt,
  });
  const report = await Promise.race([
    checks,
    new Promise<null>((resolve) => {
      if (totalSignal.aborted) {
        resolve(null);
        return;
      }
      totalSignal.addEventListener("abort", () => resolve(null), {
        once: true,
      });
    }),
  ]);
  if (report) return report;

  const error =
    `Web surface probe exceeded its total deadline of ${totalTimeoutMs}ms`;
  return {
    ok: false,
    checkedAt,
    durationMs: Date.now() - startedAt,
    mainUrl: normalizeBaseUrl(options.mainUrl),
    adminUrl: normalizeBaseUrl(options.adminUrl),
    home: { ok: false, error },
    generate: { ok: false, error },
    apiAgeGate: { ok: false, error },
    admin: { ok: false, error },
    adminApi: { ok: false, error },
    error: {
      code: "web_surface_probe_timeout",
      message: error,
      retryable: true,
    },
  };
}

async function runProbeChecks(
  options: ProbeOptions,
  runtime: {
    fetch: AssetFetch;
    requestTimeoutMs: number;
    totalSignal: AbortSignal;
    checkedAt: string;
    startedAt: number;
  },
): Promise<WebSurfaceProbeReport> {
  const home = await probeHtmlPage({
    baseUrl: options.mainUrl,
    pathname: "/",
    marker: "ourdream",
    markerKey: "containsBrand",
    fetch: runtime.fetch,
    requestTimeoutMs: runtime.requestTimeoutMs,
    signal: runtime.totalSignal,
  });
  const generate = await probeHtmlPage({
    baseUrl: options.mainUrl,
    pathname: "/generate",
    marker: "generator",
    markerKey: "containsGenerator",
    fetch: runtime.fetch,
    requestTimeoutMs: runtime.requestTimeoutMs,
    signal: runtime.totalSignal,
  });
  const apiAgeGate = await probeApiAgeGate(
    options.mainUrl,
    runtime,
  );
  const admin = await probeAdmin(options.adminUrl, runtime);
  const adminApi = await probeAdminApi(options.adminUrl, runtime);
  const ok = home.ok && generate.ok && apiAgeGate.ok && admin.ok && adminApi.ok;

  return {
    ok,
    checkedAt: runtime.checkedAt,
    durationMs: Date.now() - runtime.startedAt,
    mainUrl: normalizeBaseUrl(options.mainUrl),
    adminUrl: normalizeBaseUrl(options.adminUrl),
    home,
    generate,
    apiAgeGate,
    admin,
    adminApi,
    error: ok
      ? null
      : {
          code: "web_surface_probe_failed",
          message: "One or more web surface checks failed.",
          retryable: true,
        },
  };
}

export async function probeHtmlPage(input: {
  baseUrl: string | null;
  pathname: string;
  marker: string;
  markerKey: "containsBrand" | "containsGenerator";
  fetch?: AssetFetch;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PageEvidence> {
  let url = input.pathname;
  const requestTimeoutMs = positiveTimeout(
    input.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  try {
    url = buildUrl(input.baseUrl, input.pathname);
    const response = await fetchWithDeadline(input.fetch ?? fetch, url, {
      headers: { accept: "text/html" },
      redirect: "follow",
    }, {
      requestTimeoutMs,
      signal: input.signal,
    });
    const text = await response.text();
    const assets = await probeLinkedNextAssets(
      text,
      response.url || url,
      input.fetch ?? fetch,
      {
        requestTimeoutMs,
        signal: input.signal,
      },
    );
    const evidence: PageEvidence = {
      ok: false,
      status: response.status,
      bytes: Buffer.byteLength(text),
      contentType: response.headers.get("content-type"),
      nextErrorShell: text.includes('id="__next_error__"'),
      assets,
      [input.markerKey]: text.toLowerCase().includes(input.marker),
      error: null,
    };
    evidence.ok =
      response.status === 200 &&
      evidence.bytes !== undefined &&
      evidence.bytes > 1_000 &&
      evidence.nextErrorShell !== true &&
      assets.ok &&
      Boolean(evidence[input.markerKey]);
    if (!evidence.ok) evidence.error = `Unexpected HTML response from ${url}`;
    return evidence;
  } catch (error) {
    return {
      ok: false,
      error: requestFailure(url, error, requestTimeoutMs),
    };
  }
}

async function probeApiAgeGate(
  baseUrl: string | null,
  runtime: {
    fetch: AssetFetch;
    requestTimeoutMs: number;
    totalSignal: AbortSignal;
  },
): Promise<ApiAgeGateEvidence> {
  let url = "/api/v1/characters?limit=1";
  try {
    url = buildUrl(baseUrl, url);
    const response = await fetchWithDeadline(runtime.fetch, url, {
      headers: { accept: "application/json" },
      redirect: "follow",
    }, {
      requestTimeoutMs: runtime.requestTimeoutMs,
      signal: runtime.totalSignal,
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          error?: {
            code?: string;
            details?: { reason?: string };
          };
        }
      | null;
    const code = payload?.error?.code ?? null;
    const reason = payload?.error?.details?.reason ?? null;
    return {
      ok: response.status === 403 && code === "forbidden" && reason === "age_gate_required",
      status: response.status,
      code,
      reason,
      error:
        response.status === 403 && code === "forbidden" && reason === "age_gate_required"
          ? null
          : `Expected unauthenticated character API to fail closed at ${url}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: requestFailure(url, error, runtime.requestTimeoutMs),
    };
  }
}

async function probeAdmin(
  baseUrl: string | null,
  runtime: {
    fetch: AssetFetch;
    requestTimeoutMs: number;
    totalSignal: AbortSignal;
  },
): Promise<AdminEvidence> {
  let url = "/admin/today";
  try {
    url = buildUrl(baseUrl, url);
    const response = await fetchWithDeadline(runtime.fetch, url, {
      headers: { accept: "text/html" },
      redirect: "follow",
    }, {
      requestTimeoutMs: runtime.requestTimeoutMs,
      signal: runtime.totalSignal,
    });
    const text = await response.text();
    const accessDenied = isAdminAccessDeniedHtml(text);
    const devLoginWall = isAdminDevLoginWallHtml(text);
    const protectedSurface = accessDenied || devLoginWall;
    const protectedReason = accessDenied
      ? "access_denied"
      : devLoginWall
        ? "dev_login_wall"
        : null;
    const nextErrorShell = text.includes('id="__next_error__"');
    const bytes = Buffer.byteLength(text);
    const assets = await probeLinkedNextAssets(
      text,
      response.url || url,
      runtime.fetch,
      {
        requestTimeoutMs: runtime.requestTimeoutMs,
        signal: runtime.totalSignal,
      },
    );
    return {
      ok:
        response.status === 200 &&
        protectedSurface &&
        !nextErrorShell &&
        bytes > 1_000 &&
        assets.ok,
      status: response.status,
      bytes,
      contentType: response.headers.get("content-type"),
      protected: protectedSurface,
      protectedReason,
      nextErrorShell,
      assets,
      error:
        response.status === 200 &&
          protectedSurface &&
          !nextErrorShell &&
          assets.ok
          ? null
          : `Expected protected admin surface at ${url}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: requestFailure(url, error, runtime.requestTimeoutMs),
    };
  }
}

export function extractLinkedNextAssetUrls(
  html: string,
  documentUrl: string,
) {
  const urls = new Set<string>();
  const attributePattern =
    /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  for (const match of html.matchAll(attributePattern)) {
    const raw = (match[1] ?? match[2] ?? "").replaceAll("&amp;", "&");
    if (!raw) continue;
    try {
      const url = new URL(raw, documentUrl);
      if (
        url.pathname.startsWith("/_next/static/") &&
        /\.(?:js|css)$/i.test(url.pathname)
      ) {
        urls.add(url.toString());
      }
    } catch {
      // Ignore unrelated malformed attributes; page health checks still
      // evaluate every valid linked Next JavaScript and stylesheet.
    }
  }
  return [...urls];
}

export async function probeLinkedNextAssets(
  html: string,
  documentUrl: string,
  fetchAsset: AssetFetch = fetch,
  runtime: {
    requestTimeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<LinkedAssetEvidence> {
  const requestTimeoutMs = positiveTimeout(
    runtime.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const urls = extractLinkedNextAssetUrls(html, documentUrl);
  if (urls.length === 0) {
    return {
      ok: false,
      checked: 0,
      failures: [{
        url: documentUrl,
        error: "HTML linked no Next JavaScript or CSS assets",
      }],
    };
  }

  const results: Array<LinkedAssetFailure | null> = await Promise.all(
    urls.map(async (url): Promise<LinkedAssetFailure | null> => {
    try {
      const response = await fetchWithDeadline(fetchAsset, url, {
        headers: {
          accept: urlPathHasExtension(url, ".css")
            ? "text/css"
            : "application/javascript",
        },
        redirect: "follow",
      }, {
        requestTimeoutMs,
        signal: runtime.signal,
      });
      const bytes = (await response.arrayBuffer()).byteLength;
      const contentType = response.headers.get("content-type");
      const expectedMime = urlPathHasExtension(url, ".css")
        ? contentType?.toLowerCase().includes("text/css") === true
        : contentType?.toLowerCase().includes("javascript") === true;
      if (response.status === 200 && bytes > 0 && expectedMime) return null;
      return {
        url,
        status: response.status,
        bytes,
        contentType,
        error:
          response.status !== 200
            ? `Linked Next asset returned HTTP ${response.status}`
            : bytes === 0
              ? "Linked Next asset was empty"
              : "Linked Next asset returned an unexpected content type",
      } satisfies LinkedAssetFailure;
    } catch (error) {
      return {
        url,
        error: requestFailure(url, error, requestTimeoutMs),
      } satisfies LinkedAssetFailure;
    }
    }),
  );
  const failures = results.filter(
    (result): result is LinkedAssetFailure => result !== null,
  );
  return {
    ok: failures.length === 0,
    checked: urls.length,
    failures,
  };
}

function urlPathHasExtension(url: string, extension: ".js" | ".css") {
  return new URL(url).pathname.toLowerCase().endsWith(extension);
}

async function probeAdminApi(
  baseUrl: string | null,
  runtime: {
    fetch: AssetFetch;
    requestTimeoutMs: number;
    totalSignal: AbortSignal;
  },
): Promise<AdminApiEvidence> {
  let url = "/api/v1/admin/dashboard";
  try {
    url = buildUrl(baseUrl, url);
    const response = await fetchWithDeadline(runtime.fetch, url, {
      headers: { accept: "application/json" },
      redirect: "follow",
    }, {
      requestTimeoutMs: runtime.requestTimeoutMs,
      signal: runtime.totalSignal,
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          error?: {
            code?: string;
          };
        }
      | null;
    const code = payload?.error?.code ?? null;
    return {
      ok: response.status === 401 && code === "unauthorized",
      status: response.status,
      code,
      error:
        response.status === 401 && code === "unauthorized"
          ? null
          : `Expected unauthenticated admin API to fail closed at ${url}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: requestFailure(url, error, runtime.requestTimeoutMs),
    };
  }
}

async function fetchWithDeadline(
  fetcher: AssetFetch,
  input: string | URL | Request,
  init: RequestInit,
  runtime: {
    requestTimeoutMs: number;
    signal?: AbortSignal;
  },
) {
  const signals = [
    AbortSignal.timeout(runtime.requestTimeoutMs),
    runtime.signal,
    init.signal,
  ].filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
  return fetcher(input, {
    ...init,
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  });
}

function requestFailure(
  url: string,
  error: unknown,
  requestTimeoutMs: number,
) {
  const message = error instanceof Error ? error.message : String(error);
  const kind = error instanceof Error ? error.name : "";
  return kind === "AbortError" || kind === "TimeoutError"
    ? `Request to ${url} timed out or was aborted within ${requestTimeoutMs}ms: ${message}`
    : `Request to ${url} failed: ${message}`;
}

function positiveTimeout(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : fallback;
}

function buildUrl(baseUrl: string | null, pathname: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) throw new Error("base URL is required");
  return new URL(pathname, normalized).toString();
}

function normalizeBaseUrl(baseUrl: string | null | undefined) {
  if (!baseUrl?.trim()) return null;
  return baseUrl.trim().replace(/\/+$/, "/");
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(
      error instanceof Error ? `${error.message}\n` : `${String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
