import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { constants } from "node:os";
import path from "node:path";
import { env } from "../env";

type GenerationKind = "image" | "video";
type LeaseOptions = {
  readonly lockPath?: string;
  readonly pollMs?: number;
  readonly waitTimeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly onWait?: () => Promise<void>;
};

type NativeFlock = { tryAcquire(fd: number): boolean };
// Keep this native surface local: adding Bun's global types would change Node
// test fetch/process contracts throughout Gen. The real worker proves this ABI.
type NativeFfiModule = {
  FFIType: { i32: number; ptr: number };
  read: { i32(pointer: number): number };
  dlopen(library: string, symbols: Record<string, { args: number[]; returns: number }>): {
    symbols: Record<string, (...args: number[]) => number | null>;
  };
};
let nativeFlock: Promise<NativeFlock> | undefined;

async function loadNativeFlock(): Promise<NativeFlock> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") throw new Error(`Generation accelerator locking is unsupported on ${platform}`);
  // Keep Bun's native import lazy: Vitest runs in Node, while the actual worker
  // and the native process regression run in Bun. There is no alternate lock.
  const moduleName = "bun:ffi";
  const { dlopen, FFIType, read } = await import(/* @vite-ignore */ moduleName) as NativeFfiModule;
  const errnoSymbol = platform === "darwin" ? "__error" : "__errno_location";
  const library = dlopen(platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoSymbol]: { args: [], returns: FFIType.ptr },
  });
  return {
    tryAcquire(fd) {
      // LOCK_EX | LOCK_NB: never block the event loop or prevent Main's waiting
      // authority checks. Fetch errno synchronously on the calling native thread.
      if (library.symbols.flock(fd, 2 | 4) === 0) return true;
      const pointer = library.symbols[errnoSymbol]();
      if (pointer === null) throw new Error("Generation accelerator lock errno is unavailable");
      const errno = read.i32(pointer);
      if ([constants.errno.EAGAIN, constants.errno.EWOULDBLOCK, constants.errno.EINTR].includes(errno)) return false;
      throw new Error(`Generation accelerator native lock failed (errno ${errno})`);
    },
  };
}

// SPEC: all host image/video backends hold the same OS advisory lock for their
// full submit/poll window. The kernel releases it on close or process death.
// INVARIANT: the lock inode is permanent. Unlinking it allows a late stale-owner
// reclaimer to delete a successor's lock and lets two workers enter together.
export async function withGenerationAcceleratorLease<T>(
  kind: GenerationKind,
  run: () => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  // Native loading errors fail before entering the protected callback. Never
  // fall back to existence/PID/mtime checks, which cannot atomically reclaim.
  const locker = await (nativeFlock ??= loadNativeFlock());
  const lockPath = options.lockPath ?? env.ACCELERATOR_LOCK_PATH;
  const pollMs = options.pollMs ?? env.ACCELERATOR_LOCK_POLL_MS;
  const deadline = Date.now() + (options.waitTimeoutMs ?? env.ACCELERATOR_WAIT_TIMEOUT_MS);
  let nextHeartbeatAt = 0;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, "a+", 0o600);
  try {
    while (true) {
      if (Date.now() >= deadline) throw new Error("Generation accelerator resource wait timed out before provider invocation");
      if (locker.tryAcquire(handle.fd)) break;
      if (Date.now() >= nextHeartbeatAt) {
        await options.onWait?.();
        nextHeartbeatAt = Date.now() + (options.heartbeatMs ?? 30_000);
      }
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    }
    // Informational only: old metadata, PID reuse and wall clocks never decide
    // authority. Updating the held inode does not replace it.
    await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token: randomUUID(), kind, acquiredAtMs: Date.now() })}\n`);
    return await run();
  } finally {
    await handle.close();
  }
}
