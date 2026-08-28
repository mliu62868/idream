// SPEC: Chat persists only Agent execution facts. Product sessions, Turns,
// attachments and billing never live under CHAT_FS_ROOT.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatAuthoritySnapshot } from "@idream/shared/bff";
import type { ChatExecutionSnapshot, ChatTerminalCommit } from "@idream/shared/contracts";
import { env } from "./env.js";

export interface AgentRunInput {
  schemaVersion: 1;
  admittedAt: string;
  snapshot: ChatExecutionSnapshot;
  authority: ChatAuthoritySnapshot;
}

export interface AgentRunTerminal {
  schemaVersion: 1;
  attemptId: string;
  outcome: "committed" | "failed" | "cancelled";
  mainCommit: unknown;
  evidence: Record<string, unknown>;
  completedAt: string;
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

interface AgentRunTombstone {
  schemaVersion: 1;
  throughAttempt: number | null;
  updatedAt: string;
}

const admissionTails = new Map<string, Promise<void>>();

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

function terminalFile(turnId: string, attempt: number): string {
  return path.join(runDir(turnId, attempt), "terminal.json");
}

function proposalFile(turnId: string, attempt: number): string {
  return path.join(runDir(turnId, attempt), "proposal.json");
}

function assistantIndexFile(assistantMessageId: string): string {
  const root = path.resolve(env.CHAT_FS_ROOT);
  return path.join(root, "run-index", "assistant", `${safeSegment(assistantMessageId)}.json`);
}

function tombstoneFile(turnId: string): string {
  const root = path.resolve(env.CHAT_FS_ROOT);
  return path.join(root, "run-tombstones", `${safeSegment(turnId)}.json`);
}

function userTombstoneFile(userId: string): string {
  const root = path.resolve(env.CHAT_FS_ROOT);
  return path.join(root, "user-tombstones", `${sha256(userId)}.json`);
}

export async function admitAgentRun(
  input: AgentRunInput,
): Promise<{ duplicate: boolean; terminal: boolean; tombstoned?: true }> {
  return withAdmissionLock(
    `user:${input.snapshot.userId}`,
    () => withAdmissionLock(
      `turn:${input.snapshot.turnId}`,
      () => admitAgentRunUnlocked(input),
    ),
  );
}

async function admitAgentRunUnlocked(
  input: AgentRunInput,
): Promise<{ duplicate: boolean; terminal: boolean; tombstoned?: true }> {
  if (
    await isUserTombstoned(input.snapshot.userId) ||
    await isAgentRunTombstoned(input.snapshot.turnId, input.snapshot.attempt)
  ) {
    return { duplicate: false, terminal: false, tombstoned: true };
  }
  const file = inputFile(input.snapshot.turnId, input.snapshot.attempt);
  const encoded = `${JSON.stringify(input)}\n`;
  try {
    const existing = await readFile(file, "utf8");
    const persisted = JSON.parse(existing) as AgentRunInput;
    if (admissionIdentity(persisted) !== admissionIdentity(input)) {
      throw new Error("AgentRun identity was reused with different input");
    }
    await atomicWrite(assistantIndexFile(input.snapshot.assistantMessageId), `${JSON.stringify({
      turnId: input.snapshot.turnId,
      attempt: input.snapshot.attempt,
      userId: input.snapshot.userId,
    })}\n`);
    return {
      duplicate: true,
      terminal: Boolean(await readAgentRunTerminal(input.snapshot.turnId, input.snapshot.attempt)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(file, encoded);
  await atomicWrite(assistantIndexFile(input.snapshot.assistantMessageId), `${JSON.stringify({
    turnId: input.snapshot.turnId,
    attempt: input.snapshot.attempt,
    userId: input.snapshot.userId,
  })}\n`);
  return { duplicate: false, terminal: false };
}

export async function findAgentRunByAssistant(assistantMessageId: string): Promise<{
  turnId: string;
  attempt: number;
  userId: string;
} | null> {
  try {
    return JSON.parse(await readFile(assistantIndexFile(assistantMessageId), "utf8")) as {
      turnId: string;
      attempt: number;
      userId: string;
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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
  return withAdmissionLock(`turn:${turnId}`, async () => {
    assertNotTombstoned(turnId, attempt, await readAgentRunTombstone(turnId));
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

export async function writeAgentRunTerminal(
  turnId: string,
  attempt: number,
  terminal: AgentRunTerminal,
): Promise<void> {
  return withAdmissionLock(`turn:${turnId}`, async () => {
    assertNotTombstoned(turnId, attempt, await readAgentRunTombstone(turnId));
    await writeAgentRunTerminalUnlocked(turnId, attempt, terminal);
  });
}

async function writeAgentRunTerminalUnlocked(
  turnId: string,
  attempt: number,
  terminal: AgentRunTerminal,
): Promise<void> {
  const file = terminalFile(turnId, attempt);
  const existing = await readAgentRunTerminal(turnId, attempt);
  if (existing) {
    if (sha256(JSON.stringify(existing)) !== sha256(JSON.stringify(terminal))) {
      throw new Error("AgentRun terminal evidence is immutable");
    }
    return;
  }
  await atomicWrite(file, `${JSON.stringify(terminal)}\n`);
}

/** Main retries must replay these exact bytes; the proposal is never replaced. */
export async function writeAgentRunProposal(
  turnId: string,
  attempt: number,
  proposal: AgentRunProposal,
): Promise<void> {
  return withAdmissionLock(`turn:${turnId}`, async () => {
    assertNotTombstoned(turnId, attempt, await readAgentRunTombstone(turnId));
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

export async function readAgentRunTerminal(
  turnId: string,
  attempt: number,
): Promise<AgentRunTerminal | null> {
  try {
    return JSON.parse(await readFile(terminalFile(turnId, attempt), "utf8")) as AgentRunTerminal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Startup repair input: complete input + no terminal. */
export async function listIncompleteAgentRuns(): Promise<Array<{ turnId: string; attempt: number }>> {
  const runsRoot = path.join(path.resolve(env.CHAT_FS_ROOT), "runs");
  const result: Array<{ turnId: string; attempt: number }> = [];
  for (const turn of await directories(runsRoot)) {
    for (const attemptName of await directories(path.join(runsRoot, turn))) {
      const attempt = Number(attemptName);
      if (!Number.isSafeInteger(attempt) || attempt < 1) continue;
      const input = await exists(inputFile(turn, attempt));
      const terminal = await exists(terminalFile(turn, attempt));
      if (input && !terminal && !await isAgentRunTombstoned(turn, attempt)) {
        result.push({ turnId: turn, attempt });
      }
    }
  }
  return result;
}

/** Account erasure removes only local execution evidence for the exact user. */
export async function purgeAgentRunsForUser(userId: string): Promise<number> {
  return withAdmissionLock(`user:${userId}`, async () => {
    await atomicWrite(userTombstoneFile(userId), `${JSON.stringify({
      schemaVersion: 1,
      deletedAt: new Date().toISOString(),
    })}\n`);
    return purgeAgentRunsForUserUnlocked(userId);
  });
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
  return purged;
}

/** Product correction erases every local attempt and index for one exact Turn. */
export async function purgeAgentRunsForTurn(turnId: string): Promise<number> {
  return withAdmissionLock(`turn:${turnId}`, async () => {
    await writeAgentRunTombstoneUnlocked(turnId, null);
    return purgeAgentRunDirectoriesUnlocked(turnId, null);
  });
}

/** Regeneration erases only superseded attempts and leaves the new attempt legal. */
export async function purgeAgentRunsThroughAttempt(
  turnId: string,
  throughAttempt: number,
): Promise<number> {
  if (!Number.isSafeInteger(throughAttempt) || throughAttempt < 1) {
    throw new Error("AgentRun purge fence requires a positive attempt");
  }
  return withAdmissionLock(`turn:${turnId}`, async () => {
    await writeAgentRunTombstoneUnlocked(turnId, throughAttempt);
    return purgeAgentRunDirectoriesUnlocked(turnId, throughAttempt);
  });
}

export async function fenceAgentRunAttempt(turnId: string, attempt: number): Promise<void> {
  await withAdmissionLock(
    `turn:${turnId}`,
    () => writeAgentRunTombstoneUnlocked(turnId, attempt),
  );
}

export async function isAgentRunTombstoned(turnId: string, attempt: number): Promise<boolean> {
  const tombstone = await readAgentRunTombstone(turnId);
  return Boolean(tombstone && (tombstone.throughAttempt === null || attempt <= tombstone.throughAttempt));
}

export async function isUserTombstoned(userId: string): Promise<boolean> {
  return exists(userTombstoneFile(userId));
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
  if (throughAttempt === null) await rm(turnRoot, { recursive: true, force: true });
  return purged;
}

async function readAgentRunTombstone(turnId: string): Promise<AgentRunTombstone | null> {
  try {
    return JSON.parse(await readFile(tombstoneFile(turnId), "utf8")) as AgentRunTombstone;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeAgentRunTombstoneUnlocked(
  turnId: string,
  throughAttempt: number | null,
): Promise<void> {
  const prior = await readAgentRunTombstone(turnId);
  const nextAttempt = prior?.throughAttempt === null || throughAttempt === null
    ? null
    : Math.max(prior?.throughAttempt ?? 0, throughAttempt);
  if (prior && prior.throughAttempt === nextAttempt) return;
  await atomicWrite(tombstoneFile(turnId), `${JSON.stringify({
    schemaVersion: 1,
    throughAttempt: nextAttempt,
    updatedAt: new Date().toISOString(),
  } satisfies AgentRunTombstone)}\n`);
}

function assertNotTombstoned(
  turnId: string,
  attempt: number,
  tombstone: AgentRunTombstone | null,
): void {
  if (tombstone && (tombstone.throughAttempt === null || attempt <= tombstone.throughAttempt)) {
    throw new Error(`AgentRun ${turnId}:${attempt} is fenced`);
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

async function withAdmissionLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = admissionTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  admissionTails.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (admissionTails.get(key) === tail) admissionTails.delete(key);
  }
}
