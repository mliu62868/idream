import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompanionWorkspaceRebuild } from "@idream/shared/chat/companion-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  IgrepMemoryBuilder,
  observeIgrepWake,
  recallIgrepMemory,
  probeIgrepLifecycle,
  runJsonCommand,
  type JsonCommandOptions,
} from "./igrep";
import { AttemptWorkspaceStore, relationshipWorkspacePath } from "./workspace";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureIngest(options: JsonCommandOptions) {
  const argument = (name: string) => options.args[options.args.indexOf(name) + 1]!;
  const workspace = argument("--workspace");
  const sessionId = argument("--session-id");
  const transcript = await readFile(argument("--transcript"), "utf8");
  const rows = transcript.trim().split("\n").map((line) => JSON.parse(line));
  const dialoguePath = `.igrep/mem/memory/dialogues/deepseek-harness-${sessionId}.jsonl`;
  await mkdir(dirname(join(workspace, dialoguePath)), { recursive: true });
  await writeFile(join(workspace, dialoguePath), rows.map((row, index) => JSON.stringify({
    schema: "igrep.mem.dialogue/1",
    id: `fixture-${sessionId}-${index}`,
    session_id: sessionId,
    turn_index: index + 1,
    role: row.role,
    content: row.content,
    source_at: { instant_utc: row.source_at },
  })).join("\n") + "\n");
  return { events: rows.length, dialoguePath };
}

describe("igrep subprocess bounds", () => {
  it("kills an unbounded stderr producer and returns only a stable failure code", async () => {
    const script = `process.stderr.write("PRIVATE_STDERR_SENTINEL".repeat(5000));setInterval(()=>{},1000)`;
    let thrown: unknown;
    try {
      await runJsonCommand({
        command: process.execPath,
        args: ["-e", script],
        timeoutMs: 5_000,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /^child command failed: code=stderr_limit digest=[a-f0-9]{64}$/,
    );
    expect((thrown as Error).message).not.toContain("PRIVATE_STDERR_SENTINEL");
  });
});

describe("official igrep wake observation", () => {
  it("reports the actual command result and keeps the profile bytes in-process", async () => {
    const calls: JsonCommandOptions[] = [];
    const observed = await observeIgrepWake(
      "/opt/igrep",
      "/private/workspace",
      undefined,
      async (options) => {
        calls.push(options);
        return { markdownContext: "PRIVATE_SENTINEL" };
      },
    );
    expect(observed).toEqual({ outcome: "hit", resultCount: 1, profile: "PRIVATE_SENTINEL" });
    expect(calls).toEqual([expect.objectContaining({
      command: "/opt/igrep",
      args: [
        "mem", "wake", "--workspace", "/private/workspace",
        "--max-context-chars", "12000", "--format", "provider-json",
      ],
      timeoutMs: 10_000,
    })]);
  });

  it("reports an empty wake as no profile", async () => {
    await expect(observeIgrepWake(
      "/opt/igrep",
      "/private/workspace",
      undefined,
      async () => ({ markdownContext: "  \n" }),
    )).resolves.toEqual({ outcome: "empty", resultCount: 0, profile: "" });
  });

  it("fails closed when wake does not return the official result shape", async () => {
    await expect(observeIgrepWake(
      "/opt/igrep",
      "/private/workspace",
      undefined,
      async () => ({ warnings: [] }),
    )).rejects.toThrow("unverifiable evidence");
  });
});

describe("official igrep pre-recall", () => {
  it("searches memory in fast mode and renders dialogue notes without profile hits", async () => {
    const calls: JsonCommandOptions[] = [];
    const recall = await recallIgrepMemory(
      "/opt/igrep",
      "/private/workspace",
      "what is my dog's name",
      { referenceAt: "2026-08-24T10:00:00.000Z" },
      async (options) => {
        calls.push(options);
        return {
          provider: "igrep",
          results: [
            {
              citation: "bank/cards/profile.md#L1-L6",
              snippet: "L1: # User Profile\nL6: - Owns a dog named Kestrel.",
              sourceClass: "profile",
            },
            {
              citation: "memory/dialogues/x.jsonl#L1-L2",
              snippet: "L1: [user @ 2026-08-24] my dog is Kestrel\nL2: [assistant @ 2026-08-24] Kestrel it is.",
              sourceClass: "dialogue",
            },
          ],
          warnings: [],
          markdownContext: "",
        };
      },
    );
    expect(calls).toEqual([expect.objectContaining({
      command: "/opt/igrep",
      args: ["mem-api", "memory-search", "--payload", "-"],
      timeoutMs: 30_000,
    })]);
    expect(JSON.parse(calls[0]?.stdin ?? "{}")).toEqual({
      workspace: "/private/workspace",
      query: "what is my dog's name",
      max_results: 6,
      search_mode: "fast",
      reference_at: "2026-08-24T10:00:00.000Z",
    });
    expect(recall).toMatchObject({
      outcome: "hit",
      resultCount: 2,
      notes: ["[user @ 2026-08-24] my dog is Kestrel [assistant @ 2026-08-24] Kestrel it is."],
    });
  });

  it("reports an empty page and fails closed on an error envelope", async () => {
    await expect(recallIgrepMemory("igrep", "/w", "query", {}, async () => ({ results: [] })))
      .resolves.toMatchObject({ outcome: "empty", resultCount: 0, notes: [] });
    await expect(recallIgrepMemory(
      "igrep",
      "/w",
      "query",
      {},
      async () => ({ error: { code: "RUNTIME_ERROR", message: "PRIVATE_SENTINEL" } }),
    )).rejects.toThrow("unverifiable evidence");
  });

  it("keeps the complete user fact after an earlier assistant passage", async () => {
    const label = "idreamrecall_0123456789abcdef0123456789abcdef";
    const snippet = `L2: [assistant @ 2026-09-07] ${"The boat approaches the harbor. ".repeat(12)}\nL3: [user @ 2026-09-07] My blue notebook is beside the window. Its exact label is ${label}.`;
    const recall = await recallIgrepMemory("igrep", "/w", "What is my notebook label?", {}, async () => ({
      results: [{ citation: "memory/dialogues/x.jsonl#L2-L3", snippet, sourceClass: "dialogue" }],
    }));
    expect(recall.notes[0]).toContain(`[user @ 2026-09-07] My blue notebook is beside the window. Its exact label is ${label}.`);
  });

  it("marks bounded excerpts as incomplete without fabricating a partial identifier", async () => {
    const prefix = `[user @ 2026-09-07] ${"Earlier context. ".repeat(123)}`;
    const identifier = "full_identifier_".repeat(30);
    const recall = await recallIgrepMemory("igrep", "/w", "What is the exact identifier?", {}, async () => ({
      results: [{ citation: "memory/dialogues/x.jsonl#L1", snippet: `L1: ${prefix}${identifier}`, sourceClass: "dialogue" }],
    }));
    expect(recall.notes[0]?.length).toBeLessThanOrEqual(2000);
    expect(recall.notes[0]).not.toContain("full_identifier_");
    expect(recall.notes[0]).toContain("Excerpt incomplete; use memory_search for the complete original fact.");
  });
});

describe("official igrep canonical rebuild", () => {
  it("ingests strict Chat transcripts, rebuilds maintenance and verifies the public status seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-runtime-igrep-rebuild-"));
    temporary.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".igrep"), { recursive: true });
    const commands: JsonCommandOptions[] = [];
    let ingests = 0;
    const run = async (options: JsonCommandOptions): Promise<unknown> => {
      commands.push(options);
      if (options.args[0] === "mem" && options.args[1] === "ingest") {
        const transcript = options.args[options.args.indexOf("--transcript") + 1];
        expect((await stat(dirname(transcript!))).mode & 0o777).toBe(0o700);
        expect((await stat(transcript!)).mode & 0o777).toBe(0o600);
        const rows = (await readFile(transcript!, "utf8")).trim().split("\n");
        const expected = [[
          ["user", "Remember the observatory.", "2026-08-19T12:00:00.000Z"],
          ["assistant", "Every blue-lit window.", "2026-08-19T12:00:01.000Z"],
        ], [
          ["user", "Remember the winter garden.", "2026-08-19T12:00:02.000Z"],
          ["assistant", "Its glass roof caught the snow.", "2026-08-19T12:00:03.000Z"],
        ]][ingests++];
        expect(rows.map((row) => {
          const parsed = JSON.parse(row) as Record<string, string>;
          return [parsed.role, parsed.content, parsed.source_at];
        })).toEqual(expected);
        return fixtureIngest(options);
      }
      return { ok: true };
    };
    const request: CompanionWorkspaceRebuild = {
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      mode: "rebuild",
      messages: [
        {
          id: "user-1",
          sessionId: "session-1",
          role: "user",
          content: "Remember the observatory.",
          createdAt: "2026-08-19T12:00:00.000Z",
        },
        {
          id: "assistant-1",
          sessionId: "session-1",
          role: "assistant",
          content: "Every blue-lit window.",
          createdAt: "2026-08-19T12:00:01.000Z",
        },
        {
          id: "user-2",
          sessionId: "session-2",
          role: "user",
          content: "Remember the winter garden.",
          createdAt: "2026-08-19T12:00:02.000Z",
        },
        {
          id: "assistant-2",
          sessionId: "session-2",
          role: "assistant",
          content: "Its glass roof caught the snow.",
          createdAt: "2026-08-19T12:00:03.000Z",
        },
      ],
    };
    const builder = new IgrepMemoryBuilder(
      "igrep",
      {
        status: async () => ({
          dialogueFiles: 2,
          pendingProfileRows: 0,
          processedProfileRows: 2,
          lastMaintainAt: "2026-08-19T12:00:02.000Z",
        }),
      },
      run,
    );

    await expect(builder.build(workspace, request)).resolves.toEqual({
      sessions: 2,
      messages: 4,
      sourceReady: true,
      derivation: "accepted",
    });
    expect(commands.map((command) => command.args.slice(0, 2))).toEqual([
      ["mem", "ingest"],
      ["mem", "ingest"],
      ["mem", "maintain"],
      ["mem", "doctor"],
    ]);
    expect(commands[2]?.args).toContain("--rebuild");
    expect(commands[3]?.args).toContain("--strict");
    expect(commands[0]?.timeoutMs).toBeGreaterThan(30_000);
  });

  it("accepts a completed rebuild when profile rows remain pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-runtime-igrep-rebuild-pending-"));
    temporary.push(root);
    await mkdir(join(root, ".igrep"));
    const builder = new IgrepMemoryBuilder(
      "igrep",
      {
        status: async () => ({
          dialogueFiles: 0,
          pendingProfileRows: 2,
          processedProfileRows: 0,
          lastMaintainAt: "2026-08-19T12:00:02.000Z",
        }),
      },
      async () => ({ ok: true }),
    );

    await expect(builder.build(root, {
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      mode: "rebuild",
      messages: [],
    })).resolves.toEqual({ sessions: 0, messages: 0, sourceReady: true, derivation: "accepted" });
  });

  it("maintains an ordinary projection without re-deriving canonical memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-runtime-igrep-project-"));
    temporary.push(root);
    await mkdir(join(root, ".igrep"));
    const commands: JsonCommandOptions[] = [];
    const builder = new IgrepMemoryBuilder(
      "igrep",
      {
        status: async () => ({
          dialogueFiles: 0,
          pendingProfileRows: 0,
          processedProfileRows: 0,
          lastMaintainAt: null,
        }),
      },
      async (options) => {
        commands.push(options);
        return { ok: true };
      },
    );

    await builder.build(root, {
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      mode: "project",
      messages: [],
    });

    expect(commands[0]?.args.slice(0, 2)).toEqual(["mem", "maintain"]);
    expect(commands[0]?.args).not.toContain("--rebuild");
  });

  it("does not expose malformed ingest output in rebuild errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-runtime-igrep-rebuild-invalid-"));
    temporary.push(root);
    await mkdir(join(root, ".igrep"));
    const builder = new IgrepMemoryBuilder(
      "igrep",
      {
        status: async () => ({
          dialogueFiles: 0,
          pendingProfileRows: 0,
          processedProfileRows: 0,
          lastMaintainAt: null,
        }),
      },
      async () => ({
        events: "PRIVATE_SENTINEL",
        dialoguePath: ".igrep/mem/memory/dialogues/rebuilt.jsonl",
      }),
    );

    let thrown: unknown;
    try {
      await builder.build(root, {
        scope: "relationship",
        userId: "user-1",
        characterId: "character-1",
        mode: "rebuild",
        messages: [{
          id: "user-1",
          sessionId: "session-1",
          role: "user",
          content: "Private transcript content.",
          createdAt: "2026-08-19T12:00:00.000Z",
        }, {
          id: "assistant-1",
          sessionId: "session-1",
          role: "assistant",
          content: "Private assistant content.",
          createdAt: "2026-08-19T12:00:01.000Z",
        }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("got invalid_type");
    expect((thrown as Error).message).not.toContain("PRIVATE_SENTINEL");
  });
});

describe("igrep Main source admission", () => {
  const request: CompanionWorkspaceRebuild = {
    scope: "relationship", userId: "user-1", characterId: "character-1", mode: "project",
    messages: [
      { id: "u1", sessionId: "session-1", role: "user", content: "My notebook is blue. Do not invent a replacement.", createdAt: "2026-09-07T09:00:00.000Z" },
      { id: "a1", sessionId: "session-1", role: "assistant", content: "Your notebook is blue.", createdAt: "2026-09-07T09:00:01.000Z" },
      { id: "u2", sessionId: "session-1", role: "user", content: "Correction: my notebook is now green, beside the window.", createdAt: "2026-09-07T09:01:00.000Z" },
      { id: "a2", sessionId: "session-1", role: "assistant", content: "I will remember the green notebook beside the window.", createdAt: "2026-09-07T09:01:01.000Z" },
    ],
  };
  const dialogue = ".igrep/mem/memory/dialogues/deepseek-harness-session-1.jsonl";
  const retractions = ".igrep/mem/.state/retractions.jsonl";
  async function fixture() {
    const workspace = await mkdtemp(join(tmpdir(), "chat-igrep-admission-"));
    temporary.push(workspace);
    await mkdir(join(workspace, ".igrep"));
    return workspace;
  }
  const sourceOnlyStatus = { status: async () => ({
    dialogueFiles: 1, pendingProfileRows: 4, processedProfileRows: 0, lastMaintainAt: null,
  }) };
  async function retract(workspace: string) {
    await mkdir(dirname(join(workspace, retractions)), { recursive: true });
    await writeFile(join(workspace, retractions), JSON.stringify({
      schema: "igrep.mem.retraction/1", annotation: "[RETRACTED by user request]",
    }) + "\n");
  }
  async function expectSources(workspace: string, input: CompanionWorkspaceRebuild) {
    const rows = (await readFile(join(workspace, dialogue), "utf8")).trim().split("\n").map((row) => JSON.parse(row));
    expect(rows.map((row) => [row.role, row.content, row.source_at.instant_utc])).toEqual(
      input.messages.map((message) => [message.role, message.content, message.createdAt]),
    );
    await expect(readFile(join(workspace, retractions))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(workspace, ".igrep/mem/memory/dialogues"))).toEqual(["deepseek-harness-session-1.jsonl"]);
  }

  it.each(["project", "rebuild"] as const)("recovers a rejected %s from the current Main source, retaining explicit correction", async (mode) => {
    const workspace = await fixture();
    const calls: string[] = [];
    // A destructive rebuild supplies only the surviving Main messages.
    const input = { ...request, mode, messages: mode === "rebuild" ? request.messages.slice(2) : request.messages };
    const builder = new IgrepMemoryBuilder("igrep", sourceOnlyStatus, async (options) => {
      calls.push(options.args[1]!);
      if (options.args[1] === "ingest") return fixtureIngest(options);
      if (options.args[1] === "maintain") {
        await retract(workspace);
        await writeFile(join(workspace, ".igrep", "untrusted-profile.txt"), "The notebook was forgotten.");
      }
      return { ok: true };
    });
    await expect(builder.build(workspace, input)).resolves.toEqual({
      sessions: 1, messages: input.messages.length, sourceReady: true,
      derivation: "rejected", rejectionReason: "retractions_present",
    });
    await expectSources(workspace, input);
    await expect(readFile(join(workspace, ".igrep", "untrusted-profile.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toEqual(["ingest", "maintain", "ingest", "doctor"]);
  });

  it.each(["retraction", "unknown-dialogue"] as const)("discards an already contaminated canonical seed (%s) before maintenance", async (fault) => {
    const workspace = await fixture();
    if (fault === "retraction") await retract(workspace);
    else {
      await mkdir(dirname(join(workspace, dialogue)), { recursive: true });
      await writeFile(join(workspace, dirname(dialogue), "unknown.jsonl"), '{"content":"not a Main source"}\n');
    }
    const calls: string[] = [];
    const builder = new IgrepMemoryBuilder("igrep", sourceOnlyStatus, async (options) => {
      calls.push(options.args[1]!);
      return options.args[1] === "ingest" ? fixtureIngest(options) : { ok: true };
    });
    await expect(builder.build(workspace, request)).resolves.toMatchObject({ sourceReady: true, derivation: "rejected" });
    await expectSources(workspace, request);
    expect(calls).toEqual(["ingest", "ingest", "doctor"]);
  });

  it.each(["content", "delete", "provenance"] as const)("rejects maintenance that changes source %s", async (fault) => {
    const workspace = await fixture();
    const builder = new IgrepMemoryBuilder("igrep", sourceOnlyStatus, async (options) => {
      if (options.args[1] === "ingest") return fixtureIngest(options);
      if (options.args[1] === "maintain") {
        const path = join(workspace, dialogue);
        if (fault === "delete") await rm(path);
        else {
          const text = await readFile(path, "utf8");
          await writeFile(path, fault === "content"
            ? text.replace("My notebook is blue.", "The user forgot their notebook.")
            : text.replace("fixture-session-1-0", "rewritten-provenance"));
        }
      }
      return { ok: true };
    });
    await expect(builder.build(workspace, request)).resolves.toMatchObject({ sourceReady: true, derivation: "rejected" });
    await expectSources(workspace, request);
  });

  it("fails closed after one unsuccessful source-only recovery", async () => {
    const workspace = await fixture();
    const identity = { userId: request.userId, characterId: request.characterId };
    const canonicalRoot = join(workspace, "canonical");
    const store = new AttemptWorkspaceStore({ canonicalRoot, privateRoot: join(workspace, "private") });
    const oldFence = { mutationId: "old", authorityVersion: "1", claimToken: "11111111-1111-4111-8111-111111111111" };
    const old = await store.prepareRelationshipRebuild(identity, oldFence, { seed: "empty" }, async (candidate) => {
      await writeFile(join(candidate, ".igrep", "existing-canonical.txt"), "last admitted source");
      return { sessions: 0, messages: 0 };
    });
    await store.promoteRelationshipRebuild({ ...identity, rebuildId: old.rebuildId, fence: oldFence });
    const calls: string[] = [];
    let ingests = 0;
    const builder = new IgrepMemoryBuilder("igrep", sourceOnlyStatus, async (options) => {
      calls.push(options.args[1]!);
      const candidate = options.args[options.args.indexOf("--workspace") + 1]!;
      if (options.args[1] === "ingest") {
        const result = await fixtureIngest(options);
        if (++ingests === 2) await rm(join(candidate, result.dialoguePath));
        return result;
      }
      if (options.args[1] === "maintain") await retract(candidate);
      return { ok: true };
    });
    await expect(store.prepareRelationshipRebuild(identity, {
      mutationId: "new", authorityVersion: "2", claimToken: "22222222-2222-4222-8222-222222222222",
    }, { seed: "canonical" }, (candidate) => builder.build(candidate, request)))
      .rejects.toThrow("dialogue_inventory_mismatch");
    expect(calls).toEqual(["ingest", "maintain", "ingest"]);
    const relationship = relationshipWorkspacePath(canonicalRoot, identity.userId, identity.characterId);
    expect(await readFile(join(relationship, ".igrep", "existing-canonical.txt"), "utf8")).toBe("last admitted source");
    expect(await readdir(join(relationship, ".rebuild-candidates"))).toEqual([]);
  });

  it("honors cancellation before scanning or recovering a rejected candidate", async () => {
    const workspace = await fixture();
    const controller = new AbortController();
    const calls: string[] = [];
    const builder = new IgrepMemoryBuilder("igrep", sourceOnlyStatus, async (options) => {
      calls.push(options.args[1]!);
      if (options.args[1] === "ingest") return fixtureIngest(options);
      if (options.args[1] === "maintain") {
        await retract(workspace);
        controller.abort(new Error("Main claim cancelled"));
      }
      return { ok: true };
    });
    await expect(builder.build(workspace, request, controller.signal)).rejects.toThrow("Main claim cancelled");
    expect(calls).toEqual(["ingest", "maintain"]);
  });

  it("does not ingest through a linked candidate memory root", async () => {
    const workspace = await fixture();
    const outside = await fixture();
    await rm(join(workspace, ".igrep"), { recursive: true });
    await symlink(join(outside, ".igrep"), join(workspace, ".igrep"));
    let calls = 0;
    const builder = new IgrepMemoryBuilder("igrep", sourceOnlyStatus, async () => { calls++; return {}; });
    await expect(builder.build(workspace, request)).rejects.toThrow("dialogue_format_invalid");
    expect(calls).toBe(0);
    expect(await readdir(join(outside, ".igrep"))).toEqual([]);
  });

  it.each(["mem", "mem/memory", "mem/memory/dialogues", "mem/.state"])("rejects linked source directory %s before the first CLI write", async (directory) => {
    const workspace = await fixture();
    const outside = await fixture();
    const target = join(outside, ".igrep");
    await writeFile(join(target, "existing.txt"), "untouched");
    await mkdir(dirname(join(workspace, ".igrep", directory)), { recursive: true });
    await symlink(target, join(workspace, ".igrep", directory));
    const calls: string[] = [];
    const builder = new IgrepMemoryBuilder("igrep", sourceOnlyStatus, async (options) => {
      calls.push(options.args[1]!);
      return fixtureIngest(options);
    });
    await expect(builder.build(workspace, request)).rejects.toThrow("dialogue_format_invalid");
    expect(calls).toEqual([]);
    expect(await readdir(target)).toEqual(["existing.txt"]);
    expect(await readFile(join(target, "existing.txt"), "utf8")).toBe("untouched");
  });

  it("also rejects a linked empty dialogue directory for an empty relationship", async () => {
    const workspace = await fixture();
    const outside = await fixture();
    await mkdir(join(workspace, ".igrep/mem/memory"), { recursive: true });
    await symlink(join(outside, ".igrep"), join(workspace, ".igrep/mem/memory/dialogues"));
    const calls: string[] = [];
    const builder = new IgrepMemoryBuilder("igrep", { status: async () => ({
      dialogueFiles: 0, pendingProfileRows: 0, processedProfileRows: 0, lastMaintainAt: null,
    }) }, async (options) => { calls.push(options.args[1]!); return { ok: true }; });
    await expect(builder.build(workspace, { ...request, messages: [] })).rejects.toThrow("dialogue_format_invalid");
    expect(calls).toEqual([]);
    expect(await readdir(join(outside, ".igrep"))).toEqual([]);
  });
});

describe("igrep readiness isolation evidence", () => {
  it("proves same-session replay and bidirectional cross-workspace isolation without returning probe content", async () => {
    const searches: Array<{ workspace: string; query: string }> = [];
    const run = async (options: JsonCommandOptions): Promise<unknown> => {
      if (options.args[0] === "mem-api" && options.args[1] === "memory-search") {
        const payload = JSON.parse(options.stdin ?? "{}") as { workspace: string; query: string };
        searches.push(payload);
        return {
          provider: "igrep",
          strategy: "shared-search",
          workspaceRoot: payload.workspace,
          results: [],
          warnings: [],
          markdownContext: "",
        };
      }
      return { events: 2, dialoguePath: ".igrep/mem/memory/dialogues/readiness.jsonl" };
    };

    const evidence = await probeIgrepLifecycle("igrep", {
      run,
      status: async () => ({
        dialogueFiles: 1,
        pendingProfileRows: 0,
        processedProfileRows: 2,
        lastMaintainAt: "2026-08-19T12:00:02.000Z",
      }),
      nonce: () => "fixed-nonce",
    });

    expect(evidence).toEqual({
      duplicateIngest: { replayedSessions: 1, duplicateDialogueFiles: 0 },
      crossScope: { probes: 2, leakedResults: 0 },
    });
    expect(searches).toHaveLength(2);
    expect(searches[0]?.workspace).not.toBe(searches[1]?.workspace);
    expect(JSON.stringify(evidence)).not.toContain("fixed-nonce");
  });

  it("accepts an igrep workspaceRoot alias that resolves to the probed workspace", async () => {
    const run = async (options: JsonCommandOptions): Promise<unknown> => {
      if (options.args[0] === "mem-api" && options.args[1] === "memory-search") {
        const payload = JSON.parse(options.stdin ?? "{}") as { workspace: string };
        const alias = `${payload.workspace}-alias`;
        await symlink(payload.workspace, alias);
        return {
          provider: "igrep",
          strategy: "shared-search",
          workspaceRoot: alias,
          results: [],
          warnings: [],
          markdownContext: "",
        };
      }
      return { events: 2, dialoguePath: ".igrep/mem/memory/dialogues/readiness.jsonl" };
    };

    await expect(probeIgrepLifecycle("igrep", {
      run,
      status: async () => ({
        dialogueFiles: 1,
        pendingProfileRows: 0,
        processedProfileRows: 2,
        lastMaintainAt: "2026-08-19T12:00:02.000Z",
      }),
      nonce: () => "aliased-workspace",
    })).resolves.toEqual({
      duplicateIngest: { replayedSessions: 1, duplicateDialogueFiles: 0 },
      crossScope: { probes: 2, leakedResults: 0 },
    });
  });

  it("fails closed when either workspace can recall the other scope sentinel", async () => {
    const run = async (options: JsonCommandOptions): Promise<unknown> => {
      if (options.args[0] === "mem-api" && options.args[1] === "memory-search") {
        const payload = JSON.parse(options.stdin ?? "{}") as { workspace: string; query: string };
        return {
          provider: "igrep",
          strategy: "shared-search",
          workspaceRoot: payload.workspace,
          results: [{ content: payload.query }],
          warnings: [],
          markdownContext: "",
        };
      }
      return { events: 2, dialoguePath: ".igrep/mem/memory/dialogues/readiness.jsonl" };
    };

    await expect(probeIgrepLifecycle("igrep", {
      run,
      status: async () => ({
        dialogueFiles: 1,
        pendingProfileRows: 0,
        processedProfileRows: 2,
        lastMaintainAt: "2026-08-19T12:00:02.000Z",
      }),
      nonce: () => "leak-nonce",
    })).rejects.toThrow(/cross-scope readiness probe leaked 2 results/);
  });
});
