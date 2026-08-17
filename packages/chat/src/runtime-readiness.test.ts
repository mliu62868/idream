import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleChatModel } from "@idream/shared";
import { ACCOUNT_DELETION_V2_INGEST_PATH } from "@idream/shared/contracts";
import type { ChatPrismaClient } from "./db.js";
import type { ChatModel } from "./providers.js";
import { createChatServer } from "./web.js";
import {
  assertChatSchemaReady,
  RUNTIME_RECOVERY_INITIAL_BACKOFF_MS,
  RUNTIME_RECOVERY_MAX_BACKOFF_MS,
  RUNTIME_TURN_FAILURE_THRESHOLD,
  RuntimeReadiness,
  warmRuntime,
} from "./runtime-readiness.js";

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

  it("fails /readyz and turn admission when a warmed dependency becomes unhealthy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00.000Z"));
    const state = new RuntimeReadiness();
    const revalidate = vi.fn().mockRejectedValue(
      new Error("chat projector credential was revoked"),
    );
    state.warmed(["chat:model"], revalidate);
    vi.advanceTimersByTime(5_001);

    try {
      const readyz = await dispatchRequest(createChatServer(state), "/readyz");
      expect(readyz.status).toBe(503);
      expect(JSON.parse(readyz.body)).toMatchObject({
        ready: false,
        lastError: "chat projector credential was revoked",
      });
      expect(revalidate).toHaveBeenCalledOnce();

      const turn = await dispatchRequest(
        createChatServer(state),
        "/api/v1/chat/sessions/session-1/messages",
        {},
        "POST",
      );
      expect(turn.status).toBe(503);
      expect(JSON.parse(turn.body)).toEqual({ error: "service_not_ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("singleflights concurrent dependency freshness checks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00.000Z"));
    const state = new RuntimeReadiness();
    let release!: () => void;
    const revalidate = vi.fn(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    state.warmed(["chat:model"], revalidate);
    vi.advanceTimersByTime(5_001);

    try {
      const first = state.refreshDependencies();
      const second = state.refreshDependencies();
      expect(revalidate).toHaveBeenCalledOnce();
      release();
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(state.snapshot()).toMatchObject({ ready: true, lastError: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps serving everyone else while isolated turns fail", () => {
    const state = new RuntimeReadiness();
    state.warmed(["chat:model"]);

    for (let i = 1; i < RUNTIME_TURN_FAILURE_THRESHOLD; i += 1) {
      state.recordTurnFailure(new Error("client hung up"));
      expect(state.canAcceptTurns()).toBe(true);
      expect(state.snapshot().lastError).toBeNull();
    }
    // Any turn the provider actually answers disproves the streak, so scattered
    // failures never accumulate their way into a process-wide outage.
    state.recordTurnSuccess();
    for (let i = 1; i < RUNTIME_TURN_FAILURE_THRESHOLD; i += 1) {
      state.recordTurnFailure(new Error("client hung up"));
    }
    expect(state.canAcceptTurns()).toBe(true);
  });

  it("pulls readiness once turn failures become provider-level evidence", () => {
    const state = new RuntimeReadiness();
    state.warmed(["chat:model"]);

    for (let i = 0; i < RUNTIME_TURN_FAILURE_THRESHOLD; i += 1) {
      state.recordTurnFailure(new Error("chat model disconnected"));
    }

    expect(state.canAcceptTurns()).toBe(false);
    expect(state.snapshot().lastError).toBe("chat model disconnected");
  });

  it("keeps model failure latched until a full warmup succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00.000Z"));
    const state = new RuntimeReadiness();
    const revalidate = vi.fn().mockResolvedValue(undefined);
    state.warmed(["chat:model"], revalidate);
    state.invalidate(new Error("chat model disconnected"));
    vi.advanceTimersByTime(60_000);

    try {
      const readyz = await dispatchRequest(createChatServer(state), "/readyz");
      expect(readyz.status).toBe(503);
      expect(JSON.parse(readyz.body)).toMatchObject({
        ready: false,
        lastError: "chat model disconnected",
      });
      expect(revalidate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { failure: "provider failure", message: "chat model disconnected" },
    { failure: "empty model response", message: "chat model returned an empty response" },
  ])("keeps only turn admission unready and automatically rewarms after $failure", async ({ message }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00.000Z"));
    const internalToken = process.env.INTERNAL_TOKEN;
    const modelProvider = process.env.CHAT_MODEL_PROVIDER;
    process.env.INTERNAL_TOKEN = "runtime-readiness-test-token";
    process.env.CHAT_MODEL_PROVIDER = "mock";
    const state = new RuntimeReadiness();
    const dependencyProbe = vi.fn().mockResolvedValue(undefined);
    const fullWarmup = vi.fn(async () => {
      state.beginWarmup();
      state.warmed(["chat:mock:test-model"], dependencyProbe);
    });
    state.configureFullWarmupRecovery(fullWarmup);
    state.warmed(["chat:mock:test-model"], dependencyProbe);
    state.invalidate(new Error(message));

    try {
      const readyzWhileDown = await dispatchRequest(createChatServer(state), "/readyz");
      expect(readyzWhileDown.status).toBe(503);
      expect(JSON.parse(readyzWhileDown.body)).toMatchObject({
        ready: false,
        lastError: message,
      });

      const turnWhileDown = await dispatchRequest(
        createChatServer(state),
        "/api/v1/chat/sessions/session-1/messages",
        {},
        "POST",
      );
      expect(turnWhileDown.status).toBe(503);

      const historyWhileDown = await dispatchRequest(
        createChatServer(state),
        "/api/v1/chat/sessions",
      );
      expect(historyWhileDown.status).toBe(401);
      expect(JSON.parse(historyWhileDown.body)).not.toEqual({
        error: "service_not_ready",
      });

      const diagnostics = await dispatchRequest(
        createChatServer(state),
        "/internal/admin/provider-health",
        { "x-internal-token": "runtime-readiness-test-token" },
      );
      expect(diagnostics.status).toBe(200);
      expect(JSON.parse(diagnostics.body)).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ provider: "chat_model" }),
        ]),
      });
      const accountErasureIngress = await dispatchRequest(
        createChatServer(state),
        ACCOUNT_DELETION_V2_INGEST_PATH,
        {},
        "POST",
      );
      expect(accountErasureIngress.status).toBe(401);
      expect(JSON.parse(accountErasureIngress.body)).toEqual({
        error: "unauthorized",
      });

      expect(fullWarmup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(RUNTIME_RECOVERY_INITIAL_BACKOFF_MS);
      expect(fullWarmup).toHaveBeenCalledOnce();

      const readyz = await dispatchRequest(createChatServer(state), "/readyz");
      expect(readyz.status).toBe(200);
      expect(JSON.parse(readyz.body)).toMatchObject({
        ready: true,
        lastError: null,
      });
      const admittedTurn = await dispatchRequest(
        createChatServer(state),
        "/api/v1/chat/sessions/session-1/messages",
        {},
        "POST",
      );
      expect(admittedTurn.status).toBe(401);
      expect(JSON.parse(admittedTurn.body)).not.toEqual({
        error: "service_not_ready",
      });
    } finally {
      state.stopAccepting();
      if (internalToken === undefined) delete process.env.INTERNAL_TOKEN;
      else process.env.INTERNAL_TOKEN = internalToken;
      if (modelProvider === undefined) delete process.env.CHAT_MODEL_PROVIDER;
      else process.env.CHAT_MODEL_PROVIDER = modelProvider;
      vi.useRealTimers();
    }
  });

  it("backs off failed full warmup recovery instead of retrying in a tight loop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00.000Z"));
    const state = new RuntimeReadiness();
    const fullWarmup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("provider still unavailable"))
      .mockImplementationOnce(async () => {
        state.beginWarmup();
        state.warmed(["chat:mock:test-model"]);
      });
    state.configureFullWarmupRecovery(fullWarmup);
    state.warmed(["chat:mock:test-model"]);
    state.invalidate(new Error("chat model disconnected"));

    try {
      await vi.advanceTimersByTimeAsync(RUNTIME_RECOVERY_INITIAL_BACKOFF_MS);
      expect(fullWarmup).toHaveBeenCalledTimes(1);
      expect(state.canAcceptTurns()).toBe(false);

      await vi.advanceTimersByTimeAsync(
        RUNTIME_RECOVERY_INITIAL_BACKOFF_MS * 2 - 1,
      );
      expect(fullWarmup).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fullWarmup).toHaveBeenCalledTimes(2);
      expect(state.canAcceptTurns()).toBe(true);
    } finally {
      state.stopAccepting();
      vi.useRealTimers();
    }
  });

  it("singleflights full warmup recovery across repeated provider failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00.000Z"));
    const state = new RuntimeReadiness();
    let release!: () => void;
    const fullWarmup = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      state.beginWarmup();
      state.warmed(["chat:mock:test-model"]);
    });
    state.configureFullWarmupRecovery(fullWarmup);
    state.warmed(["chat:mock:test-model"]);
    state.invalidate(new Error("first provider failure"));
    state.invalidate(new Error("second provider failure"));

    try {
      await vi.advanceTimersByTimeAsync(RUNTIME_RECOVERY_INITIAL_BACKOFF_MS);
      expect(fullWarmup).toHaveBeenCalledOnce();

      state.invalidate(new Error("third provider failure"));
      await vi.advanceTimersByTimeAsync(RUNTIME_RECOVERY_INITIAL_BACKOFF_MS * 20);
      expect(fullWarmup).toHaveBeenCalledOnce();

      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.canAcceptTurns()).toBe(true);
    } finally {
      state.stopAccepting();
      vi.useRealTimers();
    }
  });

  it("keeps a provider failure observed during full warmup latched for the next recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00.000Z"));
    const state = new RuntimeReadiness();
    let releaseFirstWarmup!: () => void;
    let attempt = 0;
    const fullWarmup = vi.fn(async () => {
      state.beginWarmup();
      attempt += 1;
      if (attempt === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstWarmup = resolve;
        });
      }
      state.warmed(["chat:mock:test-model"]);
    });
    state.configureFullWarmupRecovery(fullWarmup);
    state.warmed(["chat:mock:test-model"]);
    state.invalidate(new Error("first provider failure"));

    try {
      await vi.advanceTimersByTimeAsync(RUNTIME_RECOVERY_INITIAL_BACKOFF_MS);
      expect(fullWarmup).toHaveBeenCalledOnce();

      state.invalidate(new Error("new failure during warmup"));
      releaseFirstWarmup();
      await vi.advanceTimersByTimeAsync(0);

      expect(state.canAcceptTurns()).toBe(false);
      expect(state.snapshot().lastError).toBe("new failure during warmup");

      await vi.advanceTimersByTimeAsync(RUNTIME_RECOVERY_INITIAL_BACKOFF_MS);
      expect(fullWarmup).toHaveBeenCalledTimes(2);
      expect(state.canAcceptTurns()).toBe(true);
    } finally {
      state.stopAccepting();
      vi.useRealTimers();
    }
  });

  it("does not re-admit or reschedule recovery after shutdown wins an in-flight warmup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00.000Z"));
    const state = new RuntimeReadiness();
    let releaseWarmup!: () => void;
    const fullWarmup = vi.fn(async () => {
      state.beginWarmup();
      await new Promise<void>((resolve) => {
        releaseWarmup = resolve;
      });
      state.warmed(["chat:mock:test-model"]);
    });
    state.configureFullWarmupRecovery(fullWarmup);
    state.warmed(["chat:mock:test-model"]);
    state.invalidate(new Error("provider failure before shutdown"));

    try {
      await vi.advanceTimersByTimeAsync(RUNTIME_RECOVERY_INITIAL_BACKOFF_MS);
      expect(fullWarmup).toHaveBeenCalledOnce();

      state.stopAccepting();
      releaseWarmup();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(RUNTIME_RECOVERY_MAX_BACKOFF_MS * 2);

      expect(fullWarmup).toHaveBeenCalledOnce();
      expect(state.snapshot()).toMatchObject({
        accepting: false,
        ready: false,
      });
      expect(state.canAcceptTurns()).toBe(false);
    } finally {
      state.stopAccepting();
      vi.useRealTimers();
    }
  });

  it("does not let an in-flight dependency probe overwrite a model failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00.000Z"));
    const state = new RuntimeReadiness();
    let release!: () => void;
    state.warmed(
      ["chat:model"],
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    vi.advanceTimersByTime(5_001);

    try {
      const checking = state.refreshDependencies();
      state.invalidate(new Error("chat model disconnected"));
      release();
      await checking;
      expect(state.snapshot()).toMatchObject({
        ready: false,
        lastError: "chat model disconnected",
      });
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps /readyz unready when the projector connection reuses the request role", async () => {
    const readiness = new RuntimeReadiness();
    const prisma = {
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
    const projectorPrisma = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{
        role: "chat_service",
        sessionRole: "chat_service",
        database: "idream",
        serverAddress: "127.0.0.1",
        serverPort: 5433,
        capabilitiesReady: true,
      }]),
    } as unknown as ChatPrismaClient;
    const chat = { stream: vi.fn() } as unknown as ChatModel;
    const pingRedis = vi.fn();

    await expect(warmRuntime({
      prisma,
      projectorPrisma,
      chat,
      pingRedis,
      readiness,
    })).rejects.toThrow("chat projector authenticated role is not canonical");

    expect(readiness.snapshot()).toMatchObject({
      ready: false,
      warming: false,
      lastError: "chat projector authenticated role is not canonical",
    });
    expect(pingRedis).not.toHaveBeenCalled();
    expect(chat.stream).not.toHaveBeenCalled();
  });

  it("keeps /readyz unready when the request connection does not use chat_service", async () => {
    const readiness = new RuntimeReadiness();
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ messageMemoryAuthorityReady: true }])
        .mockResolvedValueOnce([{ fileMutationAuthorityReady: true }])
        .mockResolvedValueOnce([{ fileMutationAuthorityReady: true }])
        .mockResolvedValueOnce([{
          role: "chat_owner",
          sessionRole: "chat_owner",
          database: "idream",
          serverAddress: "127.0.0.1",
          serverPort: 5433,
          capabilitiesReady: true,
        }]),
    } as unknown as ChatPrismaClient;
    const projectorPrisma = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{
        role: "chat_projector",
        sessionRole: "chat_projector",
        database: "idream",
        serverAddress: "127.0.0.1",
        serverPort: 5433,
        capabilitiesReady: true,
      }]),
    } as unknown as ChatPrismaClient;

    await expect(warmRuntime({
      prisma,
      projectorPrisma,
      chat: { stream: vi.fn() } as unknown as ChatModel,
      pingRedis: vi.fn(),
      readiness,
    })).rejects.toThrow("chat request authenticated role is not canonical");

    expect(readiness.snapshot()).toMatchObject({
      ready: false,
      warming: false,
      lastError: "chat request authenticated role is not canonical",
    });
  });

  it("keeps /readyz unready when SET ROLE masks a broader request login", async () => {
    const readiness = new RuntimeReadiness();
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ messageMemoryAuthorityReady: true }])
        .mockResolvedValueOnce([{ fileMutationAuthorityReady: true }])
        .mockResolvedValueOnce([{ fileMutationAuthorityReady: true }])
        .mockResolvedValueOnce([{
          role: "chat_service",
          sessionRole: "postgres",
          database: "idream",
          serverAddress: "127.0.0.1",
          serverPort: 5433,
          capabilitiesReady: true,
        }]),
    } as unknown as ChatPrismaClient;
    const projectorPrisma = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{
        role: "chat_projector",
        sessionRole: "chat_projector",
        database: "idream",
        serverAddress: "127.0.0.1",
        serverPort: 5433,
        capabilitiesReady: true,
      }]),
    } as unknown as ChatPrismaClient;
    const chat: ChatModel = {
      async *stream() {
        yield { delta: "READY", done: true };
      },
      complete: vi.fn().mockResolvedValue({ content: "{}" }),
    };

    await expect(warmRuntime({
      prisma,
      projectorPrisma,
      chat,
      memoryChat: chat,
      profiles: [{
        adapter: "openai-compatible-v1",
        provider: "openai",
        baseUrl: "http://model/v1",
        model: "model",
        apiKey: "",
        maxOutputTokens: 100,
        firstTokenTimeoutMs: 100,
        idleTimeoutMs: 100,
        completionTimeoutMs: 100,
        supportsTools: true,
      }],
      pingRedis: vi.fn().mockResolvedValue(undefined),
      readiness,
    })).rejects.toThrow("chat request authenticated role is not canonical");

    expect(readiness.snapshot().ready).toBe(false);
  });

  it("keeps /readyz unready when the request role capability boundary drifted", async () => {
    const readiness = new RuntimeReadiness();
    const prisma = {
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
          capabilitiesReady: false,
        }]),
    } as unknown as ChatPrismaClient;
    const projectorPrisma = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{
        role: "chat_projector",
        sessionRole: "chat_projector",
        database: "idream",
        serverAddress: "127.0.0.1",
        serverPort: 5433,
        capabilitiesReady: true,
      }]),
    } as unknown as ChatPrismaClient;
    const chat: ChatModel = {
      async *stream() {
        yield { delta: "READY", done: true };
      },
      complete: vi.fn().mockResolvedValue({ content: "{}" }),
    };

    await expect(warmRuntime({
      prisma,
      projectorPrisma,
      chat,
      memoryChat: chat,
      profiles: [{
        adapter: "openai-compatible-v1",
        provider: "openai",
        baseUrl: "http://model/v1",
        model: "model",
        apiKey: "",
        maxOutputTokens: 100,
        firstTokenTimeoutMs: 100,
        idleTimeoutMs: 100,
        completionTimeoutMs: 100,
        supportsTools: true,
      }],
      pingRedis: vi.fn().mockResolvedValue(undefined),
      readiness,
    })).rejects.toThrow("chat request database capability is not canonical");

    expect(readiness.snapshot().ready).toBe(false);
  });

  it("keeps /readyz unready when the projector capability boundary drifted", async () => {
    const readiness = new RuntimeReadiness();
    const prisma = {
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
    const projectorPrisma = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{
        role: "chat_projector",
        sessionRole: "chat_projector",
        database: "idream",
        serverAddress: "127.0.0.1",
        serverPort: 5433,
        capabilitiesReady: false,
      }]),
    } as unknown as ChatPrismaClient;

    await expect(warmRuntime({
      prisma,
      projectorPrisma,
      chat: { stream: vi.fn() } as unknown as ChatModel,
      pingRedis: vi.fn(),
      readiness,
    })).rejects.toThrow("chat projector database capability is not canonical");

    expect(readiness.snapshot()).toMatchObject({
      ready: false,
      lastError: "chat projector database capability is not canonical",
    });
  });

  it.each([
    ["host", { serverAddress: "127.0.0.2" }],
    ["port", { serverPort: 5434 }],
    ["database", { database: "another_database" }],
  ])("keeps /readyz unready when projector uses a different %s", async (_field, mismatch) => {
    const readiness = new RuntimeReadiness();
    const requestAuthority = {
      role: "chat_service",
      sessionRole: "chat_service",
      database: "idream",
      serverAddress: "127.0.0.1",
      serverPort: 5433,
      capabilitiesReady: true,
    };
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ messageMemoryAuthorityReady: true }])
        .mockResolvedValueOnce([{ fileMutationAuthorityReady: true }])
        .mockResolvedValueOnce([{ fileMutationAuthorityReady: true }])
        .mockResolvedValueOnce([requestAuthority]),
    } as unknown as ChatPrismaClient;
    const projectorPrisma = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{
        ...requestAuthority,
        ...mismatch,
        role: "chat_projector",
        sessionRole: "chat_projector",
      }]),
    } as unknown as ChatPrismaClient;
    const chat = { stream: vi.fn() } as unknown as ChatModel;
    const pingRedis = vi.fn();

    await expect(warmRuntime({
      prisma,
      projectorPrisma,
      chat,
      pingRedis,
      readiness,
    })).rejects.toThrow("chat projector database authority differs from request database");

    expect(readiness.snapshot()).toMatchObject({
      ready: false,
      warming: false,
      lastError: "chat projector database authority differs from request database",
    });
    expect(pingRedis).not.toHaveBeenCalled();
    expect(chat.stream).not.toHaveBeenCalled();
  });

  it("keeps /readyz unready when the projector credential cannot connect", async () => {
    const readiness = new RuntimeReadiness();
    const prisma = {
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
    const credentialError = new Error(
      'password authentication failed for user "chat_projector"',
    );
    const projectorPrisma = {
      $queryRaw: vi.fn().mockRejectedValue(credentialError),
    } as unknown as ChatPrismaClient;

    await expect(warmRuntime({
      prisma,
      projectorPrisma,
      chat: { stream: vi.fn() } as unknown as ChatModel,
      pingRedis: vi.fn(),
      readiness,
    })).rejects.toThrow(credentialError.message);

    expect(readiness.snapshot()).toMatchObject({
      ready: false,
      warming: false,
      lastError: credentialError.message,
    });
  });

  it("keeps /readyz available but unready when the projector credential is missing", async () => {
    const projectorUrl = process.env.CHAT_PROJECTOR_DATABASE_URL;
    const projectorPassword = process.env.CHAT_PROJECTOR_PASSWORD;
    delete process.env.CHAT_PROJECTOR_DATABASE_URL;
    delete process.env.CHAT_PROJECTOR_PASSWORD;
    const readiness = new RuntimeReadiness();
    const prisma = {
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

    try {
      await expect(warmRuntime({
        prisma,
        chat: { stream: vi.fn() } as unknown as ChatModel,
        pingRedis: vi.fn(),
        readiness,
      })).rejects.toThrow("Missing required env var CHAT_PROJECTOR_PASSWORD");

      expect(readiness.snapshot()).toMatchObject({
        live: true,
        ready: false,
        warming: false,
        lastError: "Missing required env var CHAT_PROJECTOR_PASSWORD",
      });
      const readyz = await dispatchRequest(createChatServer(readiness), "/readyz");
      expect(readyz.status).toBe(503);
      expect(JSON.parse(readyz.body)).toMatchObject({
        live: true,
        ready: false,
        lastError: "Missing required env var CHAT_PROJECTOR_PASSWORD",
      });
    } finally {
      if (projectorUrl === undefined) {
        delete process.env.CHAT_PROJECTOR_DATABASE_URL;
      } else {
        process.env.CHAT_PROJECTOR_DATABASE_URL = projectorUrl;
      }
      if (projectorPassword === undefined) {
        delete process.env.CHAT_PROJECTOR_PASSWORD;
      } else {
        process.env.CHAT_PROJECTOR_PASSWORD = projectorPassword;
      }
    }
  });

  it("rejects the legacy file-mutation trigger before accepting account deletion v2", async () => {
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ messageMemoryAuthorityReady: true }])
        .mockResolvedValueOnce([{ fileMutationAuthorityReady: false }]),
    } as unknown as ChatPrismaClient;

    await expect(assertChatSchemaReady(prisma)).rejects.toThrow(
      "file mutation authority is not canonical",
    );
  });

  it("rejects a file-mutation redactor that drops the request-bound receipt", async () => {
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ messageMemoryAuthorityReady: true }])
        .mockResolvedValueOnce([{ fileMutationAuthorityReady: true }])
        .mockResolvedValueOnce([{ fileMutationAuthorityReady: false }]),
    } as unknown as ChatPrismaClient;

    await expect(assertChatSchemaReady(prisma)).rejects.toThrow(
      "file mutation authority is not canonical",
    );
  });

  it("rejects a non-canonical message memory-authority trigger", async () => {
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ messageMemoryAuthorityReady: false }]),
    } as unknown as ChatPrismaClient;

    await expect(assertChatSchemaReady(prisma)).rejects.toThrow(
      "message memory authority is not canonical",
    );
  });

  it("warms every distinct model profile with tools and the memory extractor", async () => {
    const readiness = new RuntimeReadiness();
    const prisma = {
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
    const projectorPrisma = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{
        role: "chat_projector",
        sessionRole: "chat_projector",
        database: "idream",
        serverAddress: "127.0.0.1",
        serverPort: 5433,
        capabilitiesReady: true,
      }]),
    } as unknown as ChatPrismaClient;
    const calls: Array<Parameters<ChatModel["stream"]>[0]> = [];
    const chat: ChatModel = {
      supportsTools: true,
      async *stream(input) {
        calls.push(input);
        yield { delta: "READY", done: false };
        yield { delta: "", done: true };
      },
      complete: vi.fn().mockResolvedValue({ content: "{}" }),
    };
    await warmRuntime({
      prisma,
      projectorPrisma,
      chat,
      memoryChat: chat,
      pingRedis: vi.fn().mockResolvedValue(undefined),
      readiness,
      profiles: [
        { adapter: "openai-compatible-v1", provider: "openai", baseUrl: "http://model/v1", model: "free-model", apiKey: "", maxOutputTokens: 100, firstTokenTimeoutMs: 100, idleTimeoutMs: 100, completionTimeoutMs: 100, supportsTools: true },
        { adapter: "openai-compatible-v1", provider: "openai", baseUrl: "http://model/v1", model: "premium-model", apiKey: "", maxOutputTokens: 100, firstTokenTimeoutMs: 100, idleTimeoutMs: 100, completionTimeoutMs: 100, supportsTools: true },
        { adapter: "openai-compatible-v1", provider: "openai", baseUrl: "http://model/v1", model: "premium-model", apiKey: "", maxOutputTokens: 100, firstTokenTimeoutMs: 100, idleTimeoutMs: 100, completionTimeoutMs: 100, supportsTools: true },
      ],
    });
    expect(calls.map((call) => call.model)).toEqual(["free-model", "premium-model"]);
    expect(calls.every((call) => (call.tools?.length ?? 0) === 1)).toBe(true);
    expect(chat.complete).toHaveBeenCalledOnce();
    expect(readiness.snapshot()).toMatchObject({
      ready: true,
      warmedProfiles: expect.arrayContaining([
        "chat:openai:free-model",
        "chat:openai:premium-model",
      ]),
    });
  });

  it("keeps /readyz ready when a real memory model needs more than 16 output tokens to finish its warm-up", async () => {
    const readiness = new RuntimeReadiness();
    const prisma = {
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
    const projectorPrisma = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{
        role: "chat_projector",
        sessionRole: "chat_projector",
        database: "idream",
        serverAddress: "127.0.0.1",
        serverPort: 5433,
        capabilitiesReady: true,
      }]),
    } as unknown as ChatPrismaClient;
    const chat: ChatModel = {
      async *stream() {
        yield { delta: "READY", done: false };
        yield { delta: "", done: true };
      },
      complete: vi.fn(),
    };
    const profile = {
      adapter: "openai-compatible-v1" as const,
      provider: "pipeline" as const,
      baseUrl: "http://model/v1",
      model: "chat-model",
      apiKey: "provider-key",
      maxOutputTokens: 8_000,
      firstTokenTimeoutMs: 100,
      idleTimeoutMs: 100,
      completionTimeoutMs: 100,
      supportsTools: false,
    };
    const completionBodies: Array<Record<string, unknown>> = [];
    const memoryChat = new OpenAICompatibleChatModel(
      profile,
      vi.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        completionBodies.push(body);
        const outputLimitReached = Number(body.max_tokens) <= 16;
        return Response.json({
          choices: [{
            finish_reason: outputLimitReached ? "length" : "stop",
            message: { content: outputLimitReached ? "{" : "{}" },
          }],
        });
      }),
    );

    await warmRuntime({
      prisma,
      projectorPrisma,
      chat,
      memoryChat,
      pingRedis: vi.fn().mockResolvedValue(undefined),
      readiness,
      profiles: [profile],
    });

    expect(completionBodies).toEqual([expect.objectContaining({
      max_tokens: 64,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: "Reply with exactly {} and nothing else." },
        { role: "user", content: "{}" },
      ],
    })]);
    const readyz = await dispatchRequest(createChatServer(readiness), "/readyz");
    expect(readyz.status).toBe(200);
    expect(JSON.parse(readyz.body)).toMatchObject({
      live: true,
      ready: true,
      lastError: null,
    });
  });
});

async function dispatchRequest(
  server: ReturnType<typeof createChatServer>,
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; body: string }> {
  let status = 0;
  let body = "";
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const response = {
    headersSent: false,
    writeHead(this: { headersSent: boolean }, code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      finish();
      return this;
    },
  } as unknown as ServerResponse;
  const request = Object.assign(new EventEmitter(), {
    headers,
    method,
    url,
  }) as IncomingMessage;
  server.emit("request", request, response);
  queueMicrotask(() => request.emit("end"));
  await ended;
  return { status, body };
}
