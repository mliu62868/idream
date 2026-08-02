import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import {
  GENERATION_ATTEMPT_TERMINAL_OUTCOMES,
  recordGenerationAttemptEvent,
  type GenerationAttemptTerminalOutcome,
} from "./generation-attempt-events";

export type AttemptEventBackfillMode = "dry-run" | "apply";

export interface AttemptEventBackfillOptions {
  readonly mode?: AttemptEventBackfillMode;
  readonly cursor?: string;
  readonly batchSize?: number;
}

export interface AttemptEventBackfillItem {
  readonly attemptId: string;
  readonly status: string;
  readonly classification: "ready" | "canonical" | "partial" | "mismatch";
  readonly reason: string;
}

export interface AttemptEventBackfillReport {
  readonly mode: AttemptEventBackfillMode;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  readonly examined: number;
  readonly ready: number;
  readonly applied: number;
  readonly canonical: number;
  readonly partial: number;
  readonly mismatch: number;
  readonly items: readonly AttemptEventBackfillItem[];
}

interface Evidence {
  artifactCount: number;
  deliveredCount: number;
}

function terminalOutcome(status: string): GenerationAttemptTerminalOutcome | null {
  return (GENERATION_ATTEMPT_TERMINAL_OUTCOMES as readonly string[]).includes(status)
    ? status as GenerationAttemptTerminalOutcome
    : null;
}

function storedEventHash(event: {
  attemptId: string;
  sequence: number;
  eventType: string;
  outcome: string | null;
  occurredAt: Date;
  payload: Prisma.JsonValue;
}) {
  return canonicalSha256({
    attemptId: event.attemptId,
    sequence: event.sequence,
    eventType: event.eventType,
    outcome: event.outcome,
    occurredAt: event.occurredAt,
    payload: event.payload,
  });
}

function classifyAttempt(
  attempt: {
    id: string;
    status: string;
    terminalSequence: number | null;
    errorCode: string | null;
    errorSignature: string | null;
    retryability: string | null;
    terminalRecordRef: string | null;
    finishedAt: Date | null;
    events: Array<{
      attemptId: string;
      sequence: number;
      eventType: string;
      outcome: string | null;
      terminalScope: string | null;
      occurredAt: Date;
      payload: Prisma.JsonValue;
      payloadHash: string;
    }>;
  },
  evidence: Evidence,
): AttemptEventBackfillItem {
  const outcome = terminalOutcome(attempt.status);
  if (!outcome) {
    return { attemptId: attempt.id, status: attempt.status, classification: "partial", reason: "attempt_not_terminal" };
  }
  const terminalEvents = attempt.events.filter((event) => event.terminalScope === "terminal");
  if (terminalEvents.length === 1) {
    const event = terminalEvents[0];
    if (
      event.outcome !== outcome ||
      event.eventType !== `generation.attempt.${outcome}.v1` ||
      event.payloadHash !== storedEventHash(event) ||
      attempt.terminalSequence !== event.sequence
    ) {
      return { attemptId: attempt.id, status: attempt.status, classification: "mismatch", reason: "terminal_event_disagrees_with_attempt" };
    }
    return { attemptId: attempt.id, status: attempt.status, classification: "canonical", reason: "terminal_event_present" };
  }
  if (terminalEvents.length > 1) {
    return { attemptId: attempt.id, status: attempt.status, classification: "mismatch", reason: "multiple_terminal_events" };
  }
  if (!attempt.finishedAt) {
    return { attemptId: attempt.id, status: attempt.status, classification: "partial", reason: "missing_finished_at" };
  }
  if (outcome === "succeeded") {
    const hasSuccessEvidence = Boolean(attempt.terminalRecordRef) || evidence.artifactCount > 0;
    if (!hasSuccessEvidence) {
      return { attemptId: attempt.id, status: attempt.status, classification: "partial", reason: "success_without_terminal_record_or_artifact" };
    }
    return { attemptId: attempt.id, status: attempt.status, classification: "ready", reason: "success_evidence_present" };
  }
  if (outcome === "failed") {
    if (!attempt.errorCode && !attempt.errorSignature) {
      return { attemptId: attempt.id, status: attempt.status, classification: "partial", reason: "failure_without_error_evidence" };
    }
    if (evidence.deliveredCount > 0) {
      return { attemptId: attempt.id, status: attempt.status, classification: "mismatch", reason: "failed_attempt_has_delivered_artifact" };
    }
    return { attemptId: attempt.id, status: attempt.status, classification: "ready", reason: "failure_evidence_present" };
  }
  if (outcome === "unknown" && attempt.retryability === "not_retryable") {
    return { attemptId: attempt.id, status: attempt.status, classification: "ready", reason: "explicit_non_replayable_unknown" };
  }
  return {
    attemptId: attempt.id,
    status: attempt.status,
    classification: "partial",
    reason: outcome === "cancelled" ? "cancel_source_event_missing" : "unknown_replayability_not_proven",
  };
}

export async function backfillGenerationAttemptEvents(
  db: PrismaClient,
  options: AttemptEventBackfillOptions = {},
): Promise<AttemptEventBackfillReport> {
  const mode = options.mode ?? "dry-run";
  const batchSize = Math.min(500, Math.max(1, options.batchSize ?? 100));
  const attempts = await db.generationAttempt.findMany({
    where: {
      status: { in: [...GENERATION_ATTEMPT_TERMINAL_OUTCOMES] },
      ...(options.cursor ? { id: { gt: options.cursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: batchSize,
    include: { events: { orderBy: { sequence: "asc" } } },
  });
  const attemptIds = attempts.map((attempt) => attempt.id);
  const artifacts = await db.generationArtifact.findMany({
    where: { attemptId: { in: attemptIds } },
    select: { id: true, attemptId: true, validationState: true },
  });
  const deliveries = await db.generationDelivery.findMany({
    where: { artifactId: { in: artifacts.map((artifact) => artifact.id) }, status: "delivered" },
    select: { artifactId: true },
  });
  const artifactAttemptById = new Map(artifacts.map((artifact) => [artifact.id, artifact.attemptId]));
  const artifactCounts = new Map<string, number>();
  for (const artifact of artifacts) {
    if (artifact.validationState === "invalid") continue;
    artifactCounts.set(artifact.attemptId, (artifactCounts.get(artifact.attemptId) ?? 0) + 1);
  }
  const deliveryCounts = new Map<string, number>();
  for (const delivery of deliveries) {
    const attemptId = artifactAttemptById.get(delivery.artifactId);
    if (!attemptId) continue;
    deliveryCounts.set(attemptId, (deliveryCounts.get(attemptId) ?? 0) + 1);
  }
  const items = attempts.map((attempt) => classifyAttempt(attempt, {
    artifactCount: artifactCounts.get(attempt.id) ?? 0,
    deliveredCount: deliveryCounts.get(attempt.id) ?? 0,
  }));

  let applied = 0;
  if (mode === "apply") {
    for (const [index, item] of items.entries()) {
      if (item.classification !== "ready") continue;
      const attempt = attempts[index];
      const outcome = terminalOutcome(attempt.status);
      if (!outcome || !attempt.finishedAt) continue;
      const evidence = {
        artifactCount: artifactCounts.get(attempt.id) ?? 0,
        deliveredCount: deliveryCounts.get(attempt.id) ?? 0,
      };
      await db.$transaction((tx) => recordGenerationAttemptEvent(tx, {
        eventId: `${attempt.id}:terminal`,
        attemptId: attempt.id,
        eventType: `generation.attempt.${outcome}.v1`,
        outcome,
        occurredAt: attempt.finishedAt as Date,
        payload: {
          provenance: "legacy_evidence_backfill_v1",
          requestId: attempt.requestId,
          reason: item.reason,
          evidence,
          terminalRecordRef: attempt.terminalRecordRef,
          errorCode: attempt.errorCode,
          errorSignature: attempt.errorSignature,
          retryability: attempt.retryability,
        },
        errorCode: attempt.errorCode,
        errorSignature: attempt.errorSignature,
        retryability: attempt.retryability,
        terminalRecordRef: attempt.terminalRecordRef,
      }));
      applied += 1;
    }
  }

  return {
    mode,
    cursor: options.cursor ?? null,
    nextCursor: attempts.length === batchSize ? attempts.at(-1)?.id ?? null : null,
    examined: attempts.length,
    ready: items.filter((item) => item.classification === "ready").length,
    applied,
    canonical: items.filter((item) => item.classification === "canonical").length,
    partial: items.filter((item) => item.classification === "partial").length,
    mismatch: items.filter((item) => item.classification === "mismatch").length,
    items,
  };
}
