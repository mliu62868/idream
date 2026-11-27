import { randomUUID } from "node:crypto";
import {
  CHAT_SEND_PROTOCOL_VERSION,
  chatAgentRunAdmissionAckSchema,
  type ChatExecutionSnapshot,
} from "@idream/shared/contracts";
import { incrementCounter, observeHistogram } from "@idream/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { logger } from "@/server/lib/logger";
import {
  beginChatTurn,
  cancelChatTurn,
  editChatTurn,
  executionSnapshot,
  failStalledChatTurn,
  regenerateChatTurn,
  type ChatTurnEditOptions,
} from "./turn-ledger";
import { isPermanentSnapshotFailure } from "./execution-snapshot";
import { ADMISSION_EXPIRED_FAILURE_CODE, expirePendingChatTurn, type PendingAdmissionExpiry } from "./turn-terminal";
import { loadChatAuthoritySnapshot, type ChatEntitlements } from "./chat-authority-snapshot";
import {
  agentRunCancelPath,
  internalChatHeaders,
  requireChatAgentRuntime,
  signedChatBffHeaders,
} from "./chat-runtime-endpoint";

const ADMISSION_PATH = "/internal/agent-runs";
// INTENT: the request path waits for inline admission only as a latency
// optimization; the Turn is already durable and pending. A degraded Chat must
// not cost every send the dispatcher's full budget.
const INLINE_ADMISSION_TIMEOUT_MS = 2_000;
const DISPATCH_ADMISSION_TIMEOUT_MS = 5_000;
const ADMISSION_LEASE_MS = 15_000;
const TERMINAL_COMMIT_GRACE_MS = 60_000;
// A frozen snapshot that cannot be read is not repaired by waiting. Bound the
// passes before the Turn takes the expired-admission exit.
const MAX_SNAPSHOT_FAILURES = 3;
// Inline circuit: after this many consecutive timeouts / transport failures the
// request path stops waiting on Chat for a while; the dispatcher keeps trying.
const INLINE_CIRCUIT_FAILURES = 3;
const INLINE_CIRCUIT_OPEN_MS = 15_000;
const ADMISSION_LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10] as const;
const PENDING_AGE_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 180, 300] as const;

export interface AgentRunAdmissionResult {
  admitted: boolean;
  reason?: string;
}

export type AgentRunAdmissionMode = "inline" | "dispatch";

type AdmissionOutcome =
  | "admitted" | "not_due" | "converged" | "changed" | "circuit_open"
  | "transport_error" | "rejected";

/**
 * SPEC: the request-path admission circuit. Only timeouts and transport
 * failures count — a fast HTTP error costs the request nothing worth skipping.
 * Any successful admission (inline or dispatcher) closes it; after the open
 * window one inline attempt probes again and a failure reopens it at once.
 */
const inlineCircuit = { failures: 0, openUntil: 0 };

function inlineCircuitOpen(now = Date.now()): boolean {
  return inlineCircuit.openUntil > now;
}

function recordAdmissionTransport(ok: boolean) {
  if (ok) {
    inlineCircuit.failures = 0;
    inlineCircuit.openUntil = 0;
    return;
  }
  inlineCircuit.failures += 1;
  if (inlineCircuit.failures >= INLINE_CIRCUIT_FAILURES) {
    inlineCircuit.openUntil = Date.now() + INLINE_CIRCUIT_OPEN_MS;
    inlineCircuit.failures = INLINE_CIRCUIT_FAILURES - 1;
  }
}

/** Test seam: forget circuit state between isolated cases. */
export function resetInlineAdmissionCircuit() {
  inlineCircuit.failures = 0;
  inlineCircuit.openUntil = 0;
}

class AdmissionTransportError extends Error {}

/**
 * Product Turn commands own their durable mutation -> best-effort admission
 * order. HTTP callers receive product state and never coordinate the two
 * authorities themselves.
 */
export async function beginAdmittedChatTurn(input: {
  userId: string;
  sessionId: string;
  content: string;
  idempotencyKey: string;
  sendProtocolVersion?: string;
  allowPaidImage?: boolean;
  origin?: "user" | "proactive";
  voiceCall?: { id: string; leaseToken: string; utteranceId: string };
}) {
  // A legacy external POST can only read its existing receipt. It must remain
  // readable without making the execution service a prerequisite for the read.
  if (input.origin === "proactive" || input.voiceCall || input.sendProtocolVersion === CHAT_SEND_PROTOCOL_VERSION) requireChatAgentRuntime();
  const begun = await beginChatTurn(input);
  const admission = begun.snapshot
    ? await attemptChatAgentRunAdmission(begun.snapshot, fetch, { mode: "inline", entitlements: begun.entitlements })
    : null;
  const assistant = admission?.admitted
    ? { ...begun.assistant, status: "generating" as const }
    : begun.assistant;
  return {
    userMessage: begun.userMessage,
    assistant,
    assistantMessageId: assistant.id,
    streamUrl: begun.streamUrl,
    ...(begun.safety ? { safety: begun.safety } : {}),
  };
}

export async function editAndAdmitChatTurn(
  userId: string,
  messageId: string,
  content: string,
  options?: ChatTurnEditOptions,
) {
  requireChatAgentRuntime();
  const result = await editChatTurn(userId, messageId, content, options);
  const admission = result.snapshot
    ? await attemptChatAgentRunAdmission(result.snapshot, fetch, { mode: "inline" })
    : null;
  return publicRetry(result, admission?.admitted === true);
}

export async function regenerateAndAdmitChatTurn(userId: string, messageId: string) {
  requireChatAgentRuntime();
  const result = await regenerateChatTurn(userId, messageId);
  const admission = await attemptChatAgentRunAdmission(result.snapshot, fetch, { mode: "inline" });
  return publicRetry(result, admission.admitted);
}

export async function cancelAdmittedChatTurn(
  userId: string,
  messageId: string,
  expectedAttempt: number,
  fetchImpl: typeof fetch = fetch,
) {
  const result = await cancelChatTurn(userId, messageId, expectedAttempt);
  if (result.cancelled) await cancelAdmittedAttempt(result.turnId, result.attempt, fetchImpl).catch((error) => {
    logger.warn(
      { err: error, turnId: result.turnId, attempt: result.attempt },
      "immediate AgentRun cancellation failed; durable outbox remains authoritative",
    );
  });
  return { ok: true, attempt: result.attempt, cancelled: result.cancelled };
}

/**
 * TurnExecution is a durable intent with an immutable input snapshot. A lease
 * makes concurrent reconcilers harmless; backoff moves a failing row behind
 * other due Turns instead of starving the queue.
 *
 * `inline` is the creating request itself: it may claim before the Turn's
 * first dispatcher due time (new attempts start `admissionNextRunAt` a few
 * seconds out so the dispatcher does not race it), waits less, and honors the
 * inline circuit. `dispatch` is the durable reconciler.
 *
 * INVARIANT: `expected` is the attempt's frozen snapshot. It is written exactly
 * once per (turnId, attempt) — in the transaction that created the attempt, or
 * lazily by executionSnapshot() for a legacy row — and is only rewritten by a
 * revision (which increments attempt in the same statement) or by a terminal
 * transition (which leaves `pending`). The claim's attempt + pending CAS
 * therefore proves `expected` equals the persisted snapshot without reading it
 * back.
 */
export async function attemptChatAgentRunAdmission(
  expected: ChatExecutionSnapshot,
  fetchImpl: typeof fetch = fetch,
  options: { mode?: AgentRunAdmissionMode; entitlements?: ChatEntitlements } = {},
): Promise<AgentRunAdmissionResult> {
  const mode = options.mode ?? "dispatch";
  const startedAt = performance.now();
  const finish = (outcome: AdmissionOutcome, result: AgentRunAdmissionResult) => {
    observeHistogram(
      "chat_admission_duration_seconds",
      "Main to Chat AgentRun admission latency by caller and outcome",
      { mode, outcome },
      (performance.now() - startedAt) / 1_000,
      ADMISSION_LATENCY_BUCKETS,
    );
    return result;
  };
  if (mode === "inline" && inlineCircuitOpen()) {
    // The Turn stays pending; the dispatcher admits it on its next pass.
    return finish("circuit_open", { admitted: false, reason: "Inline admission skipped while Chat is degraded" });
  }
  const leaseToken = randomUUID();
  const snapshot = expected;
  let claimedAttempts = 0;
  try {
    const claim = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const turn = await tx.chatTurn.findUnique({
        where: { id: expected.turnId },
        select: {
          id: true, attempt: true, assistantMessageId: true, assistantStatus: true,
          admissionNextRunAt: true, admissionLeaseUntil: true, admissionAttempts: true,
          attemptStartedAt: true, session: { select: { status: true } },
        },
      });
      if (!turn) return null;
      // Only the creating request's first claim skips the due time. A replayed
      // POST after a failed admission honors the dispatcher's backoff.
      const firstInlineClaim = mode === "inline" && turn.admissionAttempts === 0;
      if (
        turn.assistantStatus !== "pending" || turn.attempt !== expected.attempt ||
        turn.assistantMessageId !== expected.assistantMessageId ||
        turn.session.status !== "active" ||
        (!firstInlineClaim && turn.admissionNextRunAt > now) ||
        (turn.admissionLeaseUntil !== null && turn.admissionLeaseUntil > now) ||
        // Past its TTL the attempt belongs to expiry, never to a late admission.
        turn.attemptStartedAt < pendingAdmissionCutoff(now)
      ) return null;
      const changed = await tx.chatTurn.updateMany({
        where: {
          id: turn.id,
          attempt: turn.attempt,
          assistantStatus: "pending",
          ...(firstInlineClaim ? { admissionAttempts: 0 } : { admissionNextRunAt: { lte: now } }),
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
        ? { attempts: turn.admissionAttempts + 1, attemptStartedAt: turn.attemptStartedAt }
        : null;
    });
    if (!claim) return finish("not_due", { admitted: false, reason: "Turn is not due or no longer eligible" });
    claimedAttempts = claim.attempts;

    const base = requireChatAgentRuntime();
    const authority = await loadChatAuthoritySnapshot(snapshot.userId, {
      characterId: snapshot.characterId,
      contentVersionId: snapshot.characterContentVersionId,
      releaseId: snapshot.characterReleaseId,
      visualProfileId: snapshot.characterVisualProfileId,
      visualProfileVersion: snapshot.characterVisualProfileVersion,
    }, { entitlements: options.entitlements });
    const body = JSON.stringify(snapshot);
    let response: Response;
    try {
      response = await fetchImpl(`${base}${ADMISSION_PATH}`, {
        method: "POST",
        headers: signedChatBffHeaders({
          userId: snapshot.userId, method: "POST", path: ADMISSION_PATH, body, authority,
          headers: internalChatHeaders({ "content-type": "application/json" }),
        }),
        body,
        signal: AbortSignal.timeout(mode === "inline" ? INLINE_ADMISSION_TIMEOUT_MS : DISPATCH_ADMISSION_TIMEOUT_MS),
      });
    } catch (error) {
      recordAdmissionTransport(false);
      throw new AdmissionTransportError(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
        ? "Chat AgentRun admission timed out"
        : `Chat AgentRun admission transport failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`Chat AgentRun admission failed with HTTP ${response.status}`);
    }
    const ack = chatAgentRunAdmissionAckSchema.parse(await response.json());
    if (ack.turnId !== snapshot.turnId || ack.attempt !== snapshot.attempt) {
      throw new Error("Chat AgentRun admission ACK belongs to another attempt");
    }
    if (ack.terminal) {
      // Chat marks local terminal only after Main settles. An old terminal ACK
      // cannot manufacture a fresh generating state in the product ledger.
      throw new Error("Chat AgentRun already terminal; product state must reconcile");
    }
    recordAdmissionTransport(true);
    const admittedAt = new Date();
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
        admittedAt,
        executionDeadlineAt: new Date(ack.deadlineAt!),
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
        return finish("converged", {
          admitted: current.assistantStatus === "generating",
          reason: current.assistantStatus === "generating"
            ? undefined
            : `AgentRun already converged to ${current.assistantStatus}`,
        });
      }
      // Main invalidated the exact attempt while Chat admitted it. Persisting
      // a cancel fence prevents that late request from recreating erased files.
      await cancelAdmittedAttempt(snapshot.turnId, snapshot.attempt, fetchImpl).catch((error) => {
        logger.error({ err: error, turnId: snapshot.turnId, attempt: snapshot.attempt }, "late AgentRun cancellation failed");
      });
      return finish("changed", { admitted: false, reason: "Turn changed while admission was in flight" });
    }
    observeHistogram(
      "chat_admission_pending_age_seconds",
      "Time a Chat attempt waited in pending before Chat admitted it",
      { mode },
      Math.max(0, admittedAt.getTime() - claim.attemptStartedAt.getTime()) / 1_000,
      PENDING_AGE_BUCKETS,
    );
    return finish("admitted", { admitted: true });
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
    logger.warn({ turnId: snapshot.turnId, attempt: snapshot.attempt, mode, reason }, "AgentRun admission remains pending");
    return finish(error instanceof AdmissionTransportError ? "transport_error" : "rejected", { admitted: false, reason });
  }
}

export async function dispatchPendingChatAgentRuns(
  batch = 50,
  signal?: AbortSignal,
): Promise<{ admitted: number; pending: number; expired: number }> {
  if (signal?.aborted) return { admitted: 0, pending: 0, expired: 0 };
  // Expiry runs even when Chat is unconfigured: an unreachable runtime is
  // exactly when pending Turns must stop holding the conversation.
  const { expired } = await expireStalePendingChatTurns(batch, signal);
  if (signal?.aborted || !env.CHAT_SERVICE_URL || !env.INTERNAL_TOKEN) return { admitted: 0, pending: 0, expired };
  const now = new Date();
  const rows = await prisma.chatTurn.findMany({
    where: {
      assistantStatus: "pending",
      terminalAt: null,
      attemptStartedAt: { gte: pendingAdmissionCutoff(now) },
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
    if (signal?.aborted) break;
    const result = await attemptPersistedChatAgentRunAdmission(row.id);
    if (result.admitted) admitted += 1;
  }
  return { admitted, pending: rows.length - admitted, expired };
}

function pendingAdmissionCutoff(now: Date): Date {
  return new Date(now.getTime() - env.CHAT_PENDING_ADMISSION_TTL_MS);
}

/** See expirePendingChatTurn. One failing row never strands the rest. */
export async function expireStalePendingChatTurns(
  batch = 50,
  signal?: AbortSignal,
): Promise<{ expired: number }> {
  const now = new Date();
  const startedBefore = pendingAdmissionCutoff(now);
  const rows = await prisma.chatTurn.findMany({
    where: {
      assistantStatus: "pending",
      terminalAt: null,
      attemptStartedAt: { lt: startedBefore },
      OR: [{ admissionLeaseUntil: null }, { admissionLeaseUntil: { lte: now } }],
    },
    orderBy: [{ attemptStartedAt: "asc" }, { id: "asc" }],
    select: { id: true, attempt: true, admissionLastError: true },
    take: batch,
  });
  let expired = 0;
  for (const row of rows) {
    if (signal?.aborted) break;
    try {
      const result = await expirePendingChatTurn(row.id, {
        attempt: row.attempt,
        reason: "ttl",
        startedBefore,
        lastError: admissionErrorMessage(row.admissionLastError),
      });
      if (result.expired) {
        expired += 1;
        reportAdmissionExpiry(result);
      }
    } catch (err) {
      logger.error({ err, turnId: row.id }, "failed to expire pending Chat Turn");
    }
  }
  return { expired };
}

function reportAdmissionExpiry(result: Extract<PendingAdmissionExpiry, { expired: true }>) {
  incrementCounter(
    "chat_pending_admission_expired_total",
    "Pending Chat Turns failed because Chat never admitted them",
    { reason: result.reason },
  );
  logger.warn({
    event: "chat_pending_admission_expired",
    turnId: result.turnId,
    attempt: result.attempt,
    reason: result.reason,
    pendingMs: result.pendingMs,
    admissionAttempts: result.admissionAttempts,
    failureCode: ADMISSION_EXPIRED_FAILURE_CODE,
  }, "pending Chat Turn expired before admission");
}

function admissionErrorMessage(value: Prisma.JsonValue | null): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && typeof value.message === "string"
    ? value.message
    : undefined;
}

/**
 * SPEC: reclaim Turns stuck in `generating` past any attempt's useful life.
 *
 * INTENT: Chat reports its frozen deadline at admission. Main honors that
 * commitment even when Chat's configuration differs from Main's environment.
 * Anything still generating past its deadline and commit grace needs Main to
 * release the relationship and settle usage.
 * The grace margin keeps a merely slow attempt from being cut off early.
 */
export async function reclaimStalledChatAgentRuns(
  batch = 50,
  signal?: AbortSignal,
): Promise<{ reclaimed: number }> {
  if (signal?.aborted) return { reclaimed: 0 };
  const now = Date.now();
  const cutoff = {
    deadlineBefore: new Date(now - TERMINAL_COMMIT_GRACE_MS),
  };
  const rows = await prisma.chatTurn.findMany({
    where: {
      assistantStatus: "generating",
      terminalAt: null,
      // Every admission pins Chat's deadline (the ack schema requires it);
      // legacy null-deadline rows were backfilled by migration
      // 20261126030000_backfill_legacy_chat_attempt_shapes.
      executionDeadlineAt: { lt: cutoff.deadlineBefore },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    select: { id: true },
    take: batch,
  });
  let reclaimed = 0;
  for (const row of rows) {
    if (signal?.aborted) break;
    try {
      const result = await failStalledChatTurn(row.id, cutoff);
      if (result.reclaimed) {
        reclaimed += 1;
        logger.warn(
          { turnId: result.turnId, attempt: result.attempt },
          "reclaimed stalled Chat attempt stuck in generating",
        );
      }
    } catch (err) {
      // One unreclaimable row must not strand the rest of the batch.
      logger.error({ err, turnId: row.id }, "failed to reclaim stalled Chat attempt");
    }
  }
  return { reclaimed };
}

async function attemptPersistedChatAgentRunAdmission(
  turnId: string,
): Promise<AgentRunAdmissionResult> {
  let snapshot: ChatExecutionSnapshot;
  try {
    snapshot = await executionSnapshot(turnId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid frozen execution snapshot";
    if (!isPermanentSnapshotFailure(error)) {
      // A lock timeout or connection reset says nothing about the snapshot.
      // Back off without counting it; the pending TTL still bounds the Turn.
      await prisma.chatTurn.updateMany({
        where: { id: turnId, assistantStatus: "pending" },
        data: { admissionNextRunAt: new Date(Date.now() + admissionBackoffMs(2)), admissionLastError: { message: reason, kind: "snapshot_unavailable" } },
      }).catch(() => undefined);
      logger.warn({ err: error, turnId }, "pending Chat Turn snapshot temporarily unavailable");
      return { admitted: false, reason };
    }
    // INVARIANT: one corrupt product snapshot cannot abort the rest of the due
    // admission batch, and cannot retry forever either: after a bounded number
    // of dispatcher passes it takes the same exit as an expired pending Turn.
    const marked = await prisma.chatTurn.updateManyAndReturn({
      where: { id: turnId, assistantStatus: "pending" },
      data: {
        admissionAttempts: { increment: 1 },
        admissionNextRunAt: new Date(Date.now() + admissionBackoffMs(3)),
        admissionLastError: { message: reason, kind: "snapshot_invalid" },
      },
      select: { attempt: true, admissionAttempts: true },
    }).catch(() => []);
    const row = marked[0];
    if (row && row.admissionAttempts >= MAX_SNAPSHOT_FAILURES) {
      const result = await expirePendingChatTurn(turnId, { attempt: row.attempt, reason: "snapshot_invalid", lastError: reason })
        .catch((err: unknown) => {
          logger.error({ err, turnId }, "failed to expire pending Chat Turn with an invalid snapshot");
          return null;
        });
      if (result?.expired) reportAdmissionExpiry(result);
    }
    logger.warn({ turnId, reason }, "skipping invalid pending Chat Turn snapshot");
    return { admitted: false, reason };
  }
  return attemptChatAgentRunAdmission(snapshot);
}

function admissionBackoffMs(attempts: number): number {
  return Math.min(5 * 60_000, 1_000 * 2 ** Math.min(8, Math.max(0, attempts - 1)));
}

function publicRetry(result: {
  assistantMessageId: string;
  attempt: number;
  status: string;
  streamUrl: string | null;
  safety?: { layer: "input"; policyCode?: string };
}, admitted: boolean) {
  return {
    assistantMessageId: result.assistantMessageId,
    attempt: result.attempt,
    status: admitted && result.status === "pending" ? "generating" as const : result.status,
    streamUrl: result.streamUrl,
    ...(result.safety ? { safety: result.safety } : {}),
  };
}

async function cancelAdmittedAttempt(
  turnId: string,
  attempt: number,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(`${requireChatAgentRuntime()}${agentRunCancelPath(turnId, attempt)}`, {
    method: "POST",
    headers: internalChatHeaders(),
    signal: AbortSignal.timeout(DISPATCH_ADMISSION_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`late AgentRun cancellation returned ${response.status}`);
}
