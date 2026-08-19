import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompanionWorkspaceRebuild } from "@idream/shared/chat/companion-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { IgrepMemoryRebuilder, type JsonCommandOptions } from "./igrep";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
    const run = async (options: JsonCommandOptions): Promise<unknown> => {
      commands.push(options);
      if (options.args[0] === "mem" && options.args[1] === "ingest") {
        const transcript = options.args[options.args.indexOf("--transcript") + 1];
        const rows = (await readFile(transcript!, "utf8")).trim().split("\n");
        expect(rows.map((row) => JSON.parse(row))).toEqual([
          {
            role: "user",
            content: "Remember the observatory.",
            source_at: "2026-08-19T12:00:00.000Z",
            source_timezone: "UTC",
          },
          {
            role: "assistant",
            content: "Every blue-lit window.",
            source_at: "2026-08-19T12:00:01.000Z",
            source_timezone: "UTC",
          },
        ]);
        return { events: 2, dialoguePath: ".igrep/mem/memory/dialogues/rebuilt.jsonl" };
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
      ],
    };
    const rebuilder = new IgrepMemoryRebuilder(
      "igrep",
      {
        status: async () => ({
          dialogueFiles: 1,
          pendingProfileRows: 0,
          processedProfileRows: 2,
          lastMaintainAt: "2026-08-19T12:00:02.000Z",
        }),
      },
      run,
    );

    await expect(rebuilder.rebuild(workspace, request)).resolves.toEqual({
      sessions: 1,
      messages: 2,
    });
    expect(commands.map((command) => command.args.slice(0, 2))).toEqual([
      ["mem", "ingest"],
      ["mem", "maintain"],
      ["mem", "doctor"],
    ]);
    expect(commands[1]?.args).toContain("--rebuild");
    expect(commands[2]?.args).toContain("--strict");
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
