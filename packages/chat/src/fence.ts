// SPEC: 「哪些写入已经被禁止」在 Chat 只有这一份权威。用户 / 关系 / Turn / attempt
// 四个 scope 共用一套文件布局、一把序列化锁和一个判定函数；agent-run-store、
// agent-runtime/workspace、agent-runtime/engine、agent-runner 都只能问这里。
//
// INTENT: 这条规则过去有四份实现 —— store 的 run-tombstones 与 user-tombstones、
//   workspace 在 canonicalRoot 下另写的 `.user-tombstones`、engine 的内存 purging
//   Map、runner 的 activeRuns。两个用户 tombstone 文件语义相同却互不检查：先经
//   workspace 删号的用户，store 依旧放行 admission。现在只留 CHAT_FS_ROOT 下的
//   一份，四个 module 得出同一个答案。
//
// INVARIANT: 目录布局不变（user-tombstones / run-tombstones 沿用原路径），因为
//   开发与预发机器上已存在这些文件；改名会让已删除用户的 fence 被静默遗忘。
//
// 持久 fence 与临时 fence 的分工：
// - user / turn / attempt 的 fence 是终局事实，写文件。账号擦除与产品更正过后，
//   这些 scope 永远不该再被写入。
// - relationship 只有临时 fence。关系级 purge 是产品更正，purge 结束后该关系必须
//   能被重建、能继续聊天，所以它不留文件；purge 期间的拒绝由 withDrainFence 承担。
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";

export type FenceScope =
  | { scope: "user"; userId: string }
  | { scope: "relationship"; userId: string; characterId: string }
  | { scope: "turn"; turnId: string }
  | { scope: "attempt"; turnId: string; attempt: number };

interface UserFenceRecord {
  schemaVersion: 1;
  deletedAt: string;
}

interface TurnFenceRecord {
  schemaVersion: 1;
  /** null 表示整个 Turn；数字表示「含该 attempt 及更早」被 fence。 */
  throughAttempt: number | null;
  updatedAt: string;
}

const locks = new Map<string, Promise<void>>();
const draining = new Map<string, number>();

function safeSegment(value: string): string {
  if (!value || !/^[A-Za-z0-9._:-]+$/u.test(value) || value.includes("..")) {
    throw new Error(`unsafe Chat fence path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function userFenceFile(userId: string): string {
  return path.join(path.resolve(env.CHAT_FS_ROOT), "user-tombstones", `${sha256(userId)}.json`);
}

function turnFenceFile(turnId: string): string {
  return path.join(path.resolve(env.CHAT_FS_ROOT), "run-tombstones", `${safeSegment(turnId)}.json`);
}

/** One key per fenced thing, so a drain fence and a durable fence agree on identity. */
export function fenceKey(scope: FenceScope): string {
  switch (scope.scope) {
    case "user":
      return `user:${scope.userId}`;
    case "relationship":
      return `relationship:${scope.userId}\0${scope.characterId}`;
    case "turn":
      return `turn:${scope.turnId}`;
    case "attempt":
      return `turn:${scope.turnId}`;
  }
}

/**
 * Serialize writers that share a fence key. Admission is a fence read followed
 * by a write, so AgentRun admission takes the same lock as the fence itself.
 */
export async function withFenceLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const mine = Promise.withResolvers<void>();
  const tail = previous.then(() => mine.promise);
  locks.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    mine.resolve();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** Permanently reject every later write for one user. Account erasure only. */
export async function fenceUser(userId: string): Promise<void> {
  await withFenceLock(fenceKey({ scope: "user", userId }), async () => {
    await atomicWriteJson(userFenceFile(userId), {
      schemaVersion: 1,
      deletedAt: new Date().toISOString(),
    } satisfies UserFenceRecord);
  });
}

/** Permanently reject every later write for one Turn, at any attempt. */
export async function fenceTurn(turnId: string): Promise<void> {
  await withFenceLock(fenceKey({ scope: "turn", turnId }), () => writeTurnFence(turnId, null));
}

/** Regeneration fences superseded attempts and leaves the newer attempt legal. */
export async function fenceAttemptsThrough(turnId: string, attempt: number): Promise<void> {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("AgentRun fence requires a positive attempt");
  }
  await withFenceLock(fenceKey({ scope: "turn", turnId }), () => writeTurnFence(turnId, attempt));
}

/** Callers already holding the fence lock for this Turn. */
export async function writeTurnFence(
  turnId: string,
  throughAttempt: number | null,
): Promise<void> {
  const prior = await readTurnFence(turnId);
  const next = prior?.throughAttempt === null || throughAttempt === null
    ? null
    : Math.max(prior?.throughAttempt ?? 0, throughAttempt);
  if (prior && prior.throughAttempt === next) return;
  await atomicWriteJson(turnFenceFile(turnId), {
    schemaVersion: 1,
    throughAttempt: next,
    updatedAt: new Date().toISOString(),
  } satisfies TurnFenceRecord);
}

export async function isFenced(scope: FenceScope): Promise<boolean> {
  if ((draining.get(fenceKey(scope)) ?? 0) > 0) return true;
  switch (scope.scope) {
    case "user":
      return exists(userFenceFile(scope.userId));
    // A relationship purge must leave the relationship rebuildable, so it is
    // only ever fenced for the duration of the drain above.
    case "relationship":
      return false;
    case "turn":
      return (await readTurnFence(scope.turnId))?.throughAttempt === null;
    case "attempt": {
      const fence = await readTurnFence(scope.turnId);
      return Boolean(fence && (fence.throughAttempt === null || scope.attempt <= fence.throughAttempt));
    }
  }
}

export async function assertNotFenced(scopes: readonly FenceScope[]): Promise<void> {
  for (const scope of scopes) {
    if (await isFenced(scope)) throw new Error(`${describe(scope)} is fenced`);
  }
}

/**
 * Hold a fence for the duration of a purge. Writers are rejected while the
 * bytes are being removed, and the scope becomes writable again afterwards
 * unless a durable fence also exists.
 */
export async function withDrainFence<T>(scope: FenceScope, run: () => Promise<T>): Promise<T> {
  const key = fenceKey(scope);
  draining.set(key, (draining.get(key) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const count = draining.get(key) ?? 0;
    if (count <= 1) draining.delete(key);
    else draining.set(key, count - 1);
  }
}

function describe(scope: FenceScope): string {
  switch (scope.scope) {
    case "user":
      return "Chat user";
    case "relationship":
      return "Chat relationship";
    case "turn":
      return `AgentRun turn ${scope.turnId}`;
    case "attempt":
      return `AgentRun ${scope.turnId}:${scope.attempt}`;
  }
}

async function readTurnFence(turnId: string): Promise<TurnFenceRecord | null> {
  try {
    return JSON.parse(await readFile(turnFenceFile(turnId), "utf8")) as TurnFenceRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const handle = await open(temporary, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}
