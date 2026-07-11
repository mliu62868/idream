import { afterEach, describe, expect, it, vi } from "vitest";
import { adminV2Request } from "./admin-v2-api";

afterEach(() => vi.unstubAllGlobals());

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
