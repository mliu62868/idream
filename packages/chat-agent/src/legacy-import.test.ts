import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
    legacySourceChecksum: "a".repeat(64),
    checksum: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
    recallProbes: [{
      id: "tea-preference",
      query: "What tea does the user prefer?",
      legacyExpected: "jasmine tea",
    }],
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
      if (options.args[0] === "mem" && options.args[1] === "doctor") {
        return { provider: "igrep", ok: true, warnings: [] };
      }
      return {
        provider: "igrep",
        strategy: "shared-search",
        workspaceRoot: workspace,
        markdownContext: "### Memory 1\n- User prefers jasmine tea.\nSource: MEMORY.md#L1-L3",
        results: [{ citation: "MEMORY.md#L1-L3" }],
        warnings: [],
      };
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
      recallParity: {
        probeSetChecksum: "19c0a505b433054f795b03bec1f3e86cb5e9979baf7416716aeafa996e50ed0e",
        total: 1,
        passed: 1,
        probes: [{
          probeId: "tea-preference",
          queryHash: "216a035835b91277f5f41f303a4c1a54f8367791bd7689a5578744b1c00cd4f6",
          legacyExpectedHash: "26b88faa606ffa9961833ed4934429f4c8c97e5600855b814de46cd6eb4bea97",
          recallContextHash: "5ea0812f0881a87ed6e861c91c2e90e057d2a86808b05a7502a3f6ef9f4d2b7f",
          hitCount: 1,
        }],
      },
    });
    expect(commands.map((command) => command.args.slice(0, 2))).toEqual([
      ["mem", "record"],
      ["mem", "record"],
      ["mem", "maintain"],
      ["mem", "doctor"],
      ["mem-api", "memory-search"],
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
    expect(commands[4]?.args).toEqual(["mem-api", "memory-search", "--payload", "-"]);
    expect(commands[4]?.stdin).toBe(`${JSON.stringify({
      workspace,
      query: "What tea does the user prefer?",
    })}\n`);
  });

  it("fails closed when official recall does not contain the legacy expected answer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "chat-agent-legacy-import-miss-"));
    temporary.push(workspace);
    const importer = new IgrepLegacyMemoryImporter(
      "igrep",
      "0.1.132",
      async (options) => options.args[1] === "record"
        ? {
            provider: "igrep",
            action: "record",
            path: ".igrep/mem/MEMORY.md",
            written: true,
            contentHash: "c".repeat(64),
          }
        : options.args[1] === "maintain"
          ? { provider: "igrep", action: "maintain", pendingRows: 0 }
          : options.args[1] === "doctor"
            ? { provider: "igrep", ok: true, warnings: [] }
            : {
                provider: "igrep",
                strategy: "shared-search",
                workspaceRoot: workspace,
                markdownContext: "No relevant memory.",
                results: [],
                warnings: [],
              },
      async () => "0.1.132",
    );

    await expect(importer.import(workspace, request()))
      .rejects.toThrow(/recall parity failed for tea-preference/);
  });

  it("accepts an official recall workspace alias that resolves to the import candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-legacy-import-alias-"));
    temporary.push(root);
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-alias");
    await mkdir(join(workspace, ".igrep"), { recursive: true });
    await symlink(workspace, alias);
    const importer = new IgrepLegacyMemoryImporter(
      "igrep",
      "0.1.132",
      async (options) => options.args[1] === "record"
        ? {
            provider: "igrep",
            action: "record",
            path: ".igrep/mem/MEMORY.md",
            written: true,
            contentHash: "d".repeat(64),
          }
        : options.args[1] === "maintain"
          ? { provider: "igrep", action: "maintain", pendingRows: 0 }
          : options.args[1] === "doctor"
            ? { provider: "igrep", ok: true, warnings: [] }
            : {
                provider: "igrep",
                strategy: "shared-search",
                workspaceRoot: alias,
                markdownContext: "User prefers jasmine tea.",
                results: [{ citation: "MEMORY.md#L1-L1" }],
                warnings: [],
              },
      async () => "0.1.132",
    );

    await expect(importer.import(workspace, request())).resolves.toMatchObject({
      entries: 2,
      recallParity: { total: 1, passed: 1 },
    });
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
