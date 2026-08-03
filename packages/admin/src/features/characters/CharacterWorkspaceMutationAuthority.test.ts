import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  characterCommandReplayFailureDisposition,
  characterCommandJournalCanAutoReplay,
  commandIdempotencyStorageKey,
  committedCharacterProjectionWarning,
  createCharacterMutationAuthorityCoordinator,
  getOrCreateCharacterCommandIdempotencyKey,
  parsePendingCharacterCommandJournal,
  pendingCommandStorageKey,
  releaseCharacterCommandIdempotencyKey,
} from "./CharacterWorkspace";

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

function expectSourceOrder(source: string, before: string, after: string) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  expect(beforeIndex, `missing source marker: ${before}`).toBeGreaterThan(-1);
  expect(afterIndex, `missing source marker: ${after}`).toBeGreaterThan(-1);
  expect(beforeIndex).toBeLessThan(afterIndex);
}

describe("Character workspace mutation authority", () => {
  it("keeps command B visible, journaled, and write-locked when command A refresh resolves late", async () => {
    const coordinator = createCharacterMutationAuthorityCoordinator();
    const commandA = {
      commandId: "command-a",
      action: "Publish release A",
      signature: "publish:release-a",
      createdAt: 1_000,
      terminal: false,
    } as const;
    const commandB = {
      commandId: "command-b",
      action: "Publish release B",
      signature: "publish:release-b",
      createdAt: 2_000,
      terminal: false,
    } as const;
    const refreshA = deferred<{ activeCommand: null }>();
    const cleanupA = vi.fn();

    coordinator.rememberCommand(commandA, {
      kind: "command_pending",
      message: "Publish release A is pending",
      commandId: commandA.commandId,
    });
    const lateRefreshA = coordinator.refresh({
      load: () => refreshA.promise,
      canUnlock: (workspace) => workspace.activeCommand === null,
      onUnlock: cleanupA,
    });

    coordinator.rememberCommand(commandB, {
      kind: "command_pending",
      message: "Publish release B is pending",
      commandId: commandB.commandId,
    });
    refreshA.resolve({ activeCommand: null });

    await expect(lateRefreshA).resolves.toMatchObject({ status: "superseded" });
    expect(cleanupA).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      journal: commandB,
      notice: {
        kind: "command_pending",
        commandId: commandB.commandId,
      },
      writesLocked: true,
    });
  });

  it.each([
    [401, "keep_locked"],
    [403, "keep_locked"],
    [400, "reconcile"],
    [404, "reconcile"],
    [409, "reconcile"],
    [422, "reconcile"],
    [429, "retry"],
    [500, "retry"],
    [null, "retry"],
  ] as const)(
    "classifies unknown command replay status %s as %s",
    (status, expected) => {
      expect(characterCommandReplayFailureDisposition(status)).toBe(expected);
    },
  );

  it("always resumes known commands and bounds unknown command replay by the journal TTL", () => {
    expect(characterCommandJournalCanAutoReplay({
      commandId: "command-1",
      createdAt: 1_000,
      autoReplayUntil: 2_000,
    }, 9_999_999)).toBe(true);
    expect(characterCommandJournalCanAutoReplay({
      commandId: null,
      createdAt: 1_000,
      autoReplayUntil: 2_000,
    }, 1_999)).toBe(true);
    expect(characterCommandJournalCanAutoReplay({
      commandId: null,
      createdAt: 1_000,
      autoReplayUntil: 2_000,
    }, 2_001)).toBe(false);
    expect(characterCommandJournalCanAutoReplay({
      commandId: null,
      createdAt: 1_000,
    }, 301_000)).toBe(true);
    expect(characterCommandJournalCanAutoReplay({
      commandId: null,
      createdAt: 1_000,
    }, 301_001)).toBe(false);
  });

  // SPEC: 落盘的命令日志只对"同一套 schema、同一个人、同一个环境"有效。
  // INTENT: 这三条曾经靠断言 CharacterWorkspace.tsx 的源码文本来守。日志的读侧是导出的，
  //         直接喂它就能验——写侧只要少盖任一枚戳，读侧就会拒绝自己写的日志。
  it("rejects persisted command journals from another schema, actor, or environment", () => {
    const journal = {
      schemaVersion: 1,
      actorId: "operator-1",
      environment: "https://admin.example.test",
      commandId: null,
      action: "Release publish",
      signature: "publish:release-1",
      endpoint: "/api/v2/admin/characters/character-1/releases/release-1/commands/publish",
      body: { entityVersion: 1 },
      idempotencyKey: "command-key-1",
      createdAt: 1_000,
    };
    const parse = (record: object) => parsePendingCharacterCommandJournal(
      JSON.stringify(record),
      journal.actorId,
      journal.environment,
    );

    expect(parse(journal)).toMatchObject({ signature: "publish:release-1" });
    expect(parse({ ...journal, schemaVersion: 2 })).toBeNull();
    expect(parse({ ...journal, schemaVersion: undefined })).toBeNull();
    expect(parse({ ...journal, actorId: "operator-2" })).toBeNull();
    expect(parse({ ...journal, actorId: undefined })).toBeNull();
    expect(parse({ ...journal, environment: "https://staging.example.test" })).toBeNull();
    expect(parse({ ...journal, environment: undefined })).toBeNull();
  });

  // SPEC: 没写明过期时刻的日志，重放窗口从"命令创建时"起算 5 分钟，不是从"现在"起算。
  // INTENT: 从 now 起算等于每读一次就续一次命，一个受理状态不明的命令能被无限重放。
  it("bounds an unexpired journal from its creation time, not from now", () => {
    const command = { commandId: null, createdAt: 1_000 } as const;
    expect(characterCommandJournalCanAutoReplay(command, 301_000)).toBe(true);
    expect(characterCommandJournalCanAutoReplay(command, 301_001)).toBe(false);
    // 显式过期时刻优先于默认窗口。
    expect(characterCommandJournalCanAutoReplay(
      { ...command, autoReplayUntil: 2_000 },
      2_001,
    )).toBe(false);
    // 已知 commandId 的命令不受重放窗口限制——它的受理状态是可查的。
    expect(characterCommandJournalCanAutoReplay(
      { commandId: "command-1", createdAt: 1_000 },
      Number.MAX_SAFE_INTEGER,
    )).toBe(true);
  });

  it("rejects journals with missing or invalid creation authority instead of extending replay from now", () => {
    const validJournal = {
      schemaVersion: 1,
      actorId: "operator-1",
      environment: "https://admin.example.test",
      commandId: null,
      action: "Release publish",
      signature: "publish:release-1",
      endpoint: "/api/v2/admin/characters/character-1/releases/release-1/commands/publish",
      body: { entityVersion: 1 },
      idempotencyKey: "command-key-1",
      createdAt: 1_000,
      autoReplayUntil: 301_000,
    };

    expect(parsePendingCharacterCommandJournal(
      JSON.stringify(validJournal),
      validJournal.actorId,
      validJournal.environment,
    )).toMatchObject({
      createdAt: 1_000,
      autoReplayUntil: 301_000,
    });

    for (const createdAt of [undefined, null, "now", 0, -1, Number.NaN]) {
      expect(parsePendingCharacterCommandJournal(
        JSON.stringify({ ...validJournal, createdAt }),
        validJournal.actorId,
        validJournal.environment,
      )).toBeNull();
    }

    // INTENT: 这里原本还断言解析器源码里没有 "Date.now()"。上面这段已经证明了同一件事：
    //         createdAt 不可信就整条作废，而不是拿当前时间给它续一个新的重放窗口。
  });

  it("keeps one durable command key per canonical signature and releases only that signature", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const createKey = () => `key-${++sequence}`;

    expect(getOrCreateCharacterCommandIdempotencyKey(
      storage,
      "operator-a",
      "character-1",
      "publish:release-1",
      createKey,
    )).toBe("key-1");
    expect(getOrCreateCharacterCommandIdempotencyKey(
      storage,
      "operator-a",
      "character-1",
      "publish:release-1",
      createKey,
    )).toBe("key-1");
    expect(getOrCreateCharacterCommandIdempotencyKey(
      storage,
      "operator-a",
      "character-1",
      "rollback:release-0",
      createKey,
    )).toBe("key-2");

    releaseCharacterCommandIdempotencyKey(
      storage,
      "operator-a",
      "character-1",
      "publish:release-1",
    );

    expect(getOrCreateCharacterCommandIdempotencyKey(
      storage,
      "operator-a",
      "character-1",
      "rollback:release-0",
      createKey,
    )).toBe("key-2");
    expect(getOrCreateCharacterCommandIdempotencyKey(
      storage,
      "operator-a",
      "character-1",
      "publish:release-1",
      createKey,
    )).toBe("key-3");
  });

  it("isolates durable command keys by actor for the same Character and signature", () => {
    const storage = memoryStorage();
    expect(getOrCreateCharacterCommandIdempotencyKey(
      storage,
      "operator-a",
      "character-1",
      "publish:release-1",
      () => "operator-a-key",
    )).toBe("operator-a-key");
    expect(getOrCreateCharacterCommandIdempotencyKey(
      storage,
      "operator-b",
      "character-1",
      "publish:release-1",
      () => "operator-b-key",
    )).toBe("operator-b-key");
    expect(storage.values.size).toBe(2);
    expect(commandIdempotencyStorageKey(
      "operator-a",
      "character-1",
    )).not.toBe(commandIdempotencyStorageKey(
      "operator-b",
      "character-1",
    ));
    expect(pendingCommandStorageKey(
      "operator-a",
      "character-1",
    )).not.toBe(pendingCommandStorageKey(
      "operator-b",
      "character-1",
    ));
  });

  it("fails closed without deadlocking when browser storage throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {
        throw new Error("storage disabled");
      },
    };

    expect(getOrCreateCharacterCommandIdempotencyKey(
      storage,
      "operator-a",
      "character-1",
      "publish:release-1",
      () => "memory-key",
    )).toBe("memory-key");
    expect(() => releaseCharacterCommandIdempotencyKey(
      storage,
      "operator-a",
      "character-1",
      "publish:release-1",
    )).not.toThrow();
  });

  it("describes a committed write separately from an authoritative refresh failure", () => {
    expect(committedCharacterProjectionWarning(
      "Release publish",
      new Error("workspace unavailable"),
    )).toBe(
      "Release publish was committed, but the authoritative Character workspace could not be refreshed: workspace unavailable. Refresh the authoritative workspace before another write.",
    );
  });

  // SPEC: 命令必须先落盘再发出；只有"服务端明确拒绝"才解锁写入。
  // INTENT: 保留源码断言是有意的——这两条提交流程都关在 ReleasePanel / CharacterDetail
  //         内部，没有导出的接缝，而它守的是一条安全不变量："先发后记"会在断网时留下
  //         一个既没记录、又可能已生效的写入。挂载整个 CharacterWorkspace 详情页来打这条
  //         成本远高于收益，所以这里明说：锁的是顺序与解锁条件，不是措辞。
  //         下面刻意只比较顺序与关键调用，不比较缩进与行内文本。
  it("persists command intent before POST and only unlocks on a definitive rejection", () => {
    const source = readFileSync(new URL("./CharacterWorkspace.tsx", import.meta.url), "utf8");
    const releaseCommand = source.slice(
      source.indexOf("const command = async"),
      source.indexOf("const rollbackSourceId"),
    );
    const servingCommand = source.slice(
      source.indexOf("const servingCommand = async"),
      source.indexOf("return (", source.indexOf("const servingCommand = async")),
    );

    for (const flow of [releaseCommand, servingCommand]) {
      expectSourceOrder(
        flow,
        "rememberPendingCommand(submission)",
        "await adminV2Request(endpoint",
      );
      expect(flow).toContain("isDefinitiveCommandRejection(cause)");
      expect(flow).toContain("discardPendingCommand(submission)");
      // INVARIANT: 不得有"无条件中止并报错"的分支——受理状态不明时必须保持写入锁定。
      expect(flow).not.toMatch(/abortCommandSubmission\(\);\s*setError/);
    }
  });

  // SPEC: 命令恢复与轮询归 CharacterDetail，ReleasePanel 不碰命令状态接口。
  // INTENT: 同上，保留源码断言。这条守的是作用域划分——ReleasePanel 会随投影刷新反复
  //         重建，把恢复逻辑放进去等于每刷一次就重放一次命令。没有导出接缝能表达
  //         "这段代码不在那个组件里"。
  it("recovers and polls commands at CharacterDetail scope, independent of ReleasePanel data", () => {
    const source = readFileSync(new URL("./CharacterWorkspace.tsx", import.meta.url), "utf8");
    const releasePanel = source.slice(
      source.indexOf("function ReleasePanel"),
      source.indexOf("function CharacterDetail"),
    );
    const characterDetail = source.slice(
      source.indexOf("function CharacterDetail"),
      source.indexOf("export function CharacterWorkspace"),
    );

    expect(releasePanel).not.toContain("/api/v2/admin/commands/");
    expect(characterDetail).toContain("rememberPendingCommand(pending)");
    expect(characterDetail).toContain("await adminV2Request(pendingCommand.endpoint");
    expect(characterDetail).toContain("/api/v2/admin/commands/");
    expectSourceOrder(
      characterDetail,
      "/api/v2/admin/commands/",
      'if (!permissions.read) return permissionDenied',
    );
    expect(characterDetail).toContain('window.addEventListener("storage", onStorage)');
  });

  it("runs terminal cleanup only after the authoritative refresh resolves", async () => {
    const coordinator = createCharacterMutationAuthorityCoordinator();
    const command = {
      commandId: "command-terminal",
      action: "Publish release",
      signature: "publish:release-terminal",
      createdAt: 1_000,
      terminal: true,
    } as const;
    const refresh = deferred<{ activeCommand: null }>();
    const cleanup = vi.fn(() => coordinator.clearCommand(command));
    coordinator.rememberCommand(command, {
      kind: "command_pending",
      message: "Publish release is pending",
      commandId: command.commandId,
    });

    const settling = coordinator.refresh({
      load: () => refresh.promise,
      canUnlock: (workspace) => workspace.activeCommand === null,
      onUnlock: cleanup,
    });
    expect(cleanup).not.toHaveBeenCalled();

    refresh.resolve({ activeCommand: null });
    await expect(settling).resolves.toMatchObject({ status: "unlocked" });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot()).toMatchObject({
      journal: null,
      notice: null,
      writesLocked: false,
    });
  });

  it("rejects stale command cleanup by identity and keeps the current command locked", () => {
    const coordinator = createCharacterMutationAuthorityCoordinator();
    const commandA = {
      commandId: "command-a",
      action: "Publish release A",
      signature: "publish:release-a",
      createdAt: 1_000,
      terminal: true,
    } as const;
    const commandB = {
      commandId: "command-b",
      action: "Publish release B",
      signature: "publish:release-b",
      createdAt: 2_000,
      terminal: false,
    } as const;
    coordinator.rememberCommand(commandA, {
      kind: "command_pending",
      message: "Publish release A is pending",
      commandId: commandA.commandId,
    });
    coordinator.rememberCommand(commandB, {
      kind: "command_pending",
      message: "Publish release B is pending",
      commandId: commandB.commandId,
    });

    expect(coordinator.clearCommand(commandA)).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({
      journal: commandB,
      notice: { commandId: commandB.commandId },
      writesLocked: true,
    });
  });

  // SPEC: 受理状态未知的命令，任何情况下都不许直接解锁写入。
  // INTENT: 保留源码断言。这是这一屏最硬的一条安全不变量：解锁意味着允许第二次写入，
  //         而"上一次到底生效没有"此刻并不知道。recoverPendingCommand 是 useCallback
  //         闭包，没有导出接缝；能表达"这条路径里不存在 discardPendingCommand"的，
  //         目前只有源码断言。
  it("never unlocks an unknown command directly when replay authority is unavailable or ambiguous", () => {
    const source = readFileSync(new URL("./CharacterWorkspace.tsx", import.meta.url), "utf8");
    const recoveryStart = source.indexOf("const recoverPendingCommand = useCallback");
    const recovery = source.slice(
      recoveryStart,
      source.indexOf("try {\n        const status", recoveryStart),
    );

    expect(recoveryStart).toBeGreaterThan(-1);
    expect(recovery).toContain("characterCommandReplayFailureDisposition(");
    expect(recovery).toContain('replayDisposition === "keep_locked"');
    expect(recovery).toContain("acceptance cannot be proven with the current session or permissions");
    expect(recovery).toContain("Character writes remain locked");
    // SPEC: 受理状态未知时只能继续等待重试，不能放弃——所以这里必须返回一个重试间隔。
    expect(recovery).toContain("return 5_000;");
    expect(recovery).toContain('replayDisposition === "reconcile"');
    expect(recovery).toContain("await reconcilePendingCommandAuthority(");
    expect(recovery).not.toContain("discardPendingCommand(pendingCommand)");
  });
});
