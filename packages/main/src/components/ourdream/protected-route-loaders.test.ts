import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadChatSessionsForViewer } from "./ChatHubWorkspace";
import { loadProfileForViewer } from "./ProfileWorkspace";
import { loadUpgradeProfileForViewer } from "./UpgradeWorkspace";
import { invalidateViewerAuthority } from "./viewer-auth";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Viewer authority is resolved once per page lifetime and shared by every
// protected loader, so each case has to start before anyone has resolved it.
// What these cases pin down is unchanged: no loader may touch its protected
// path until the viewer is known to be signed in.
beforeEach(() => {
  invalidateViewerAuthority();
});

const protectedRouteLoaders = [
  ["profile", "/api/v1/profile", loadProfileForViewer],
  ["upgrade", "/api/v1/profile", loadUpgradeProfileForViewer],
  ["chat", "/api/v1/chat/sessions", loadChatSessionsForViewer],
] as const;

describe.each(protectedRouteLoaders)(
  "%s protected route loader",
  (_name, protectedPath, loadForViewer) => {
    it("does not send its protected request for an anonymous viewer", async () => {
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("/api/v1/me");
        return jsonResponse({ ok: true, data: { user: null } });
      });

      const result = await loadForViewer(fetcher);

      expect(result).toEqual({ viewer: "anonymous", response: null });
      expect(fetcher).not.toHaveBeenCalledWith(protectedPath, expect.anything());
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("sends its protected request only after authentication resolves", async () => {
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/v1/me") {
          return jsonResponse({ ok: true, data: { user: { id: "user-1" } } });
        }
        return jsonResponse([]);
      });

      const result = await loadForViewer(fetcher);

      expect(result.viewer).toBe("authenticated");
      expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
        "/api/v1/me",
        protectedPath,
      ]);
    });

    it("does not send its protected request for a malformed user object", async () => {
      const fetcher = vi.fn(async () =>
        jsonResponse({ ok: true, data: { user: {} } }),
      );

      await expect(loadForViewer(fetcher)).rejects.toThrow(
        "Invalid viewer authority response",
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  },
);
