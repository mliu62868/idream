import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import {
  companionWorkspaceRebuildSessionIngestTimeoutMs,
  companionWorkspaceRebuildSchema,
} from "@idream/shared/chat/companion-runtime";
import {
  rebuildSourceMetrics,
  rebuildSpoolSessions,
  type CompanionWorkspaceRebuildSource,
} from "./rebuild-source";
import {
  invalidBoundedCommandOutput,
  runBoundedTextCommand,
} from "./bounded-command";
import type {
  MemoryProbe,
  MemoryStatus,
} from "./workspace";

export const NORMAL_IGREP_CONFIG = Object.freeze({
  search: true,
  webProvider: false,
  webTool: false,
  memory: true,
  ingest: true,
  wake: true,
});

export const PRIVATE_IGREP_CONFIG = Object.freeze({
  search: false,
  webProvider: false,
  webTool: false,
  memory: false,
  ingest: false,
  wake: false,
});

export interface IgrepPluginModule {
  readonly name: string;
  readonly inject?: readonly string[];
  apply(ctx: Context, config: Record<string, unknown>): void;
  resolveConfig?(config: Record<string, unknown>): Record<string, unknown>;
}

export interface LoadedIgrepPlugin {
  module: IgrepPluginModule;
  version: string;
  moduleUrl: string;
}

async function moduleFile(specifier: string): Promise<string> {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (!isAbsolute(specifier)) {
    throw new Error("DSH_IGREP_PLUGIN_URL must be an absolute path or file: URL");
  }
  const metadata = await stat(specifier);
  return metadata.isDirectory() ? join(specifier, "index.mjs") : specifier;
}

export async function loadIgrepPlugin(specifier: string): Promise<LoadedIgrepPlugin> {
  const file = await moduleFile(specifier);
  const moduleUrl = pathToFileURL(resolve(file)).href;
  const namespace = await import(moduleUrl) as Partial<IgrepPluginModule>;
  if (namespace.name !== "igrep" || typeof namespace.apply !== "function") {
    throw new Error("DSH_IGREP_PLUGIN_URL is not the official igrep DSH module namespace");
  }
  const packageJson = JSON.parse(
    await readFile(join(dirname(file), "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  if (packageJson.name !== "@igrep/dsh-plugin" || packageJson.version !== "0.1.0") {
    throw new Error("igrep plugin package identity must be @igrep/dsh-plugin@0.1.0");
  }
  return { module: namespace as IgrepPluginModule, version: packageJson.version, moduleUrl };
}

export interface JsonCommandOptions {
  command: string;
  args: string[];
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type RunJsonCommand = (options: JsonCommandOptions) => Promise<unknown>;

async function sameRealPath(left: string, right: string): Promise<boolean> {
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return false;
  }
}

export async function runJsonCommand(options: JsonCommandOptions): Promise<unknown> {
  const stdout = await runBoundedTextCommand({
    command: options.command,
    args: options.args,
    stdin: options.stdin,
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw invalidBoundedCommandOutput(stdout);
  }
}

export class IgrepMemoryProbe implements MemoryProbe {
  constructor(private readonly command: string) {}

  async status(workspace: string): Promise<MemoryStatus> {
    const payload = await runJsonCommand({
      command: this.command,
      args: ["mem-api", "memory-status", "--payload", "-"],
      stdin: `${JSON.stringify({ workspace })}\n`,
    }) as {
      error?: unknown;
      memory?: {
        dialogueFiles?: unknown;
        pendingProfileRows?: unknown;
        processedProfileRows?: unknown;
        lastMaintain?: { at?: unknown } | null;
      };
    };
    if (payload.error) {
      throw invalidBoundedCommandOutput(JSON.stringify(payload.error));
    }
    const dialogueFiles = payload.memory?.dialogueFiles;
    if (!Number.isSafeInteger(dialogueFiles) || Number(dialogueFiles) < 0) {
      throw new Error("igrep memory-status omitted a valid memory.dialogueFiles count");
    }
    const pendingProfileRows = payload.memory?.pendingProfileRows;
    const processedProfileRows = payload.memory?.processedProfileRows;
    if (!Number.isSafeInteger(pendingProfileRows) || Number(pendingProfileRows) < 0
      || !Number.isSafeInteger(processedProfileRows) || Number(processedProfileRows) < 0) {
      throw new Error("igrep memory-status omitted valid profile row counts");
    }
    const lastMaintainAt = payload.memory?.lastMaintain?.at;
    if (lastMaintainAt !== undefined && typeof lastMaintainAt !== "string") {
      throw new Error("igrep memory-status returned an invalid lastMaintain.at");
    }
    return {
      dialogueFiles: Number(dialogueFiles),
      pendingProfileRows: Number(pendingProfileRows),
      processedProfileRows: Number(processedProfileRows),
      lastMaintainAt: lastMaintainAt ?? null,
    };
  }
}

export class IgrepMemoryRebuilder {
  constructor(
    private readonly command: string,
    private readonly probe: MemoryProbe = new IgrepMemoryProbe(command),
    private readonly run: RunJsonCommand = runJsonCommand,
  ) {}

  async rebuild(
    workspace: string,
    input: CompanionWorkspaceRebuildSource,
    signal?: AbortSignal,
  ): Promise<{ sessions: number; messages: number }> {
    const source = "kind" in input ? input : companionWorkspaceRebuildSchema.parse(input);
    const metrics = rebuildSourceMetrics(source);
    // The transcript is transport input, not canonical memory. Keep it beside
    // the candidate .igrep so atomic promotion cannot retain a second copy.
    const transcriptsRoot = join(workspace, ".idream-rebuild-transcripts");
    await mkdir(transcriptsRoot, { recursive: true, mode: 0o700 });
    await chmod(transcriptsRoot, 0o700);
    const ingest = async (session: {
      sessionId: string;
      transcriptPath: string;
      messageCount: number;
      estimatedBytes: number;
    }) => {
      throwIfAborted(signal);
      const result = await this.run({
        command: this.command,
        args: [
          "mem",
          "ingest",
          "--transcript",
          session.transcriptPath,
          "--workspace",
          workspace,
          "--agent",
          "deepseek-harness",
          "--session-id",
          session.sessionId,
        ],
        timeoutMs: companionWorkspaceRebuildSessionIngestTimeoutMs(
          session.estimatedBytes,
        ),
        signal,
      });
      const record = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : {};
      if (record.events !== session.messageCount || typeof record.dialoguePath !== "string") {
        throw new Error(`igrep ingest did not verify session ${session.sessionId}`);
      }
    };
    if ("kind" in source) {
      for await (const session of rebuildSpoolSessions(source)) await ingest(session);
    } else {
      let current: {
        sessionId: string;
        transcriptPath: string;
        messageCount: number;
        estimatedBytes: number;
        handle: Awaited<ReturnType<typeof open>>;
      } | undefined;
      const finish = async () => {
        if (!current) return;
        await current.handle.sync();
        await current.handle.close();
        await ingest(current);
        current = undefined;
      };
      try {
        for (const message of source.messages) {
          if (current?.sessionId !== message.sessionId) {
            await finish();
            const digest = createHash("sha256").update(message.sessionId).digest("hex");
            const transcriptPath = join(transcriptsRoot, `session-${digest}.jsonl`);
            current = {
              sessionId: message.sessionId,
              transcriptPath,
              messageCount: 0,
              estimatedBytes: 0,
              handle: await open(transcriptPath, "wx", 0o600),
            };
          }
          const row = `${JSON.stringify({
            role: message.role,
            content: message.content,
            source_at: message.createdAt,
            source_timezone: "UTC",
          })}\n`;
          await current.handle.write(row);
          current.messageCount += 1;
          current.estimatedBytes += Buffer.byteLength(row);
        }
        await finish();
      } finally {
        await current?.handle.close().catch(() => undefined);
      }
    }
    await this.run({
      command: this.command,
      args: ["mem", "maintain", "--workspace", workspace, "--rebuild"],
      timeoutMs: 300_000,
      signal,
    });
    await this.run({
      command: this.command,
      args: ["mem", "doctor", "--workspace", workspace, "--json", "--strict"],
      timeoutMs: 30_000,
      signal,
    });
    const status = await this.probe.status(workspace);
    const expectedDialogueFiles = metrics.sessionCount;
    if (status.dialogueFiles !== expectedDialogueFiles) {
      throw new Error(
        `igrep rebuild dialogue count mismatch: expected ${expectedDialogueFiles}, got ${status.dialogueFiles}`,
      );
    }
    if ((status.pendingProfileRows ?? 0) > 0) {
      throw new Error(`igrep maintain left ${status.pendingProfileRows} profile rows pending`);
    }
    if (metrics.messageCount > 0 && !status.lastMaintainAt) {
      throw new Error("igrep rebuild did not expose a completed maintain pass");
    }
    return { sessions: metrics.sessionCount, messages: metrics.messageCount };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("igrep command aborted");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function igrepVersion(
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const stdout = await runBoundedTextCommand({
    command,
    args: ["--version"],
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal,
  });
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(stdout.trim());
  if (!match?.[1]) throw invalidBoundedCommandOutput(stdout);
  return match[1];
}

/**
 * A disposable write/maintain/status cycle proves the executable can finish
 * the exact lifecycle required before a canonical relationship promotion.
 */
export interface IgrepLifecycleProbeEvidence {
  duplicateIngest: {
    replayedSessions: number;
    duplicateDialogueFiles: 0;
  };
  crossScope: {
    probes: number;
    leakedResults: 0;
  };
}

export async function probeIgrepLifecycle(
  command: string,
  dependencies: {
    run?: RunJsonCommand;
    status?(workspace: string): Promise<MemoryStatus>;
    nonce?(): string;
  } = {},
): Promise<IgrepLifecycleProbeEvidence> {
  const root = await mkdtemp(join(tmpdir(), "idream-igrep-ready-"));
  const workspaces = [join(root, "scope-a"), join(root, "scope-b")] as const;
  const nonce = dependencies.nonce?.() ?? `${process.pid}-${Date.now()}`;
  const sentinels = [`scope-a-${nonce}`, `scope-b-${nonce}`] as const;
  const run = dependencies.run ?? runJsonCommand;
  const status = dependencies.status ?? ((workspace: string) =>
    new IgrepMemoryProbe(command).status(workspace));
  const ingest = async (workspace: string, sentinel: string, sessionId: string) => {
    const transcript = join(workspace, "readiness.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ role: "user", content: `readiness ${sentinel}` }),
      JSON.stringify({ role: "assistant", content: `acknowledged ${sentinel}` }),
      "",
    ].join("\n"), { mode: 0o600 });
    await run({
      command,
      args: [
        "mem", "ingest",
        "--workspace", workspace,
        "--transcript", transcript,
        "--agent", "idream-readiness",
        "--session-id", sessionId,
        "--format", "json",
      ],
      timeoutMs: 30_000,
    });
  };
  try {
    await Promise.all(workspaces.map((workspace) => mkdir(workspace, { recursive: true })));
    const sessionId = `readiness-${nonce}`;
    await ingest(workspaces[0], sentinels[0], sessionId);
    const beforeReplay = await status(workspaces[0]);
    await ingest(workspaces[0], sentinels[0], sessionId);
    const afterReplay = await status(workspaces[0]);
    const duplicateDialogueFiles = afterReplay.dialogueFiles - beforeReplay.dialogueFiles;
    if (beforeReplay.dialogueFiles < 1 || duplicateDialogueFiles !== 0) {
      throw new Error(`igrep replay created ${duplicateDialogueFiles} duplicate dialogue files`);
    }
    await ingest(workspaces[1], sentinels[1], `${sessionId}-scope-b`);

    for (const workspace of workspaces) {
      await run({
        command,
        args: ["mem", "maintain", "--workspace", workspace],
        timeoutMs: 120_000,
      });
      const observed = await status(workspace);
      if (observed.dialogueFiles < 1) {
        throw new Error("igrep readiness lifecycle did not persist dialogue evidence");
      }
      if ((observed.pendingProfileRows ?? 0) !== 0 || !observed.lastMaintainAt) {
        throw new Error(
          `igrep readiness lifecycle did not settle: pending=${observed.pendingProfileRows ?? "missing"}`,
        );
      }
    }

    let leakedResults = 0;
    for (const [workspace, foreignSentinel] of [
      [workspaces[0], sentinels[1]],
      [workspaces[1], sentinels[0]],
    ] as const) {
      const recalled = objectRecord(await run({
        command,
        args: ["mem-api", "memory-search", "--payload", "-"],
        stdin: `${JSON.stringify({ workspace, query: foreignSentinel })}\n`,
        timeoutMs: 30_000,
      }));
      const workspaceMatches = typeof recalled?.workspaceRoot === "string"
        && await sameRealPath(recalled.workspaceRoot, workspace);
      if (
        recalled?.provider !== "igrep"
        || recalled.strategy !== "shared-search"
        || !workspaceMatches
        || !Array.isArray(recalled.results)
        || !Array.isArray(recalled.warnings)
        || recalled.warnings.length !== 0
        || typeof recalled.markdownContext !== "string"
      ) {
        throw new Error("igrep cross-scope readiness probe returned unverifiable evidence");
      }
      if (`${recalled.markdownContext}\n${JSON.stringify(recalled.results)}`.includes(foreignSentinel)) {
        leakedResults += 1;
      }
    }
    if (leakedResults !== 0) {
      throw new Error(`igrep cross-scope readiness probe leaked ${leakedResults} results`);
    }
    return {
      duplicateIngest: { replayedSessions: 1, duplicateDialogueFiles: 0 },
      crossScope: { probes: 2, leakedResults: 0 },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
