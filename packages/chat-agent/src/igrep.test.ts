import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompanionWorkspaceRebuild } from "@idream/shared/chat/companion-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  IgrepMemoryRebuilder,
  observeIgrepWake,
  recallIgrepMemory,
  probeIgrepLifecycle,
  runJsonCommand,
  type JsonCommandOptions,
} from "./igrep";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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
      timeoutMs: 10_000,
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
});

describe("official igrep canonical rebuild", () => {
  it("ingests strict Chat transcripts, rebuilds maintenance and verifies the public status seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-igrep-rebuild-"));
    temporary.push(root);
    const memory = join(root, "memory-version");
    const workspace = join(root, "workspace");
    await mkdir(memory);
    await mkdir(workspace);
    await symlink(memory, join(workspace, ".igrep"), "dir");
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
        return { events: rows.length, dialoguePath: ".igrep/mem/memory/dialogues/rebuilt.jsonl" };
      }
      return { ok: true };
    };
    const request: CompanionWorkspaceRebuild = {
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
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
    const rebuilder = new IgrepMemoryRebuilder(
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

    await expect(rebuilder.rebuild(workspace, request)).resolves.toEqual({
      sessions: 2,
      messages: 4,
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
    const root = await mkdtemp(join(tmpdir(), "chat-agent-igrep-rebuild-pending-"));
    temporary.push(root);
    await mkdir(join(root, ".igrep"));
    const rebuilder = new IgrepMemoryRebuilder(
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

    await expect(rebuilder.rebuild(root, {
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      messages: [],
    })).resolves.toEqual({ sessions: 0, messages: 0 });
  });

  it("does not expose malformed ingest output in rebuild errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-igrep-rebuild-invalid-"));
    temporary.push(root);
    await mkdir(join(root, ".igrep"));
    const rebuilder = new IgrepMemoryRebuilder(
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
      await rebuilder.rebuild(root, {
        scope: "relationship",
        userId: "user-1",
        characterId: "character-1",
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
