import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_DSH_COMMIT,
  COMPANION_DSH_VERSION,
  COMPANION_IGREP_PLUGIN_VERSION,
  COMPANION_IGREP_VERSION,
  COMPANION_RUNTIME_PROTOCOL_VERSION,
} from "@idream/shared/chat/companion-runtime";
import {
  probeCompanionSidecar,
  verifiedCompanionProfileDigest,
} from "./companion-sidecar-readiness.js";

function ready() {
  return {
    protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
    service: "dsh-companion" as const,
    ready: true as const,
    checkedAt: new Date().toISOString(),
    dshVersion: COMPANION_DSH_VERSION,
    dshCommit: COMPANION_DSH_COMMIT,
    igrepVersion: COMPANION_IGREP_VERSION,
    pluginVersion: COMPANION_IGREP_PLUGIN_VERSION,
    instance: {
      id: "11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-19T11:59:00.000Z",
    },
    provider: {
      name: "mock",
      baseUrl: "http://127.0.0.1:8061/v1",
      model: "local-model",
      resolved: true as const,
    },
    profiles: {
      normal: {
        name: "normal" as const,
        loaded: true as const,
        normalizedConfigDigest: "a".repeat(64),
        capabilities: { memoryRead: true as const, memoryWrite: true as const, tools: true as const, commit: true as const },
      },
      private: {
        name: "private" as const,
        loaded: true as const,
        normalizedConfigDigest: "b".repeat(64),
        capabilities: { memoryRead: false as const, memoryWrite: false as const, tools: true as const, commit: true as const },
      },
    },
    bridges: {
      toolReachable: true as const,
      commitReachable: true as const,
      workspaceRebuildReachable: true as const,
    },
    verification: {
      duplicateIngest: { replayedSessions: 1, duplicateDialogueFiles: 0 as const },
      crossScope: { probes: 2, leakedResults: 0 as const },
    },
  };
}

describe("companion sidecar readiness", () => {
  it("authenticates and returns only an exact pinned readiness document", async () => {
    const fetchImpl = vi.fn(async () => Response.json(ready()));
    await expect(probeCompanionSidecar({
      baseUrl: "http://127.0.0.1:3101",
      token: "probe-token",
      expectedProvider: "mock",
      expectedBaseUrl: "http://127.0.0.1:8061/v1",
      expectedModel: "local-model",
      full: true,
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ ready: true, dshCommit: COMPANION_DSH_COMMIT });
    const calls = fetchImpl.mock.calls as unknown[][];
    const init = calls[0]?.[1] as RequestInit | undefined;
    expect(calls[0]?.[0]).toBe("http://127.0.0.1:3101/readyz?full=1");
    expect(new Headers(init?.headers).get("authorization"))
      .toBe("Bearer probe-token");
    expect(verifiedCompanionProfileDigest("http://127.0.0.1:3101/", "normal"))
      .toBe("a".repeat(64));
  });

  it("fails closed when the sidecar resolves a different model", async () => {
    await expect(probeCompanionSidecar({
      baseUrl: "http://127.0.0.1:3101",
      token: "probe-token",
      expectedProvider: "mock",
      expectedBaseUrl: "http://127.0.0.1:8061/v1",
      expectedModel: "other-model",
      fetchImpl: async () => Response.json(ready()),
    })).rejects.toThrow(/provider profile/);
  });
});
