import {
  COMPANION_MEMORY_PURGE_PATH,
  COMPANION_MEMORY_REBUILD_PREPARE_PATH,
  COMPANION_MEMORY_REBUILD_PROMOTE_PATH,
} from "@idream/shared/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeReadiness } from "./runtime-readiness.js";

const memory = vi.hoisted(() => ({
  prepare: vi.fn(),
  promote: vi.fn(),
  purge: vi.fn(),
}));

vi.mock("./companion-memory.js", () => ({
  prepareCompanionMemory: memory.prepare,
  promoteCompanionMemory: memory.promote,
  purgeCompanionMemory: memory.purge,
}));

import { handleChatRequest } from "./web.js";

describe("Chat companion memory HTTP boundary", () => {
  const readiness = new RuntimeReadiness({ ttlMs: 60_000 });

  beforeEach(() => {
    process.env.INTERNAL_TOKEN = "workspace-control-token";
    memory.prepare.mockReset().mockResolvedValue({
      rebuildId: "11111111-1111-4111-8111-111111111111",
      sessions: 1,
      messages: 2,
    });
    memory.promote.mockReset().mockResolvedValue({ sessions: 1, messages: 2 });
    memory.purge.mockReset().mockResolvedValue({ purged: 1 });
    readiness.markReady();
  });

  afterEach(() => {
    delete process.env.INTERNAL_TOKEN;
  });

  it("handles streamed rebuild preparation inside Chat", async () => {
    const request = new Request(
      `http://chat.internal${COMPANION_MEMORY_REBUILD_PREPARE_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          "x-internal-token": "workspace-control-token",
        },
        body: "{\"type\":\"opaque-test-frame\"}\n",
      },
    );
    const response = await handleChatRequest(request, readiness);

    expect(response.status).toBe(200);
    expect(memory.prepare).toHaveBeenCalledWith(request);
    expect(await response.json()).toMatchObject({
      ok: true,
      rebuilt: { sessions: 1, messages: 2 },
    });
  });

  it("keeps purge and promotion behind the internal capability", async () => {
    for (const [path, handler] of [
      [COMPANION_MEMORY_PURGE_PATH, memory.purge],
      [COMPANION_MEMORY_REBUILD_PROMOTE_PATH, memory.promote],
    ] as const) {
      const request = new Request(`http://chat.internal${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": "workspace-control-token",
        },
        body: "{}",
      });
      const response = await handleChatRequest(request, readiness);
      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledWith(request);
    }

    const unauthorized = await handleChatRequest(new Request(
      `http://chat.internal${COMPANION_MEMORY_PURGE_PATH}`,
      { method: "POST", body: "{}" },
    ), readiness);
    expect(unauthorized.status).toBe(401);
  });
});
