import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import {
  companionWorkspaceRebuildSchema,
  type CompanionWorkspaceRebuild,
} from "@idream/shared/chat/companion-runtime";
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

const COMMAND_STDOUT_LIMIT_BYTES = 4_194_304;
const COMMAND_STDERR_LIMIT_BYTES = 65_536;

async function sameRealPath(left: string, right: string): Promise<boolean> {
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return false;
  }
}

export async function runJsonCommand(options: JsonCommandOptions): Promise<unknown> {
  throwIfAborted(options.signal);
  const child = spawn(options.command, options.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const abort = () => child.kill("SIGKILL");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  child.stdin.on("error", () => undefined);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let limitFailure: "stdout" | "stderr" | null = null;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > COMMAND_STDOUT_LIMIT_BYTES) {
      limitFailure ??= "stdout";
      child.kill("SIGKILL");
    }
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const remaining = Math.max(0, COMMAND_STDERR_LIMIT_BYTES - stderrBytes);
    if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
    stderrBytes += chunk.byteLength;
    if (stderrBytes > COMMAND_STDERR_LIMIT_BYTES) {
      limitFailure ??= "stderr";
      child.kill("SIGKILL");
    }
  });
  child.stdin.end(options.stdin);
  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 10_000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  }).finally(() => {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  });
  throwIfAborted(options.signal);
  if (limitFailure) {
    throw new Error(`igrep_command_${limitFailure}_limit_exceeded`);
  }
  if (result.code !== 0) {
    const stderrDigest = createHash("sha256").update(Buffer.concat(stderr)).digest("hex");
    throw new Error(`igrep command failed (${result.code ?? result.signal}; stderr sha256 ${stderrDigest})`);
  }
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
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
    if (payload.error) throw new Error(`igrep memory-status failed: ${JSON.stringify(payload.error)}`);
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
    input: CompanionWorkspaceRebuild,
  ): Promise<{ sessions: number; messages: number }> {
    const request = companionWorkspaceRebuildSchema.parse(input);
    // The transcript is transport input, not canonical memory. Keep it beside
    // the candidate .igrep so atomic promotion cannot retain a second copy.
    const transcriptsRoot = join(workspace, ".idream-rebuild-transcripts");
    await mkdir(transcriptsRoot, { recursive: true });
    const bySession = new Map<string, typeof request.messages>();
    for (const message of request.messages) {
      const messages = bySession.get(message.sessionId) ?? [];
      messages.push(message);
      bySession.set(message.sessionId, messages);
    }
    for (const [sessionId, messages] of bySession) {
      const digest = createHash("sha256").update(sessionId).digest("hex");
      const transcript = join(transcriptsRoot, `session-${digest}.jsonl`);
      const rows = messages.map((message) => JSON.stringify({
        role: message.role,
        content: message.content,
        source_at: message.createdAt,
        source_timezone: "UTC",
      }));
      await writeFile(transcript, `${rows.join("\n")}\n`, "utf8");
      const result = await this.run({
        command: this.command,
        args: [
          "mem",
          "ingest",
          "--transcript",
          transcript,
          "--workspace",
          workspace,
          "--agent",
          "deepseek-harness",
          "--session-id",
          sessionId,
        ],
        timeoutMs: 30_000,
      });
      const record = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : {};
      if (record.events !== messages.length || typeof record.dialoguePath !== "string") {
        throw new Error(`igrep ingest did not verify session ${sessionId}`);
      }
    }
    await this.run({
      command: this.command,
      args: ["mem", "maintain", "--workspace", workspace, "--rebuild"],
      timeoutMs: 300_000,
    });
    await this.run({
      command: this.command,
      args: ["mem", "doctor", "--workspace", workspace, "--json", "--strict"],
      timeoutMs: 30_000,
    });
    const status = await this.probe.status(workspace);
    if (status.dialogueFiles !== bySession.size) {
      throw new Error(
        `igrep rebuild dialogue count mismatch: expected ${bySession.size}, got ${status.dialogueFiles}`,
      );
    }
    if ((status.pendingProfileRows ?? 0) > 0) {
      throw new Error(`igrep maintain left ${status.pendingProfileRows} profile rows pending`);
    }
    if (request.messages.length > 0 && !status.lastMaintainAt) {
      throw new Error("igrep rebuild did not expose a completed maintain pass");
    }
    return { sessions: bySession.size, messages: request.messages.length };
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

export async function igrepVersion(command: string): Promise<string> {
  const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const result = await new Promise<number | null>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", resolveResult);
  });
  if (result !== 0) throw new Error(Buffer.concat(stderr).toString("utf8").trim() || "igrep --version failed");
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(Buffer.concat(stdout).toString("utf8").trim());
  if (!match?.[1]) throw new Error("igrep --version did not return a semantic version");
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
