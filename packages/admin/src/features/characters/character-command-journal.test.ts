import { describe, expect, it, vi } from "vitest";
import { AdminV2RequestError, type adminV2Request } from "@/lib/admin-v2-api";
import {
  characterCommandJournalCanAutoReplay,
  committedCharacterProjectionWarning,
  createCharacterCommandJournal,
  parsePendingCharacterCommandJournal,
  type CharacterCommandJournal,
} from "./character-command-journal";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };
}

type RequestCall = { readonly path: string; readonly options?: unknown };

/**
 * SPEC: 一个可编排的 adminV2Request 替身。
 * INTENT: journal 的每个出口都由「服务端这次怎么回」决定，所以测试只需要控制这一个输入。
 */
function fakeRequest() {
  const calls: RequestCall[] = [];
  let next: (path: string) => Promise<unknown> = () =>
    Promise.reject(new Error("no response queued"));
  const request = ((path: string, options?: unknown) => {
    calls.push({ path, options });
    return next(path);
  }) as unknown as typeof adminV2Request;
  return {
    calls,
    request,
    reply(handler: (path: string) => Promise<unknown>) {
      next = handler;
    },
    resolveWith(value: unknown) {
      next = () => Promise.resolve(value);
    },
    rejectWith(cause: unknown) {
      next = () => Promise.reject(cause);
    },
  };
}

function createJournal(
  overrides: Partial<Parameters<typeof createCharacterCommandJournal>[0]> = {},
) {
  const storage = memoryStorage();
  const server = fakeRequest();
  let sequence = 0;
  const journal = createCharacterCommandJournal({
    actorId: "operator-a",
    characterId: "character-1",
    storage,
    environment: "https://admin.example.test",
    now: () => 1_000,
    createIdempotencyKey: () => `key-${++sequence}`,
    request: server.request,
    ...overrides,
  });
  return { journal, server, storage };
}

const releaseIntent = {
  action: "Release publish",
  signature: "publish:release-1",
  endpoint:
    "/api/v2/admin/characters/character-1/releases/release-1/commands/publish",
  body: { entityVersion: 1 },
} as const;

function persistedJournal(storage: ReturnType<typeof memoryStorage>) {
  const raw = [...storage.values.entries()].find(([key]) =>
    key.endsWith(":pending-command"),
  )?.[1];
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe("character command journal — 开始一个命令", () => {
  // SPEC: 命令必须先落盘再发出。
  // INTENT: 这条此前只能靠断言 CharacterWorkspace.tsx 的语句顺序来守——「先发后记」会在断网时
  //         留下一个既没记录、又可能已生效的写入。收进模块后它是可观测行为：POST 发生的那一刻
  //         日志必须已经在存储里。
  it("persists the command intent before the POST leaves", async () => {
    const { journal, server, storage } = createJournal();
    let persistedAtRequestTime: unknown = "not called";
    server.reply(async () => {
      persistedAtRequestTime = persistedJournal(storage);
      return { commandId: "command-1" };
    });

    await journal.submit(releaseIntent);

    expect(persistedAtRequestTime).toMatchObject({
      schemaVersion: 1,
      actorId: "operator-a",
      environment: "https://admin.example.test",
      commandId: null,
      signature: "publish:release-1",
      idempotencyKey: "key-1",
    });
  });

  it("locks writes and reports the accepted command id", async () => {
    const { journal, server } = createJournal();
    server.resolveWith({ commandId: "command-1" });

    const outcome = await journal.submit(releaseIntent);

    expect(outcome).toMatchObject({
      kind: "accepted",
      command: { commandId: "command-1", action: "Release publish" },
    });
    expect(journal.getSnapshot()).toMatchObject({
      writesLocked: true,
      notice: { kind: "command_pending", commandId: "command-1" },
    });
  });

  // SPEC: 服务端说别的命令还活着时，本次提交改挂到那一条上，绝不再发第二条。
  it("attaches to the active command reported by a 409 conflict", async () => {
    const { journal, server, storage } = createJournal();
    server.rejectWith(
      new AdminV2RequestError("conflict", 409, "conflict", {
        activeCommandId: "command-other",
        activeCommandType: "character.release.publish",
      }),
    );

    const outcome = await journal.submit(releaseIntent);

    expect(outcome).toMatchObject({
      kind: "attached",
      command: { commandId: "command-other", action: "release publish" },
    });
    expect(journal.getSnapshot().writesLocked).toBe(true);
    expect(persistedJournal(storage)).toMatchObject({
      commandId: "command-other",
    });
  });

  // SPEC: 首发被服务端明确拒绝 = 这条命令确定没生效，日志作废、写入解锁、幂等键释放。
  it("unlocks writes and releases the idempotency key on a definitive rejection", async () => {
    const { journal, server, storage } = createJournal();
    server.rejectWith(new AdminV2RequestError("bad request", 400));

    const outcome = await journal.submit(releaseIntent);

    expect(outcome).toMatchObject({ kind: "rejected" });
    expect(journal.getSnapshot()).toMatchObject({
      command: null,
      notice: null,
      writesLocked: false,
    });
    expect(persistedJournal(storage)).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  // SPEC: 受理状态不明时日志必须留着，且幂等键不许换——重放要打在同一次写入上。
  it("keeps the journal and the same idempotency key when acceptance is unknown", async () => {
    const { journal, server, storage } = createJournal();
    server.rejectWith(new Error("network down"));

    const outcome = await journal.submit(releaseIntent);

    expect(outcome).toMatchObject({ kind: "unknown" });
    expect(journal.getSnapshot()).toMatchObject({
      writesLocked: true,
      notice: { kind: "command_submission_unknown" },
    });
    expect(persistedJournal(storage)).toMatchObject({
      commandId: null,
      idempotencyKey: "key-1",
    });

    server.resolveWith({ commandId: "command-1" });
    await journal.replay(journal.getSnapshot().command!);
    expect(server.calls.at(-1)?.options).toMatchObject({
      idempotencyKey: "key-1",
    });
  });

  it("refuses a second submission while a command is still locked", async () => {
    const { journal, server } = createJournal();
    server.resolveWith({ commandId: "command-1" });
    await journal.submit(releaseIntent);

    expect(journal.beginSubmission("second write")).toBe(false);
  });
});

describe("character command journal — 能不能重放", () => {
  async function unknownCommand(journal: CharacterCommandJournal, server: ReturnType<typeof fakeRequest>) {
    server.rejectWith(new Error("network down"));
    await journal.submit(releaseIntent);
    return journal.getSnapshot().command!;
  }

  it.each([
    [401, "blocked"],
    [403, "blocked"],
    [400, "reconcile"],
    [404, "reconcile"],
    [409, "reconcile"],
    [422, "reconcile"],
    [429, "retry"],
    [500, "retry"],
  ] as const)(
    "routes a replay rejected with %s to %s and never unlocks writes",
    async (status, expected) => {
      const { journal, server } = createJournal();
      const command = await unknownCommand(journal, server);

      server.rejectWith(new AdminV2RequestError("rejected", status));
      const outcome = await journal.replay(command);

      expect(outcome.kind).toBe(expected);
      // INVARIANT: 首发路径这些状态码全是 definitive rejection，重放路径一个都不许解锁。
      expect(journal.getSnapshot().writesLocked).toBe(true);
      expect(journal.getSnapshot().command).not.toBeNull();
    },
  );

  it("routes a replay failure without a status to retry", async () => {
    const { journal, server } = createJournal();
    const command = await unknownCommand(journal, server);

    server.rejectWith(new Error("still offline"));
    expect(await journal.replay(command)).toMatchObject({
      kind: "retry",
      retryInMs: 2_000,
    });
  });

  it("keeps waiting rather than giving up when replay authority is unavailable", async () => {
    const { journal, server } = createJournal();
    const command = await unknownCommand(journal, server);

    server.rejectWith(new AdminV2RequestError("forbidden", 403));
    expect(await journal.replay(command)).toMatchObject({
      kind: "blocked",
      retryInMs: 5_000,
    });
  });

  // SPEC: 自动重放窗口过期后不再自动发，改成要求运营重新确认。
  it("stops auto replay after the window expires and resumes only on explicit authorization", async () => {
    let clock = 1_000;
    const { journal, server } = createJournal({ now: () => clock });
    server.rejectWith(new Error("network down"));
    await journal.submit(releaseIntent);

    clock = 1_000 + 5 * 60_000 + 1;
    const expired = await journal.replay(journal.getSnapshot().command!);
    expect(expired).toEqual({ kind: "window_expired" });
    expect(journal.getSnapshot().notice).toMatchObject({
      kind: "command_reconfirmation_required",
    });
    expect(server.calls).toHaveLength(1);

    journal.authorizeReplay();
    server.resolveWith({ commandId: "command-1" });
    expect(await journal.replay(journal.getSnapshot().command!)).toMatchObject({
      kind: "accepted",
    });
    expect(server.calls).toHaveLength(2);
  });

  it("refuses to replay an incomplete journal and marks it terminal", async () => {
    const { journal, server } = createJournal();
    server.rejectWith(
      new AdminV2RequestError("conflict", 409, "conflict", {
        activeCommandId: "command-other",
      }),
    );
    await journal.submit(releaseIntent);
    // 从服务端权威挂上来的命令没有 endpoint/body，无法原样重放。
    const attached = { ...journal.getSnapshot().command!, commandId: null };

    expect(await journal.replay(attached)).toEqual({
      kind: "evidence_incomplete",
    });
  });

  it("always resumes known commands and bounds unknown command replay by the journal TTL", () => {
    expect(
      characterCommandJournalCanAutoReplay(
        { commandId: "command-1", createdAt: 1_000, autoReplayUntil: 2_000 },
        9_999_999,
      ),
    ).toBe(true);
    expect(
      characterCommandJournalCanAutoReplay(
        { commandId: null, createdAt: 1_000, autoReplayUntil: 2_000 },
        1_999,
      ),
    ).toBe(true);
    expect(
      characterCommandJournalCanAutoReplay(
        { commandId: null, createdAt: 1_000, autoReplayUntil: 2_000 },
        2_001,
      ),
    ).toBe(false);
  });

  // SPEC: 没写明过期时刻的日志，重放窗口从"命令创建时"起算 5 分钟，不是从"现在"起算。
  // INTENT: 从 now 起算等于每读一次就续一次命，一个受理状态不明的命令能被无限重放。
  it("bounds an unexpired journal from its creation time, not from now", () => {
    const command = { commandId: null, createdAt: 1_000 } as const;
    expect(characterCommandJournalCanAutoReplay(command, 301_000)).toBe(true);
    expect(characterCommandJournalCanAutoReplay(command, 301_001)).toBe(false);
  });
});

describe("character command journal — 命令回来了", () => {
  async function acceptedCommand() {
    const { journal, server, storage } = createJournal();
    server.resolveWith({ commandId: "command-1" });
    await journal.submit(releaseIntent);
    return { journal, server, storage, command: journal.getSnapshot().command! };
  }

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "reports %s as a settled terminal result and stops the recovery loop",
    async (status) => {
      const { journal, server, command } = await acceptedCommand();
      server.resolveWith({ commandId: "command-1", status });

      const outcome = await journal.pollStatus(command);

      expect(outcome).toMatchObject({
        kind: "settled",
        status,
        succeeded: status === "succeeded",
      });
      expect(journal.getSnapshot().command?.terminal).toBe(true);
    },
  );

  it("keeps polling while the command is still running", async () => {
    const { journal, server, command } = await acceptedCommand();
    server.resolveWith({ commandId: "command-1", status: "running" });

    expect(await journal.pollStatus(command)).toMatchObject({
      kind: "running",
      retryInMs: 1_000,
    });
    expect(journal.getSnapshot().command?.terminal).toBe(false);
  });

  it.each([
    [404, { kind: "evidence_missing" }],
    [403, { kind: "blocked", retryInMs: 5_000 }],
    [500, { kind: "unavailable", retryInMs: 1_000 }],
  ] as const)(
    "routes command evidence status %s without unlocking writes",
    async (status, expected) => {
      const { journal, server, command } = await acceptedCommand();
      server.rejectWith(new AdminV2RequestError("evidence", status));

      expect(await journal.pollStatus(command)).toMatchObject(expected);
      expect(journal.getSnapshot().writesLocked).toBe(true);
    },
  );

  it("asks for command evidence by the accepted command id", async () => {
    const { journal, server, command } = await acceptedCommand();
    server.resolveWith({ commandId: "command-1", status: "running" });
    await journal.pollStatus(command);

    expect(server.calls.at(-1)?.path).toBe("/api/v2/admin/commands/command-1");
  });

  // SPEC: 刚提交就刷新页面的场景要等满命令的最短受理窗口再去查。
  it("delays the first recovery poll by acceptance state", async () => {
    let clock = 1_000;
    const { journal, server } = createJournal({ now: () => clock });
    server.rejectWith(new Error("network down"));
    await journal.submit(releaseIntent);

    expect(journal.initialRecoveryDelayMs(journal.getSnapshot().command!)).toBe(
      1_500,
    );
    clock = 3_000;
    expect(journal.initialRecoveryDelayMs(journal.getSnapshot().command!)).toBe(
      250,
    );

    server.resolveWith({ commandId: "command-1" });
    await journal.replay(journal.getSnapshot().command!);
    expect(journal.initialRecoveryDelayMs(journal.getSnapshot().command!)).toBe(
      500,
    );
  });
});

describe("character command journal — 权威刷新与代际", () => {
  it("keeps command B visible, journaled, and write-locked when command A refresh resolves late", async () => {
    const { journal, server } = createJournal();
    server.resolveWith({ commandId: "command-a" });
    await journal.submit(releaseIntent);
    const refreshA = deferred<{ activeCommand: null }>();
    const cleanupA = vi.fn();

    const lateRefreshA = journal.refresh({
      load: () => refreshA.promise,
      onUnlock: cleanupA,
    });

    server.resolveWith({ commandId: "command-b" });
    await journal.submit({ ...releaseIntent, signature: "publish:release-2" });
    refreshA.resolve({ activeCommand: null });

    await expect(lateRefreshA).resolves.toMatchObject({ status: "superseded" });
    expect(cleanupA).not.toHaveBeenCalled();
    expect(journal.getSnapshot()).toMatchObject({
      command: { commandId: "command-b" },
      notice: { kind: "command_pending", commandId: "command-b" },
      writesLocked: true,
    });
  });

  it("runs terminal cleanup only after the authoritative refresh resolves", async () => {
    const { journal, server } = createJournal();
    server.resolveWith({ commandId: "command-terminal" });
    await journal.submit(releaseIntent);
    const command = journal.getSnapshot().command!;
    const refresh = deferred<{ activeCommand: null }>();
    const cleanup = vi.fn(() => journal.discard(command));

    const settling = journal.refresh({
      load: () => refresh.promise,
      onUnlock: cleanup,
    });
    expect(cleanup).not.toHaveBeenCalled();

    refresh.resolve({ activeCommand: null });
    await expect(settling).resolves.toMatchObject({ status: "unlocked" });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(journal.getSnapshot()).toMatchObject({
      command: null,
      notice: null,
      writesLocked: false,
    });
  });

  // SPEC: 权威投影里还有命令在跑，就把日志改挂到它上面，而不是留着调用方自己那条。
  it("re-attaches to the still-active server command instead of unlocking", async () => {
    const { journal, server } = createJournal();
    server.rejectWith(new Error("network down"));
    await journal.submit(releaseIntent);
    const cleanup = vi.fn();

    const result = await journal.refresh({
      load: async () => ({
        activeCommand: {
          commandId: "command-server",
          commandType: "character.serving.pause",
          status: "running",
          createdAt: new Date(2_000).toISOString(),
        } as never,
      }),
      onUnlock: cleanup,
    });

    expect(result.status).toBe("kept_locked");
    expect(cleanup).not.toHaveBeenCalled();
    expect(journal.getSnapshot()).toMatchObject({
      command: { commandId: "command-server", action: "serving pause" },
      writesLocked: true,
    });
  });

  it("rejects stale command cleanup by identity and keeps the current command locked", async () => {
    const { journal, server } = createJournal();
    server.resolveWith({ commandId: "command-a" });
    await journal.submit(releaseIntent);
    const commandA = journal.getSnapshot().command!;
    server.resolveWith({ commandId: "command-b" });
    await journal.submit({ ...releaseIntent, signature: "publish:release-2" });

    expect(journal.discard(commandA)).toBe(false);
    expect(journal.getSnapshot()).toMatchObject({
      command: { commandId: "command-b" },
      notice: { commandId: "command-b" },
      writesLocked: true,
    });
  });

  it("describes a committed write separately from an authoritative refresh failure", () => {
    expect(
      committedCharacterProjectionWarning(
        "Release publish",
        new Error("workspace unavailable"),
      ),
    ).toBe(
      "Release publish was committed, but the authoritative Character workspace could not be refreshed: workspace unavailable. Refresh the authoritative workspace before another write.",
    );
  });
});

describe("character command journal — 落盘身份", () => {
  // SPEC: 落盘的命令日志只对"同一套 schema、同一个人、同一个环境"有效。
  it("rejects persisted command journals from another schema, actor, or environment", () => {
    const journal = {
      schemaVersion: 1,
      actorId: "operator-1",
      environment: "https://admin.example.test",
      commandId: null,
      action: "Release publish",
      signature: "publish:release-1",
      endpoint:
        "/api/v2/admin/characters/character-1/releases/release-1/commands/publish",
      body: { entityVersion: 1 },
      idempotencyKey: "command-key-1",
      createdAt: 1_000,
    };
    const parse = (record: object) =>
      parsePendingCharacterCommandJournal(
        JSON.stringify(record),
        journal.actorId,
        journal.environment,
      );

    expect(parse(journal)).toMatchObject({ signature: "publish:release-1" });
    expect(parse({ ...journal, schemaVersion: 2 })).toBeNull();
    expect(parse({ ...journal, schemaVersion: undefined })).toBeNull();
    expect(parse({ ...journal, actorId: "operator-2" })).toBeNull();
    expect(parse({ ...journal, actorId: undefined })).toBeNull();
    expect(
      parse({ ...journal, environment: "https://staging.example.test" }),
    ).toBeNull();
    expect(parse({ ...journal, environment: undefined })).toBeNull();
  });

  it("rejects journals with missing or invalid creation authority instead of extending replay from now", () => {
    const validJournal = {
      schemaVersion: 1,
      actorId: "operator-1",
      environment: "https://admin.example.test",
      commandId: null,
      action: "Release publish",
      signature: "publish:release-1",
      endpoint:
        "/api/v2/admin/characters/character-1/releases/release-1/commands/publish",
      body: { entityVersion: 1 },
      idempotencyKey: "command-key-1",
      createdAt: 1_000,
      autoReplayUntil: 301_000,
    };

    expect(
      parsePendingCharacterCommandJournal(
        JSON.stringify(validJournal),
        validJournal.actorId,
        validJournal.environment,
      ),
    ).toMatchObject({ createdAt: 1_000, autoReplayUntil: 301_000 });

    for (const createdAt of [undefined, null, "now", 0, -1, Number.NaN]) {
      expect(
        parsePendingCharacterCommandJournal(
          JSON.stringify({ ...validJournal, createdAt }),
          validJournal.actorId,
          validJournal.environment,
        ),
      ).toBeNull();
    }
  });

  // SPEC: 只有本人本环境写的日志才能被恢复；别人的日志读不出来，也就重放不了。
  it("restores only the journal written by this actor in this environment", async () => {
    const storage = memoryStorage();
    const server = fakeRequest();
    server.rejectWith(new Error("network down"));
    const mine = createCharacterCommandJournal({
      actorId: "operator-a",
      characterId: "character-1",
      storage,
      environment: "https://admin.example.test",
      request: server.request,
    });
    await mine.submit(releaseIntent);

    const otherActor = createCharacterCommandJournal({
      actorId: "operator-b",
      characterId: "character-1",
      storage,
      environment: "https://admin.example.test",
      request: server.request,
    });
    const otherEnvironment = createCharacterCommandJournal({
      actorId: "operator-a",
      characterId: "character-1",
      storage,
      environment: "https://staging.example.test",
      request: server.request,
    });

    expect(otherActor.hasPersistedCommand()).toBe(false);
    expect(otherEnvironment.hasPersistedCommand()).toBe(false);
    expect(otherEnvironment.restore()).toBeNull();

    const resumed = createCharacterCommandJournal({
      actorId: "operator-a",
      characterId: "character-1",
      storage,
      environment: "https://admin.example.test",
      request: server.request,
    });
    expect(resumed.hasPersistedCommand()).toBe(true);
    expect(resumed.restore()).toMatchObject({ signature: "publish:release-1" });
    expect(resumed.getSnapshot().writesLocked).toBe(true);
  });

  it("keeps one durable command key per canonical signature and releases only that signature", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const journal = createCharacterCommandJournal({
      actorId: "operator-a",
      characterId: "character-1",
      storage,
      createIdempotencyKey: () => `key-${++sequence}`,
    });

    expect(journal.takeIdempotencyKey("publish:release-1")).toBe("key-1");
    expect(journal.takeIdempotencyKey("publish:release-1")).toBe("key-1");
    expect(journal.takeIdempotencyKey("rollback:release-0")).toBe("key-2");

    journal.releaseIdempotencyKey("publish:release-1");

    expect(journal.takeIdempotencyKey("rollback:release-0")).toBe("key-2");
    expect(journal.takeIdempotencyKey("publish:release-1")).toBe("key-3");
  });

  it("isolates durable command keys by actor for the same Character and signature", () => {
    const storage = memoryStorage();
    const operatorA = createCharacterCommandJournal({
      actorId: "operator-a",
      characterId: "character-1",
      storage,
      createIdempotencyKey: () => "operator-a-key",
    });
    const operatorB = createCharacterCommandJournal({
      actorId: "operator-b",
      characterId: "character-1",
      storage,
      createIdempotencyKey: () => "operator-b-key",
    });

    expect(operatorA.takeIdempotencyKey("publish:release-1")).toBe(
      "operator-a-key",
    );
    expect(operatorB.takeIdempotencyKey("publish:release-1")).toBe(
      "operator-b-key",
    );
    expect(storage.values.size).toBe(2);
  });

  it("fails closed without deadlocking when browser storage throws", () => {
    const journal = createCharacterCommandJournal({
      actorId: "operator-a",
      characterId: "character-1",
      storage: {
        getItem: () => {
          throw new Error("storage disabled");
        },
        setItem: () => {
          throw new Error("storage disabled");
        },
        removeItem: () => {
          throw new Error("storage disabled");
        },
      },
      createIdempotencyKey: () => "memory-key",
    });

    expect(journal.takeIdempotencyKey("publish:release-1")).toBe("memory-key");
    expect(() =>
      journal.releaseIdempotencyKey("publish:release-1"),
    ).not.toThrow();
    expect(journal.hasPersistedCommand()).toBe(false);
  });

  // SPEC: 换了一条命令，上一条的恢复旁注必须清零。
  // INTENT: 运营看着一条已经不存在的命令的告警去处理另一条命令，是这块最贵的误导。
  it("clears the recovery note whenever the journal moves to another command", async () => {
    const { journal, server } = createJournal();
    server.rejectWith(new Error("network down"));
    await journal.submit(releaseIntent);
    journal.setRecoveryError("acceptance is still unknown");
    expect(journal.getSnapshot().recoveryError).not.toBeNull();

    server.resolveWith({ commandId: "command-1" });
    await journal.replay(journal.getSnapshot().command!);

    expect(journal.getSnapshot().recoveryError).toBeNull();
  });

  it("notifies subscribers with a stable snapshot identity between changes", async () => {
    const { journal, server } = createJournal();
    const listener = vi.fn();
    journal.subscribe(listener);
    const before = journal.getSnapshot();

    expect(journal.getSnapshot()).toBe(before);
    server.resolveWith({ commandId: "command-1" });
    await journal.submit(releaseIntent);

    expect(listener).toHaveBeenCalled();
    expect(journal.getSnapshot()).not.toBe(before);
    expect(journal.getSnapshot()).toBe(journal.getSnapshot());
  });
});
