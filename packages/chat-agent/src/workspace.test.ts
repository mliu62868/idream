import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
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
  it("initializes a brand-new empty relationship and promotes only its accepted attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-workspace-new-"));
    temporary.push(root);
    let probes = 0;
    const workspaces = store(root, {
      status: async () => ({ dialogueFiles: probes++ === 0 ? 0 : 1 }),
    });

    const workspace = await workspaces.prepare(invocation("normal"));
    await writeFile(join(workspace.path, ".igrep", "dialogue.jsonl"), "{}\n");
    await workspace.commit();

    const relationship = relationshipWorkspacePath(
      join(root, "canonical"),
      "user-1",
      "character-1",
    );
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
    await workspace.commit();
    expect(workspace.mode).toBe("private");
    await expect(lstat(userWorkspacePath(canonicalRoot, "user-1")))
      .rejects.toMatchObject({ code: "ENOENT" });
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
