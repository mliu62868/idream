import { describe, expect, it, vi } from "vitest";

import { fetchProtectedForViewer } from "./viewer-auth";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("protected viewer requests", () => {
  it("does not request the protected resource for an anonymous viewer", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/v1/me");
      return jsonResponse({ ok: true, data: { user: null } });
    });

    await expect(
      fetchProtectedForViewer("/api/v1/profile", undefined, fetcher),
    ).resolves.toEqual({ viewer: "anonymous", response: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requests the protected resource after authenticated viewer authority resolves", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/me") {
        return jsonResponse({ ok: true, data: { user: { id: "user-1" } } });
      }
      return jsonResponse({ ok: true, data: { user: { id: "user-1" } } });
    });

    const result = await fetchProtectedForViewer(
      "/api/v1/profile",
      { cache: "no-store" },
      fetcher,
    );

    expect(result.viewer).toBe("authenticated");
    expect(result.response?.ok).toBe(true);
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/v1/me", {
      cache: "no-store",
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/v1/profile", {
      cache: "no-store",
    });
  });

  it("does not request the protected resource when viewer authority fails", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        { ok: false, error: { message: "Viewer authority unavailable." } },
        503,
      ),
    );

    await expect(
      fetchProtectedForViewer("/api/v1/chat/sessions", undefined, fetcher),
    ).rejects.toThrow("Viewer authority unavailable.");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not request the protected resource for a malformed authenticated viewer", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ ok: true, data: { user: {} } }),
    );

    await expect(
      fetchProtectedForViewer("/api/v1/profile", undefined, fetcher),
    ).rejects.toThrow("Invalid viewer authority response");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
