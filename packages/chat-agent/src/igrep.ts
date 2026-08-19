import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { MemoryProbe, MemoryStatus } from "./workspace";

export const NORMAL_IGREP_CONFIG = Object.freeze({
  search: true,
  webProvider: false,
  webTool: false,
  memory: true,
  ingest: true,
  wake: false,
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

interface JsonCommandOptions {
  command: string;
  args: string[];
  stdin?: string;
  timeoutMs?: number;
}

export async function runJsonCommand(options: JsonCommandOptions): Promise<unknown> {
  const child = spawn(options.command, options.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > 4_194_304) child.kill("SIGKILL");
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(options.stdin);
  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 10_000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (result.code !== 0) {
    throw new Error(
      `${options.command} ${options.args.join(" ")} failed (${result.code ?? result.signal}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
    );
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
