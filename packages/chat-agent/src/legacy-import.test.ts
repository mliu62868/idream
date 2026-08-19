import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompanionLegacyMemoryImport } from "@idream/shared/chat/companion-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { IgrepLegacyMemoryImporter, type JsonCommandOptions } from "./igrep";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function request(): CompanionLegacyMemoryImport {
  const entries = [
    {
      legacyMemoryId: "memory-1",
      type: "preference",
      text: "User prefers jasmine tea.",
      sourceMessageIds: ["user-message-1"],
    },
    {
      legacyMemoryId: "memory-2",
      type: "user_fact",
      text: "User celebrates on March 3.",
      sourceMessageIds: ["user-message-2"],
    },
  ];
  return {
    scope: "relationship",
    userId: "user-1",
    characterId: "character-1",
    checksum: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
  };
}

describe("official igrep legacy memory import", () => {
  it("records each validated fact, rebuilds maintenance and runs strict doctor", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-legacy-import-"));
    temporary.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".igrep"), { recursive: true });
    const commands: JsonCommandOptions[] = [];
    const run = async (options: JsonCommandOptions): Promise<unknown> => {
      commands.push(options);
      if (options.args[0] === "mem" && options.args[1] === "record") {
        return {
          provider: "igrep",
          action: "record",
          path: ".igrep/mem/MEMORY.md",
          written: true,
          contentHash: "a".repeat(64),
        };
      }
      if (options.args[0] === "mem" && options.args[1] === "maintain") {
        return { provider: "igrep", action: "maintain", pendingRows: 0 };
      }
      return { provider: "igrep", ok: true, warnings: [] };
    };
    const importer = new IgrepLegacyMemoryImporter(
      "igrep",
      "0.1.132",
      run,
      async () => "0.1.132",
    );

    await expect(importer.import(workspace, request())).resolves.toEqual({
      entries: 2,
      written: 2,
      igrepVersion: "0.1.132",
    });
    expect(commands.map((command) => command.args.slice(0, 2))).toEqual([
      ["mem", "record"],
      ["mem", "record"],
      ["mem", "maintain"],
      ["mem", "doctor"],
    ]);
    expect(commands.slice(0, 2).map((command) => command.stdin)).toEqual([
      "User prefers jasmine tea.",
      "User celebrates on March 3.",
    ]);
    expect(commands.slice(0, 2).every((command) => !command.args.includes("--text")))
      .toBe(true);
    expect(commands.slice(0, 2).every((command) =>
      command.args.includes("--format") && command.args.includes("json"))).toBe(true);
    expect(commands[2]?.args).toContain("--rebuild");
    expect(commands[3]?.args).toContain("--strict");
  });

  it("rejects a forged checksum before invoking igrep", async () => {
    const commands: JsonCommandOptions[] = [];
    const importer = new IgrepLegacyMemoryImporter(
      "igrep",
      "0.1.132",
      async (options) => {
        commands.push(options);
        return {};
      },
      async () => "0.1.132",
    );
    await expect(importer.import("/tmp/not-used", {
      ...request(),
      checksum: "0".repeat(64),
    })).rejects.toThrow(/checksum/);
    expect(commands).toEqual([]);
  });

  it("fails closed when strict doctor does not certify the candidate", async () => {
    const importer = new IgrepLegacyMemoryImporter(
      "igrep",
      "0.1.132",
      async (options) => options.args[1] === "record"
        ? {
            provider: "igrep",
            action: "record",
            path: ".igrep/mem/MEMORY.md",
            written: true,
            contentHash: "b".repeat(64),
          }
        : options.args[1] === "maintain"
          ? { provider: "igrep", action: "maintain", pendingRows: 0 }
          : { provider: "igrep", ok: false, warnings: ["corrupt"] },
      async () => "0.1.132",
    );
    await expect(importer.import("/tmp/not-used", request()))
      .rejects.toThrow(/doctor/);
  });

  it("rejects executable version drift before writing the candidate", async () => {
    const commands: JsonCommandOptions[] = [];
    const importer = new IgrepLegacyMemoryImporter(
      "igrep",
      "0.1.132",
      async (options) => {
        commands.push(options);
        return {};
      },
      async () => "0.1.133",
    );

    await expect(importer.import("/tmp/not-used", request()))
      .rejects.toThrow(/version drifted to 0\.1\.133/);
    expect(commands).toEqual([]);
  });
});
