import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { companionReadinessSchema } from "@idream/shared/chat/companion-runtime";
import { createCompanionServer, type CompanionServer } from "./server";

const AUTH_TOKEN = "test-sidecar-secret";
const readiness = companionReadinessSchema.parse({
  protocolVersion: 1,
  service: "dsh-companion",
  ready: true,
  checkedAt: "2026-08-19T12:00:00.000Z",
  dshVersion: "0.1.0-rc.7",
  dshCommit: "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca",
  igrepVersion: "0.1.132",
  pluginVersion: "0.1.0",
  instance: {
    id: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-08-19T11:59:00.000Z",
  },
  provider: {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/test",
    resolved: true,
  },
  profiles: {
    normal: {
      name: "normal",
      loaded: true,
      normalizedConfigDigest: "b".repeat(64),
      capabilities: { memoryRead: true, memoryWrite: true, tools: true, commit: true },
    },
    private: {
      name: "private",
      loaded: true,
      normalizedConfigDigest: "c".repeat(64),
      capabilities: { memoryRead: false, memoryWrite: false, tools: true, commit: true },
    },
  },
  bridges: {
    toolReachable: true,
    commitReachable: true,
    workspaceRebuildReachable: true,
  },
  verification: {
    duplicateIngest: { replayedSessions: 1, duplicateDialogueFiles: 0 },
    crossScope: { probes: 2, leakedResults: 0 },
  },
});

const servers: CompanionServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function listen(server: CompanionServer): Promise<string> {
  server.http.listen(0, "127.0.0.1");
  await once(server.http, "listening");
  const address = server.http.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return `http://127.0.0.1:${address.port}`;
}

describe("companion HTTP authority boundary", () => {
  it("keeps liveness public and protects strict readiness with bearer auth", async () => {
    const forces: boolean[] = [];
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async (force) => {
        forces.push(force ?? false);
        return readiness;
      },
      invocation: {
        async run() {
          throw new Error("not used");
        },
        async accept() {
          throw new Error("not used");
        },
        async purge() {
          throw new Error("not used");
        },
        async rebuild() {
          throw new Error("not used");
        },
        async importLegacyMemory() {
          throw new Error("not used");
        },
        async memoryCutoverProof() {
          throw new Error("not used");
        },
        async shutdown() {},
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/readyz`, {
      headers: { authorization: "Bearer wrong" },
    })).status).toBe(401);

    const readyResponse = await fetch(`${baseUrl}/readyz`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(readyResponse.status).toBe(200);
    expect(companionReadinessSchema.parse(await readyResponse.json())).toEqual(readiness);
    expect((await fetch(`${baseUrl}/readyz?full=1`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })).status).toBe(200);
    expect(forces).toEqual([false, true]);
  });

  it("returns 503 instead of a partial readiness claim", async () => {
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("plugin version drift"); },
      invocation: {
        async run() { throw new Error("not used"); },
        async accept() { throw new Error("not used"); },
        async purge() { throw new Error("not used"); },
        async rebuild() { throw new Error("not used"); },
        async importLegacyMemory() { throw new Error("not used"); },
        async memoryCutoverProof() { throw new Error("not used"); },
        async shutdown() {},
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/readyz`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "not_ready", message: "plugin version drift" },
    });
  });

  it("protects and strictly validates canonical relationship rebuilds", async () => {
    const rebuild = vi.fn(async () => ({ sessions: 1, messages: 2 }));
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => readiness,
      invocation: {
        async run() { throw new Error("not used"); },
        async accept() { throw new Error("not used"); },
        async purge() { throw new Error("not used"); },
        rebuild,
        async importLegacyMemory() { throw new Error("not used"); },
        async memoryCutoverProof() { throw new Error("not used"); },
        async shutdown() {},
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const body = {
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      messages: [
        {
          id: "user-message-1",
          sessionId: "session-1",
          role: "user",
          content: "Remember the observatory.",
          createdAt: "2026-08-19T12:00:00.000Z",
        },
        {
          id: "assistant-message-1",
          sessionId: "session-1",
          role: "assistant",
          content: "Every blue-lit window.",
          createdAt: "2026-08-19T12:00:01.000Z",
        },
      ],
    };
    expect((await fetch(`${baseUrl}/v1/workspaces/rebuild`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/workspaces/rebuild`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, arbitraryPath: "/tmp/escape" }),
    })).status).toBe(400);
    const response = await fetch(`${baseUrl}/v1/workspaces/rebuild`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, rebuilt: { sessions: 1, messages: 2 } });
    expect(rebuild).toHaveBeenCalledWith(body);
  });

  it("protects and strictly validates one relationship legacy memory import", async () => {
    const importLegacyMemory = vi.fn(async () => ({
      skipped: false,
      entries: 1,
      written: 1,
      checksum: "d".repeat(64),
      legacySourceChecksum: "a".repeat(64),
      igrepVersion: "0.1.132" as const,
      cutoverWorkspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
      workspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
      status: "cutover_ready" as const,
      recallParity: {
        probeSetChecksum: "e".repeat(64),
        total: 1,
        passed: 1,
        probes: [{
          probeId: "tea-preference",
          queryHash: "1".repeat(64),
          legacyExpectedHash: "2".repeat(64),
          recallContextHash: "3".repeat(64),
          hitCount: 1,
        }],
      },
      completedAt: "2026-08-19T12:00:00.000Z",
    }));
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => readiness,
      invocation: {
        async run() { throw new Error("not used"); },
        async accept() { throw new Error("not used"); },
        async purge() { throw new Error("not used"); },
        async rebuild() { throw new Error("not used"); },
        importLegacyMemory,
        async memoryCutoverProof() { throw new Error("not used"); },
        async shutdown() {},
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const body = {
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      legacySourceChecksum: "a".repeat(64),
      checksum: "d".repeat(64),
      entries: [{
        legacyMemoryId: "memory-1",
        type: "preference",
        text: "User prefers jasmine tea.",
        sourceMessageIds: ["user-message-1"],
      }],
      recallProbes: [{
        id: "tea-preference",
        query: "What tea does the user prefer?",
        legacyExpected: "jasmine tea",
      }],
    };
    expect((await fetch(`${baseUrl}/v1/workspaces/import-legacy-memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/workspaces/import-legacy-memory`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, workspace: "/tmp/escape" }),
    })).status).toBe(400);
    const response = await fetch(`${baseUrl}/v1/workspaces/import-legacy-memory`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      imported: await importLegacyMemory.mock.results[0]?.value,
    });
    expect(importLegacyMemory).toHaveBeenCalledWith(body, expect.any(AbortSignal));
  });

  it("returns the current content-free cutover proof for one relationship", async () => {
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
    const memoryCutoverProof = vi.fn(async () => proof);
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => readiness,
      invocation: {
        async run() { throw new Error("not used"); },
        async accept() { throw new Error("not used"); },
        async purge() { throw new Error("not used"); },
        async rebuild() { throw new Error("not used"); },
        async importLegacyMemory() { throw new Error("not used"); },
        memoryCutoverProof,
        async shutdown() {},
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);
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
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, proof });
    expect(memoryCutoverProof).toHaveBeenCalledWith({
      userId: body.userId,
      characterId: body.characterId,
    });
  });

  it("aborts a legacy import when its authenticated client disconnects", async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => readiness,
      invocation: {
        async run() { throw new Error("not used"); },
        async accept() { throw new Error("not used"); },
        async purge() { throw new Error("not used"); },
        async rebuild() { throw new Error("not used"); },
        async importLegacyMemory(_request, signal) {
          if (!signal) throw new Error("missing import abort signal");
          entered.resolve(signal);
          return new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        async memoryCutoverProof() { throw new Error("not used"); },
        async shutdown() {},
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const client = new AbortController();
    const response = fetch(`${baseUrl}/v1/workspaces/import-legacy-memory`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: "relationship",
        userId: "disconnect-user",
        characterId: "disconnect-character",
        legacySourceChecksum: "a".repeat(64),
        checksum: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        entries: [],
        recallProbes: [],
      }),
      signal: client.signal,
    });
    const sidecarSignal = await entered.promise;

    client.abort();

    await expect(response).rejects.toThrow();
    await vi.waitFor(() => expect(sidecarSignal.aborted).toBe(true));
  });
});
