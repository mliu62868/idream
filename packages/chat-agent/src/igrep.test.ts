import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompanionWorkspaceRebuild } from "@idream/shared/chat/companion-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  IgrepMemoryRebuilder,
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

  it("fails closed when maintain leaves canonical profile rows pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-igrep-rebuild-fail-"));
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
    })).rejects.toThrow(/left 2 profile rows pending/);
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
