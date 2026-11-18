import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRuntimeConfig } from "./config";

const state = vi.hoisted(() => ({ config: undefined as AgentRuntimeConfig | undefined, verifyPiPackages: vi.fn() }));
vi.mock("./config", async importOriginal => ({ ...await importOriginal<typeof import("./config")>(), loadAgentRuntimeConfig: () => state.config! }));
vi.mock("./igrep", async importOriginal => ({ ...await importOriginal<typeof import("./igrep")>(), igrepVersion: async () => "0.1.169" }));
vi.mock("./readiness", async importOriginal => ({ ...await importOriginal<typeof import("./readiness")>(), verifyPiPackages: state.verifyPiPackages }));

let root: string;
beforeEach(async () => {
  vi.resetModules();
  state.verifyPiPackages.mockReset().mockResolvedValue(undefined);
  root = await mkdtemp(join(tmpdir(), "chat-runtime-health-"));
  state.config = {
    canonicalRoot: join(root, "canonical"), privateRoot: join(root, "private"), igrepCommand: "igrep", igrepEnvironment: {},
    igrepLlm: { url: "https://maintenance.invalid/v1", model: "maintenance", apiKey: "fixture" },
    modelProfile: { provider: "openai", adapter: "openai-compatible-v1", baseUrl: "https://model.invalid/v1", model: "fixture", apiKey: "fixture",
      supportsTools: true, maxOutputTokens: 256, firstTokenTimeoutMs: 1_000, idleTimeoutMs: 1_000 },
    maxSteps: 8, maxConcurrentAgents: { normal: 4, private: 4 },
  };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("rechecks installed Pi packages on admission health and rejects later version drift", async () => {
  const { warmAgentRuntime } = await import("./runtime");
  await expect(warmAgentRuntime()).resolves.toBeUndefined();
  state.verifyPiPackages.mockRejectedValueOnce(new Error("Pi core version drift: @earendil-works/pi-ai"));
  await expect(warmAgentRuntime()).rejects.toThrow("Pi core version drift");
  expect(state.verifyPiPackages).toHaveBeenCalledTimes(2);
});
