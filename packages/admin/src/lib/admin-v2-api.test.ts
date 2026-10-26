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

  it.each([
    ["empty object", {}],
    ["array", []],
    ["numeric fields", { code: 123, message: 456 }],
    ["missing code", { message: "Rejected" }],
    ["missing message", { code: "bad_request" }],
    ["blank code", { code: " ", message: "Rejected" }],
    ["blank message", { code: "bad_request", message: " " }],
    ["numeric request ID", { code: "bad_request", message: "Rejected", requestId: 123 }],
    ["object request ID", { code: "bad_request", message: "Rejected", requestId: {} }],
    ["null request ID", { code: "bad_request", message: "Rejected", requestId: null }],
    ["blank request ID", { code: "bad_request", message: "Rejected", requestId: " " }],
  ])("treats a malformed error with %s as an unverified response", async (_, error) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error }, { status: 400 })));

    await expect(adminV2Request("/api/v2/admin/cases/case-1", {
      headers: { "x-request-id": "unverified-error-request" },
    })).rejects.toMatchObject({
      status: 400,
      code: "admin_v2_response_contract_violation",
      outcome: "unknown",
      requestId: "unverified-error-request",
    });
  });

  it("preserves extended authority facts from a valid error", async () => {
    const error = {
      code: "conflict",
      message: "Entity version changed",
      requestId: "authority-request",
      details: { blocker: "version_mismatch", expectedVersion: 2 },
      currentSnapshot: { id: "case-1", version: 3 },
      differences: ["Expected version 2"],
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error }, { status: 409 })));

    await expect(adminV2Request("/api/v2/admin/cases/case-1")).rejects.toMatchObject({
      code: "conflict",
      requestId: "authority-request",
      details: {
        ...error.details,
        currentSnapshot: error.currentSnapshot,
        differences: error.differences,
      },
    });
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

  it.each(["truncated JSON", "interrupted rejection", "invalid contract"])("retains request identity and an unknown outcome for %s", async (failure) => {
    const status = failure === "interrupted rejection" ? 400 : 200;
    const response = failure === "interrupted rejection"
      ? new Response(new ReadableStream({ start(controller) { controller.error(new Error("Receipt body lost")); } }), { status })
      : failure === "truncated JSON"
        ? new Response('{"ok":true,"data":', { status })
        : Response.json({ ok: true, data: { id: null } });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const schema = { parse: () => { throw new Error("No Run was created; invalid case receipt"); } };

    const error = await adminV2Request("/api/v2/admin/cases/case-1", {
      headers: { "x-request-id": "unverified-receipt-request" },
      schema,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdminV2RequestError);
    expect(error).toMatchObject({ status, outcome: "unknown", requestId: "unverified-receipt-request" });
    expect((error as AdminV2RequestError).message).not.toContain("No Run was created");
    if (failure === "invalid contract") {
      expect((error as AdminV2RequestError).details).toEqual({ validationError: "No Run was created; invalid case receipt" });
    }
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
