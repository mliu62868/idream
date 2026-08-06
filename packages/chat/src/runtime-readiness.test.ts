import { describe, expect, it, vi } from "vitest";
import type { ChatPrismaClient } from "./db.js";
import type { ChatModel } from "./providers.js";
import { RuntimeReadiness, warmRuntime } from "./runtime-readiness.js";

describe("RuntimeReadiness", () => {
  it("distinguishes liveness, warmup readiness and shutdown admission", () => {
    const state = new RuntimeReadiness();
    expect(state.snapshot()).toMatchObject({ live: true, ready: false });
    state.beginWarmup();
    expect(state.snapshot().warming).toBe(true);
    state.warmed();
    expect(state.canAcceptTurns()).toBe(true);
    state.stopAccepting();
    expect(state.snapshot()).toMatchObject({ live: true, ready: false, accepting: false });
  });

  it("retains the warmup failure for readiness diagnostics", () => {
    const state = new RuntimeReadiness();
    state.beginWarmup();
    state.failed(new Error("model offline"));
    expect(state.snapshot()).toMatchObject({
      live: true,
      ready: false,
      warming: false,
      lastError: "model offline",
    });
  });

  it("stays unready when the Scene schema migration is not applied", async () => {
    const readiness = new RuntimeReadiness();
    const schemaError = new Error("column messages.scene_version does not exist");
    const prisma = {
      $queryRaw: vi.fn().mockRejectedValue(schemaError),
    } as unknown as ChatPrismaClient;
    const chat = {
      stream: vi.fn(),
    } as unknown as ChatModel;
    const pingRedis = vi.fn();

    await expect(warmRuntime({ prisma, chat, pingRedis, readiness })).rejects.toThrow(
      "messages.scene_version",
    );

    expect(readiness.snapshot()).toMatchObject({
      ready: false,
      warming: false,
      lastError: "column messages.scene_version does not exist",
    });
    expect(pingRedis).not.toHaveBeenCalled();
    expect(chat.stream).not.toHaveBeenCalled();
  });
});
