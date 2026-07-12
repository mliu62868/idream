import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPrometheusMetrics, resetMetricsForTests } from "@idream/shared";
import { BFF_HEADER, BFF_USER_HEADER, verifyBffContext, type BffContext } from "@idream/shared/bff";
import { proxyToMain } from "./main-proxy";

const SIGNING_SECRET = "admin-bff-test-secret-at-least-32-characters";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetMetricsForTests();
});

describe("Admin main HTTP proxy", () => {
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
      'admin_http_requests_total{method="POST",outcome="completed",routeClass="command",surface="legacy_v1"} 1',
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
      'admin_http_requests_total{method="GET",outcome="unavailable",routeClass="today",surface="admin_v2"} 1',
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
      'admin_proxy_kill_switch_total{scope="read"} 1',
    );
    expect(renderPrometheusMetrics()).toContain(
      'admin_proxy_kill_switch_total{scope="write"} 1',
    );
  });

  it("classifies every v2 mutation as a command for the command-accept SLO", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":true}', { status: 200 })));

    const response = await proxyToMain(
      new Request("http://admin.local/api/v2/admin/cases/case-1/assignment", {
        method: "POST",
        body: "{}",
      }),
      "/api/v2/admin/cases/case-1/assignment",
    );

    expect(response.status).toBe(200);
    expect(renderPrometheusMetrics()).toContain(
      'admin_http_requests_total{method="POST",outcome="completed",routeClass="command",surface="admin_v2"} 1',
    );
  });
});
