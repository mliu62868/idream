import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionReadiness } from "@idream/shared/chat/companion-runtime";
import { createCompanionServer, type InvocationService } from "./server";

const servers: Array<ReturnType<typeof createCompanionServer>> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

const readiness = {
  protocolVersion: 1,
  service: "dsh-companion",
  ready: true,
  checkedAt: "2026-08-20T12:00:00.000Z",
  instance: { id: "11111111-1111-4111-8111-111111111111", startedAt: "2026-08-20T11:59:00.000Z" },
  dshVersion: "0.1.0-rc.7",
  dshCommit: "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca",
  igrepVersion: "0.1.132",
  pluginVersion: "0.1.0",
  provider: { name: "local", model: "model-1", baseUrl: "http://127.0.0.1:8061/v1", resolved: true },
  profiles: {
    normal: {
      name: "normal",
      loaded: true,
      executionCompositionDigest: "a".repeat(64),
      capabilities: { memoryRead: true, memoryWrite: true, tools: true, commit: true },
    },
    private: {
      name: "private",
      loaded: true,
      executionCompositionDigest: "b".repeat(64),
      capabilities: { memoryRead: false, memoryWrite: false, tools: true, commit: true },
    },
  },
  bridges: { toolReachable: true, commitReachable: true, workspaceRebuildReachable: true },
  verification: {
    duplicateIngest: { replayedSessions: 1, duplicateDialogueFiles: 0 },
    crossScope: { probes: 2, leakedResults: 0 },
  },
} satisfies CompanionReadiness;

function invocation(): InvocationService {
  return {
    run: vi.fn(async () => {}),
    accept: vi.fn(async () => {}),
    purge: vi.fn(async () => 1),
    rebuild: vi.fn(async () => ({ sessions: 1, messages: 2 })),
    memoryCutoverProof: vi.fn(async () => null),
    shutdown: vi.fn(async () => {}),
  };
}

async function start(service = invocation()) {
  const server = createCompanionServer({ authToken: "sidecar-token", readiness: async () => readiness, invocation: service });
  servers.push(server);
  await new Promise<void>((resolve) => server.http.listen(0, "127.0.0.1", resolve));
  const address = server.http.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return { baseUrl: `http://127.0.0.1:${address.port}`, service };
}

const authorized = { authorization: "Bearer sidecar-token", "content-type": "application/json" };

describe("companion HTTP authority boundary", () => {
  it("keeps liveness public and protects readiness", async () => {
    const { baseUrl } = await start();
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/readyz`, { headers: { authorization: "Bearer sidecar-token" } })).status).toBe(200);
  });

  it("strictly validates relationship rebuilds", async () => {
    const { baseUrl, service } = await start();
    const response = await fetch(`${baseUrl}/v1/workspaces/rebuild`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ scope: "relationship", userId: "user-1", characterId: "character-1", messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(service.rebuild).toHaveBeenCalledOnce();
  });

  it("has no legacy import endpoint", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/workspaces/import-legacy-memory`, {
      method: "POST",
      headers: authorized,
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("returns the current content-free historical cutover proof", async () => {
    const proof = {
      entries: 0,
      legacySourceChecksum: "a".repeat(64),
      checksum: "d".repeat(64),
      igrepVersion: "0.1.132" as const,
      cutoverWorkspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
      workspaceVersion: "commit-1787169700000-22222222-2222-4222-8222-222222222222",
      status: "cutover_ready" as const,
      recallParity: {
        probeSetChecksum: "e".repeat(64),
        total: 0,
        passed: 0,
        probes: [],
      },
      completedAt: "2026-08-19T12:00:00.000Z",
    };
    const service: InvocationService = {
      ...invocation(),
      memoryCutoverProof: vi.fn(async () => proof),
    };
    const { baseUrl } = await start(service);
    const body = {
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
    };
    expect((await fetch(`${baseUrl}/v1/workspaces/memory-cutover-proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })).status).toBe(401);
    const response = await fetch(`${baseUrl}/v1/workspaces/memory-cutover-proof`, {
      method: "POST",
      headers: {
        authorization: "Bearer sidecar-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, proof });
    expect(service.memoryCutoverProof).toHaveBeenCalledWith({
      userId: body.userId,
      characterId: body.characterId,
    });
  });
});
