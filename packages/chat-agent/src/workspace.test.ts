import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  releasedKnowledgeDigest,
  type CompanionInvocation,
} from "@idream/shared/chat/companion-runtime";
import {
  AttemptWorkspaceStore,
  memoryCutoverMarkerPath,
  relationshipWorkspacePath,
  userWorkspacePath,
} from "./workspace";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

function invocation(memoryMode: "normal" | "private"): CompanionInvocation {
  const authority = {
    characterId: "character-1",
    characterContentVersionId: "content-1",
    characterReleaseId: "release-1",
    files: [] as [],
  };
  const releasedKnowledge = {
    ...authority,
    digest: releasedKnowledgeDigest(authority),
  };
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
      version: 2,
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
        timeout: { firstTokenMs: 1_000, idleMs: 1_000, completionMs: 2_000 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
          structuredTemperature: 0.2,
        },
      },
      budget: { maxInputTokens: 2_000, usedInputTokens: 100, dropped: [] },
      releasedKnowledge,
      trace: {
        characterContentVersionId: "content-1",
        characterReleaseId: "release-1",
        soulFingerprint: "soul-1",
        compilerVersion: "soul-v1",
        sceneVersion: 1,
        relationshipVersion: 1,
        fileContextRevision: "1",
        releasedKnowledgeDigest: releasedKnowledge.digest,
      },
    },
  };
}

function store(
  root: string,
  memoryProbe = { status: async () => ({ dialogueFiles: 0 }) },
) {
  return new AttemptWorkspaceStore({
    canonicalRoot: join(root, "canonical"),
    privateRoot: join(root, "private"),
    verificationPollMs: 1,
    memoryProbe,
  });
}

describe("DSH workspace authority", () => {
  it("prepares a fenced rebuild without promotion, then promotes it idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-workspace-fenced-rebuild-"));
    temporary.push(root);
    const workspaces = store(root);
    const identity = { userId: "user-1", characterId: "character-1" };
    await workspaces.rebuildRelationship(identity, async (workspace) => {
      for (const path of [
        join(root, "canonical"),
        userWorkspacePath(join(root, "canonical"), identity.userId),
        relationshipWorkspacePath(
          join(root, "canonical"),
          identity.userId,
          identity.characterId,
        ),
        dirname(dirname(workspace)),
        dirname(workspace),
        workspace,
        join(workspace, ".igrep"),
      ]) {
        expect((await stat(path)).mode & 0o777).toBe(0o700);
      }
      await writeFile(join(workspace, ".igrep", "old.txt"), "old");
    });
    const fence = {
      mutationId: "filemut-1",
      claimToken: "11111111-1111-4111-8111-111111111111",
      authorityVersion: "7",
    };

    const prepared = await workspaces.prepareRelationshipRebuild(
      identity,
      fence,
      async (workspace) => {
        await writeFile(join(workspace, ".igrep", "new.txt"), "new");
        return { sessions: 2, messages: 4 };
      },
    );
    const relationship = relationshipWorkspacePath(
      join(root, "canonical"),
      identity.userId,
      identity.characterId,
    );
    expect(await readFile(join(await realpath(join(relationship, ".igrep")), "old.txt"), "utf8"))
      .toBe("old");
    expect((await stat(join(
      relationship,
      ".rebuild-candidates",
      prepared.rebuildId,
      "manifest.json",
    ))).mode & 0o777).toBe(0o600);

    await expect(workspaces.promoteRelationshipRebuild({
      ...identity,
      rebuildId: prepared.rebuildId,
      fence,
    })).resolves.toEqual({ sessions: 2, messages: 4 });
    expect(await readFile(join(await realpath(join(relationship, ".igrep")), "new.txt"), "utf8"))
      .toBe("new");

    const replay = await workspaces.prepareRelationshipRebuild(
      identity,
      { ...fence, claimToken: "22222222-2222-4222-8222-222222222222" },
      async (workspace) => {
        await writeFile(join(workspace, ".igrep", "must-not-win.txt"), "stale retry");
        return { sessions: 2, messages: 4 };
      },
    );
    await expect(workspaces.promoteRelationshipRebuild({
      ...identity,
      rebuildId: replay.rebuildId,
      fence: { ...fence, claimToken: "22222222-2222-4222-8222-222222222222" },
    })).resolves.toEqual({ sessions: 2, messages: 4 });
    await expect(readFile(
      join(await realpath(join(relationship, ".igrep")), "must-not-win.txt"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });

    const staleFence = {
      mutationId: "filemut-stale",
      claimToken: "33333333-3333-4333-8333-333333333333",
      authorityVersion: "6",
    };
    const stale = await workspaces.prepareRelationshipRebuild(
      identity,
      staleFence,
      async (workspace) => {
        await writeFile(join(workspace, ".igrep", "stale.txt"), "stale");
        return { sessions: 1, messages: 2 };
      },
    );
    await expect(workspaces.promoteRelationshipRebuild({
      ...identity,
      rebuildId: stale.rebuildId,
      fence: staleFence,
    })).rejects.toThrow(/authority is stale/);
  });

  it("cancels a queued fenced promotion before any pointer swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-workspace-abort-promotion-"));
    temporary.push(root);
    const workspaces = store(root);
    const identity = { userId: "user-1", characterId: "character-1" };
    await workspaces.rebuildRelationship(identity, async (workspace) => {
      await writeFile(join(workspace, ".igrep", "old.txt"), "old");
    });
    const fence = {
      mutationId: "filemut-abort",
      claimToken: "44444444-4444-4444-8444-444444444444",
      authorityVersion: "8",
    };
    const prepared = await workspaces.prepareRelationshipRebuild(
      identity,
      fence,
      async (workspace) => {
        await writeFile(join(workspace, ".igrep", "must-not-promote.txt"), "new");
        return { sessions: 1, messages: 2 };
      },
    );
    const attempt = await workspaces.prepare(invocation("normal"));
    const controller = new AbortController();
    const promotion = workspaces.promoteRelationshipRebuild({
      ...identity,
      rebuildId: prepared.rebuildId,
      fence,
    }, controller.signal);
    const rejected = expect(promotion).rejects.toThrow(/promotion deadline elapsed/);
    controller.abort(new Error("promotion deadline elapsed"));
    await attempt.discard();

    await rejected;
    const relationship = relationshipWorkspacePath(
      join(root, "canonical"),
      identity.userId,
      identity.characterId,
    );
    expect(await readFile(join(await realpath(join(relationship, ".igrep")), "old.txt"), "utf8"))
      .toBe("old");
    await expect(readFile(
      join(await realpath(join(relationship, ".igrep")), "must-not-promote.txt"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back when cancellation lands immediately after the pointer rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-workspace-abort-after-swap-"));
    temporary.push(root);
    const workspaces = store(root);
    const identity = { userId: "user-1", characterId: "character-1" };
    await workspaces.rebuildRelationship(identity, async (workspace) => {
      await writeFile(join(workspace, ".igrep", "old.txt"), "old");
    });
    const fence = {
      mutationId: "filemut-abort-after-swap",
      claimToken: "55555555-5555-4555-8555-555555555555",
      authorityVersion: "9",
    };
    const prepared = await workspaces.prepareRelationshipRebuild(
      identity,
      fence,
      async (workspace) => {
        await writeFile(join(workspace, ".igrep", "new.txt"), "new");
        return { sessions: 1, messages: 2 };
      },
    );
    const controller = new AbortController();
    const signal = controller.signal;
    const nativeThrow = signal.throwIfAborted.bind(signal);
    let checkpoints = 0;
    Object.defineProperty(signal, "throwIfAborted", {
      value() {
        checkpoints += 1;
        // acquire wait + entry + pre/post candidate rename + pre pointer
        // rename = five checks; the sixth is the post-rename barrier.
        if (checkpoints === 6) {
          controller.abort(new Error("abort after pointer swap"));
        }
        nativeThrow();
      },
    });

    await expect(workspaces.promoteRelationshipRebuild({
      ...identity,
      rebuildId: prepared.rebuildId,
      fence,
    }, signal)).rejects.toThrow(/abort after pointer swap/);
    const relationship = relationshipWorkspacePath(
      join(root, "canonical"),
      identity.userId,
      identity.characterId,
    );
    expect(await readFile(join(await realpath(join(relationship, ".igrep")), "old.txt"), "utf8"))
      .toBe("old");
    expect(await readFile(join(
      relationship,
      ".rebuild-candidates",
      prepared.rebuildId,
      "workspace",
      ".igrep",
      "new.txt",
    ), "utf8")).toBe("new");
  });

  it("reaps durable rebuild garbage after a sidecar restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-workspace-rebuild-garbage-"));
    temporary.push(root);
    const relationship = relationshipWorkspacePath(
      join(root, "canonical"),
      "user-1",
      "character-1",
    );
    const stale = join(relationship, ".rebuild-garbage", "stale", "secret.txt");
    await mkdir(dirname(stale), { recursive: true });
    await writeFile(stale, "deleted transcript");

    store(root);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await lstat(stale);
        await new Promise((resolve) => setTimeout(resolve, 2));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("initializes a brand-new empty relationship and promotes only its accepted attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-workspace-new-"));
    temporary.push(root);
    let probes = 0;
    const workspaces = store(root, {
      status: async () => ({ dialogueFiles: probes++ === 0 ? 0 : 1 }),
    });

    const workspace = await workspaces.prepare(invocation("normal"));
    const relationship = relationshipWorkspacePath(
      join(root, "canonical"),
      "user-1",
      "character-1",
    );
    for (const path of [
      join(root, "canonical"),
      userWorkspacePath(join(root, "canonical"), "user-1"),
      relationship,
      join(relationship, ".igrep.versions"),
      join(relationship, ".attempts"),
      dirname(workspace.path),
      workspace.path,
      join(workspace.path, ".igrep"),
    ]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    await writeFile(join(workspace.path, ".igrep", "dialogue.jsonl"), "{}\n");
    await workspace.commit();

    const pointer = join(relationship, ".igrep");
    expect(workspace.mode).toBe("normal");
    expect((await lstat(pointer)).isSymbolicLink()).toBe(true);
    expect(await readdir(resolve(dirname(pointer), await readlink(pointer))))
      .toContain("dialogue.jsonl");
    expect(await readdir(join(relationship, ".attempts"))).toEqual([]);
  });

  it("reuses an already-migrated canonical workspace and exposes its historical proof read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-workspace-migrated-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const relationship = relationshipWorkspacePath(
      canonicalRoot,
      "user-1",
      "character-1",
    );
    const versionName = "rebuild-1787169600000-11111111-1111-4111-8111-111111111111";
    const version = join(relationship, ".igrep.versions", versionName);
    await mkdir(version, { recursive: true });
    await writeFile(join(version, "migrated.jsonl"), "{}\n");
    await symlink(relative(relationship, version), join(relationship, ".igrep"), "dir");
    const markerPath = memoryCutoverMarkerPath(canonicalRoot, "user-1", "character-1");
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, JSON.stringify({
      checksum: "b".repeat(64),
      entries: 1,
      legacySourceChecksum: "a".repeat(64),
      igrepVersion: "0.1.132",
      workspaceVersion: versionName,
      status: "cutover_ready",
      recallParity: {
        probeSetChecksum: "c".repeat(64),
        total: 1,
        passed: 1,
        probes: [{
          probeId: "migration-proof",
          queryHash: "d".repeat(64),
          legacyExpectedHash: "e".repeat(64),
          recallContextHash: "f".repeat(64),
          hitCount: 1,
        }],
      },
      completedAt: "2026-08-19T12:00:00.000Z",
    }));
    const workspaces = store(root);

    await expect(workspaces.memoryCutoverProof({
      userId: "user-1",
      characterId: "character-1",
    })).resolves.toMatchObject({
      status: "cutover_ready",
      entries: 1,
      cutoverWorkspaceVersion: versionName,
      workspaceVersion: versionName,
    });
    const workspace = await workspaces.prepare(invocation("normal"));
    expect(await readFile(join(workspace.path, ".igrep", "migrated.jsonl"), "utf8"))
      .toBe("{}\n");
    await workspace.discard();
  });

  it("keeps private attempts ephemeral and never creates canonical memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-workspace-private-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const workspace = await store(root).prepare(invocation("private"));
    const privateRelationship = relationshipWorkspacePath(
      join(root, "private"),
      "user-1",
      "character-1",
    );
    for (const path of [
      join(root, "private"),
      userWorkspacePath(join(root, "private"), "user-1"),
      privateRelationship,
      workspace.path,
    ]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    await workspace.commit();
    expect(workspace.mode).toBe("private");
    await expect(lstat(userWorkspacePath(canonicalRoot, "user-1")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs permissive existing authority directories before use", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-workspace-mode-repair-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const userRoot = userWorkspacePath(canonicalRoot, "user-1");
    const relationship = relationshipWorkspacePath(
      canonicalRoot,
      "user-1",
      "character-1",
    );
    await mkdir(relationship, { recursive: true });
    for (const path of [canonicalRoot, userRoot, relationship]) await chmod(path, 0o755);

    const workspace = await store(root).prepare(invocation("normal"));
    for (const path of [canonicalRoot, userRoot, relationship, workspace.path]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    await workspace.discard();
  });

  it("purges relationship workspace and historical proof idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-workspace-purge-"));
    temporary.push(root);
    const workspaces = store(root);
    await (await workspaces.prepare(invocation("normal"))).discard();
    const markerPath = memoryCutoverMarkerPath(
      join(root, "canonical"),
      "user-1",
      "character-1",
    );
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, "{}");
    const request = {
      scope: "relationship" as const,
      userId: "user-1",
      characterId: "character-1",
    };
    expect(await workspaces.purge(request)).toBe(1);
    expect(await workspaces.purge(request)).toBe(0);
    await expect(lstat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
