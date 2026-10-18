import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANION_PRODUCT_PROMPT_VERSION } from "@idream/shared";
import type { AgentRuntimeConfig } from "./config";
import { createReadinessProbe, probePiKernel, probeWorkspaceRebuild, readinessProfile, warmProvider } from "./readiness";
import { companionCompositionDigest, companionIgrepConfig, companionIgrepRoutes } from "./composition";

const config: AgentRuntimeConfig = {
  canonicalRoot: "/tmp/readiness-canonical", privateRoot: "/tmp/readiness-private", igrepCommand: "igrep",
  igrepLlm: { url: "https://maintenance.example/v1", model: "maintenance-model", apiKey: "maintenance-secret" },
  igrepEnvironment: { IGREP_NO_CACHE: "1", IGREP_LLM_URL: "https://maintenance.example/v1", IGREP_LLM_MODEL: "maintenance-model", IGREP_LLM_API_KEY: "maintenance-secret" },
  modelProfile: {
    adapter: "openai-compatible-v1", provider: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/test",
    apiKey: "provider-secret", maxOutputTokens: 8_000, firstTokenTimeoutMs: 30_000, idleTimeoutMs: 30_000, supportsTools: true,
  },
  openRouterProviderOnly: ["DeepSeek"], maxSteps: 8, maxConcurrentAgents: { normal: 4, private: 4 },
};
const runtimeInstance = { id: "11111111-1111-4111-8111-111111111111", startedAt: "2026-08-19T11:59:00.000Z" };
const igrepVerification = {
  duplicateIngest: { replayedSessions: 1, duplicateDialogueFiles: 0 as const },
  crossScope: { probes: 2, leakedResults: 0 as const },
};
const successfulRuntimeEvidence = {
  instance: runtimeInstance,
  resolveIgrepVersion: async () => "0.1.161",
  providerWarmup: async () => {}, memoryLifecycleProbe: async () => igrepVerification,
  bridgeProbe: async () => {}, retrievalProbe: async () => {}, workspaceRebuildProbe: async () => {},
};
afterEach(() => { vi.unstubAllGlobals(); });

describe("fail-closed Pi companion readiness", () => {
  it("reports pinned packages, a public MemoryStorage proof and actual composition digests", async () => {
    let bridgeProfileDigest: string | undefined;
    let observedEnvironment: Record<string,string|undefined> | undefined;
    const readiness = await createReadinessProbe({
      config, ...successfulRuntimeEvidence,
      bridgeProbe: async invocation => { bridgeProfileDigest = invocation.expectedProfileDigest; },
      resolveIgrepVersion: async cli => { observedEnvironment = cli.env; return "0.1.161"; },
    })();
    expect(readiness).toMatchObject({
      ready: true, productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION, piVersion: "1.3.0", igrepVersion: "0.1.161",
      kernel: { storage: "memory", publicApi: true }, instance: runtimeInstance,
      provider: { name: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/test", resolved: true },
      bridges: { toolReachable: true, commitReachable: true, workspaceRebuildReachable: true }, verification: igrepVerification,
    });
    expect(readiness.profiles.normal.executionCompositionDigest).toBe(companionCompositionDigest("normal", companionIgrepConfig("normal", config.igrepCommand, config.igrepEnvironment), {
      maxSteps: config.maxSteps, igrepLlm: config.igrepLlm, igrepRoutes: companionIgrepRoutes(config.igrepEnvironment),
    }));
    expect(readiness.profiles.normal.executionCompositionDigest).not.toBe(readiness.profiles.private.executionCompositionDigest);
    expect(bridgeProfileDigest).toBe(readiness.profiles.private.executionCompositionDigest);
    expect(observedEnvironment).toBe(config.igrepEnvironment);
    expect(JSON.stringify(readiness)).not.toContain("maintenance-secret");
    expect(JSON.stringify(readiness)).not.toContain("pluginVersion");
  });

  it("rejects CLI or package drift before making provider calls", async () => {
    const providerWarmup = vi.fn(async () => {});
    for (const version of ["latest", "0.1.150", "9.8.7"]) {
      await expect(createReadinessProbe({ config, ...successfulRuntimeEvidence, providerWarmup, resolveIgrepVersion: async () => version })()).rejects.toThrow(/igrepVersion/);
    }
    await expect(createReadinessProbe({ config, ...successfulRuntimeEvidence, providerWarmup, resolvePackageVersion: async name => name.endsWith("pi-ai") ? "1.2.0" : "1.3.0" })()).rejects.toThrow(/Pi core version drift/);
    expect(providerWarmup).not.toHaveBeenCalled();
  });

  it("cannot substitute a kernel symbol check for compaction, recall, bridge or rebuild proof", async () => {
    for (const failed of ["kernelProbe", "providerWarmup", "memoryLifecycleProbe", "bridgeProbe", "retrievalProbe", "workspaceRebuildProbe"] as const) {
      await expect(createReadinessProbe({ config, ...successfulRuntimeEvidence, [failed]: async () => { throw new Error(`${failed} failed`); } })()).rejects.toThrow(`${failed} failed`);
    }
    await expect(probePiKernel()).resolves.toEqual({ storage: "memory", publicApi: true });
  });

  it("singleflights and invalidates cached success after a failed forced rewarm", async () => {
    let warmups = 0;
    let fail = true;
    const probe = createReadinessProbe({ config, ...successfulRuntimeEvidence, providerWarmup: async () => { warmups++; if (fail) throw new Error("transient provider failure"); } });
    await expect(probe()).rejects.toThrow("transient provider failure");
    fail = false;
    await expect(Promise.all([probe(), probe()])).resolves.toHaveLength(2);
    expect(warmups).toBe(2);
    await probe(); expect(warmups).toBe(2);
    fail = true;
    await expect(probe(true)).rejects.toThrow("transient provider failure");
    await expect(probe()).rejects.toThrow("transient provider failure");
    expect(warmups).toBe(4);
  });

  it("warms a tool-capable route and requires the upstream usage receipt", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let supplyUsage = true;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const payload = { id: "warmup-response", provider: "DeepSeek", choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], ...(supplyUsage ? { usage: { prompt_tokens: 8, completion_tokens: 1 } } : {}) };
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
    });
    await expect(warmProvider(config, readinessProfile(config.modelProfile))).resolves.toBeUndefined();
    expect(requests[0]).toMatchObject({ model: "deepseek/test", max_tokens: 1, tools: [{ type: "function", function: { name: "idream_readiness_probe" } }] });
    supplyUsage = false;
    await expect(warmProvider(config, readinessProfile(config.modelProfile))).rejects.toThrow("usage is unknown");
  });

  it("retains structured provider failure classification at the terminal event", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"error":{"message":"bad upstream"}}', { status: 503 }));
    await expect(warmProvider(config, readinessProfile(config.modelProfile))).rejects.toThrow("PROVIDER_HTTP_ERROR");
  });

  it("probes empty and populated disposable rebuilds and always purges them", async () => {
    const calls: string[] = [];
    await expect(probeWorkspaceRebuild({
      async prepareRebuild(request) {
        calls.push(`prepare:${request.userId}:${request.messages.length}`);
        return {
          rebuildId: "11111111-1111-4111-8111-111111111111",
          sessions: 0,
          messages: 0,
        };
      },
      async promoteRebuild(request) {
        calls.push(`promote:${request.userId}:${request.rebuildId}`);
        return { sessions: 0, messages: 0 };
      },
      async purge(request) {
        calls.push(`purge:${request.userId}`);
        return 1;
      },
    }, () => "fixed-nonce")).resolves.toBeUndefined();
    expect(calls).toEqual([
      "prepare:readiness-fixed-nonce:0",
      "promote:readiness-fixed-nonce:11111111-1111-4111-8111-111111111111",
      "prepare:readiness-fixed-nonce:2",
      "promote:readiness-fixed-nonce:11111111-1111-4111-8111-111111111111",
      "purge:readiness-fixed-nonce",
    ]);

    calls.length = 0;
    await expect(probeWorkspaceRebuild({
      async prepareRebuild(request) {
        calls.push(`prepare:${request.userId}`);
        throw new Error("candidate rebuild failed");
      },
      async promoteRebuild() {
        calls.push("promote:unexpected");
        return { sessions: 0, messages: 0 };
      },
      async purge(request) {
        calls.push(`purge:${request.userId}`);
        return 0;
      },
    }, () => "failed-nonce")).rejects.toThrow("candidate rebuild failed");
    expect(calls).toEqual([
      "prepare:readiness-failed-nonce",
      "purge:readiness-failed-nonce",
    ]);
  });
});


it("binds readiness and bridge digests to the explicitly registered web route", async () => {
  const enabled = {...config,igrepEnvironment:{...config.igrepEnvironment,IGREP_WEB_SEARCH_PROVIDER:"searxng",IGREP_SEARXNG_URL:"https://search.example",IGREP_SEARXNG_API_KEY:"private-web-key"}};
  let bridgeDigest: string | undefined;
  const result = await createReadinessProbe({config:enabled,...successfulRuntimeEvidence,bridgeProbe:async invocation=>{bridgeDigest=invocation.expectedProfileDigest;}})();
  const digest = companionCompositionDigest("private",companionIgrepConfig("private",enabled.igrepCommand,enabled.igrepEnvironment),{maxSteps:enabled.maxSteps,igrepLlm:enabled.igrepLlm,igrepRoutes:companionIgrepRoutes(enabled.igrepEnvironment)});
  expect(result.profiles.private.executionCompositionDigest).toBe(digest);
  expect(bridgeDigest).toBe(digest);
  expect(JSON.stringify(result)).not.toContain("private-web-key");
});
