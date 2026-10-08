import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompanionWorkspaceRebuild } from "@idream/shared/chat/companion-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IgrepMemoryBuilder,
  igrepFailureCategory,
  observeIgrepWake,
  recallIgrepMemory,
  probeIgrepLifecycle,
  runJsonCommand,
  type JsonCommandOptions,
} from "./igrep";
import { AttemptWorkspaceStore, relationshipWorkspacePath } from "./workspace";
import { BoundedCommandError } from "./bounded-command";

const temporary: string[] = [];

// A fence is a Chat-wide durable fact under CHAT_FS_ROOT. Give every test its
// own root so one test's fenced user cannot reject another test's invocation.
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-fence-igrep-"));
  temporary.push(root);
  process.env.CHAT_FS_ROOT = root;
});

afterEach(async () => {
  delete process.env.CHAT_FS_ROOT;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureIngest(options: JsonCommandOptions) {
  const argument = (name: string) => options.args[options.args.indexOf(name) + 1]!;
  const workspace = argument("--workspace");
  const sessionId = argument("--session-id");
  const transcript = await readFile(argument("--transcript"), "utf8");
  const rows = transcript.trim().split("\n").map((line) => JSON.parse(line));
  const dialoguePath = `.igrep/mem/memory/dialogues/deepseek-harness-${sessionId}.jsonl`;
  const sessionPath = `.igrep/mem/memory/sessions/deepseek-harness-${sessionId}.jsonl`;
  await mkdir(dirname(join(workspace, dialoguePath)), { recursive: true });
  await mkdir(dirname(join(workspace, sessionPath)), { recursive: true });
  // Captured official igrep 0.1.150: searchable tuples and separate role-bearing sources.
  await writeFile(join(workspace, dialoguePath), rows.map((row) => JSON.stringify([row.source_at, row.content])).join("\n") + "\n");
  await writeFile(join(workspace, sessionPath), rows.map((row, index) => JSON.stringify({
    schema: "igrep.mem.session/1",
    agent: "deepseek-harness",
    id: `fixture-${sessionId}-${index}`,
    session_id: sessionId,
    turn_index: index + 1,
    role: row.role,
    content: row.content,
    source_at: { instant_utc: row.source_at },
  })).join("\n") + "\n");
  return { events: rows.length, dialoguePath, sessionPath };
}

async function recallFixture(messages: { role: string; content: string; source_at: string }[]) {
  const workspace = await mkdtemp(join(tmpdir(), "chat-igrep-recall-"));
  temporary.push(workspace);
  const transcript = join(workspace, "transcript.jsonl");
  await writeFile(transcript, messages.map(row => JSON.stringify(row)).join("\n") + "\n");
  const source = await fixtureIngest({ command: "igrep", args: ["mem", "ingest", "--workspace", workspace, "--session-id", "recall", "--transcript", transcript] });
  return { workspace, path: source.dialoguePath.replace(".igrep/mem/", "") };
}

describe("igrep subprocess bounds", () => {
  it("classifies plugin and subprocess failures without echoing their private text", () => {
    const prefix = "memory unavailable (an availability error, not an empty memory): ";
    expect(igrepFailureCategory(new BoundedCommandError("exit_nonzero", "a".repeat(64)))).toBe("command_exit_nonzero");
    expect(igrepFailureCategory({ message: `${prefix}igrep memory contract mismatch: PRIVATE_CONTRACT` })).toBe("contract_mismatch");
    expect(igrepFailureCategory({ message: `${prefix}invalid igrep JSON output: PRIVATE_BODY` })).toBe("command_invalid_output");
    expect(igrepFailureCategory({ message: `${prefix}igrep mem-api timed out after 10000ms` })).toBe("command_timeout");
    expect(igrepFailureCategory({ message: `${prefix}PRIVATE_CHILD_ERROR` })).toBe("memory_unavailable");
    expect(igrepFailureCategory(new Error("PRIVATE_PROVIDER_BODY"))).toBe("unknown");
    expect(igrepFailureCategory({ code: "PRIVATE_ERROR_CODE", message: "PRIVATE_PROVIDER_BODY" })).toBe("unknown");
    expect(igrepFailureCategory({ code: "ENOENT", path: "/PRIVATE_PATH" })).toBe("source_missing");
  });

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
    await expect(recallIgrepMemory("igrep", "/w", "query", {}, async () => ({
      results: [], warnings: ["workspace memory search incomplete (1 dialogue file(s) could not be bound to canonical evidence); run mem reproject"],
    }))).rejects.toThrow("unverifiable evidence");
  });
});

describe("official igrep pre-recall", () => {
  it.each([
    { payload: { results: [], warnings: ["PRIVATE_MEMORY_WARNING"] }, reason: "partial_evidence" },
    { payload: { results: [], failed: true, error: "PRIVATE_MEMORY_ERROR" }, reason: "failed_envelope" },
    { payload: { results: [], provider: "PRIVATE_PROVIDER" }, reason: "provider_mismatch" },
    { payload: { results: [], workspaceRoot: "/PRIVATE_OTHER_WORKSPACE" }, reason: "workspace_mismatch" },
    { payload: { results: "PRIVATE_INVALID_RESULTS" }, reason: "invalid_envelope" },
  ])("classifies rejected memory evidence without retaining private envelope bytes ($reason)", async ({ payload, reason }) => {
    let thrown: unknown;
    try {
      await recallIgrepMemory("igrep", "/w", "PRIVATE_QUERY", {}, async () => payload);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ reason });
    expect(String(thrown)).toContain("unverifiable evidence");
    expect(String(thrown)).not.toContain("PRIVATE_");
    expect(JSON.stringify(thrown)).not.toContain("PRIVATE_");
  });

  it("searches memory in fast mode and renders dialogue notes without profile hits", async () => {
    const calls: JsonCommandOptions[] = [];
    const fixture = await recallFixture([
      { role: "user", content: "my dog is Kestrel", source_at: "2026-08-24T10:00:00.000Z" },
      { role: "assistant", content: "Kestrel it is.", source_at: "2026-08-24T10:00:01.000Z" },
    ]);
    const recall = await recallIgrepMemory(
      "/opt/igrep",
      fixture.workspace,
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
              citation: `${fixture.path}#L1-L2`,
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
      workspace: fixture.workspace,
      query: "what is my dog's name",
      max_results: 6,
      search_mode: "fast",
      reference_at: "2026-08-24T10:00:00.000Z",
    });
    expect(recall).toMatchObject({
      outcome: "hit",
      resultCount: 2,
      notes: ["[user @ 2026-08-24T10:00:00.000Z] my dog is Kestrel [assistant @ 2026-08-24T10:00:01.000Z] Kestrel it is."],
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
    const fixture = await recallFixture([
      { role: "user", content: "A prior message.", source_at: "2026-09-07T00:00:00.000Z" },
      { role: "assistant", content: "The boat approaches the harbor. ".repeat(12), source_at: "2026-09-07T00:00:01.000Z" },
      { role: "user", content: `My blue notebook is beside the window. Its exact label is ${label}.`, source_at: "2026-09-07T00:00:02.000Z" },
    ]);
    const recall = await recallIgrepMemory("igrep", fixture.workspace, "What is my notebook label?", {}, async () => ({
      results: [{ citation: `${fixture.path}#L2-L3`, snippet: "Derived preview", sourceClass: "dialogue" }],
    }));
    expect(recall.notes[0]).toContain(`[user @ 2026-09-07T00:00:02.000Z] My blue notebook is beside the window. Its exact label is ${label}.`);
  });

  it("marks bounded excerpts as incomplete without fabricating a partial identifier", async () => {
    const prefix = "Earlier context. ".repeat(123);
    const identifier = "full_identifier_".repeat(30);
    const fixture = await recallFixture([{ role: "user", content: `${prefix}${identifier}`, source_at: "2026-09-07T00:00:00.000Z" }]);
    const recall = await recallIgrepMemory("igrep", fixture.workspace, "What is the exact identifier?", {}, async () => ({
      results: [{ citation: `${fixture.path}#L1`, snippet: `L1: ${prefix}${identifier}`, sourceClass: "dialogue" }],
    }));
    expect(recall.notes[0]?.length).toBeLessThanOrEqual(2000);
    expect(recall.notes[0]).not.toContain("full_identifier_");
    expect(recall.notes[0]).toContain("Excerpt incomplete; use memory_search for the complete original fact.");
  });
});

describe("official igrep canonical rebuild", () => {
  it("preserves multiline Unicode sources through the captured v3 transport and relative-date view", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "chat-igrep-transport-"));
    temporary.push(workspace);
    await mkdir(join(workspace, ".igrep"));
    const run = async (options: JsonCommandOptions) => {
      if (options.args[1] !== "ingest") return { ok: true };
      const result = await fixtureIngest(options);
      // Captured from official mem_dialogue_facts.project_rows in igrep 0.1.150.
      await writeFile(join(workspace, result.dialoguePath), [
        ["2026-09-30T17:00:00.469Z", "明天（2026-10-01）晚上见。␊␡I have ␊␊ and ␡␡ symbols.␉␡End. 🛶"],
        ["2026-09-30T17:00:01.000Z", "Acknowledged."],
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
      return result;
    };
    const builder = new IgrepMemoryBuilder("igrep", { status: async () => ({ dialogueFiles: 1, pendingProfileRows: 0, processedProfileRows: 1, lastMaintainAt: "2026-09-30T17:00:01.000Z" }) }, run);
    await expect(builder.build(workspace, {
      scope: "relationship", userId: "user-1", characterId: "character-1", mode: "rebuild",
      messages: [
        { id: "source", sessionId: "transport", role: "user", content: "明天晚上见。\nI have ␊ and ␡ symbols.\tEnd. 🛶", createdAt: "2026-09-30T17:00:00.469Z" },
        { id: "reply", sessionId: "transport", role: "assistant", content: "Acknowledged.", createdAt: "2026-09-30T17:00:01.000Z" },
      ],
    })).resolves.toMatchObject({ sourceReady: true, derivation: "accepted" });
  });

  it.each(["truncated ␊", "invalid ␊x", "invalid ␡x", "changed original"]) (
    "rejects malformed transport or rewritten text: %s", async (content) => {
      const workspace = await mkdtemp(join(tmpdir(), "chat-igrep-bad-transport-"));
      temporary.push(workspace);
      await mkdir(join(workspace, ".igrep"));
      const run = async (options: JsonCommandOptions) => {
        if (options.args[1] !== "ingest") return { ok: true };
        const result = await fixtureIngest(options);
        await writeFile(join(workspace, result.dialoguePath), [
          ["2026-09-30T17:00:00.000Z", content],
          ["2026-09-30T17:00:01.000Z", "Acknowledged."],
        ].map((row) => JSON.stringify(row)).join("\n") + "\n");
        return result;
      };
      const builder = new IgrepMemoryBuilder("igrep", { status: async () => ({ dialogueFiles: 1, pendingProfileRows: 0, processedProfileRows: 1, lastMaintainAt: "2026-09-30T17:00:01.000Z" }) }, run);
      await expect(builder.build(workspace, {
        scope: "relationship", userId: "user-1", characterId: "character-1", mode: "rebuild",
        messages: [
          { id: "source", sessionId: "transport", role: "user", content: "original", createdAt: "2026-09-30T17:00:00.000Z" },
          { id: "reply", sessionId: "transport", role: "assistant", content: "Acknowledged.", createdAt: "2026-09-30T17:00:01.000Z" },
        ],
      })).rejects.toThrow("igrep source integrity rejected");
    },
  );

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

  it("initializes an empty memory root before strict doctor without inventing facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-runtime-igrep-empty-"));
    temporary.push(root);
    await mkdir(join(root, ".igrep"));
    const commands: JsonCommandOptions[] = [];
    const builder = new IgrepMemoryBuilder(
      "igrep",
      { status: async () => ({ dialogueFiles: 0, pendingProfileRows: 0, processedProfileRows: 0, lastMaintainAt: null }) },
      async (options) => {
        commands.push(options);
        if (options.args[1] === "doctor") {
          expect(options.args).toContain("--strict");
          expect((await stat(join(root, ".igrep/mem"))).isDirectory()).toBe(true);
          expect(await readdir(join(root, ".igrep/mem"))).toEqual([]);
        }
        return { ok: true };
      },
    );

    await expect(builder.build(root, {
      scope: "relationship", userId: "user-1", characterId: "character-1", mode: "rebuild", messages: [],
    })).resolves.toEqual({ sessions: 0, messages: 0, sourceReady: true, derivation: "accepted" });
    expect(commands.map(command => command.args.slice(0, 2))).toEqual([["mem", "maintain"], ["mem", "doctor"]]);
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
    expect(rows).toEqual(
      input.messages.map((message) => [message.createdAt, message.content]),
    );
    await expect(readFile(join(workspace, retractions))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(workspace, ".igrep/mem/memory/dialogues"))).toEqual(["deepseek-harness-session-1.jsonl"]);
  }

  it("accepts the captured igrep 0.1.150 tuple and session formats", async () => {
    const workspace = await fixture();
    const calls: string[] = [];
    const builder = new IgrepMemoryBuilder("igrep", { status: async () => ({
      dialogueFiles: 1, pendingProfileRows: 0, processedProfileRows: 4, lastMaintainAt: "2026-09-10T01:08:00Z",
    }) }, async (options) => {
      calls.push(options.args[1]!);
      return options.args[1] === "ingest" ? fixtureIngest(options) : { ok: true };
    });
    await expect(builder.build(workspace, request)).resolves.toMatchObject({
      sourceReady: true, derivation: "accepted", sessions: 1, messages: 4,
    });
    expect(calls).toEqual(["ingest", "maintain", "doctor"]);
    await expectSources(workspace, request);
  });

  it.each(["text", "timestamp", "order", "extra-field", "role", "session-id", "turn-index", "source-text", "missing-source"])(
    "rejects changed tuple/session evidence: %s", async (fault) => {
      const workspace = await fixture();
      const calls: string[] = [];
      const builder = new IgrepMemoryBuilder("igrep", sourceOnlyStatus, async (options) => {
        calls.push(options.args[1]!);
        if (options.args[1] !== "ingest") return { ok: true };
        const result = await fixtureIngest(options);
        const sourceFault = ["role", "session-id", "turn-index", "source-text", "missing-source"].includes(fault);
        const path = join(workspace, sourceFault ? result.sessionPath : result.dialoguePath);
        if (fault === "missing-source") { await rm(path); return result; }
        const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        if (fault === "text") rows[0][1] = "The notebook was forgotten.";
        if (fault === "timestamp") rows[0][0] = "2026-09-08T09:00:00Z";
        if (fault === "order") rows.reverse();
        if (fault === "extra-field") rows[0].push("unverified source");
        if (fault === "role") rows[0].role = "assistant";
        if (fault === "session-id") rows[0].session_id = "another-session";
        if (fault === "turn-index") rows[0].turn_index = 2;
        if (fault === "source-text") rows[0].content = "The notebook was forgotten.";
        await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
        return result;
      });
      await expect(builder.build(workspace, request)).rejects.toThrow("igrep source integrity rejected");
      expect(calls).toEqual(["ingest", "ingest"]);
    },
  );

  it.each(["dialogue", "session"] as const)("rejects maintenance changes to the %s source", async (kind) => {
    const workspace = await fixture();
    const calls: string[] = [];
    const builder = new IgrepMemoryBuilder("igrep", sourceOnlyStatus, async (options) => {
      calls.push(options.args[1]!);
      if (options.args[1] === "ingest") return fixtureIngest(options);
      if (options.args[1] === "maintain") {
        const path = join(workspace, kind === "dialogue" ? dialogue : dialogue.replace("/dialogues/", "/sessions/"));
        const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        if (kind === "dialogue") rows[0][1] = "The notebook was forgotten.";
        else rows[0].role = "assistant";
        await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      }
      return { ok: true };
    });
    await expect(builder.build(workspace, request)).resolves.toMatchObject({
      sourceReady: true, derivation: "rejected", rejectionReason: "dialogue_source_mismatch",
    });
    expect(calls).toEqual(["ingest", "maintain", "ingest", "doctor"]);
    await expectSources(workspace, request);
  });

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
        const path = join(workspace, fault === "provenance" ? dialogue.replace("/dialogues/", "/sessions/") : dialogue);
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

  // igrep >= 0.1.148 refuses a session re-ingested from another transcript path.
  const maintainedStatus = { status: async () => ({
    dialogueFiles: 1, pendingProfileRows: 0, processedProfileRows: 4, lastMaintainAt: "2026-09-25T00:00:00.000Z",
  }) };
  it("keeps one transcript path per session across candidates and discards its bytes", async () => {
    const workspace = await fixture();
    const identity = { userId: request.userId, characterId: request.characterId };
    const canonicalRoot = join(workspace, "canonical");
    const store = new AttemptWorkspaceStore({ canonicalRoot, privateRoot: join(workspace, "private") });
    const transcripts: string[] = [];
    const builder = new IgrepMemoryBuilder("igrep", maintainedStatus, async (options) => {
      if (options.args[1] !== "ingest") return { ok: true };
      transcripts.push(options.args[options.args.indexOf("--transcript") + 1]!);
      return fixtureIngest(options);
    });
    const fences = ["1", "2"].map((version) => ({
      mutationId: `m${version}`, authorityVersion: version, claimToken: `${version.repeat(8)}-${version.repeat(4)}-4${version.repeat(3)}-8${version.repeat(3)}-${version.repeat(12)}`,
    }));
    const first = await store.prepareRelationshipRebuild(identity, fences[0]!, { seed: "empty" },
      (candidate, root) => builder.build(candidate, request, undefined, root));
    await store.promoteRelationshipRebuild({ ...identity, rebuildId: first.rebuildId, fence: fences[0]! });
    await store.prepareRelationshipRebuild(identity, fences[1]!, { seed: "canonical" },
      (candidate, root) => builder.build(candidate, request, undefined, root));
    const relationship = relationshipWorkspacePath(canonicalRoot, identity.userId, identity.characterId);
    expect(transcripts).toHaveLength(2);
    expect(transcripts[1]).toBe(transcripts[0]);
    expect(dirname(transcripts[0]!)).toBe(join(relationship, ".rebuild-transcripts"));
    await expect(stat(join(relationship, ".rebuild-transcripts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rebuilds a project candidate whose canonical seed refuses an ingest", async () => {
    const workspace = await fixture();
    await writeFile(join(workspace, ".igrep", "stale-seed.txt"), "registered to an old path");
    const calls: string[][] = [];
    const builder = new IgrepMemoryBuilder("igrep", maintainedStatus, async (options) => {
      calls.push(options.args.slice(1, 2).concat(options.args.includes("--rebuild") ? ["--rebuild"] : []));
      if (options.args[1] !== "ingest") return { ok: true };
      if (calls.length === 1) throw new BoundedCommandError("exit_nonzero", "refused");
      return fixtureIngest(options);
    });
    await expect(builder.build(workspace, request)).resolves.toMatchObject({ sourceReady: true, derivation: "accepted" });
    expect(calls).toEqual([["ingest"], ["ingest"], ["maintain", "--rebuild"], ["doctor"]]);
    await expect(stat(join(workspace, ".igrep", "stale-seed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectSources(workspace, request);
  });

  it("does not turn a timed-out project ingest into a rebuild", async () => {
    const workspace = await fixture();
    const builder = new IgrepMemoryBuilder("igrep", sourceOnlyStatus, async (options) => {
      if (options.args[1] === "ingest") throw new BoundedCommandError("timeout", "slow");
      return { ok: true };
    });
    await expect(builder.build(workspace, request)).rejects.toMatchObject({ code: "timeout" });
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

  it.each(["mem", "mem/memory", "mem/memory/dialogues", "mem/memory/sessions", "mem/.state"])("rejects linked source directory %s before the first CLI write", async (directory) => {
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
      if (options.args[1] === "ingest") return fixtureIngest(options);
      if (options.args[1] === "reproject") return { provider: "igrep", action: "reproject", migrated: false };
      if (options.args[0] === "mem-api" && options.args[1] === "memory-search") {
        const payload = JSON.parse(options.stdin ?? "{}") as { workspace: string; query: string };
        const [file] = await readdir(join(payload.workspace, ".igrep/mem/memory/dialogues"));
        const citation = `memory/dialogues/${file}#L1-L2`;
        searches.push(payload);
        return {
          provider: "igrep",
          strategy: "shared-search",
          workspaceRoot: payload.workspace,
          results: payload.workspace.includes(payload.query.startsWith("scope-a-") ? "scope-a" : "scope-b")
            ? [{ citation, sourceClass: "dialogue", snippet: payload.query }] : [],
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
    expect(searches).toHaveLength(4);
    expect(searches[0]?.workspace).not.toBe(searches[1]?.workspace);
    expect(JSON.stringify(evidence)).not.toContain("fixed-nonce");
  });

  it("accepts an igrep workspaceRoot alias that resolves to the probed workspace", async () => {
    const run = async (options: JsonCommandOptions): Promise<unknown> => {
      if (options.args[1] === "ingest") return fixtureIngest(options);
      if (options.args[1] === "reproject") return { provider: "igrep", action: "reproject", migrated: false };
      if (options.args[0] === "mem-api" && options.args[1] === "memory-search") {
        const payload = JSON.parse(options.stdin ?? "{}") as { workspace: string; query: string };
        const [file] = await readdir(join(payload.workspace, ".igrep/mem/memory/dialogues"));
        const citation = `memory/dialogues/${file}#L1-L2`;
        const alias = `${payload.workspace}-alias`;
        await symlink(payload.workspace, alias).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
        return {
          provider: "igrep",
          strategy: "shared-search",
          workspaceRoot: alias,
          results: payload.workspace.includes(payload.query.startsWith("scope-a-") ? "scope-a" : "scope-b")
            ? [{ citation, sourceClass: "dialogue", snippet: payload.query }] : [],
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
      if (options.args[1] === "ingest") return fixtureIngest(options);
      if (options.args[1] === "reproject") return { provider: "igrep", action: "reproject", migrated: false };
      if (options.args[0] === "mem-api" && options.args[1] === "memory-search") {
        const payload = JSON.parse(options.stdin ?? "{}") as { workspace: string; query: string };
        const [file] = await readdir(join(payload.workspace, ".igrep/mem/memory/dialogues"));
        const citation = `memory/dialogues/${file}#L1-L2`;
        return {
          provider: "igrep",
          strategy: "shared-search",
          workspaceRoot: payload.workspace,
          results: [{ citation, sourceClass: "dialogue", snippet: payload.query }],
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
