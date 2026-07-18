import { describe, expect, it, vi } from "vitest";

import { loadChatSessionsForViewer } from "./ChatHubWorkspace";
import { loadProfileForViewer } from "./ProfileWorkspace";
import { loadUpgradeProfileForViewer } from "./UpgradeWorkspace";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
