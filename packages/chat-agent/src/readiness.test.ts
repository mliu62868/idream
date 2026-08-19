import { describe, expect, it } from "vitest";
import type { SidecarConfig } from "./config";
import { createReadinessProbe, probeWorkspaceRebuild } from "./readiness";
import { companionCompositionDigest } from "./composition";

const config: SidecarConfig = {
  host: "127.0.0.1",
  port: 3101,
  authToken: "readiness-secret",
  canonicalRoot: "/tmp/readiness-canonical",
  shadowRoot: "/tmp/readiness-shadow",
  privateRoot: "/tmp/readiness-private",
  igrepCommand: "igrep",
  igrepPluginUrl: "file:///tmp/igrep/index.mjs",
  bootstrapStatePath: "/tmp/idream-companion-bootstrap.json",
  providerApiKey: "provider-secret",
  readyProvider: "openrouter",
  readyModel: "deepseek/test",
  readyBaseUrl: "https://openrouter.ai/api/v1",
  openRouterProviderOnly: ["DeepSeek"],
  maxSteps: 8,
  maxConcurrentAgents: { normal: 4, private: 4 },
};

const normalDigest = "1".repeat(64);
const privateDigest = "2".repeat(64);
const successfulRuntimeEvidence = {
  readBootstrapState: async () => ({
    schemaVersion: 1 as const,
    pins: { dsh: "0.1.0-rc.7", igrep: "0.1.132", plugin: "0.1.0" },
    profiles: {
      normal: {
        name: "idream-companion-memory",
        pluginPath: "/tmp/igrep",
        configDigest: normalDigest,
        profileInputDigest: "3".repeat(64),
      },
      private: {
        name: "idream-companion-private",
        pluginPath: "/tmp/igrep",
        configDigest: privateDigest,
        profileInputDigest: "4".repeat(64),
      },
    },
  }),
  bootstrapRuntimeProof: async () => {},
  providerWarmup: async () => {},
  memoryLifecycleProbe: async () => {},
  bridgeProbe: async () => {},
  workspaceRebuildProbe: async () => {},
};

const plugin = {
  module: {
    name: "igrep",
    apply() {},
    resolveConfig(raw: Record<string, unknown>) {
      return {
        timeoutMs: 60_000,
        searchMode: "normal",
        ...raw,
      };
    },
  },
  version: "0.1.0",
  moduleUrl: "file:///tmp/igrep/index.mjs",
};

describe("fail-closed companion readiness", () => {
  it("reports exact runtime identities, normalized profile digests and bridge capabilities", async () => {
    const readiness = await createReadinessProbe({
      config,
      plugin: async () => plugin,
      resolveIgrepVersion: async () => "0.1.132",
      ...successfulRuntimeEvidence,
    })();
    expect(readiness).toMatchObject({
      ready: true,
      dshVersion: "0.1.0-rc.7",
      dshCommit: "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca",
      igrepVersion: "0.1.132",
      pluginVersion: "0.1.0",
      provider: {
        name: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "deepseek/test",
        resolved: true,
      },
      bridges: {
        toolReachable: true,
        commitReachable: true,
        workspaceRebuildReachable: true,
      },
    });
    expect(readiness.profiles.normal.normalizedConfigDigest).toBe(
      companionCompositionDigest("normal", plugin.module.resolveConfig({
        command: config.igrepCommand,
        search: true,
        webProvider: false,
        webTool: false,
        memory: true,
        ingest: true,
        wake: true,
      })),
    );
    expect(readiness.profiles.normal.normalizedConfigDigest).not.toBe(normalDigest);
    expect(readiness.profiles.private.normalizedConfigDigest).not.toBe(privateDigest);
    expect(readiness.profiles.normal.normalizedConfigDigest)
      .not.toBe(readiness.profiles.private.normalizedConfigDigest);
  });

  it("fails closed when the executable version or normalized profile drifts", async () => {
    await expect(createReadinessProbe({
      config,
      plugin: async () => plugin,
      resolveIgrepVersion: async () => "0.1.133",
      ...successfulRuntimeEvidence,
    })()).rejects.toThrow(/igrep version drifted/);
    await expect(createReadinessProbe({
      config,
      plugin: async () => ({
        ...plugin,
        module: {
          ...plugin.module,
          resolveConfig: (raw: Record<string, unknown>) => ({ ...raw, wake: true }),
        },
      }),
      resolveIgrepVersion: async () => "0.1.132",
      ...successfulRuntimeEvidence,
    })()).rejects.toThrow(/profile did not normalize/);
  });

  it("does not report ready when provider, memory lifecycle or bridge proof fails", async () => {
    for (const failed of [
      "bootstrapRuntimeProof",
      "providerWarmup",
      "memoryLifecycleProbe",
      "bridgeProbe",
      "workspaceRebuildProbe",
    ] as const) {
      await expect(createReadinessProbe({
        config,
        plugin: async () => plugin,
        resolveIgrepVersion: async () => "0.1.132",
        ...successfulRuntimeEvidence,
        [failed]: async () => { throw new Error(`${failed} failed`); },
      })()).rejects.toThrow(`${failed} failed`);
    }
  });

  it("singleflights, retries failure, and refreshes only when explicitly forced", async () => {
    let warmups = 0;
    let fail = true;
    const probe = createReadinessProbe({
      config,
      plugin: async () => plugin,
      resolveIgrepVersion: async () => "0.1.132",
      ...successfulRuntimeEvidence,
      providerWarmup: async () => {
        warmups += 1;
        if (fail) throw new Error("transient provider failure");
      },
    });

    await expect(probe()).rejects.toThrow("transient provider failure");
    fail = false;
    await expect(Promise.all([probe(), probe()])).resolves.toHaveLength(2);
    expect(warmups).toBe(2);
    await probe();
    expect(warmups).toBe(2);
    await probe();
    expect(warmups).toBe(2);
    await probe(true);
    expect(warmups).toBe(3);
  });

  it("probes a disposable empty rebuild and always purges it", async () => {
    const calls: string[] = [];
    await expect(probeWorkspaceRebuild({
      async rebuild(request) {
        calls.push(`rebuild:${request.userId}:${request.messages.length}`);
        return { sessions: 0, messages: 0 };
      },
      async purge(request) {
        calls.push(`purge:${request.userId}`);
        return 1;
      },
    }, () => "fixed-nonce")).resolves.toBeUndefined();
    expect(calls).toEqual([
      "rebuild:readiness-fixed-nonce:0",
      "purge:readiness-fixed-nonce",
    ]);

    calls.length = 0;
    await expect(probeWorkspaceRebuild({
      async rebuild(request) {
        calls.push(`rebuild:${request.userId}`);
        throw new Error("candidate rebuild failed");
      },
      async purge(request) {
        calls.push(`purge:${request.userId}`);
        return 0;
      },
    }, () => "failed-nonce")).rejects.toThrow("candidate rebuild failed");
    expect(calls).toEqual([
      "rebuild:readiness-failed-nonce",
      "purge:readiness-failed-nonce",
    ]);
  });
});
