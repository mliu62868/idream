// SPEC: Chat persists only Agent execution facts. Product sessions, Turns,
// attachments and billing never live under CHAT_FS_ROOT.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatAuthoritySnapshot } from "@idream/shared/bff";
import type { ChatExecutionSnapshot, ChatTerminalCommit } from "@idream/shared/contracts";
import { env } from "./env.js";
import {
  assertNotFenced,
  fenceAttemptsThrough,
  fenceKey,
  fenceTurn,
  fenceUser,
  isFenced,
  withFenceLock,
  writeTurnFence,
} from "./fence.js";

export interface AgentRunInput {
  schemaVersion: 1;
  admittedAt: string;
  snapshot: ChatExecutionSnapshot;
  authority: ChatAuthoritySnapshot;
}

export interface AgentRunCompletion {
  schemaVersion: 1;
  attemptId: string;
  outcome: "committed" | "failed" | "cancelled";
  evidence: Record<string, unknown>;
  completedAt: string;
  expiresAt: string;
}

export interface AgentRunProposal {
  schemaVersion: 1;
  attemptId: string;
  terminal: ChatTerminalCommit;
  proposedAt: string;
}

export interface AgentRunEvent {
  schemaVersion: 1;
  sequence: number;
  occurredAt: string;
  kind: string;
  payload: unknown;
}

export interface AgentRunRecoveryCandidate {
  turnId: string;
  attempt: number;
  userId: string;
}

export interface AgentRunRecoveryFailure {
  evidencePath: string;
  reason: string;
}

export interface AgentRunRecoveryScan {
  runs: AgentRunRecoveryCandidate[];
  failures: AgentRunRecoveryFailure[];
}

interface AgentRunIndex {
  schemaVersion: 1;
  turnId: string;
  attempt: number;
  userId: string;
  snapshotDigest: string;
  terminal: boolean;
  expiresAt: string | null;
}

const FAILED_TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function safeSegment(value: string): string {
  if (!value || !/^[A-Za-z0-9._:-]+$/u.test(value) || value.includes("..")) {
    throw new Error(`unsafe AgentRun path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function runDir(turnId: string, attempt: number): string {
  const root = path.resolve(env.CHAT_FS_ROOT);
  const dir = path.resolve(root, "runs", safeSegment(turnId), safeSegment(String(attempt)));
  if (!dir.startsWith(`${root}${path.sep}`)) throw new Error("AgentRun path escapes CHAT_FS_ROOT");
  return dir;
}

function inputFile(turnId: string, attempt: number): string {
  return path.join(runDir(turnId, attempt), "input.json");
}

function eventsFile(turnId: string, attempt: number): string {
  return path.join(runDir(turnId, attempt), "events.jsonl");
}

function completionFile(turnId: string, attempt: number): string {
  return path.join(runDir(turnId, attempt), "completion.json");
}

function proposalFile(turnId: string, attempt: number): string {
  return path.join(runDir(turnId, attempt), "proposal.json");
}

function assistantIndexFile(assistantMessageId: string): string {
  const root = path.resolve(env.CHAT_FS_ROOT);
  return path.join(root, "run-index", "assistant", `${safeSegment(assistantMessageId)}.json`);
}

export async function admitAgentRun(
  input: AgentRunInput,
): Promise<{ duplicate: boolean; terminal: boolean; tombstoned?: true }> {
  return withFenceLock(
    fenceKey({ scope: "user", userId: input.snapshot.userId }),
    () => withFenceLock(
      fenceKey({ scope: "turn", turnId: input.snapshot.turnId }),
      () => admitAgentRunUnlocked(input),
    ),
  );
}

async function admitAgentRunUnlocked(
  input: AgentRunInput,
): Promise<{ duplicate: boolean; terminal: boolean; tombstoned?: true }> {
  if (
    await isFenced({ scope: "user", userId: input.snapshot.userId }) ||
    await isFenced({
      scope: "attempt",
      turnId: input.snapshot.turnId,
      attempt: input.snapshot.attempt,
    })
  ) {
    return { duplicate: false, terminal: false, tombstoned: true };
  }
  const snapshotDigest = admissionIdentity(input);
  const existingIndex = await readAgentRunIndex(input.snapshot.assistantMessageId);
  if (existingIndex) {
    const exactIdentity =
      existingIndex.turnId !== input.snapshot.turnId
      ? false
      : existingIndex.attempt === input.snapshot.attempt
        && existingIndex.userId === input.snapshot.userId
        && existingIndex.snapshotDigest === snapshotDigest;
    const supersedesPriorAttempt =
      existingIndex.turnId === input.snapshot.turnId &&
      existingIndex.userId === input.snapshot.userId &&
      existingIndex.attempt < input.snapshot.attempt;
    // INVARIANT: Main signs the monotonically newer product attempt. It may
    // arrive after Main's terminal ACK but before Chat has marked the prior
    // local trace complete; that local bookkeeping lag must not reject regen.
    if (!exactIdentity && !supersedesPriorAttempt) {
      throw new Error("AgentRun identity was reused with different input");
    }
    if (exactIdentity && existingIndex.terminal) return { duplicate: true, terminal: true };
  }
  const file = inputFile(input.snapshot.turnId, input.snapshot.attempt);
  const encoded = `${JSON.stringify(input)}\n`;
  try {
    const existing = await readFile(file, "utf8");
    const persisted = JSON.parse(existing) as AgentRunInput;
    if (admissionIdentity(persisted) !== admissionIdentity(input)) {
      throw new Error("AgentRun identity was reused with different input");
    }
    await writeAgentRunIndex(input, false);
    return {
      duplicate: true,
      terminal: Boolean(await readAgentRunCompletion(input.snapshot.turnId, input.snapshot.attempt)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(file, encoded);
  await writeAgentRunIndex(input, false);
  return { duplicate: false, terminal: false };
}

export async function findAgentRunByAssistant(assistantMessageId: string): Promise<{
  turnId: string;
  attempt: number;
  userId: string;
} | null> {
  const index = await readAgentRunIndex(assistantMessageId);
  return index && new Date(index.expiresAt ?? 0).getTime() >= Date.now()
    ? { turnId: index.turnId, attempt: index.attempt, userId: index.userId }
    : index && !index.terminal
      ? { turnId: index.turnId, attempt: index.attempt, userId: index.userId }
      : null;
}

export async function readAgentRunInput(turnId: string, attempt: number): Promise<AgentRunInput | null> {
  try {
    return JSON.parse(await readFile(inputFile(turnId, attempt), "utf8")) as AgentRunInput;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function appendAgentRunEvent(
  turnId: string,
  attempt: number,
  kind: string,
  payload: unknown,
): Promise<AgentRunEvent> {
  return withFenceLock(fenceKey({ scope: "turn", turnId }), async () => {
    await assertRunWritable(turnId, attempt);
    return appendAgentRunEventUnlocked(turnId, attempt, kind, payload);
  });
}

async function appendAgentRunEventUnlocked(
  turnId: string,
  attempt: number,
  kind: string,
  payload: unknown,
): Promise<AgentRunEvent> {
  const file = eventsFile(turnId, attempt);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const sequence = await nextSequence(file);
  const event: AgentRunEvent = {
    schemaVersion: 1,
    sequence,
    occurredAt: new Date().toISOString(),
    kind,
    payload,
  };
  const handle = await open(file, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(event)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return event;
}

export async function completeAgentRun(
  turnId: string,
  attempt: number,
  completion: Omit<AgentRunCompletion, "schemaVersion" | "expiresAt">,
): Promise<void> {
  return withFenceLock(fenceKey({ scope: "turn", turnId }), async () => {
    await assertRunWritable(turnId, attempt);
    const input = await readAgentRunInput(turnId, attempt);
    if (!input) throw new Error("AgentRun input is missing at completion");
    const expiresAt = new Date(
      new Date(completion.completedAt).getTime() + FAILED_TRACE_RETENTION_MS,
    ).toISOString();
    await writeAgentRunIndex(input, true, expiresAt);
    if (completion.outcome === "committed") {
      await rm(runDir(turnId, attempt), { recursive: true, force: true });
      return;
    }
    const record: AgentRunCompletion = {
      schemaVersion: 1,
      ...completion,
      expiresAt,
    };
    const existing = await readAgentRunCompletion(turnId, attempt);
    if (existing && sha256(JSON.stringify(existing)) !== sha256(JSON.stringify(record))) {
      throw new Error("AgentRun completion evidence is immutable");
    }
    if (!existing) await atomicWrite(completionFile(turnId, attempt), `${JSON.stringify(record)}\n`);
    await rm(proposalFile(turnId, attempt), { force: true });
  });
}

/** Main retries must replay these exact bytes; the proposal is never replaced. */
export async function writeAgentRunProposal(
  turnId: string,
  attempt: number,
  proposal: AgentRunProposal,
): Promise<void> {
  return withFenceLock(fenceKey({ scope: "turn", turnId }), async () => {
    await assertRunWritable(turnId, attempt);
    await writeAgentRunProposalUnlocked(turnId, attempt, proposal);
  });
}

async function writeAgentRunProposalUnlocked(
  turnId: string,
  attempt: number,
  proposal: AgentRunProposal,
): Promise<void> {
  const file = proposalFile(turnId, attempt);
  const existing = await readAgentRunProposal(turnId, attempt);
  if (existing) {
    if (sha256(JSON.stringify(existing)) !== sha256(JSON.stringify(proposal))) {
      throw new Error("AgentRun terminal proposal is immutable");
    }
    return;
  }
  await atomicWrite(file, `${JSON.stringify(proposal)}\n`);
}

export async function readAgentRunProposal(
  turnId: string,
  attempt: number,
): Promise<AgentRunProposal | null> {
  try {
    return JSON.parse(await readFile(proposalFile(turnId, attempt), "utf8")) as AgentRunProposal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readAgentRunCompletion(
  turnId: string,
  attempt: number,
): Promise<AgentRunCompletion | null> {
  try {
    return parseAgentRunCompletion(
      JSON.parse(await readFile(completionFile(turnId, attempt), "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Startup repair input: complete input + no accepted or rejected completion. */
export async function listIncompleteAgentRuns(): Promise<AgentRunRecoveryScan> {
  const failures = await cleanupExpiredAgentRuns();
  const runsRoot = path.join(path.resolve(env.CHAT_FS_ROOT), "runs");
  const runs: AgentRunRecoveryCandidate[] = [];
  for (const turn of await directories(runsRoot)) {
    for (const attemptName of await directories(path.join(runsRoot, turn))) {
      const attempt = Number(attemptName);
      if (!Number.isSafeInteger(attempt) || attempt < 1) continue;
      let input: AgentRunInput | null;
      try {
        input = await readAgentRunInput(turn, attempt);
      } catch (error) {
        // INVARIANT: one corrupt local trace is evidence to repair, not a
        // reason to starve every later recoverable AgentRun.
        failures.push(recoveryFailure(
          path.join("runs", turn, attemptName, "input.json"),
          error,
          "invalid AgentRun input",
        ));
        continue;
      }
      if (!input) continue;
      try {
        // A fenced user's leftover input must never be recovered into a live
        // run; that is the one path that can recreate erased bytes at boot.
        if (
          !await exists(completionFile(turn, attempt))
          && !await isFenced({ scope: "attempt", turnId: turn, attempt })
          && !await isFenced({ scope: "user", userId: input.snapshot.userId })
        ) {
          runs.push({ turnId: turn, attempt, userId: input.snapshot.userId });
        }
      } catch (error) {
        failures.push(recoveryFailure(
          path.join("runs", turn, attemptName),
          error,
          "invalid AgentRun recovery evidence",
        ));
      }
    }
  }
  return { runs, failures };
}

async function cleanupExpiredAgentRuns(now = Date.now()): Promise<AgentRunRecoveryFailure[]> {
  const root = path.resolve(env.CHAT_FS_ROOT);
  const failures: AgentRunRecoveryFailure[] = [];
  const runsRoot = path.join(root, "runs");
  for (const turnId of await directories(runsRoot)) {
    for (const attemptName of await directories(path.join(runsRoot, turnId))) {
      const attempt = Number(attemptName);
      if (!Number.isSafeInteger(attempt) || attempt < 1) continue;
      try {
        const completion = await readAgentRunCompletion(turnId, attempt);
        if (!completion || Date.parse(completion.expiresAt) > now) continue;
        await rm(runDir(turnId, attempt), { recursive: true, force: true });
      } catch (error) {
        // INVARIANT: cleanup never destroys evidence it cannot decode, and a
        // single bad trace never blocks later recovery candidates.
        failures.push(recoveryFailure(
          path.join("runs", turnId, attemptName, "completion.json"),
          error,
          "invalid AgentRun completion evidence",
        ));
      }
    }
  }
  const indexRoot = path.join(root, "run-index", "assistant");
  for (const name of await files(indexRoot)) {
    const target = path.join(indexRoot, name);
    try {
      const index = await readAgentRunIndexFile(target);
      if (!index?.terminal || !index.expiresAt || Date.parse(index.expiresAt) > now) continue;
      await rm(target, { force: true });
    } catch (error) {
      failures.push(recoveryFailure(
        path.join("run-index", "assistant", name),
        error,
        "invalid AgentRun assistant index",
      ));
    }
  }
  return failures;
}

/** Account erasure removes only local execution evidence for the exact user. */
export async function purgeAgentRunsForUser(userId: string): Promise<number> {
  await fenceUser(userId);
  return withFenceLock(
    fenceKey({ scope: "user", userId }),
    () => purgeAgentRunsForUserUnlocked(userId),
  );
}

async function purgeAgentRunsForUserUnlocked(userId: string): Promise<number> {
  const runsRoot = path.join(path.resolve(env.CHAT_FS_ROOT), "runs");
  let purged = 0;
  for (const turnId of await directories(runsRoot)) {
    let belongsToUser = false;
    for (const attemptName of await directories(path.join(runsRoot, turnId))) {
      const attempt = Number(attemptName);
      if (!Number.isSafeInteger(attempt) || attempt < 1) continue;
      const input = await readAgentRunInput(turnId, attempt);
      if (input?.snapshot.userId !== userId) continue;
      belongsToUser = true;
      break;
    }
    if (!belongsToUser) continue;
    purged += await purgeAgentRunsForTurn(turnId);
  }
  await purgeAgentRunIndexes((index) => index.userId === userId);
  return purged;
}

/** Product correction erases every local attempt and index for one exact Turn. */
export async function purgeAgentRunsForTurn(turnId: string): Promise<number> {
  await fenceTurn(turnId);
  return withFenceLock(
    fenceKey({ scope: "turn", turnId }),
    () => purgeAgentRunDirectoriesUnlocked(turnId, null),
  );
}

/** Regeneration erases only superseded attempts and leaves the new attempt legal. */
export async function purgeAgentRunsThroughAttempt(
  turnId: string,
  throughAttempt: number,
): Promise<number> {
  await fenceAttemptsThrough(turnId, throughAttempt);
  return withFenceLock(
    fenceKey({ scope: "turn", turnId }),
    () => purgeAgentRunDirectoriesUnlocked(turnId, throughAttempt),
  );
}

// INVARIANT: 一次写入要同时过 attempt fence 和「这条 run 属于谁」的用户 fence。
// 只查 attempt 的话，账号擦除已经 fence 掉该用户、却仍在跑的那一轮，还能把
// proposal 和 completion 写回刚被清空的目录里。
async function assertRunWritable(turnId: string, attempt: number): Promise<void> {
  const input = await readAgentRunInput(turnId, attempt);
  await assertNotFenced([
    { scope: "attempt", turnId, attempt },
    ...(input ? [{ scope: "user", userId: input.snapshot.userId } as const] : []),
  ]);
}

async function purgeAgentRunDirectoriesUnlocked(
  turnId: string,
  throughAttempt: number | null,
): Promise<number> {
  const safeTurnId = safeSegment(turnId);
  const turnRoot = path.join(path.resolve(env.CHAT_FS_ROOT), "runs", safeTurnId);
  const attempts = await directories(turnRoot);
  let purged = 0;
  for (const attemptName of attempts) {
    const attempt = Number(attemptName);
    if (!Number.isSafeInteger(attempt) || attempt < 1) continue;
    if (throughAttempt !== null && attempt > throughAttempt) continue;
    const input = await readAgentRunInput(safeTurnId, attempt);
    if (input) {
      await rm(assistantIndexFile(input.snapshot.assistantMessageId), { force: true });
      purged += 1;
    }
    await rm(runDir(safeTurnId, attempt), { recursive: true, force: true });
  }
  await purgeAgentRunIndexes((index) =>
    index.turnId === safeTurnId
    && (throughAttempt === null || index.attempt <= throughAttempt));
  if (throughAttempt === null) await rm(turnRoot, { recursive: true, force: true });
  return purged;
}

async function purgeAgentRunIndexes(
  matches: (index: AgentRunIndex) => boolean,
): Promise<void> {
  const root = path.join(path.resolve(env.CHAT_FS_ROOT), "run-index", "assistant");
  for (const name of await files(root)) {
    const target = path.join(root, name);
    const index = await readJsonFile<AgentRunIndex>(target);
    if (index && matches(index)) await rm(target, { force: true });
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const handle = await open(temporary, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

async function nextSequence(file: string): Promise<number> {
  try {
    const raw = await readFile(file, "utf8");
    const last = raw.trim().split("\n").at(-1);
    if (!last) return 1;
    const parsed = JSON.parse(last) as { sequence?: unknown };
    return typeof parsed.sequence === "number" ? parsed.sequence + 1 : 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 1;
    throw error;
  }
}

async function directories(parent: string): Promise<string[]> {
  try {
    return (await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function files(parent: string): Promise<string[]> {
  try {
    return (await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readAgentRunIndex(assistantMessageId: string): Promise<AgentRunIndex | null> {
  return readAgentRunIndexFile(assistantIndexFile(assistantMessageId));
}

async function readAgentRunIndexFile(file: string): Promise<AgentRunIndex | null> {
  const value = await readJsonFile<unknown>(file);
  return value === null ? null : parseAgentRunIndex(value);
}

async function writeAgentRunIndex(
  input: AgentRunInput,
  terminal: boolean,
  expiresAt: string | null = null,
): Promise<void> {
  const existing = await readAgentRunIndex(input.snapshot.assistantMessageId);
  if (
    existing &&
    existing.turnId === input.snapshot.turnId &&
    existing.userId === input.snapshot.userId &&
    existing.attempt > input.snapshot.attempt
  ) {
    // Main may start attempt N+1 immediately after accepting N's terminal,
    // before Chat finishes N's local cleanup. Never let that delayed cleanup
    // move the assistant index backwards.
    return;
  }
  await atomicWrite(assistantIndexFile(input.snapshot.assistantMessageId), `${JSON.stringify({
    schemaVersion: 1,
    turnId: input.snapshot.turnId,
    attempt: input.snapshot.attempt,
    userId: input.snapshot.userId,
    snapshotDigest: admissionIdentity(input),
    terminal,
    expiresAt,
  } satisfies AgentRunIndex)}\n`);
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function admissionIdentity(input: AgentRunInput): string {
  // INTENT: the first Main-signed authority accepted for this exact Turn attempt
  // is frozen in input.json. A lost HTTP ACK may be retried after mutable user or
  // entitlement facts change; that retry must discover the existing run instead
  // of replacing it or rejecting exact product identity.
  return sha256(JSON.stringify(input.snapshot));
}

function parseAgentRunCompletion(value: unknown): AgentRunCompletion {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.attemptId !== "string"
    || !value.attemptId
    || !["committed", "failed", "cancelled"].includes(String(value.outcome))
    || !isRecord(value.evidence)
    || !isDateString(value.completedAt)
    || !isDateString(value.expiresAt)
    || Date.parse(value.expiresAt) < Date.parse(value.completedAt)
  ) {
    throw new Error("invalid AgentRun completion evidence");
  }
  return value as unknown as AgentRunCompletion;
}

function parseAgentRunIndex(value: unknown): AgentRunIndex {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.turnId !== "string"
    || !value.turnId
    || !Number.isSafeInteger(value.attempt)
    || Number(value.attempt) < 1
    || typeof value.userId !== "string"
    || !value.userId
    || typeof value.snapshotDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.snapshotDigest)
    || typeof value.terminal !== "boolean"
    || (value.terminal ? !isDateString(value.expiresAt) : value.expiresAt !== null)
  ) {
    throw new Error("invalid AgentRun assistant index");
  }
  return value as unknown as AgentRunIndex;
}

function recoveryFailure(
  evidencePath: string,
  error: unknown,
  fallbackReason: string,
): AgentRunRecoveryFailure {
  return {
    evidencePath,
    reason: error instanceof Error ? error.message : fallbackReason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

