import { lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CompanionWorkspaceRebuildFence,
} from "@idream/shared/chat/companion-runtime";
import type { CompanionInvocation } from "./contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttemptWorkspaceStore,
  relationshipWorkspacePath,
} from "./workspace";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function invocation(memoryMode: "normal" | "private"): CompanionInvocation {
  return {
    invocationId: `invocation-${memoryMode}`,
    attemptId: `attempt-${memoryMode}`,
    sessionId: "session-1",
    userId: "user-1",
    characterId: "character-1",
    memoryMode,
    expectedProfileDigest: "d".repeat(64),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    preparedTurn: {
      version: 3,
      model: "model-1",
      characterName: "Mira",
      messages: [{
        id: "user-message-1",
        sourceKind: "current_user",
        role: "user",
        content: "Remember this view.",
      }],
      tools: [],
      profile: {
        tier: "free",
        adapter: "openai-compatible-v1",
        provider: "local",
        baseUrl: "http://127.0.0.1:8061/v1",
        model: "model-1",
        supportsTools: true,
        maxOutputTokens: 100,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      budget: { maxInputTokens: 2_000, usedInputTokens: 100, dropped: [] },
      trace: {
        characterContentVersionId: "content-1",
        characterReleaseId: "release-1",
        soulFingerprint: "a".repeat(64),
        compilerVersion: "soul-v1",
        sceneVersion: 1,
        contextRevision: "1",
      },
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chat-workspace-"));
  temporary.push(root);
  const canonicalRoot = join(root, "canonical");
  const privateRoot = join(root, "private");
  return {
    root,
    canonicalRoot,
    privateRoot,
    store: new AttemptWorkspaceStore({ canonicalRoot, privateRoot }),
  };
}

function fence(authorityVersion: string): CompanionWorkspaceRebuildFence {
  return {
    mutationId: `mutation-${authorityVersion}`,
    claimToken: authorityVersion === "1"
      ? "11111111-1111-4111-8111-111111111111"
      : authorityVersion === "2"
        ? "22222222-2222-4222-8222-222222222222"
        : "33333333-3333-4333-8333-333333333333",
    authorityVersion,
  };
}

async function rebuildRelationship(
  store: AttemptWorkspaceStore,
  identity: { userId: string; characterId: string },
  build: (workspace: string) => Promise<void>,
): Promise<void> {
  const rebuildFence = fence("1");
  const candidate = await store.prepareRelationshipRebuild(
    identity,
    rebuildFence,
    async (workspace) => {
      await build(workspace);
      return { sessions: 1, messages: 1 };
    },
  );
  await store.promoteRelationshipRebuild({
    ...identity,
    rebuildId: candidate.rebuildId,
    fence: rebuildFence,
  });
}

describe("Chat companion workspace", () => {
  it("uses an ephemeral private workspace and removes it after the turn", async () => {
    const { store, privateRoot } = await fixture();
    const workspace = await store.prepare(invocation("private"));

    expect(workspace.mode).toBe("private");
    expect(workspace.path.startsWith(privateRoot)).toBe(true);
    expect((await stat(workspace.path)).mode & 0o777).toBe(0o700);

    await workspace.discard();
    await expect(lstat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies canonical memory into a disposable normal attempt", async () => {
    const { store, canonicalRoot } = await fixture();
    const identity = { userId: "user-1", characterId: "character-1" };
    await rebuildRelationship(store, identity, async (workspace) => {
      await writeFile(join(workspace, ".igrep", "memory.txt"), "canonical-memory");
    });

    const workspace = await store.prepare(invocation("normal"));
    expect(workspace.mode).toBe("normal");
    expect(await readFile(join(workspace.path, ".igrep", "memory.txt"), "utf8"))
      .toBe("canonical-memory");
    await writeFile(join(workspace.path, ".igrep", "attempt-only.txt"), "discard me");
    await workspace.discard();

    const relationship = relationshipWorkspacePath(canonicalRoot, "user-1", "character-1");
    const canonical = await lstat(join(relationship, ".igrep"));
    expect(canonical.isSymbolicLink()).toBe(true);
    await expect(readFile(join(relationship, ".igrep", "attempt-only.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not lock a normal turn behind an asynchronous projection build", async () => {
    const { store } = await fixture();
    const identity = { userId: "user-1", characterId: "character-1" };
    const buildStarted = Promise.withResolvers<void>();
    const releaseBuild = Promise.withResolvers<void>();
    const preparing = store.prepareRelationshipRebuild(
      identity,
      fence("1"),
      async (workspace) => {
        buildStarted.resolve();
        await releaseBuild.promise;
        await writeFile(join(workspace, ".igrep", "projection.txt"), "projected");
        return { sessions: 1, messages: 2 };
      },
    );
    await buildStarted.promise;

    const attempt = await Promise.race([
      store.prepare(invocation("normal")),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("normal turn waited for projection")), 500)),
    ]);
    await attempt.discard();

    releaseBuild.resolve();
    const prepared = await preparing;
    await store.discardRelationshipRebuild({
      ...identity,
      rebuildId: prepared.rebuildId,
      fence: fence("1"),
    });
  });

  it("does not let an active normal attempt block projection promotion", async () => {
    const { store } = await fixture();
    const identity = { userId: "user-1", characterId: "character-1" };
    const rebuildFence = fence("1");
    const prepared = await store.prepareRelationshipRebuild(
      identity,
      rebuildFence,
      async (workspace) => {
        await writeFile(join(workspace, ".igrep", "projection.txt"), "projected");
        return { sessions: 1, messages: 2 };
      },
    );
    const attempt = await store.prepare(invocation("normal"));

    await expect(Promise.race([
      store.promoteRelationshipRebuild({
        ...identity,
        rebuildId: prepared.rebuildId,
        fence: rebuildFence,
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("projection waited for active turn")), 100)),
    ])).resolves.toEqual({ sessions: 1, messages: 2 });

    await attempt.discard();
  });

  it("prepares privately, promotes by monotonic Main authority, and converges stale promotion", async () => {
    const { store, canonicalRoot } = await fixture();
    const identity = { userId: "user-1", characterId: "character-1" };
    const firstFence = fence("1");
    const first = await store.prepareRelationshipRebuild(
      identity,
      firstFence,
      async (workspace) => {
        await writeFile(join(workspace, ".igrep", "projection.txt"), "v1");
        return { sessions: 1, messages: 2 };
      },
    );

    expect(await store.promoteRelationshipRebuild({
      ...identity,
      rebuildId: first.rebuildId,
      fence: firstFence,
    })).toEqual({ sessions: 1, messages: 2 });
    const relationship = relationshipWorkspacePath(canonicalRoot, identity.userId, identity.characterId);
    expect(await readFile(join(relationship, ".igrep", "projection.txt"), "utf8")).toBe("v1");

    const secondFence = fence("2");
    const second = await store.prepareRelationshipRebuild(
      identity,
      secondFence,
      async (workspace) => {
        await writeFile(join(workspace, ".igrep", "projection.txt"), "v2");
        return { sessions: 2, messages: 4 };
      },
    );
    await store.promoteRelationshipRebuild({
      ...identity,
      rebuildId: second.rebuildId,
      fence: secondFence,
    });
    expect(await readFile(join(relationship, ".igrep", "projection.txt"), "utf8")).toBe("v2");

    const stale = await store.prepareRelationshipRebuild(
      identity,
      firstFence,
      async (workspace) => {
        await writeFile(join(workspace, ".igrep", "projection.txt"), "stale");
        return { sessions: 1, messages: 2 };
      },
    );
    await expect(store.promoteRelationshipRebuild({
      ...identity,
      rebuildId: stale.rebuildId,
      fence: firstFence,
    })).resolves.toEqual({ sessions: 1, messages: 2, superseded: true });
    expect(await readFile(join(relationship, ".igrep", "projection.txt"), "utf8")).toBe("v2");
  });

  it("purges one relationship without touching another user relationship", async () => {
    const { store, canonicalRoot } = await fixture();
    for (const identity of [
      { userId: "user-1", characterId: "character-1" },
      { userId: "user-2", characterId: "character-1" },
    ]) {
      await rebuildRelationship(store, identity, async (workspace) => {
        await writeFile(join(workspace, ".igrep", "memory.txt"), identity.userId);
      });
    }

    await expect(store.purge({
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
    })).resolves.toBe(1);
    await expect(lstat(relationshipWorkspacePath(canonicalRoot, "user-1", "character-1")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(
      relationshipWorkspacePath(canonicalRoot, "user-2", "character-1"),
      ".igrep",
      "memory.txt",
    ), "utf8")).toBe("user-2");
  });

  it("fences rebuild preparation and promotion after a user purge", async () => {
    const { store, canonicalRoot } = await fixture();
    const identity = { userId: "user-1", characterId: "character-1" };
    const rebuildFence = fence("1");
    const buildStarted = Promise.withResolvers<void>();
    const releaseBuild = Promise.withResolvers<void>();
    const preparing = store.prepareRelationshipRebuild(
      identity,
      rebuildFence,
      async (workspace) => {
        buildStarted.resolve();
        await releaseBuild.promise;
        await writeFile(join(workspace, ".igrep", "projection.txt"), "must be purged");
        return { sessions: 1, messages: 2 };
      },
    );
    await buildStarted.promise;

    const purging = store.purge({ scope: "user", userId: identity.userId });
    await new Promise((resolve) => setImmediate(resolve));
    releaseBuild.resolve();
    const [prepared] = await Promise.all([preparing, purging]);

    await expect(store.promoteRelationshipRebuild({
      ...identity,
      rebuildId: prepared.rebuildId,
      fence: rebuildFence,
    })).rejects.toThrow(/deleted user/);
    await expect(store.prepareRelationshipRebuild(
      identity,
      fence("2"),
      async () => ({ sessions: 0, messages: 0 }),
    )).rejects.toThrow(/deleted user/);
    await expect(lstat(relationshipWorkspacePath(
      canonicalRoot,
      identity.userId,
      identity.characterId,
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
