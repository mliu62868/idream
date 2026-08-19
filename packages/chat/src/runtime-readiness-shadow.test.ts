import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatPrismaClient } from "./db.js";
import type { ChatModel } from "./providers.js";
import { RuntimeReadiness, warmRuntime } from "./runtime-readiness.js";

const originalEnv = {
  runtime: process.env.CHAT_COMPANION_RUNTIME,
  memory: process.env.CHAT_MEMORY_BACKEND,
  shadow: process.env.CHAT_COMPANION_DSH_SHADOW_ENABLED,
  token: process.env.DSH_AGENT_TOKEN,
  sidecarUrl: process.env.DSH_AGENT_URL,
};

afterEach(() => {
  for (const [name, value] of Object.entries({
    CHAT_COMPANION_RUNTIME: originalEnv.runtime,
    CHAT_MEMORY_BACKEND: originalEnv.memory,
    CHAT_COMPANION_DSH_SHADOW_ENABLED: originalEnv.shadow,
    DSH_AGENT_TOKEN: originalEnv.token,
    DSH_AGENT_URL: originalEnv.sidecarUrl,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function installShadowEnv(): void {
  process.env.CHAT_COMPANION_RUNTIME = "native";
  process.env.CHAT_MEMORY_BACKEND = "legacy";
  process.env.CHAT_COMPANION_DSH_SHADOW_ENABLED = "true";
  process.env.DSH_AGENT_TOKEN = "shadow-readiness-token";
  process.env.DSH_AGENT_URL = "http://shadow-sidecar:3101";
}

function canonicalDatabases(): {
  prisma: ChatPrismaClient;
  projectorPrisma: ChatPrismaClient;
} {
  const authority = {
    database: "idream",
    serverAddress: "127.0.0.1",
    serverPort: 5433,
    capabilitiesReady: true,
  };
  return {
    prisma: {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ messageMemoryAuthorityReady: true }])
        .mockResolvedValueOnce([{ fileMutationAuthorityReady: true }])
        .mockResolvedValueOnce([{ fileMutationAuthorityReady: true }])
        .mockResolvedValueOnce([{
          ...authority,
          role: "chat_service",
          sessionRole: "chat_service",
        }]),
    } as unknown as ChatPrismaClient,
    projectorPrisma: {
      $queryRaw: vi.fn().mockResolvedValueOnce([{
        ...authority,
        role: "chat_projector",
        sessionRole: "chat_projector",
      }]),
    } as unknown as ChatPrismaClient,
  };
}

function warmableModel(): ChatModel {
  return {
    async *stream() {
      yield { delta: "READY", done: true };
    },
    complete: vi.fn().mockResolvedValue({ content: "{}" }),
  };
}

const profile = {
  adapter: "openai-compatible-v1" as const,
  provider: "openai" as const,
  baseUrl: "http://native-model/v1",
  model: "native-model",
  apiKey: "",
  maxOutputTokens: 100,
  firstTokenTimeoutMs: 100,
  idleTimeoutMs: 100,
  completionTimeoutMs: 100,
  supportsTools: true,
};

describe("native runtime DSH shadow readiness", () => {
  it("admits shadow only after an authenticated full sidecar identity probe", async () => {
    installShadowEnv();
    const readiness = new RuntimeReadiness();
    const databases = canonicalDatabases();
    const probeSidecar = vi.fn().mockResolvedValue({
      dshVersion: "0.1.0-rc.7",
      dshCommit: "99f6f02",
      igrepVersion: "1.2.3",
      pluginVersion: "1.2.3",
      profiles: {
        normal: { normalizedConfigDigest: "a".repeat(64) },
        private: { normalizedConfigDigest: "b".repeat(64) },
      },
    });

    await warmRuntime({
      ...databases,
      chat: warmableModel(),
      memoryChat: warmableModel(),
      profiles: [profile],
      pingRedis: vi.fn().mockResolvedValue(undefined),
      probeSidecar,
      readiness,
    });

    expect(probeSidecar).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "http://shadow-sidecar:3101",
      token: "shadow-readiness-token",
      expectedProvider: "openai",
      expectedBaseUrl: "http://native-model/v1",
      expectedModel: "native-model",
      full: true,
    }));
    expect(readiness.canAcceptTurns()).toBe(true);
    expect(readiness.canAdmitShadow()).toBe(true);
    expect(readiness.canAdmitShadow({
      provider: "openai",
      baseUrl: "http://native-model/v1",
      model: "another-tier-model",
    })).toBe(false);
    expect(readiness.snapshot().components.shadow).toMatchObject({ status: "healthy" });
  });

  it("keeps native ready but rejects shadow admission when full readiness fails", async () => {
    installShadowEnv();
    const readiness = new RuntimeReadiness();
    const databases = canonicalDatabases();
    const probeSidecar = vi.fn().mockRejectedValue(
      new Error("companion sidecar resolved a different provider profile"),
    );

    await expect(warmRuntime({
      ...databases,
      chat: warmableModel(),
      memoryChat: warmableModel(),
      profiles: [profile],
      pingRedis: vi.fn().mockResolvedValue(undefined),
      probeSidecar,
      readiness,
    })).resolves.toBeUndefined();

    expect(readiness.canAcceptTurns()).toBe(true);
    expect(readiness.canAdmitShadow()).toBe(false);
    expect(readiness.snapshot()).toMatchObject({
      ready: true,
      lastError: null,
      components: {
        provider: { status: "healthy" },
        memory: { status: "healthy" },
        shadow: {
          status: "unhealthy",
          lastError: "companion sidecar resolved a different provider profile",
        },
      },
    });
  });
});
