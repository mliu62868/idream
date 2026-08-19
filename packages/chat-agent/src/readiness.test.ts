import { describe, expect, it } from "vitest";
import type { SidecarConfig } from "./config";
import { createReadinessProbe } from "./readiness";

const config: SidecarConfig = {
  host: "127.0.0.1",
  port: 3101,
  authToken: "readiness-secret",
  canonicalRoot: "/tmp/readiness-canonical",
  privateRoot: "/tmp/readiness-private",
  igrepCommand: "igrep",
  igrepPluginUrl: "file:///tmp/igrep/index.mjs",
  providerApiKey: "provider-secret",
  readyProvider: "openrouter",
  readyModel: "deepseek/test",
  readyBaseUrl: "https://openrouter.ai/api/v1",
  openRouterProviderOnly: ["DeepSeek"],
  maxSteps: 8,
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
    })();
    expect(readiness).toMatchObject({
      ready: true,
      dshVersion: "0.1.0-rc.7",
      dshCommit: "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca",
      igrepVersion: "0.1.132",
      pluginVersion: "0.1.0",
      provider: { name: "openrouter", model: "deepseek/test", resolved: true },
      bridges: { toolReachable: true, commitReachable: true },
    });
    expect(readiness.profiles.normal.normalizedConfigDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(readiness.profiles.private.normalizedConfigDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(readiness.profiles.normal.normalizedConfigDigest)
      .not.toBe(readiness.profiles.private.normalizedConfigDigest);
  });

  it("fails closed when the executable version or normalized profile drifts", async () => {
    await expect(createReadinessProbe({
      config,
      plugin: async () => plugin,
      resolveIgrepVersion: async () => "0.1.133",
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
    })()).rejects.toThrow(/profile did not normalize/);
  });
});
