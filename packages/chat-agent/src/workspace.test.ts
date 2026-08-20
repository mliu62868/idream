import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LlmAdapter, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type { CompanionInvocation } from "@idream/shared/chat/companion-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionEngine } from "./engine";
import { companionCompositionDigest, companionIgrepConfig } from "./composition";
import { createCompanionServer, type CompanionServer } from "./server";
import {
  AttemptWorkspaceStore,
  legacyMemoryImportMarkerPath,
  relationshipWorkspacePath,
  userWorkspacePath,
} from "./workspace";

const AUTH_TOKEN = "purge-test-secret";
const temporary: string[] = [];
const IGREP_LLM = { url: "https://maintenance.example/v1", model: "maintenance-model" };
const servers: CompanionServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function listen(server: CompanionServer): Promise<string> {
  server.http.listen(0, "127.0.0.1");
  await once(server.http, "listening");
  const address = server.http.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return `http://127.0.0.1:${address.port}`;
}

async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function recallParity(probeSetChecksum = "1".repeat(64)) {
  return {
    probeSetChecksum,
    total: 1,
    passed: 1,
    probes: [{
      probeId: "tea-preference",
      queryHash: "2".repeat(64),
      legacyExpectedHash: "3".repeat(64),
      recallContextHash: "4".repeat(64),
      hitCount: 1,
    }],
  };
}

class UnusedAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<never> {
    throw new Error("not used");
  }
}

class BlockingAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error("aborted"));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function activeInvocation(): CompanionInvocation {
  return {
    invocationId: "invocation-purge-active",
    attemptId: "attempt-purge-active",
    sessionId: "session-purge-active",
    userId: "user-active",
    characterId: "character-active",
    memoryMode: "normal",
    expectedProfileDigest: companionCompositionDigest(
      "normal",
      companionIgrepConfig("normal", "igrep"),
      { maxSteps: 8, igrepLlm: IGREP_LLM },
    ),
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    preparedTurn: {
      version: 2,
      model: "deepseek/test",
      characterName: "Mira",
      messages: [{
        id: "current-active",
        sourceKind: "current_user",
        role: "user",
        content: "Wait here while privacy cleanup starts.",
      }],
      tools: [],
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openrouter",
        baseUrl: "https://example.invalid/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 32,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000, completionMs: 5_000 },
        sampling: { temperature: 1, topP: 1, repetitionPenalty: 1, structuredTemperature: 0 },
      },
      budget: { maxInputTokens: 100, usedInputTokens: 10, dropped: [] },
      releasedKnowledge: {
        characterId: "character-active",
        characterContentVersionId: "ccv-active",
        characterReleaseId: "release-active",
        digest: "535b3a772e9ac656e0feefc53a5923976d76541399437d70ea172f055c89d39d",
        files: [{
          path: "canon.md",
          content: "# Canon facts\n\n- Mira keeps the observatory keys.\n",
        }],
      },
      trace: {
        characterContentVersionId: "ccv-active",
        characterReleaseId: "release-active",
        soulFingerprint: "active",
        compilerVersion: "test",
        sceneVersion: 0,
        relationshipVersion: 0,
        fileContextRevision: "0",
        releasedKnowledgeDigest:
          "535b3a772e9ac656e0feefc53a5923976d76541399437d70ea172f055c89d39d",
      },
    },
  };
}

describe("authenticated workspace privacy authority", () => {
  it("promotes a verified legacy candidate with an external idempotency marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-legacy-promote-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const identity = { userId: "legacy-user", characterId: "legacy-character" };
    const relationship = relationshipWorkspacePath(
      canonicalRoot,
      identity.userId,
      identity.characterId,
    );
    const oldVersion = join(relationship, ".igrep.versions", "old");
    await mkdir(oldVersion, { recursive: true });
    await writeFile(join(oldVersion, "sentinel.txt"), "old");
    await symlink(".igrep.versions/old", join(relationship, ".igrep"), "dir");
    const store = new AttemptWorkspaceStore({
      canonicalRoot,
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });
    const marker = {
      checksum: "d".repeat(64),
      igrepVersion: "0.1.132",
      completedAt: "2026-08-19T12:00:00.000Z",
      status: "cutover_ready" as const,
      recallParity: recallParity(),
    };
    let builds = 0;
    const first = await store.importLegacyMemory(identity, {
      checksum: marker.checksum,
      igrepVersion: marker.igrepVersion,
      probeSetChecksum: marker.recallParity.probeSetChecksum,
      completedAt: marker.completedAt,
    }, async (workspace) => {
      builds += 1;
      // igrep 0.1.132 resolves memory files and rejects a .igrep symlink whose
      // target sits outside the workspace, so candidate construction is real.
      expect((await lstat(join(workspace, ".igrep"))).isSymbolicLink()).toBe(false);
      expect(await readFile(join(relationship, ".igrep", "sentinel.txt"), "utf8"))
        .toBe("old");
      await writeFile(join(workspace, ".igrep", "sentinel.txt"), "imported");
      return {
        entries: 2,
        written: 2,
        igrepVersion: "0.1.132",
        recallParity: recallParity(),
      };
    });

    expect(first).toMatchObject({
      skipped: false,
      result: {
        entries: 2,
        written: 2,
        igrepVersion: "0.1.132",
        recallParity: recallParity(),
      },
      marker,
    });
    expect(first.marker.workspaceVersion).toMatch(/^rebuild-\d+-[0-9a-f-]{36}$/);
    expect(await readFile(join(relationship, ".igrep", "sentinel.txt"), "utf8"))
      .toBe("imported");
    const markerPath = legacyMemoryImportMarkerPath(
      canonicalRoot,
      identity.userId,
      identity.characterId,
    );
    expect(markerPath.startsWith(relationship)).toBe(false);
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual(first.marker);

    await expect(store.importLegacyMemory(identity, {
      checksum: marker.checksum,
      igrepVersion: marker.igrepVersion,
      probeSetChecksum: marker.recallParity.probeSetChecksum,
      completedAt: "2026-08-19T13:00:00.000Z",
    }, async () => {
      builds += 1;
      throw new Error("idempotent import must not rebuild");
    })).resolves.toEqual({ skipped: true, marker: first.marker });
    expect(builds).toBe(1);

    const changedParity = recallParity("5".repeat(64));
    const changed = await store.importLegacyMemory(identity, {
      checksum: marker.checksum,
      igrepVersion: marker.igrepVersion,
      probeSetChecksum: changedParity.probeSetChecksum,
      completedAt: "2026-08-19T14:00:00.000Z",
    }, async (workspace) => {
      builds += 1;
      await writeFile(join(workspace, ".igrep", "sentinel.txt"), "reverified");
      return {
        entries: 2,
        written: 2,
        igrepVersion: "0.1.132",
        recallParity: changedParity,
      };
    });
    expect(changed).toMatchObject({
      skipped: false,
      marker: { status: "cutover_ready", recallParity: changedParity },
    });
    expect(builds).toBe(2);
  });

  it("records completion only after candidate verification succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-legacy-completed-at-"));
    temporary.push(root);
    const store = new AttemptWorkspaceStore({
      canonicalRoot: join(root, "canonical"),
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });
    let verifiedAt = 0;
    const imported = await store.importLegacyMemory(
      { userId: "completed-user", characterId: "completed-character" },
      {
        checksum: "e".repeat(64),
        igrepVersion: "0.1.132",
        probeSetChecksum: "1".repeat(64),
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        verifiedAt = Date.now();
        return {
          entries: 1,
          written: 1,
          igrepVersion: "0.1.132",
          recallParity: recallParity(),
        };
      },
    );

    expect(imported.skipped).toBe(false);
    expect(Date.parse(imported.marker.completedAt)).toBeGreaterThanOrEqual(verifiedAt);
    expect(imported.marker).toMatchObject({
      status: "cutover_ready",
      recallParity: recallParity(),
    });
  });

  it("does not reuse recall evidence after another canonical rebuild", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-legacy-rebuild-invalidates-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const identity = { userId: "rebuilt-user", characterId: "rebuilt-character" };
    const store = new AttemptWorkspaceStore({
      canonicalRoot,
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });
    const marker = {
      checksum: "7".repeat(64),
      igrepVersion: "0.1.132",
      probeSetChecksum: "1".repeat(64),
    };
    let imports = 0;
    const importCandidate = async (workspace: string) => {
      imports += 1;
      await writeFile(join(workspace, ".igrep", "sentinel.txt"), `import-${imports}`);
      return {
        entries: 1,
        written: 1,
        igrepVersion: "0.1.132",
        recallParity: recallParity(),
      };
    };
    await store.importLegacyMemory(identity, marker, importCandidate);
    await store.rebuildRelationship(identity, async (workspace) => {
      await writeFile(join(workspace, ".igrep", "sentinel.txt"), "canonical-rebuild");
    });

    const retried = await store.importLegacyMemory(identity, marker, importCandidate);

    expect(retried.skipped).toBe(false);
    expect(imports).toBe(2);
    expect(await readFile(join(
      relationshipWorkspacePath(canonicalRoot, identity.userId, identity.characterId),
      ".igrep",
      "sentinel.txt",
    ), "utf8")).toBe("import-2");
  });

  it("rejects importer version drift before canonical promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-legacy-version-drift-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const identity = { userId: "drift-user", characterId: "drift-character" };
    const relationship = relationshipWorkspacePath(
      canonicalRoot,
      identity.userId,
      identity.characterId,
    );
    const oldVersion = join(relationship, ".igrep.versions", "old");
    await mkdir(oldVersion, { recursive: true });
    await writeFile(join(oldVersion, "sentinel.txt"), "old");
    await symlink(".igrep.versions/old", join(relationship, ".igrep"), "dir");
    const store = new AttemptWorkspaceStore({
      canonicalRoot,
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });

    await expect(store.importLegacyMemory(identity, {
      checksum: "8".repeat(64),
      igrepVersion: "0.1.132",
      probeSetChecksum: "1".repeat(64),
    }, async (workspace) => {
      await writeFile(join(workspace, ".igrep", "sentinel.txt"), "drifted");
      return {
        entries: 1,
        written: 1,
        igrepVersion: "0.1.133",
        recallParity: recallParity(),
      };
    })).rejects.toThrow(/version drifted/);

    expect(await readFile(join(relationship, ".igrep", "sentinel.txt"), "utf8")).toBe("old");
    expect(await present(legacyMemoryImportMarkerPath(
      canonicalRoot,
      identity.userId,
      identity.characterId,
    ))).toBe(false);
  });

  it("revalidates an old completion marker before treating it as cutover-ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-legacy-marker-upgrade-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const identity = { userId: "old-marker-user", characterId: "old-marker-character" };
    const markerPath = legacyMemoryImportMarkerPath(
      canonicalRoot,
      identity.userId,
      identity.characterId,
    );
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, `${JSON.stringify({
      checksum: "6".repeat(64),
      igrepVersion: "0.1.132",
      completedAt: "2026-08-19T11:00:00.000Z",
    })}\n`);
    const store = new AttemptWorkspaceStore({
      canonicalRoot,
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });
    let builds = 0;
    const imported = await store.importLegacyMemory(identity, {
      checksum: "6".repeat(64),
      igrepVersion: "0.1.132",
      probeSetChecksum: "1".repeat(64),
    }, async () => {
      builds += 1;
      return {
        entries: 1,
        written: 1,
        igrepVersion: "0.1.132",
        recallParity: recallParity(),
      };
    });

    expect(builds).toBe(1);
    expect(imported).toMatchObject({ skipped: false, marker: { status: "cutover_ready" } });
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
      status: "cutover_ready",
      recallParity: recallParity(),
    });
  });

  it("keeps the prior authority and marker when legacy candidate verification fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-legacy-failure-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const identity = { userId: "legacy-user", characterId: "legacy-character" };
    const relationship = relationshipWorkspacePath(
      canonicalRoot,
      identity.userId,
      identity.characterId,
    );
    const oldVersion = join(relationship, ".igrep.versions", "old");
    await mkdir(oldVersion, { recursive: true });
    await writeFile(join(oldVersion, "sentinel.txt"), "old");
    await symlink(".igrep.versions/old", join(relationship, ".igrep"), "dir");
    const store = new AttemptWorkspaceStore({
      canonicalRoot,
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });
    const markerPath = legacyMemoryImportMarkerPath(
      canonicalRoot,
      identity.userId,
      identity.characterId,
    );

    await expect(store.importLegacyMemory(identity, {
      checksum: "e".repeat(64),
      igrepVersion: "0.1.132",
      probeSetChecksum: "1".repeat(64),
      completedAt: "2026-08-19T12:00:00.000Z",
    }, async (workspace) => {
      await writeFile(join(workspace, ".igrep", "sentinel.txt"), "unverified");
      throw new Error("doctor failed");
    })).rejects.toThrow("doctor failed");
    expect(await readFile(join(relationship, ".igrep", "sentinel.txt"), "utf8"))
      .toBe("old");
    expect(await present(markerPath)).toBe(false);
  });

  it("discards a verified candidate when the bounded import is aborted before promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-legacy-abort-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const identity = { userId: "legacy-abort-user", characterId: "legacy-abort-character" };
    const relationship = relationshipWorkspacePath(
      canonicalRoot,
      identity.userId,
      identity.characterId,
    );
    const oldVersion = join(relationship, ".igrep.versions", "old");
    await mkdir(oldVersion, { recursive: true });
    await writeFile(join(oldVersion, "sentinel.txt"), "old");
    await symlink(".igrep.versions/old", join(relationship, ".igrep"), "dir");
    const store = new AttemptWorkspaceStore({
      canonicalRoot,
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });
    const abort = new AbortController();

    await expect(store.importLegacyMemory(identity, {
      checksum: "f".repeat(64),
      igrepVersion: "0.1.132",
      probeSetChecksum: "1".repeat(64),
    }, async (workspace) => {
      await writeFile(join(workspace, ".igrep", "sentinel.txt"), "verified-but-late");
      abort.abort(new Error("operator deadline elapsed"));
      return {
        entries: 1,
        written: 1,
        igrepVersion: "0.1.132",
        recallParity: recallParity(),
      };
    }, abort.signal)).rejects.toThrow("operator deadline elapsed");

    expect(await readFile(join(relationship, ".igrep", "sentinel.txt"), "utf8"))
      .toBe("old");
    expect(await present(legacyMemoryImportMarkerPath(
      canonicalRoot,
      identity.userId,
      identity.characterId,
    ))).toBe(false);
  });

  it("fences and imports one strict relationship through the engine", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-legacy-engine-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const entries = [{
      legacyMemoryId: "memory-engine-1",
      type: "preference",
      text: "User prefers jasmine tea.",
      sourceMessageIds: ["user-message-engine-1"],
    }];
    const checksum = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    const engineParity = {
      ...recallParity(),
      probeSetChecksum: "19c0a505b433054f795b03bec1f3e86cb5e9979baf7416716aeafa996e50ed0e",
    };
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot,
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new UnusedAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
      legacyImporter: {
        version: "0.1.132",
        async import(workspace) {
          await writeFile(join(workspace, ".igrep", "imported.txt"), "verified");
          return {
            entries: 1,
            written: 1,
            igrepVersion: "0.1.132",
            recallParity: engineParity,
          };
        },
      },
    });

    const imported = await engine.importLegacyMemory({
      scope: "relationship",
      userId: "engine-user",
      characterId: "engine-character",
      checksum,
      entries,
      recallProbes: [{
        id: "tea-preference",
        query: "What tea does the user prefer?",
        legacyExpected: "jasmine tea",
      }],
    });

    expect(imported).toMatchObject({
      skipped: false,
      entries: 1,
      written: 1,
      checksum,
      igrepVersion: "0.1.132",
      status: "cutover_ready",
      recallParity: engineParity,
    });
    expect(await readFile(join(
      relationshipWorkspacePath(canonicalRoot, "engine-user", "engine-character"),
      ".igrep",
      "imported.txt",
    ), "utf8")).toBe("verified");
  });

  it("mounts released knowledge read-only for normal attempts and never for private attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-knowledge-"));
    temporary.push(root);
    const store = new AttemptWorkspaceStore({
      canonicalRoot: join(root, "canonical"),
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });

    const normal = await store.prepare(activeInvocation());
    const normalFile = join(normal.path, "knowledge", "canon.md");
    expect(await readFile(normalFile, "utf8"))
      .toBe("# Canon facts\n\n- Mira keeps the observatory keys.\n");
    expect((await stat(normalFile)).mode & 0o222).toBe(0);
    expect((await stat(join(normal.path, "knowledge"))).mode & 0o222).toBe(0);
    await normal.discard();

    const privateAttempt = await store.prepare({
      ...activeInvocation(),
      invocationId: "invocation-private-knowledge",
      attemptId: "attempt-private-knowledge",
      memoryMode: "private",
    });
    expect(await present(join(privateAttempt.path, "knowledge"))).toBe(false);
    await privateAttempt.discard();
  });

  it("atomically replaces one relationship only after a rebuild succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-rebuild-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const shadowRoot = join(root, "shadow");
    const relationship = relationshipWorkspacePath(canonicalRoot, "user-rebuild", "character-rebuild");
    const versions = join(relationship, ".igrep.versions");
    const oldVersion = join(versions, "old");
    const orphanVersion = join(versions, "orphan-with-forgotten-text");
    await mkdir(oldVersion, { recursive: true });
    await mkdir(orphanVersion, { recursive: true });
    await writeFile(join(oldVersion, "sentinel.txt"), "old");
    await writeFile(join(orphanVersion, "deleted.txt"), "must be removed");
    await symlink(".igrep.versions/old", join(relationship, ".igrep"), "dir");
    const store = new AttemptWorkspaceStore({
      canonicalRoot,
      shadowRoot,
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });
    const privateAttempt = await store.prepare({
      ...activeInvocation(),
      invocationId: "invocation-private-rebuild",
      attemptId: "attempt-private-rebuild",
      userId: "user-rebuild",
      characterId: "character-rebuild",
      memoryMode: "private",
    });
    const shadowRelationship = relationshipWorkspacePath(
      shadowRoot,
      "user-rebuild",
      "character-rebuild",
    );
    await mkdir(shadowRelationship, { recursive: true });
    await writeFile(join(shadowRelationship, "shadow-deleted.txt"), "must be removed");
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const rebuilding = store.rebuildRelationship(
      { userId: "user-rebuild", characterId: "character-rebuild" },
      async (workspace) => {
        await writeFile(join(workspace, ".igrep", "sentinel.txt"), "new");
        entered.resolve();
        await finish.promise;
      },
    );
    await entered.promise;
    expect(await present(privateAttempt.path)).toBe(false);
    expect(await present(shadowRelationship)).toBe(false);
    expect(await readFile(join(relationship, ".igrep", "sentinel.txt"), "utf8")).toBe("old");
    finish.resolve();
    await rebuilding;
    expect(await readFile(join(relationship, ".igrep", "sentinel.txt"), "utf8")).toBe("new");
    expect(await readdir(join(relationship, ".rebuilds"))).toEqual([]);
    expect(await readdir(versions)).toHaveLength(1);

    await expect(store.rebuildRelationship(
      { userId: "user-rebuild", characterId: "character-rebuild" },
      async (workspace) => {
        await writeFile(join(workspace, ".igrep", "sentinel.txt"), "corrupt");
        throw new Error("maintain failed");
      },
    )).rejects.toThrow("maintain failed");
    expect(await readFile(join(relationship, ".igrep", "sentinel.txt"), "utf8")).toBe("new");
    expect(await readdir(join(relationship, ".rebuilds"))).toEqual([]);
  });

  it("isolates shadow attempts from canonical memory and forbids promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-shadow-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const shadowRoot = join(root, "shadow");
    const store = new AttemptWorkspaceStore({
      canonicalRoot,
      shadowRoot,
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });

    const workspace = await store.prepare({
      ...activeInvocation(),
      invocationId: "invocation-shadow",
      attemptId: "shadow:attempt-purge-active",
      memoryMode: "shadow",
    });

    expect(workspace.mode).toBe("shadow");
    expect(workspace.path.startsWith(shadowRoot)).toBe(true);
    expect(await present(relationshipWorkspacePath(
      canonicalRoot,
      "user-active",
      "character-active",
    ))).toBe(false);
    await expect(workspace.commit()).rejects.toThrow(/shadow.*promote/i);
    await workspace.discard();
    expect(await present(workspace.path)).toBe(false);
  });

  it("fails closed immediately when a completed igrep maintain leaves profile rows pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-maintain-failure-"));
    temporary.push(root);
    let calls = 0;
    const store = new AttemptWorkspaceStore({
      canonicalRoot: join(root, "canonical"),
      privateRoot: join(root, "private"),
      verificationTimeoutMs: 30_000,
      memoryProbe: {
        status: async () => calls++ === 0
          ? {
              dialogueFiles: 0,
              pendingProfileRows: 0,
              processedProfileRows: 0,
              lastMaintainAt: null,
            }
          : {
              dialogueFiles: 1,
              pendingProfileRows: 2,
              processedProfileRows: 0,
              lastMaintainAt: "2026-08-19T14:20:57Z",
            },
      },
    });
    const workspace = await store.prepare(activeInvocation());

    await expect(workspace.commit()).rejects.toThrow(/left 2 profile rows pending/);
    const relationship = relationshipWorkspacePath(
      join(root, "canonical"),
      "user-active",
      "character-active",
    );
    expect(await readdir(join(relationship, ".attempts"))).toEqual([]);
  });

  it("removes an unpromoted candidate version when pointer replacement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-promotion-failure-"));
    temporary.push(root);
    let calls = 0;
    const canonicalRoot = join(root, "canonical");
    const store = new AttemptWorkspaceStore({
      canonicalRoot,
      privateRoot: join(root, "private"),
      verificationPollMs: 1,
      memoryProbe: {
        status: async () => calls++ === 0
          ? { dialogueFiles: 0, pendingProfileRows: 0, processedProfileRows: 0, lastMaintainAt: null }
          : {
              dialogueFiles: 1,
              pendingProfileRows: 0,
              processedProfileRows: 2,
              lastMaintainAt: "2026-08-19T15:00:00Z",
            },
      },
    });
    const workspace = await store.prepare(activeInvocation());
    const relationship = relationshipWorkspacePath(canonicalRoot, "user-active", "character-active");
    const canonical = join(relationship, ".igrep");
    await rm(canonical, { recursive: true, force: true });
    await mkdir(canonical);
    await writeFile(join(canonical, "blocks-rename"), "sentinel");

    await expect(workspace.commit()).rejects.toThrow();

    const versions = await readdir(join(relationship, ".igrep.versions"));
    expect(versions.filter((name) => name.startsWith("commit-"))).toEqual([]);
    expect(await readdir(join(relationship, ".attempts"))).toEqual([]);
  });

  it("waits for fire-and-forget disposal maintain before deleting a rejected attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-disposal-settle-"));
    temporary.push(root);
    let lastMaintainAt: string | null = null;
    const store = new AttemptWorkspaceStore({
      canonicalRoot: join(root, "canonical"),
      privateRoot: join(root, "private"),
      verificationTimeoutMs: 1_000,
      verificationPollMs: 5,
      memoryProbe: {
        status: async () => ({
          dialogueFiles: 0,
          pendingProfileRows: 0,
          processedProfileRows: 0,
          lastMaintainAt,
        }),
      },
    });
    const workspace = await store.prepare(activeInvocation());
    setTimeout(() => {
      lastMaintainAt = "2026-08-19T14:50:21Z";
    }, 20);

    await workspace.settleAndDiscard();

    expect(await present(workspace.path)).toBe(false);
    const relationship = relationshipWorkspacePath(
      join(root, "canonical"),
      "user-active",
      "character-active",
    );
    expect(await readdir(join(relationship, ".attempts"))).toEqual([]);
  });

  it("hashes hostile ids, purges idempotently and never deletes another tenant", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-purge-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const victimUser = "../../victim";
    const victimCharacter = "../../../character";
    const neighborUser = "neighbor";
    const neighborCharacter = "character-2";
    const victim = relationshipWorkspacePath(canonicalRoot, victimUser, victimCharacter);
    const neighbor = relationshipWorkspacePath(canonicalRoot, neighborUser, neighborCharacter);
    await mkdir(victim, { recursive: true });
    await mkdir(neighbor, { recursive: true });
    await writeFile(join(victim, "victim.txt"), "victim");
    await writeFile(join(neighbor, "neighbor.txt"), "neighbor");
    const outside = join(root, "must-survive.txt");
    await writeFile(outside, "authority sentinel");

    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot,
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new UnusedAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);

    expect((await fetch(`${baseUrl}/v1/workspaces/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "relationship", userId: victimUser, characterId: victimCharacter }),
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/workspaces/purge`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        scope: "relationship",
        userId: victimUser,
        characterId: victimCharacter,
        recursive: true,
      }),
    })).status).toBe(400);

    const purge = async () => {
      const response = await fetch(`${baseUrl}/v1/workspaces/purge`, {
        method: "POST",
        headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ scope: "relationship", userId: victimUser, characterId: victimCharacter }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ ok: true; purged: number }>;
    };
    expect(await purge()).toEqual({ ok: true, purged: 1 });
    expect(await purge()).toEqual({ ok: true, purged: 0 });
    expect(await present(victim)).toBe(false);
    expect(await present(userWorkspacePath(canonicalRoot, victimUser))).toBe(false);
    expect(await present(neighbor)).toBe(true);
    expect(await present(outside)).toBe(true);
  });

  it("purges every relationship for one user without crossing the user boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-user-purge-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const first = relationshipWorkspacePath(canonicalRoot, "user-a", "character-1");
    const second = relationshipWorkspacePath(canonicalRoot, "user-a", "character-2");
    const neighbor = relationshipWorkspacePath(canonicalRoot, "user-b", "character-1");
    await Promise.all([first, second, neighbor].map((path) => mkdir(path, { recursive: true })));
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot,
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new UnusedAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/workspaces/purge`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "user", userId: "user-a" }),
    });
    expect(await response.json()).toEqual({ ok: true, purged: 2 });
    expect(await present(first)).toBe(false);
    expect(await present(second)).toBe(false);
    expect(await present(neighbor)).toBe(true);
  });

  it("places private crash leftovers under the relationship authority and purges them", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-private-purge-"));
    temporary.push(root);
    const store = new AttemptWorkspaceStore({
      canonicalRoot: join(root, "canonical"),
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });
    const invocation: CompanionInvocation = {
      ...activeInvocation(),
      invocationId: "invocation-private-leftover",
      attemptId: "attempt-private-leftover",
      userId: "user-private",
      characterId: "character-private",
      memoryMode: "private",
    };
    const workspace = await store.prepare(invocation);
    await writeFile(join(workspace.path, "sigkill-leftover.txt"), "private sentinel");

    expect(await present(workspace.path)).toBe(true);
    expect(await store.purge({
      scope: "relationship",
      userId: invocation.userId,
      characterId: invocation.characterId,
    })).toBe(1);
    expect(await present(workspace.path)).toBe(false);
    expect(await store.purge({
      scope: "relationship",
      userId: invocation.userId,
      characterId: invocation.characterId,
    })).toBe(0);
  });

  it("serializes relationship rebuild and user purge while keeping both routing fences active", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-maintenance-order-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const relationship = relationshipWorkspacePath(
      canonicalRoot,
      "user-maintenance",
      "character-maintenance",
    );
    await mkdir(relationship, { recursive: true });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot,
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new UnusedAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
      rebuilder: {
        async rebuild() {
          entered.resolve();
          await finish.promise;
          return { sessions: 0, messages: 0 };
        },
      },
    });
    const rebuilding = engine.rebuild({
      scope: "relationship",
      userId: "user-maintenance",
      characterId: "character-maintenance",
      messages: [],
    });
    await entered.promise;
    let purgeFinished = false;
    const purging = engine.purge({ scope: "user", userId: "user-maintenance" })
      .finally(() => { purgeFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(purgeFinished).toBe(false);
    expect(await present(relationship)).toBe(true);
    await expect(engine.run({
      ...activeInvocation(),
      invocationId: "invocation-during-maintenance",
      attemptId: "attempt-during-maintenance",
      userId: "user-maintenance",
      characterId: "character-maintenance",
    }, () => undefined)).rejects.toThrow(/being purged/);

    finish.resolve();
    await rebuilding;
    await expect(purging).resolves.toBe(1);
    expect(await present(relationship)).toBe(false);
  });

  it("cancels an active relationship invocation before deleting canonical and attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-active-purge-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const run = activeInvocation();
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot,
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new BlockingAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const runResponse = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, type: "run", invocation: run }),
    });
    const stream = runResponse.text();
    const purgeResponse = await fetch(`${baseUrl}/v1/workspaces/purge`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        scope: "relationship",
        userId: run.userId,
        characterId: run.characterId,
      }),
    });
    expect(await purgeResponse.json()).toEqual({ ok: true, purged: 1 });
    expect(await stream).toContain('"type":"cancelled"');
    expect(await stream).toContain('"reason":"user"');
    expect(await present(relationshipWorkspacePath(canonicalRoot, run.userId, run.characterId))).toBe(false);
  });
});
