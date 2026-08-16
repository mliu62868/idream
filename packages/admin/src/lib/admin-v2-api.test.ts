import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminV2RequestError, adminV2Request, setWorkspaceUrl } from "./admin-v2-api";

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

  // SPEC: 非 JSON 响应也必须是 AdminV2RequestError，且带住状态码。
  // INTENT: 以前抛裸 Error，状态码只存在于那句英文里，运营首屏就只剩 "…failed (500)"；
  //         成了 AdminV2RequestError，状态码才能被 ui/request-error-copy 接住翻成人话。
  it("turns a non-JSON upstream failure into a typed, status-carrying error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));

    const rejection = await adminV2Request("/api/v2/admin/incidents").catch(
      (cause: unknown) => cause,
    );

    expect(rejection).toBeInstanceOf(AdminV2RequestError);
    expect((rejection as AdminV2RequestError).status).toBe(500);
    expect((rejection as AdminV2RequestError).code).toBeUndefined();
    expect((rejection as AdminV2RequestError).requestId).toBeTruthy();
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

  it("forwards cancellation to projection reads", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({ ok: true, data: { id: "case-1" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await adminV2Request("/api/v2/admin/cases/case-1", {
      signal: controller.signal,
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.signal).toBe(controller.signal);
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

  it("preserves an exact in-page repair target for workspace navigation", () => {
    const pushState = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/admin/characters/alexa-reeves" },
      history: { pushState, replaceState: vi.fn() },
    });

    setWorkspaceUrl(
      new URLSearchParams({ tab: "visual" }),
      {
        mode: "push",
        ...({
          hash: "route-qualification-workbench",
        } as Parameters<typeof setWorkspaceUrl>[1]),
      },
    );

    expect(pushState).toHaveBeenCalledWith(
      null,
      "",
      "/admin/characters/alexa-reeves?tab=visual#route-qualification-workbench",
    );
  });
});
