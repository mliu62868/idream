import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_V2_API_OPERATIONS,
  findAdminV2ApiOperation,
  renderPrometheusMetrics,
  requireExecutableAdminV2Contract,
  resetMetricsForTests,
} from "@idream/shared";
import { BFF_HEADER, BFF_USER_HEADER, verifyBffContext, type BffContext } from "@idream/shared/bff";
import { proxyToMain } from "./main-proxy";

const SIGNING_SECRET = "admin-bff-test-secret-at-least-32-characters";

function validV2Response(method: string, pathname: string) {
  const operation = findAdminV2ApiOperation(method, pathname);
  if (!operation) throw new Error(`Missing manifest operation for ${method} ${pathname}`);
  return Response.json({
    ok: true,
    data: requireExecutableAdminV2Contract(operation.contract.response).fixtures.valid,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetMetricsForTests();
});

describe("Admin main HTTP proxy", () => {
  it("binds every declared operation response to the runtime BFF contract gate", async () => {
    vi.stubGlobal("fetch", vi.fn(async (target: URL, init: RequestInit) =>
      validV2Response(init.method ?? "GET", target.pathname)));

    for (const operation of ADMIN_V2_API_OPERATIONS) {
      const pathname = operation.route.replace(/:[^/]+/g, "fixture");
      const response = await proxyToMain(
        new Request(`http://admin.local${pathname}`, {
          method: operation.method,
          body: operation.method === "GET" ? undefined : "{}",
        }),
        pathname,
      );
      expect(response.status, operation.id).toBe(200);
    }
  });

  it("fails closed when a successful Admin v2 response violates its manifest contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: {} })));

    const response = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/bootstrap"),
      "/api/v2/admin/bootstrap",
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "admin_v2_response_contract_violation",
        operationId: "GET /api/v2/admin/bootstrap",
      },
    });
  });

  it("passes a manifest-valid Admin v2 response through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => validV2Response("GET", "/api/v2/admin/bootstrap")));

    const response = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/bootstrap"),
      "/api/v2/admin/bootstrap",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { bootstrap: {} } });
  });
  it("forwards method, query, cookie, and body without hop-by-hop headers", async () => {
    vi.stubEnv("ADMIN_BFF_SIGNING_SECRET", SIGNING_SECRET);
    const fetchMock = vi.fn(async (target: URL, init: RequestInit) => {
      expect(target.toString()).toBe("http://127.0.0.1:3000/api/v1/admin/users?status=active");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("cookie")).toBe("idream_admin_session=token");
      expect(new Headers(init.headers).get("host")).toBeNull();
      const forwardedBody = new TextDecoder().decode(init.body as Uint8Array);
      expect(forwardedBody).toBe('{"status":"active"}');
      const headers = new Headers(init.headers);
      expect(headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      const context = JSON.parse(headers.get(BFF_USER_HEADER) ?? "null") as BffContext;
      expect(context.userId).toBe("admin-bff");
      expect(verifyBffContext({
        secret: SIGNING_SECRET,
        signature: headers.get(BFF_HEADER) ?? "",
        context,
        method: "POST",
        path: "/api/v1/admin/users?status=active",
        body: Buffer.from(forwardedBody).toString("base64"),
        now: context.authTime,
      })).toEqual({ ok: true });
      return new Response('{"ok":true}', {
        status: 202,
        headers: { "content-type": "application/json", "set-cookie": "admin=renewed; Path=/" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyToMain(
      new Request("http://admin.local/api/v1/admin/users?status=active", {
        method: "POST",
        headers: {
          connection: "keep-alive",
          cookie: "idream_admin_session=token",
          "content-type": "application/json",
        },
        body: '{"status":"active"}',
      }),
      "/api/v1/admin/users",
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("set-cookie")).toContain("admin=renewed");
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(renderPrometheusMetrics()).toContain(
      'admin_http_requests_total{domain="unscoped",method="POST",outcome="completed",readAuthority="not_applicable",routeClass="command",surface="legacy_v1"} 1',
    );
    expect(renderPrometheusMetrics()).toContain(
      'admin_legacy_v1_requests_total{method="POST",outcome="completed"} 1',
    );
  });

  it("fails closed in production before contacting main when service HMAC is unconfigured", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("ADMIN_BFF_SIGNING_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyToMain(
      new Request("https://admin.example/api/v2/admin/today"),
      "/api/v2/admin/today",
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin_bff_signing_unconfigured" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when main authority is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("main down"))));
    const response = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/today"),
      "/api/v2/admin/today",
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "admin_upstream_unavailable" },
    });
    expect(renderPrometheusMetrics()).toContain(
      'admin_http_requests_total{domain="today",method="GET",outcome="unavailable",readAuthority="canonical_v2",routeClass="today",surface="admin_v2"} 1',
    );
  });

  it("provides independent fail-closed read and write kill switches for v2 cutover", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    vi.stubEnv("ADMIN_V2_READ_KILL_SWITCH", "true");
    const readBlocked = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/today"),
      "/api/v2/admin/today",
    );
    expect(readBlocked.status).toBe(503);
    await expect(readBlocked.json()).resolves.toMatchObject({
      error: { code: "admin_v2_read_kill_switch_active" },
    });

    vi.stubEnv("ADMIN_V2_READ_KILL_SWITCH", "false");
    vi.stubEnv("ADMIN_V2_WRITE_KILL_SWITCH", "true");
    const writeBlocked = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/cases/case-1/commands/close", {
        method: "POST",
        body: "{}",
      }),
      "/api/v2/admin/cases/case-1/commands/close",
    );
    expect(writeBlocked.status).toBe(503);
    expect(writeBlocked.headers.get("retry-after")).toBe("0");
    await expect(writeBlocked.json()).resolves.toMatchObject({
      error: { code: "admin_v2_write_kill_switch_active" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(renderPrometheusMetrics()).toContain(
      'admin_proxy_kill_switch_total{domain="today",readAuthority="global_kill_switch",scope="read"} 1',
    );
    expect(renderPrometheusMetrics()).toContain(
      'admin_proxy_kill_switch_total{domain="case",readAuthority="global_kill_switch",scope="write"} 1',
    );
  });

  it("classifies every v2 mutation as a command for the command-accept SLO", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => validV2Response("POST", "/api/v2/admin/cases/case-1/assignment")));

    const response = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/cases/case-1/assignment", {
        method: "POST",
        body: "{}",
      }),
      "/api/v2/admin/cases/case-1/assignment",
    );

    expect(response.status).toBe(200);
    expect(renderPrometheusMetrics()).toContain(
      'admin_http_requests_total{domain="case",method="POST",outcome="completed",readAuthority="canonical_write",routeClass="command",surface="admin_v2"} 1',
    );
  });

  it("rolls back one domain read through a same-contract HTTP authority without changing another domain", async () => {
    vi.stubEnv("ADMIN_CASE_READ_AUTHORITY", "compatibility_http");
    vi.stubEnv("ADMIN_CASE_COMPATIBILITY_READ_URL", "https://previous-main.internal");
    const targets: string[] = [];
    const upstreamProvenance: Array<[string | null, string | null]> = [];
    vi.stubGlobal("fetch", vi.fn(async (target: URL, init: RequestInit) => {
      targets.push(target.toString());
      const headers = new Headers(init.headers);
      upstreamProvenance.push([
        headers.get("x-idream-admin-domain"),
        headers.get("x-idream-admin-read-authority"),
      ]);
      return validV2Response("GET", new URL(target).pathname);
    }));

    const caseResponse = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/cases?status=open", {
        headers: {
          "x-idream-admin-domain": "character",
          "x-idream-admin-read-authority": "canonical_v2",
        },
      }),
      "/api/v2/admin/cases",
    );
    const incidentResponse = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/incidents?status=open"),
      "/api/v2/admin/incidents",
    );

    expect(targets).toEqual([
      "https://previous-main.internal/api/v2/admin/cases?status=open",
      "http://127.0.0.1:3000/api/v2/admin/incidents?status=open",
    ]);
    expect(upstreamProvenance).toEqual([
      ["case", "compatibility_http"],
      ["incident", "canonical_v2"],
    ]);
    expect(caseResponse.headers.get("x-idream-admin-domain")).toBe("case");
    expect(caseResponse.headers.get("x-idream-admin-read-authority")).toBe("compatibility_http");
    expect(incidentResponse.headers.get("x-idream-admin-domain")).toBe("incident");
    expect(incidentResponse.headers.get("x-idream-admin-read-authority")).toBe("canonical_v2");
    expect(renderPrometheusMetrics()).toContain(
      'admin_http_requests_total{domain="case",method="GET",outcome="completed",readAuthority="compatibility_http",routeClass="list",surface="admin_v2"} 1',
    );
    expect(renderPrometheusMetrics()).toContain(
      'admin_http_requests_total{domain="incident",method="GET",outcome="completed",readAuthority="canonical_v2",routeClass="list",surface="admin_v2"} 1',
    );
  });

  it("returns explicit unavailable instead of mapping a v2 read to a non-equivalent legacy DTO", async () => {
    vi.stubEnv("ADMIN_TODAY_READ_AUTHORITY", "compatibility_http");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/today"),
      "/api/v2/admin/today",
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("x-idream-admin-domain")).toBe("today");
    expect(response.headers.get("x-idream-admin-read-authority")).toBe("unavailable");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin_today_compatibility_read_unconfigured" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps writes on canonical authority even when the domain read uses compatibility HTTP", async () => {
    vi.stubEnv("ADMIN_CASE_READ_AUTHORITY", "compatibility_http");
    vi.stubEnv("ADMIN_CASE_COMPATIBILITY_READ_URL", "https://previous-main.internal");
    vi.stubEnv("ADMIN_CASE_WRITE_AUTHORITY", "legacy_v1");
    const fetchMock = vi.fn(async (target: URL) => {
      expect(target.toString()).toContain("/api/v2/admin/cases/case-1/commands/close");
      return validV2Response("POST", "/api/v2/admin/cases/case-1/commands/close");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/cases/case-1/commands/close", {
        method: "POST",
        body: "{}",
      }),
      "/api/v2/admin/cases/case-1/commands/close",
    );

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:3000/api/v2/admin/cases/case-1/commands/close",
    );
    expect(response.headers.get("x-idream-admin-domain")).toBe("case");
    expect(response.headers.get("x-idream-admin-read-authority")).toBe("canonical_write");
  });

  it("applies the global kill switch before invalid domain read configuration", async () => {
    vi.stubEnv("ADMIN_V2_READ_KILL_SWITCH", "true");
    vi.stubEnv("ADMIN_CHARACTER_READ_AUTHORITY", "legacy_v1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/characters"),
      "/api/v2/admin/characters",
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin_v2_read_kill_switch_active" },
    });
    expect(response.headers.get("x-idream-admin-domain")).toBe("character");
    expect(response.headers.get("x-idream-admin-read-authority")).toBe("global_kill_switch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the canonical write authority URL is invalid", async () => {
    vi.stubEnv("MAIN_WEB_URL", "not-a-valid-authority");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/incidents/incident-1/commands/resolve", {
        method: "POST",
        body: "{}",
      }),
      "/api/v2/admin/incidents/incident-1/commands/resolve",
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin_main_authority_url_invalid" },
    });
    expect(response.headers.get("x-idream-admin-domain")).toBe("incident");
    expect(response.headers.get("x-idream-admin-read-authority")).toBe("canonical_write");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
