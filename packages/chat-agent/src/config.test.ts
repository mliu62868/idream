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
  });

  it("rejects invalid TCP ports and the removed duplicate token variable", () => {
    expect(() => loadSidecarConfig(environment({ CHAT_AGENT_PORT: "65536" })))
      .toThrow(/CHAT_AGENT_PORT/);
    const env = environment({ DSH_AGENT_TOKEN: undefined, CHAT_AGENT_AUTH_TOKEN: "stale-token" });
    expect(() => loadSidecarConfig(env)).toThrow(/DSH_AGENT_TOKEN is required/);
  });
});
