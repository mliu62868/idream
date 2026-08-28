import { randomUUID } from "node:crypto";
import {
  BFF_HEADER,
  BFF_USER_HEADER,
  signBffContext,
} from "@idream/shared/bff";
import {
  chatExecutionSnapshotSchema,
  type ChatExecutionSnapshot,
} from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { logger } from "@/server/lib/logger";
import { executionSnapshot } from "./turn-ledger";
import { loadChatAuthoritySnapshot } from "./chat-authority-snapshot";
import { assertNoPendingCompanionMemoryRebuild } from "./companion-memory-authority";

const ADMISSION_PATH = "/internal/agent-runs";
const ADMISSION_TIMEOUT_MS = 5_000;
const ADMISSION_LEASE_MS = 15_000;

export interface AgentRunAdmissionResult {
  admitted: boolean;
  reason?: string;
}

/**
 * TurnExecution is a durable intent with an immutable input snapshot. A lease
 * makes concurrent reconcilers harmless; backoff moves a failing row behind
 * other due Turns instead of starving the queue.
 */
export async function attemptChatAgentRunAdmission(
  expected: ChatExecutionSnapshot,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentRunAdmissionResult> {
  const leaseToken = randomUUID();
  let snapshot = expected;
  let claimedAttempts = 0;
  try {
    const claim = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const turn = await tx.chatTurn.findUnique({
        where: { id: expected.turnId },
        include: { session: { select: { status: true, characterId: true } } },
      });
      if (
        !turn || turn.assistantStatus !== "pending" || turn.attempt !== expected.attempt ||
        turn.session.status !== "active" || turn.admissionNextRunAt > now ||
        (turn.admissionLeaseUntil !== null && turn.admissionLeaseUntil > now)
      ) return null;
      const persisted = chatExecutionSnapshotSchema.safeParse(turn.executionSnapshot);
      if (!persisted.success) throw new Error("Chat Turn has no valid frozen execution snapshot");
      if (JSON.stringify(persisted.data) !== JSON.stringify(expected)) {
        throw new Error("Chat Turn execution snapshot changed after creation");
      }
      await assertNoPendingCompanionMemoryRebuild(
        tx,
        persisted.data.userId,
        turn.session.characterId,
      );
      const changed = await tx.chatTurn.updateMany({
        where: {
          id: turn.id,
          attempt: turn.attempt,
          assistantStatus: "pending",
          admissionNextRunAt: { lte: now },
          OR: [{ admissionLeaseUntil: null }, { admissionLeaseUntil: { lte: now } }],
        },
        data: {
          admissionAttempts: { increment: 1 },
          admissionLeaseToken: leaseToken,
          admissionLeaseUntil: new Date(now.getTime() + ADMISSION_LEASE_MS),
          admissionLastError: Prisma.DbNull,
        },
      });
      return changed.count === 1
        ? { snapshot: persisted.data, attempts: turn.admissionAttempts + 1 }
        : null;
    });
    if (!claim) return { admitted: false, reason: "Turn is not due or no longer eligible" };
    snapshot = claim.snapshot;
    claimedAttempts = claim.attempts;

    const base = configuredChatBase();
    const authority = await loadChatAuthoritySnapshot(snapshot.userId, {
      characterId: snapshot.characterId,
      contentVersionId: snapshot.characterContentVersionId,
      releaseId: snapshot.characterReleaseId,
      visualProfileId: snapshot.characterVisualProfileId,
      visualProfileVersion: snapshot.characterVisualProfileVersion,
    });
    const body = JSON.stringify(snapshot);
    const response = await fetchImpl(`${base}${ADMISSION_PATH}`, {
      method: "POST",
      headers: signedAdmissionHeaders(snapshot.userId, body, authority),
      body,
      signal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Chat AgentRun admission failed with HTTP ${response.status}`);
    }
    const changed = await prisma.chatTurn.updateMany({
      where: {
        id: snapshot.turnId,
        attempt: snapshot.attempt,
        assistantMessageId: snapshot.assistantMessageId,
        assistantStatus: "pending",
        admissionLeaseToken: leaseToken,
      },
      data: {
        assistantStatus: "generating",
        admittedAt: new Date(),
        admissionLeaseToken: null,
        admissionLeaseUntil: null,
        admissionLastError: Prisma.DbNull,
      },
    });
    if (changed.count !== 1) {
      const current = await prisma.chatTurn.findUnique({
        where: { id: snapshot.turnId },
        select: { attempt: true, assistantMessageId: true, assistantStatus: true },
      });
      const sameRunConverged = current &&
        current.attempt === snapshot.attempt &&
        current.assistantMessageId === snapshot.assistantMessageId &&
        ["pending", "generating", "sent", "failed"].includes(current.assistantStatus);
      if (sameRunConverged) {
        // A previous lease may have expired after Chat accepted this same
        // idempotent AgentRun. Its stale owner must not cancel the newer
        // owner's valid run merely because it lost the Main CAS.
        return {
          admitted: current.assistantStatus === "generating",
          reason: current.assistantStatus === "generating"
            ? undefined
            : `AgentRun already converged to ${current.assistantStatus}`,
        };
      }
      // Main invalidated the exact attempt while Chat admitted it. Persisting
      // a cancel fence prevents that late request from recreating erased files.
      await cancelAdmittedAttempt(snapshot.turnId, snapshot.attempt, fetchImpl).catch((error) => {
        logger.error({ err: error, turnId: snapshot.turnId, attempt: snapshot.attempt }, "late AgentRun cancellation failed");
      });
      return { admitted: false, reason: "Turn changed while admission was in flight" };
    }
    return { admitted: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "AgentRun admission failed";
    if (claimedAttempts > 0) {
      await prisma.chatTurn.updateMany({
        where: {
          id: snapshot.turnId,
          attempt: snapshot.attempt,
          assistantStatus: "pending",
          admissionLeaseToken: leaseToken,
        },
        data: {
          admissionLeaseToken: null,
          admissionLeaseUntil: null,
          admissionNextRunAt: new Date(Date.now() + admissionBackoffMs(claimedAttempts)),
          admissionLastError: { message: reason },
        },
      }).catch(() => undefined);
    }
    logger.warn({ turnId: snapshot.turnId, attempt: snapshot.attempt, reason }, "AgentRun admission remains pending");
    return { admitted: false, reason };
  }
}

export async function dispatchPendingChatAgentRuns(
  batch = 50,
): Promise<{ admitted: number; pending: number }> {
  if (!env.CHAT_SERVICE_URL || !env.INTERNAL_TOKEN) return { admitted: 0, pending: 0 };
  const now = new Date();
  const rows = await prisma.chatTurn.findMany({
    where: {
      assistantStatus: "pending",
      terminalAt: null,
      admissionNextRunAt: { lte: now },
      OR: [{ admissionLeaseUntil: null }, { admissionLeaseUntil: { lte: now } }],
      session: { status: "active" },
    },
    orderBy: [{ admissionNextRunAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
    take: batch,
  });
  let admitted = 0;
  for (const row of rows) {
    const result = await attemptChatAgentRunAdmission(await executionSnapshot(row.id));
    if (result.admitted) admitted += 1;
  }
  return { admitted, pending: rows.length - admitted };
}

function admissionBackoffMs(attempts: number): number {
  return Math.min(5 * 60_000, 1_000 * 2 ** Math.min(8, Math.max(0, attempts - 1)));
}

async function cancelAdmittedAttempt(
  turnId: string,
  attempt: number,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${configuredChatBase()}/internal/agent-runs/${encodeURIComponent(turnId)}/${attempt}/cancel`,
    {
      method: "POST",
      headers: { "x-internal-token": env.INTERNAL_TOKEN ?? "" },
      signal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`late AgentRun cancellation returned ${response.status}`);
}

function configuredChatBase(): string {
  if (!env.CHAT_SERVICE_URL) throw new Error("CHAT_SERVICE_URL not configured");
  if (!env.INTERNAL_TOKEN) throw new Error("INTERNAL_TOKEN not configured");
  if (!env.CHAT_BFF_SIGNING_SECRET && env.APP_ENV !== "test") {
    throw new Error("CHAT_BFF_SIGNING_SECRET not configured");
  }
  return env.CHAT_SERVICE_URL.replace(/\/$/u, "");
}

function signedAdmissionHeaders(
  userId: string,
  body: string,
  authority: Parameters<typeof signBffContext>[0]["authority"],
): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    "x-internal-token": env.INTERNAL_TOKEN ?? "",
  });
  const secret = env.CHAT_BFF_SIGNING_SECRET;
  if (!secret) {
    headers.set("x-idream-user-id", userId);
    return headers;
  }
  const signed = signBffContext({
    secret,
    userId,
    method: "POST",
    path: ADMISSION_PATH,
    body,
    authority,
  });
  headers.set(BFF_HEADER, signed.signature);
  headers.set(BFF_USER_HEADER, asciiJson(signed.context));
  return headers;
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
