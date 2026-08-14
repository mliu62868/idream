import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatPrismaClient } from "./db.js";
import type { ChatModel } from "./providers.js";

const redisMock = vi.hoisted(() => ({
  ping: vi.fn<() => Promise<string>>(),
  quit: vi.fn<() => Promise<string>>(),
  disconnect: vi.fn<() => void>(),
}));

vi.mock("ioredis", () => ({
  default: class Redis {
    ping() {
      return redisMock.ping();
    }

    quit() {
      return redisMock.quit();
    }

    disconnect() {
      redisMock.disconnect();
    }
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Chat Redis runtime readiness", () => {
  it("fails warmRuntime within a bounded deadline when Redis PING never settles", async () => {
    vi.useFakeTimers();
    redisMock.ping.mockReturnValue(new Promise<string>(() => {}));
    redisMock.quit.mockResolvedValue("OK");

    const { RuntimeReadiness, warmRuntime } = await import("./runtime-readiness.js");
    const readiness = new RuntimeReadiness();
    const warming = warmRuntime({
      prisma: canonicalRequestPrisma(),
      projectorPrisma: canonicalProjectorPrisma(),
      chat: { stream: vi.fn(), complete: vi.fn() } as unknown as ChatModel,
      readiness,
    });
    const outcome = warming.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(redisMock.ping).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    const settled = await Promise.race([
      outcome,
      Promise.resolve({ status: "pending" as const }),
    ]);

    expect(settled).toMatchObject({
      status: "rejected",
      error: expect.objectContaining({
        message: "Chat Redis readiness ping timed out after 5000ms",
      }),
    });
    expect(readiness.snapshot()).toMatchObject({
      ready: false,
      warming: false,
      lastError: "Chat Redis readiness ping timed out after 5000ms",
    });
    expect(readiness.canAcceptTurns()).toBe(false);
    expect(redisMock.disconnect).toHaveBeenCalledOnce();
    expect(redisMock.quit).not.toHaveBeenCalled();
  });
});

function canonicalRequestPrisma(): ChatPrismaClient {
  return {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ messageMemoryAuthorityReady: true }])
      .mockResolvedValueOnce([{ fileMutationAuthorityReady: true }])
      .mockResolvedValueOnce([{ fileMutationAuthorityReady: true }])
      .mockResolvedValueOnce([{
        role: "chat_service",
        sessionRole: "chat_service",
        database: "idream",
        serverAddress: "127.0.0.1",
        serverPort: 5433,
        capabilitiesReady: true,
      }]),
  } as unknown as ChatPrismaClient;
}

function canonicalProjectorPrisma(): ChatPrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValueOnce([{
      role: "chat_projector",
      sessionRole: "chat_projector",
      database: "idream",
      serverAddress: "127.0.0.1",
      serverPort: 5433,
      capabilitiesReady: true,
    }]),
  } as unknown as ChatPrismaClient;
}
