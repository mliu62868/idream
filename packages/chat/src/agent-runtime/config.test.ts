import { describe, expect, it } from "vitest";
import { bindIgrepLlmEnvironment, loadAgentRuntimeConfig } from "./config";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DSH_IGREP_PLUGIN_URL: "/opt/igrep/profile/node_modules/@igrep/dsh-plugin/index.mjs",
    DSH_BOOTSTRAP_STATE_PATH: "/opt/igrep/idream-companion-bootstrap.json",
    IGREP_LLM_URL: "http://127.0.0.1:8061/v1",
    IGREP_LLM_MODEL: "maintenance-model",
    IGREP_LLM_API_KEY: "maintenance-secret",
    CHAT_MODEL_PROVIDER: "openai",
    CHAT_MODEL_BASE_URL: "https://openrouter.ai/api/v1",
    CHAT_MODEL_NAME: "deepseek/test",
    CHAT_MODEL_API_KEY: "provider-secret",
    DSH_OPENROUTER_PROVIDER_ONLY: "DeepSeek",
    ...overrides,
  };
}

describe("Agent runtime configuration", () => {
  it("defaults to Chat-owned memory roots and bounded pools", () => {
    const config = loadAgentRuntimeConfig(environment());

    expect(config.canonicalRoot).toMatch(/companion-memory$/);
    expect(config.privateRoot).toMatch(/companion-private$/);
    expect(config.maxConcurrentAgents).toEqual({ normal: 4, private: 4 });
    expect(config.modelProfile).toMatchObject({
      provider: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/test",
      apiKey: "provider-secret",
    });
  });

  it("uses only the Chat model profile for turns and readiness", () => {
    const config = loadAgentRuntimeConfig(environment({
      DSH_PROVIDER_API_KEY: "stale-key",
      DSH_READY_PROVIDER: "stale-provider",
      DSH_READY_MODEL: "stale-model",
      DSH_READY_BASE_URL: "https://stale.example/v1",
    }));

    expect(config.modelProfile.model).toBe("deepseek/test");
    expect(config.modelProfile.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.modelProfile.apiKey).toBe("provider-secret");
  });

  it("does not send OpenRouter routing metadata to another compatible host", () => {
    const config = loadAgentRuntimeConfig(environment({
      CHAT_MODEL_BASE_URL: "http://127.0.0.1:8061/v1",
    }));

    expect(config.openRouterProviderOnly).toBeUndefined();
  });

  it("requires an explicit maintenance LLM instead of inheriting user igrep config", () => {
    expect(() => loadAgentRuntimeConfig(environment({ IGREP_LLM_URL: undefined })))
      .toThrow(/IGREP_LLM_URL is required/);
    expect(() => loadAgentRuntimeConfig(environment({ IGREP_LLM_MODEL: "  " })))
      .toThrow(/IGREP_LLM_MODEL is required/);
    expect(() => loadAgentRuntimeConfig(environment({ IGREP_LLM_API_KEY: undefined })))
      .toThrow(/IGREP_LLM_API_KEY is required/);
    expect(() => loadAgentRuntimeConfig(environment({ IGREP_LLM_URL: "file:///tmp/model" })))
      .toThrow(/IGREP_LLM_URL.*HTTP/);
    expect(() => loadAgentRuntimeConfig(environment({ IGREP_LLM_URL: "not-a-url" })))
      .toThrow(/IGREP_LLM_URL.*URL/);
    expect(() => loadAgentRuntimeConfig(environment({
      IGREP_LLM_URL: "https://user:secret@maintenance.example/v1",
    }))).toThrow(/IGREP_LLM_URL.*credentials/);
    expect(() => loadAgentRuntimeConfig(environment({
      IGREP_LLM_URL: "https://maintenance.example/v1?route=hidden",
    }))).toThrow(/IGREP_LLM_URL.*query/);
    expect(() => loadAgentRuntimeConfig(environment({
      IGREP_LLM_URL: "https://maintenance.example/v1#hidden",
    }))).toThrow(/IGREP_LLM_URL.*fragment/);
  });

  it("binds every igrep child to the validated maintenance LLM values", () => {
    const config = loadAgentRuntimeConfig(environment({
      IGREP_LLM_URL: " https://maintenance.example/v1/ ",
      IGREP_LLM_MODEL: " maintenance-model ",
      IGREP_LLM_API_KEY: " maintenance-secret ",
    }));
    const childEnvironment: NodeJS.ProcessEnv = {
      IGREP_LLM_URL: "http://stale-user-config/v1",
      IGREP_LLM_MODEL: "stale-user-model",
      IGREP_LLM_API_KEY: "stale-user-secret",
      IGREP_LLM_EXTRA_BODY: JSON.stringify({ model: "hidden-model", temperature: 1, presence_penalty: 1.5 }),
    };

    bindIgrepLlmEnvironment(config.igrepLlm, childEnvironment);

    expect(childEnvironment).toEqual({
      IGREP_LLM_URL: "https://maintenance.example/v1",
      IGREP_LLM_MODEL: "maintenance-model",
      IGREP_LLM_API_KEY: "maintenance-secret",
      IGREP_LLM_EXTRA_BODY: JSON.stringify({ temperature: 0, top_p: 1, presence_penalty: 0 }),
    });
    expect(config.modelProfile.temperature).toBe(0.9);
  });

  it("keeps normal and private agent capacity in separate bounded pools", () => {
    expect(loadAgentRuntimeConfig(environment({
      DSH_MAX_NORMAL_AGENTS: "2",
      DSH_MAX_PRIVATE_AGENTS: "1",
    })).maxConcurrentAgents).toEqual({ normal: 2, private: 1 });
    expect(() => loadAgentRuntimeConfig(environment({ DSH_MAX_NORMAL_AGENTS: "0" })))
      .toThrow(/DSH_MAX_NORMAL_AGENTS/);
    expect(() => loadAgentRuntimeConfig(environment({ DSH_MAX_PRIVATE_AGENTS: "1.5" })))
      .toThrow(/DSH_MAX_PRIVATE_AGENTS/);
  });

  it("keeps canonical and private workspace authority roots disjoint", () => {
    expect(() => loadAgentRuntimeConfig(environment({
      DSH_IGREP_CANONICAL_ROOT: "/var/lib/idream/memory",
      DSH_IGREP_PRIVATE_ROOT: "/var/lib/idream/memory/private",
    }))).toThrow(/workspace roots.*disjoint/);
  });

});
