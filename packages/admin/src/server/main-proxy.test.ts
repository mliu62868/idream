import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyToMain } from "./main-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Admin main HTTP proxy", () => {
  it("forwards method, query, cookie, and body without hop-by-hop headers", async () => {
    const fetchMock = vi.fn(async (target: URL, init: RequestInit) => {
      expect(target.toString()).toBe("http://127.0.0.1:3000/api/v1/admin/users?status=active");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("cookie")).toBe("idream_admin_session=token");
      expect(new Headers(init.headers).get("host")).toBeNull();
      expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"status":"active"}');
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
  });
});
