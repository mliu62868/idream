import { afterEach, describe, expect, it, vi } from "vitest";
import { adminV2Request, setWorkspaceUrl } from "./admin-v2-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin v2 client", () => {
  it("preserves authority error messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: false,
      error: { code: "version_conflict", message: "Case version changed" },
    }, { status: 409 })));

    await expect(adminV2Request("/api/v2/admin/cases/case-1")).rejects.toThrow(
      "Case version changed",
    );
  });

  it("turns a non-JSON upstream failure into a stable fail-closed error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));

    await expect(adminV2Request("/api/v2/admin/incidents")).rejects.toThrow(
      "Admin authority request failed (500)",
    );
  });

  it("validates successful data with the endpoint contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { id: "case-1" } })));
    const schema = { parse: vi.fn((value: unknown) => ({ ...(value as object), parsed: true })) };

    await expect(adminV2Request("/api/v2/admin/cases/case-1", { schema })).resolves.toEqual({
      id: "case-1",
      parsed: true,
    });
    expect(schema.parse).toHaveBeenCalledWith({ id: "case-1" });
  });

  it("forwards PUT watch mutations through the Admin HTTP BFF with idempotency", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({ ok: true, data: { watching: true } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await adminV2Request("/api/v2/admin/collaboration/incident/incident-1/watch", {
      method: "PUT",
      idempotencyKey: "watch-1",
      body: { watching: true },
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("watch-1");
  });
});

describe("setWorkspaceUrl", () => {
  it("uses replace for draft state and push for navigable state", () => {
    const pushState = vi.fn();
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/admin/cases" },
      history: { pushState, replaceState },
    });

    setWorkspaceUrl(new URLSearchParams({ search: "draft" }), { mode: "replace" });
    setWorkspaceUrl(new URLSearchParams({ cursor: "page-2" }), { mode: "push" });

    expect(replaceState).toHaveBeenCalledWith(null, "", "/admin/cases?search=draft");
    expect(pushState).toHaveBeenCalledWith(null, "", "/admin/cases?cursor=page-2");
  });

  it("can preserve a canonical detail pathname while updating its query state", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/admin/cases/case-7" },
      history: { pushState: vi.fn(), replaceState },
    });

    setWorkspaceUrl(new URLSearchParams({ case: "case-7" }), {
      mode: "replace",
      pathname: "/admin/cases/case-7",
    });

    expect(replaceState).toHaveBeenCalledWith(null, "", "/admin/cases/case-7?case=case-7");
  });
});
