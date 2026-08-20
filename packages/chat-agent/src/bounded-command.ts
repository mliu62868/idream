import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const CHILD_STDOUT_LIMIT_BYTES = 4 * 1024 * 1024;
export const CHILD_STDERR_LIMIT_BYTES = 64 * 1024;

export type BoundedCommandFailureCode =
  | "aborted"
  | "exit_nonzero"
  | "invalid_output"
  | "spawn_failed"
  | "stderr_limit"
  | "stdout_limit"
  | "timeout";

export interface BoundedTextCommandOptions {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
}

/**
 * Child output can contain prompts, provider errors, or transcript fragments.
 * This error deliberately exposes only a stable category and a correlation
 * digest; callers must never interpolate stdout/stderr into logs or responses.
 */
export class BoundedCommandError extends Error {
  constructor(
    readonly code: BoundedCommandFailureCode,
    readonly digest: string,
  ) {
    super(`child command failed: code=${code} digest=${digest}`);
    this.name = "BoundedCommandError";
  }
}

export function invalidBoundedCommandOutput(output: string): BoundedCommandError {
  const digest = createHash("sha256").update(output).digest("hex");
  return new BoundedCommandError("invalid_output", digest);
}

export async function runBoundedTextCommand(
  options: BoundedTextCommandOptions,
): Promise<string> {
  if (options.signal?.aborted) {
    throw commandError("aborted", createHash("sha256"));
  }
  const stdoutLimit = options.stdoutLimitBytes ?? CHILD_STDOUT_LIMIT_BYTES;
  const stderrLimit = options.stderrLimitBytes ?? CHILD_STDERR_LIMIT_BYTES;
  const digest = createHash("sha256");
  const child = spawn(options.command, [...options.args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env ?? process.env,
  });
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure: BoundedCommandFailureCode | undefined;
  let spawnFailed = false;
  const fail = (code: BoundedCommandFailureCode) => {
    failure ??= code;
    child.kill("SIGKILL");
  };
  child.stdout.on("data", (chunk: Buffer) => {
    digest.update("stdout\0").update(chunk);
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > stdoutLimit) fail("stdout_limit");
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    digest.update("stderr\0").update(chunk);
    stderrBytes += chunk.byteLength;
    if (stderrBytes > stderrLimit) fail("stderr_limit");
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.stdin);
  const abort = () => fail("aborted");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => fail("timeout"), options.timeoutMs);
  timeout.unref();
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveResult) => {
    child.once("error", (error) => {
      spawnFailed = true;
      digest.update("spawn\0").update(
        (error as NodeJS.ErrnoException).code ?? error.name,
      );
    });
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  }).finally(() => {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  });
  digest.update("result\0").update(String(result.code)).update("\0").update(String(result.signal));
  if (failure) throw commandError(failure, digest);
  if (spawnFailed) throw commandError("spawn_failed", digest);
  if (result.code !== 0) throw commandError("exit_nonzero", digest);
  return Buffer.concat(stdout, stdoutBytes).toString("utf8");
}

function commandError(
  code: BoundedCommandFailureCode,
  digest: ReturnType<typeof createHash>,
): BoundedCommandError {
  return new BoundedCommandError(code, digest.digest("hex"));
}
