import { describe, expect, it } from "vitest";
import { loadSidecarConfig } from "./config";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DSH_AGENT_TOKEN: "shared-chat-sidecar-token",
    DSH_IGREP_PLUGIN_URL: "/opt/igrep/profile/node_modules/@igrep/dsh-plugin/index.mjs",
    DSH_BOOTSTRAP_STATE_PATH: "/opt/igrep/idream-companion-bootstrap.json",
    DSH_PROVIDER_API_KEY: "provider-secret",
    DSH_READY_PROVIDER: "openrouter",
    DSH_READY_MODEL: "deepseek/test",
    DSH_READY_BASE_URL: "https://openrouter.ai/api/v1",
    DSH_OPENROUTER_PROVIDER_ONLY: "DeepSeek",
    ...overrides,
  };
}

describe("sidecar process configuration", () => {
  it("shares the Chat bearer token SSoT and defaults to the Chat URL port", () => {
    const config = loadSidecarConfig(environment());

    expect(config.authToken).toBe("shared-chat-sidecar-token");
    expect(config.port).toBe(3101);
    expect(config.shadowRoot).toMatch(/chat-agent-shadow$/);
    expect(config.maxConcurrentAgents).toEqual({ normal: 4, private: 4 });
  });

  it("keeps normal and private agent capacity in separate bounded pools", () => {
    expect(loadSidecarConfig(environment({
      DSH_MAX_NORMAL_AGENTS: "2",
      DSH_MAX_PRIVATE_AGENTS: "1",
    })).maxConcurrentAgents).toEqual({ normal: 2, private: 1 });
    expect(() => loadSidecarConfig(environment({ DSH_MAX_NORMAL_AGENTS: "0" })))
      .toThrow(/DSH_MAX_NORMAL_AGENTS/);
    expect(() => loadSidecarConfig(environment({ DSH_MAX_PRIVATE_AGENTS: "1.5" })))
      .toThrow(/DSH_MAX_PRIVATE_AGENTS/);
  });

  it("requires all workspace authority roots to be pairwise disjoint", () => {
    expect(() => loadSidecarConfig(environment({
      DSH_IGREP_CANONICAL_ROOT: "/var/lib/idream/memory",
      DSH_IGREP_PRIVATE_ROOT: "/var/lib/idream/memory/private",
    }))).toThrow(/workspace roots.*disjoint/);
    expect(() => loadSidecarConfig(environment({
      DSH_IGREP_CANONICAL_ROOT: "/var/lib/idream/memory",
      DSH_IGREP_SHADOW_ROOT: "/var/lib/idream/memory",
    }))).toThrow(/workspace roots.*disjoint/);
    expect(() => loadSidecarConfig(environment({
      DSH_IGREP_CANONICAL_ROOT: "/var/lib/idream/memory",
      DSH_IGREP_SHADOW_ROOT: "/var/lib/idream/memory/shadow",
    }))).toThrow(/workspace roots.*disjoint/);
  });

  it("rejects invalid TCP ports and the removed duplicate token variable", () => {
    expect(() => loadSidecarConfig(environment({ CHAT_AGENT_PORT: "65536" })))
      .toThrow(/CHAT_AGENT_PORT/);
    const env = environment({ DSH_AGENT_TOKEN: undefined, CHAT_AGENT_AUTH_TOKEN: "stale-token" });
    expect(() => loadSidecarConfig(env)).toThrow(/DSH_AGENT_TOKEN is required/);
  });
});
