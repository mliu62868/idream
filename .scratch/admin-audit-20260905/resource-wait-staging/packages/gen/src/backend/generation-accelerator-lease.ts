import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { env } from "../env";

type GenerationKind = "image" | "video";
type LeaseOwner = {
  readonly pid: number;
  readonly token: string;
  readonly kind: GenerationKind;
  readonly acquiredAtMs: number;
};

type LeaseOptions = {
  readonly lockPath?: string;
  readonly pollMs?: number;
  readonly staleMs?: number;
  readonly waitTimeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly onWait?: () => Promise<void>;
};

// SPEC: image and video ComfyUI processes may differ, but both consume the same
// Apple GPU and unified memory. This host-local lease serializes the full
// submit/poll window across both Gen worker processes.
export async function withGenerationAcceleratorLease<T>(
  kind: GenerationKind,
  run: () => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  const lockPath = options.lockPath ?? env.ACCELERATOR_LOCK_PATH;
  const pollMs = options.pollMs ?? env.ACCELERATOR_LOCK_POLL_MS;
  const staleMs = options.staleMs ?? env.ACCELERATOR_LOCK_STALE_MS;
  const owner: LeaseOwner = {
    pid: process.pid,
    token: randomUUID(),
    kind,
    acquiredAtMs: Date.now(),
  };

  await mkdir(path.dirname(lockPath), { recursive: true });
  await acquire(lockPath, owner, pollMs, staleMs, {
    timeoutMs: options.waitTimeoutMs ?? env.ACCELERATOR_WAIT_TIMEOUT_MS,
    heartbeatMs: options.heartbeatMs ?? 30_000,
    onWait: options.onWait,
  });
  try {
    return await run();
  } finally {
    await release(lockPath, owner.token);
  }
}

async function acquire(
  lockPath: string,
  owner: LeaseOwner,
  pollMs: number,
  staleMs: number,
  wait: { timeoutMs: number; heartbeatMs: number; onWait?: () => Promise<void> },
) {
  const deadline = Date.now() + wait.timeoutMs;
  let nextHeartbeatAt = 0;
  while (true) {
    if (Date.now() >= deadline) throw new Error("Generation accelerator resource wait timed out before provider invocation");
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ ...owner, acquiredAtMs: Date.now() })}\n`);
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }

    if (await staleOwnerCanBeReclaimed(lockPath, staleMs)) {
      try {
        await unlink(lockPath);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      continue;
    }
    if (Date.now() >= nextHeartbeatAt) {
      await wait.onWait?.();
      nextHeartbeatAt = Date.now() + wait.heartbeatMs;
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

async function staleOwnerCanBeReclaimed(lockPath: string, staleMs: number) {
  let ageMs: number;
  try {
    ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
  if (ageMs < staleMs) return false;

  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LeaseOwner>;
    return typeof owner.pid !== "number" || !pidIsAlive(owner.pid);
  } catch {
    return true;
  }
}

async function release(lockPath: string, token: string) {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LeaseOwner>;
    if (owner.token !== token) return;
    await unlink(lockPath);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

function pidIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

function hasCode(error: unknown, code: string) {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
