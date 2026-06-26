import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type ProbeOptions = {
  report: string | null;
  mainUrl: string | null;
  adminUrl: string | null;
};

type PageEvidence = {
  ok: boolean;
  status?: number;
  bytes?: number;
  contentType?: string | null;
  containsBrand?: boolean;
  containsGenerator?: boolean;
  nextErrorShell?: boolean;
  error?: string | null;
};

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
  nextErrorShell?: boolean;
  error?: string | null;
};

type WebSurfaceProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  mainUrl: string | null;
  adminUrl: string | null;
  home: PageEvidence;
  generate: PageEvidence;
  apiAgeGate: ApiAgeGateEvidence;
  admin: AdminEvidence;
  adminApi: AdminApiEvidence;
  error: { code: string; message: string; retryable?: boolean } | null;
};

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptions(): ProbeOptions {
  return {
    report: readArg("report") ?? process.env.WEB_SURFACE_PROBE_REPORT ?? null,
    mainUrl:
      readArg("main-url") ??
      process.env.MAIN_WEB_URL ??
      process.env.BETTER_AUTH_URL ??
      null,
    adminUrl: readArg("admin-url") ?? process.env.ADMIN_WEB_URL ?? null,
  };
}

async function main() {
  const options = readOptions();
  const report = await runProbe(options);

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function runProbe(options: ProbeOptions): Promise<WebSurfaceProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const home = await probeHtmlPage({
    baseUrl: options.mainUrl,
    pathname: "/",
    marker: "ourdream",
    markerKey: "containsBrand",
  });
  const generate = await probeHtmlPage({
    baseUrl: options.mainUrl,
    pathname: "/generate",
    marker: "generator",
    markerKey: "containsGenerator",
  });
  const apiAgeGate = await probeApiAgeGate(options.mainUrl);
  const admin = await probeAdmin(options.adminUrl);
  const adminApi = await probeAdminApi(options.adminUrl);
  const ok = home.ok && generate.ok && apiAgeGate.ok && admin.ok && adminApi.ok;

  return {
    ok,
    checkedAt,
    durationMs: Date.now() - startedAt,
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

async function probeHtmlPage(input: {
  baseUrl: string | null;
  pathname: string;
  marker: string;
  markerKey: "containsBrand" | "containsGenerator";
}): Promise<PageEvidence> {
  try {
    const url = buildUrl(input.baseUrl, input.pathname);
    const response = await fetch(url, {
      headers: { accept: "text/html" },
      redirect: "follow",
    });
    const text = await response.text();
    const evidence: PageEvidence = {
      ok: false,
      status: response.status,
      bytes: Buffer.byteLength(text),
      contentType: response.headers.get("content-type"),
      nextErrorShell: text.includes('id="__next_error__"'),
      [input.markerKey]: text.toLowerCase().includes(input.marker),
      error: null,
    };
    evidence.ok =
      response.status === 200 &&
      evidence.bytes !== undefined &&
      evidence.bytes > 1_000 &&
      evidence.nextErrorShell !== true &&
      Boolean(evidence[input.markerKey]);
    if (!evidence.ok) evidence.error = `Unexpected HTML response from ${url}`;
    return evidence;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeApiAgeGate(baseUrl: string | null): Promise<ApiAgeGateEvidence> {
  try {
    const url = buildUrl(baseUrl, "/api/v1/characters?limit=1");
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "follow",
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
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeAdmin(baseUrl: string | null): Promise<AdminEvidence> {
  try {
    const url = buildUrl(baseUrl, "/admin");
    const response = await fetch(url, {
      headers: { accept: "text/html" },
      redirect: "follow",
    });
    const text = await response.text();
    const protectedSurface = text.includes("Admin access denied");
    const nextErrorShell = text.includes('id="__next_error__"');
    const bytes = Buffer.byteLength(text);
    return {
      ok: response.status === 200 && protectedSurface && !nextErrorShell && bytes > 1_000,
      status: response.status,
      bytes,
      contentType: response.headers.get("content-type"),
      protected: protectedSurface,
      nextErrorShell,
      error:
        response.status === 200 && protectedSurface && !nextErrorShell
          ? null
          : `Expected protected admin surface at ${url}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeAdminApi(baseUrl: string | null): Promise<AdminApiEvidence> {
  try {
    const url = buildUrl(baseUrl, "/api/v1/admin/dashboard");
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "follow",
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
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
  process.exitCode = 1;
});
