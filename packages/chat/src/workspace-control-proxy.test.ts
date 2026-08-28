import {
  COMPANION_MEMORY_PURGE_PATH,
  COMPANION_MEMORY_REBUILD_PREPARE_PATH,
  COMPANION_MEMORY_REBUILD_PROMOTE_PATH,
} from "@idream/shared/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeReadiness } from "./runtime-readiness.js";
import { handleChatRequest } from "./web.js";

describe("Chat companion workspace control proxy", () => {
  const fetchMock = vi.fn();
  const readiness = new RuntimeReadiness({ ttlMs: 60_000 });

  beforeEach(() => {
    process.env.INTERNAL_TOKEN = "workspace-control-token";
    process.env.DSH_AGENT_TOKEN = "sidecar-token";
    process.env.DSH_AGENT_URL = "http://127.0.0.1:3101";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(Response.json({ ok: true, purged: 1 }));
    readiness.markReady();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INTERNAL_TOKEN;
    delete process.env.DSH_AGENT_TOKEN;
    delete process.env.DSH_AGENT_URL;
  });

  it("streams an unbounded fenced rebuild to the sidecar without decoding transcript bytes", async () => {
    const body = "{\"type\":\"opaque-test-frame\"}\n";
    const response = await handleChatRequest(new Request(
      `http://chat.internal${COMPANION_MEMORY_REBUILD_PREPARE_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          "x-internal-token": "workspace-control-token",
        },
        body,
      },
    ), readiness);

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3101/v1/workspaces/rebuild/prepare");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sidecar-token");
    expect(await new Response(init.body).text()).toBe(body);
  });

  it("keeps physical purge and promotion behind the internal capability", async () => {
    for (const [path, sidecarPath, body] of [
      [COMPANION_MEMORY_PURGE_PATH, "/v1/workspaces/purge", {
        scope: "relationship",
        userId: "user-1",
        characterId: "character-1",
      }],
      [COMPANION_MEMORY_REBUILD_PROMOTE_PATH, "/v1/workspaces/rebuild/promote", {
        scope: "relationship",
        userId: "user-1",
        characterId: "character-1",
        rebuildId: "11111111-1111-4111-8111-111111111111",
        fence: {
          mutationId: "mutation-1",
          claimToken: "22222222-2222-4222-8222-222222222222",
          authorityVersion: "1",
        },
      }],
    ] as const) {
      fetchMock.mockResolvedValueOnce(Response.json({ ok: true, purged: 1 }));
      const response = await handleChatRequest(new Request(`http://chat.internal${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": "workspace-control-token",
        },
        body: JSON.stringify(body),
      }), readiness);
      expect(response.status).toBe(200);
      const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
      expect(url).toBe(`http://127.0.0.1:3101${sidecarPath}`);
      expect(await new Response(init.body).json()).toEqual(body);
    }

    const unauthorized = await handleChatRequest(new Request(
      `http://chat.internal${COMPANION_MEMORY_PURGE_PATH}`,
      { method: "POST", body: "{}" },
    ), readiness);
    expect(unauthorized.status).toBe(401);
  });
});
