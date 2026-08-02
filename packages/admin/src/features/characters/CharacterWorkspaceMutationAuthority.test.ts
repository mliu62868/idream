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

  it("pins persisted command journals to schema, actor, environment, and replay expiry", () => {
    const source = readFileSync(new URL("./CharacterWorkspace.tsx", import.meta.url), "utf8");

    expect(source).toContain("const CHARACTER_COMMAND_JOURNAL_SCHEMA_VERSION = 1");
    expect(source).toContain("const UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS = 5 * 60_000");
    expect(source).toContain("record.schemaVersion !== CHARACTER_COMMAND_JOURNAL_SCHEMA_VERSION");
    expect(source).toContain("record.actorId !== actorId");
    expect(source).toContain("record.environment !== environment");
    expect(source).toContain("schemaVersion: CHARACTER_COMMAND_JOURNAL_SCHEMA_VERSION");
    expect(source).toContain("actorId,\n        environment: browserCommandEnvironment()");
    expect(source).toContain("environment: browserCommandEnvironment()");
    expect(source).toMatch(
      /autoReplayUntil:\s*command\.autoReplayUntil/,
    );
    expect(source).toMatch(
      /\?\?\s*command\.createdAt \+ UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS/,
    );
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

    const source = readFileSync(new URL("./CharacterWorkspace.tsx", import.meta.url), "utf8");
    const parser = source.slice(
      source.indexOf("export function parsePendingCharacterCommandJournal"),
      source.indexOf("function readPendingCharacterCommand"),
    );
    expect(parser).not.toContain("Date.now()");
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
      expect(flow).not.toContain("abortCommandSubmission();\n      setError");
    }
  });

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
