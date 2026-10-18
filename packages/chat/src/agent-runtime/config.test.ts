import { describe, expect, it } from "vitest";
import { createIgrepEnvironment, loadAgentRuntimeConfig } from "./config";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    IGREP_LLM_URL: "http://127.0.0.1:8061/v1",
    IGREP_LLM_MODEL: "maintenance-model",
    IGREP_LLM_API_KEY: "maintenance-secret",
    CHAT_MODEL_PROVIDER: "openai",
    CHAT_MODEL_BASE_URL: "https://openrouter.ai/api/v1",
    CHAT_MODEL_NAME: "deepseek/test",
    CHAT_MODEL_API_KEY: "provider-secret",
    PI_OPENROUTER_PROVIDER_ONLY: "DeepSeek",
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
      PI_PROVIDER_API_KEY: "stale-key",
      PI_READY_PROVIDER: "stale-provider",
      PI_READY_MODEL: "stale-model",
      PI_READY_BASE_URL: "https://stale.example/v1",
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

    const original = { ...childEnvironment };
    const result = createIgrepEnvironment({ llm: config.igrepLlm, embedding: null, rerank: null }, childEnvironment);
    expect(childEnvironment).toEqual(original);

    expect(result).toMatchObject({
      IGREP_LLM_URL: "https://maintenance.example/v1",
      IGREP_LLM_MODEL: "maintenance-model",
      IGREP_LLM_API_KEY: "maintenance-secret",
      IGREP_LLM_EXTRA_BODY: JSON.stringify({ temperature: 0, top_p: 1, presence_penalty: 0 }),
    });
    expect(config.modelProfile.temperature).toBe(0.9);
  });

  it("keeps normal and private agent capacity in separate bounded pools", () => {
    expect(loadAgentRuntimeConfig(environment({
      PI_MAX_NORMAL_AGENTS: "2",
      PI_MAX_PRIVATE_AGENTS: "1",
    })).maxConcurrentAgents).toEqual({ normal: 2, private: 1 });
    expect(() => loadAgentRuntimeConfig(environment({ PI_MAX_NORMAL_AGENTS: "0" })))
      .toThrow(/PI_MAX_NORMAL_AGENTS/);
    expect(() => loadAgentRuntimeConfig(environment({ PI_MAX_PRIVATE_AGENTS: "1.5" })))
      .toThrow(/PI_MAX_PRIVATE_AGENTS/);
  });

  it("keeps canonical and private workspace authority roots disjoint", () => {
    expect(() => loadAgentRuntimeConfig(environment({
      PI_IGREP_CANONICAL_ROOT: "/var/lib/idream/memory",
      PI_IGREP_PRIVATE_ROOT: "/var/lib/idream/memory/private",
    }))).toThrow(/workspace roots.*disjoint/);
  });

});

describe("explicit igrep child environment", () => {
  it("pins independent model routes and disables ambient routes, proxies and caches without mutating the parent", () => {
    const ambient = { ...environment(), PATH:"/service/bin", HOME:"/real-home", CODEX_HOME:"/real-codex", CHAT_MODEL_API_KEY:"private-chat-key", HTTP_PROXY:"http://ambient-proxy", IGREP_ASK_LLM_URL:"http://ambient-model", REDIS_URL:"redis://ambient" };
    const original = {...ambient};
    const env = loadAgentRuntimeConfig(ambient).igrepEnvironment;
    expect(ambient).toEqual(original);
    expect(env.PATH).toBe("/service/bin");
    expect(env.HOME).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.CHAT_MODEL_API_KEY).toBeUndefined();
    for (const prefix of ["LLM", "ASK_LLM", "LLM_FINAL_SORT"]) {
      expect(env[`IGREP_${prefix}_URL`]).toBe("http://127.0.0.1:8061/v1");
      expect(env[`IGREP_${prefix}_MODEL`]).toBe("maintenance-model");
      expect(env[`IGREP_${prefix}_API_KEY`]).toBe("maintenance-secret");
    }
    for (const name of ["IGREP_EMBEDDING_URL","IGREP_EMBED_MODEL","IGREP_RERANK_URL","IGREP_WEB_SEARCH_URL","IGREP_OCR_URL","OPENAI_API_KEY","REDIS_URL","HTTP_PROXY"]) expect(env[name]).toBe("");
    expect(env.IGREP_NO_CACHE).toBe("1");
    expect(env.NO_PROXY).toBe("*");
  });

  it("requires complete explicit optional routes and preserves their distinct credentials", () => {
    expect(() => loadAgentRuntimeConfig(environment({IGREP_EMBEDDING_URL:"http://embed/v1"}))).toThrow(/IGREP_EMBED_MODEL/);
    const config = loadAgentRuntimeConfig(environment({
      IGREP_EMBEDDING_URL:"http://embed/v1", IGREP_EMBED_MODEL:"embedding", IGREP_EMBEDDING_API_KEY:"embed-key", IGREP_EMBED_DIM:"768",
      IGREP_RERANK_URL:"http://rerank/v1", IGREP_RERANK_MODEL:"reranker", IGREP_RERANK_API_KEY:"rerank-key", IGREP_RERANK_API_FORMAT:"tei",
    }));
    expect(config.igrepEnvironment).toMatchObject({IGREP_EMBEDDING_URL:"http://embed/v1",IGREP_EMBED_MODEL:"embedding",IGREP_EMBEDDING_API_KEY:"embed-key",IGREP_EMBED_DIM:"768",IGREP_RERANK_API_KEY:"rerank-key",IGREP_RERANK_API_FORMAT:"tei"});
  });
});

describe("explicit igrep public web configuration", () => {
  it("does not enable ambient web provider credentials", () => {
    const config = loadAgentRuntimeConfig(environment({IGREP_WEB_SEARCH_PROVIDER:"tavily",IGREP_TAVILY_API_KEY:"ambient",IGREP_SEARXNG_URL:"https://personal.example"}));
    expect(config.igrepEnvironment.IGREP_WEB_SEARCH_PROVIDER).toBe("");
    expect(config.igrepEnvironment.IGREP_TAVILY_API_KEY).toBe("");
    expect(config.igrepEnvironment.IGREP_SEARXNG_URL).toBe("");
  });

  it("pins a validated SearXNG endpoint and optional dedicated credential", () => {
    const config = loadAgentRuntimeConfig(environment({PI_IGREP_WEB_PROVIDER:"searxng",PI_IGREP_WEB_URL:"https://search.example/",PI_IGREP_WEB_API_KEY:"service-search-key"}));
    expect(config.igrepEnvironment).toMatchObject({IGREP_WEB_SEARCH_PROVIDER:"searxng",IGREP_SEARXNG_URL:"https://search.example",IGREP_SEARXNG_API_KEY:"service-search-key",IGREP_TAVILY_API_KEY:"",IGREP_WEB_FAST_BUDGET_S:"12",IGREP_WEB_PROVIDER_TIMEOUT_S:"10"});
    expect(loadAgentRuntimeConfig(environment({PI_IGREP_WEB_PROVIDER:"searxng",PI_IGREP_WEB_URL:"http://127.0.0.1:8080"})).igrepEnvironment.IGREP_SEARXNG_API_KEY).toBe("");
  });

  it.each(["tavily","serper","exa"])("pins only the selected %s cloud credential", provider => {
    const config = loadAgentRuntimeConfig(environment({PI_IGREP_WEB_PROVIDER:provider,PI_IGREP_WEB_API_KEY:"service-key"}));
    expect(config.igrepEnvironment.IGREP_WEB_SEARCH_PROVIDER).toBe(provider);
    for (const name of ["tavily","serper","exa"]) expect(config.igrepEnvironment[`IGREP_${name.toUpperCase()}_API_KEY`]).toBe(name === provider ? "service-key" : "");
    expect(config.igrepEnvironment.IGREP_SEARXNG_URL).toBe("");
  });

  it.each([
    {PI_IGREP_WEB_PROVIDER:"unknown"}, {PI_IGREP_WEB_PROVIDER:"searxng"}, {PI_IGREP_WEB_PROVIDER:"tavily"},
    {PI_IGREP_WEB_URL:"https://search.example"}, {PI_IGREP_WEB_API_KEY:"orphan-key"},
    {PI_IGREP_WEB_PROVIDER:"searxng",PI_IGREP_WEB_URL:"file:///search"},
    {PI_IGREP_WEB_PROVIDER:"searxng",PI_IGREP_WEB_URL:"https://user:secret@search.example"},
    {PI_IGREP_WEB_PROVIDER:"searxng",PI_IGREP_WEB_URL:"https://search.example?secret=value"},
    {PI_IGREP_WEB_PROVIDER:"searxng",PI_IGREP_WEB_URL:"https://search.example#route"},
    {PI_IGREP_WEB_PROVIDER:"exa",PI_IGREP_WEB_URL:"https://ignored.example",PI_IGREP_WEB_API_KEY:"key"},
    {PI_IGREP_WEB_PROVIDER:"serper",PI_IGREP_WEB_API_KEY:"header\ninjection"},
  ])("rejects incomplete or unsafe explicit web configuration (%j)", overrides => {
    expect(() => loadAgentRuntimeConfig(environment(overrides))).toThrow();
  });
});
