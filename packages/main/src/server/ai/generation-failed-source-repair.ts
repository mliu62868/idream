import { Prisma, type PrismaClient } from "@prisma/client";
import { adminActorRoleSchema } from "@idream/shared/admin";
import {
  bullMqJobIdForDedupeKey,
  GEN_QUEUES,
} from "@idream/shared/contracts";
import { z } from "zod";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES } from "@/server/events/main-outbox-transport";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import {
  jobQueue,
  type JobQueue,
  type QueueJobSnapshot,
} from "@/server/jobs/queue";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { transitionControlPlaneCommand } from "@/server/modules/admin-v2/shared/control-plane-command-transition";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { readAttemptTerminalRecord } from "./generation-dispatch-evidence-authority";

export const FAILED_SOURCE_RESIDUE_COMMAND_TYPE =
  "generation.failed_source_residue.acknowledge";
export const FAILED_SOURCE_RESIDUE_TARGET_TYPE =
  "generation_failed_source_residue";
export const FAILED_SOURCE_RESIDUE_AUDIT_ACTION =
  "generation.failed_source_residue.acknowledged";

const inspectInputSchema = z.object({
  actorId: z.string().trim().min(1).max(160),
  queue: z.literal(GEN_QUEUES.videoGenerate),
  bullJobId: z.string().trim().min(1).max(512),
}).strict();

export const failedSourceResidueExpectationSchema = z.object({
  queue: z.literal(GEN_QUEUES.videoGenerate),
  bullJobId: z.string().min(1),
  dedupeKey: z.string().min(1),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  rowIdentityHash: z.string().regex(/^[a-f0-9]{64}$/),
  attemptsMade: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  failedReason: z.string().min(1),
  timestamp: z.number().int().positive(),
  processedOn: z.number().int().positive(),
  finishedOn: z.number().int().positive(),
  generationJobId: z.string().min(1),
  userId: z.string().min(1),
  jobVersion: z.number().int().positive(),
  jobFinishedAt: z.string().datetime(),
  attemptId: z.string().min(1),
  attemptNo: z.number().int().positive(),
  attemptFinishedAt: z.string().datetime(),
  attemptErrorCode: z.string().min(1),
  attemptRetryability: z.string().min(1),
  terminalEventId: z.string().min(1),
  priorTransportExecutionIds: z.tuple([z.string().min(1), z.string().min(1)]),
  transportExecutionId: z.string().min(1),
  transportAttemptNo: z.literal(3),
  terminalRecordRef: z.string().min(1),
  artifactId: z.string().min(1),
  artifactChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  deliveryId: z.string().min(1),
  lateArtifactEventId: z.string().min(1),
  spendEntryId: z.string().min(1),
  refundEntryId: z.string().min(1),
  spendSettlementLinkId: z.string().min(1),
  refundSettlementLinkId: z.string().min(1),
}).strict();

export type LegacyFailedGenerationSourceRepairExpectation = z.infer<
  typeof failedSourceResidueExpectationSchema
>;

const acknowledgeInputSchema = z.object({
  actorId: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(10).max(2_000),
  requestId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(200),
  expectation: failedSourceResidueExpectationSchema,
  confirmation: z.string().trim().min(1).max(2_000),
}).strict();

type RepairQueue = Pick<JobQueue, "inspectFailed">;

export type FailedSourceResidueDependencies = {
  readonly queue?: RepairQueue;
  readonly terminalRecordProbe?: (attemptId: string) => Promise<boolean>;
};

type Blocker = {
  readonly code: string;
  readonly detail?: string;
};

type EvidenceSummary = {
  readonly terminalEventId: string | null;
  readonly transportExecutionId: string | null;
  readonly transportAttemptNo: number | null;
  readonly previousTransportStatuses: readonly string[];
  readonly terminalRecordRef: string | null;
  readonly artifactId: string | null;
  readonly deliveryId: string | null;
  readonly deliveryStatus: string | null;
  readonly settlement: {
    readonly captured: number;
    readonly refunded: number;
    readonly spendEntryId: string | null;
    readonly refundEntryId: string | null;
  };
};

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function addBlocker(
  blockers: Blocker[],
  condition: boolean,
  code: string,
  detail?: string,
) {
  if (!condition) blockers.push({ code, ...(detail ? { detail } : {}) });
}

export function failedSourceRowPayloadHash(row: QueueJobSnapshot) {
  return canonicalSha256(row.payload);
}

export function failedSourceRowIdentityHash(row: QueueJobSnapshot) {
  return canonicalSha256({
    queue: row.queue,
    bullJobId: row.id,
    dedupeKey: row.dedupeKey,
    payloadHash: failedSourceRowPayloadHash(row),
    state: row.state,
    attemptsMade: row.attemptsMade,
    maxAttempts: row.maxAttempts,
    failedReason: row.failedReason ?? null,
    timestamp: row.timestamp,
    processedOn: row.processedOn ?? null,
    finishedOn: row.finishedOn ?? null,
  });
}

async function authorizedOperator(db: PrismaClient, actorId: string) {
  const actor = await db.user.findUnique({
    where: { id: actorId },
    select: { id: true, role: true, status: true },
  });
  const role = adminActorRoleSchema.safeParse(actor?.role);
  if (!actor || actor.status !== "active" || !role.success) {
    throw Errors.forbidden("Repair actor is not an active admin operator");
  }
  const permissions = await effectivePermissions(actor.id, role.data);
  if (!permissions.has("ops.deadletter.write")) {
    throw Errors.forbidden("Missing admin permission", {
      permission: "ops.deadletter.write",
    });
  }
  return { id: actor.id, role: role.data };
}

async function findFailedRow(
  queue: RepairQueue,
  queueName: typeof GEN_QUEUES.videoGenerate,
  bullJobId: string,
) {
  for (let offset = 0; ; offset += 100) {
    const page = await queue.inspectFailed([queueName], { limit: 100, offset });
    const row = page.find((candidate) => candidate.id === bullJobId);
    if (row) return row;
    if (page.length < 100) return null;
  }
}

async function terminalRecordExists(
  attemptId: string,
  probe?: (attemptId: string) => Promise<boolean>,
) {
  if (probe) return probe(attemptId);
  const read = await readAttemptTerminalRecord(attemptId);
  return read.ok;
}

async function inspectDatabaseEvidence(
  db: PrismaClient,
  identity: {
    readonly generationJobId: string;
    readonly attemptId: string;
    readonly attemptNo: number;
    readonly userId: string;
  },
  terminalProbe?: (attemptId: string) => Promise<boolean>,
  expected?: LegacyFailedGenerationSourceRepairExpectation,
) {
  const [
    job,
    attempts,
    terminalEvent,
    transports,
    artifacts,
    deliveries,
    ledger,
    settlementLinks,
    dispatchOutboxes,
    lateArtifactEvents,
    mediaCount,
    exactTerminalRecordExists,
  ] = await Promise.all([
    db.generationJob.findUnique({
      where: { id: identity.generationJobId },
      select: {
        id: true,
        userId: true,
        mode: true,
        status: true,
        sourceType: true,
        costDreamcoins: true,
        outputCount: true,
        deliveredOutputCount: true,
        completedAt: true,
        finishedAt: true,
        errorCode: true,
        version: true,
      },
    }),
    db.generationAttempt.findMany({
      where: { requestId: identity.generationJobId },
      orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
    }),
    db.generationAttemptEvent.findUnique({
      where: {
        attemptId_terminalScope: {
          attemptId: identity.attemptId,
          terminalScope: "terminal",
        },
      },
    }),
    db.generationTransportExecution.findMany({
      where: { attemptId: identity.attemptId },
      orderBy: { transportAttemptNo: "asc" },
    }),
    db.generationArtifact.findMany({
      where: { attemptId: identity.attemptId },
      orderBy: { ordinal: "asc" },
    }),
    db.generationDelivery.findMany({
      where: { requestId: identity.generationJobId },
      orderBy: { createdAt: "asc" },
    }),
    db.dreamcoinLedger.findMany({
      where: {
        sourceId: identity.generationJobId,
        reason: { in: ["generation_spend", "refund"] },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.generationSettlementLink.findMany({
      where: { requestId: identity.generationJobId },
      orderBy: { createdAt: "asc" },
    }),
    db.mainOutboxEvent.findMany({
      where: {
        aggregateId: identity.generationJobId,
        eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
      },
      select: { id: true },
    }),
    db.generationJobEvent.findMany({
      where: {
        jobId: identity.generationJobId,
        type: "late_artifact_archived",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    db.mediaAsset.count({ where: { sourceJobId: identity.generationJobId } }),
    terminalRecordExists(identity.attemptId, terminalProbe).catch(() => true),
  ]);

  const blockers: Blocker[] = [];
  const latestAttempt = attempts[0] ?? null;
  const attempt = attempts.find((candidate) => candidate.id === identity.attemptId) ?? null;
  const first = transports[0] ?? null;
  const second = transports[1] ?? null;
  const third = transports[2] ?? null;
  const artifact = artifacts[0] ?? null;
  const delivery = deliveries[0] ?? null;
  const spendRows = ledger.filter((entry) => entry.reason === "generation_spend");
  const refundRows = ledger.filter((entry) => entry.reason === "refund");
  const spend = spendRows[0] ?? null;
  const refund = refundRows[0] ?? null;
  const captured = spendRows.reduce(
    (sum, entry) => sum + (entry.delta < 0 ? -entry.delta : 0),
    0,
  );
  const refunded = refundRows.reduce(
    (sum, entry) => sum + (entry.delta > 0 ? entry.delta : 0),
    0,
  );
  const linkByLedgerId = new Map(
    settlementLinks.map((link) => [link.ledgerEntryId, link]),
  );
  const spendLink = spend ? linkByLedgerId.get(spend.id) ?? null : null;
  const refundLink = refund ? linkByLedgerId.get(refund.id) ?? null : null;
  const terminalPayload = jsonRecord(terminalEvent?.payload);
  const lateArtifactEvent = lateArtifactEvents.find((event) => {
    const metadata = jsonRecord(event.metadata);
    return metadata.attemptId === identity.attemptId;
  }) ?? null;
  const lateMetadata = jsonRecord(lateArtifactEvent?.metadata);

  addBlocker(blockers, Boolean(job), "job_not_found");
  if (job) {
    addBlocker(blockers, job.userId === identity.userId, "job_user_mismatch");
    addBlocker(blockers, job.mode === "video", "job_mode_mismatch");
    addBlocker(blockers, job.status === "failed", "job_not_failed_terminal");
    addBlocker(blockers, job.sourceType === "generator", "job_source_type_mismatch");
    addBlocker(blockers, job.costDreamcoins > 0, "job_cost_not_positive");
    addBlocker(blockers, job.outputCount === 1, "job_output_count_mismatch");
    addBlocker(blockers, job.deliveredOutputCount === 0, "job_has_delivered_output");
    addBlocker(blockers, job.completedAt === null, "job_marked_completed");
    addBlocker(blockers, job.finishedAt !== null, "job_missing_finished_at");
    addBlocker(blockers, Boolean(job.errorCode), "job_error_code_missing");
    if (expected) {
      addBlocker(blockers, job.version === expected.jobVersion, "job_version_changed");
      addBlocker(
        blockers,
        job.finishedAt?.toISOString() === expected.jobFinishedAt,
        "job_finished_at_changed",
      );
    }
  }
  addBlocker(blockers, attempts.length === 1, "attempt_history_not_singleton");
  addBlocker(blockers, latestAttempt?.id === identity.attemptId, "attempt_not_latest");
  addBlocker(blockers, Boolean(attempt), "attempt_not_found");
  if (attempt) {
    addBlocker(blockers, attempt.requestId === identity.generationJobId, "attempt_job_mismatch");
    addBlocker(blockers, attempt.attemptNo === identity.attemptNo, "attempt_number_mismatch");
    addBlocker(blockers, attempt.status === "failed", "attempt_not_failed_terminal");
    addBlocker(blockers, attempt.finishedAt !== null, "attempt_missing_finished_at");
    addBlocker(blockers, Boolean(attempt.errorCode), "attempt_error_code_missing");
    addBlocker(blockers, Boolean(attempt.retryability), "attempt_retryability_missing");
    addBlocker(blockers, attempt.terminalRecordRef === null, "attempt_has_recoverable_terminal_ref");
    addBlocker(blockers, attempt.errorCode === job?.errorCode, "job_attempt_error_mismatch");
    if (expected) {
      addBlocker(
        blockers,
        attempt.finishedAt?.toISOString() === expected.attemptFinishedAt,
        "attempt_finished_at_changed",
      );
      addBlocker(blockers, attempt.errorCode === expected.attemptErrorCode, "attempt_error_code_changed");
      addBlocker(
        blockers,
        attempt.retryability === expected.attemptRetryability,
        "attempt_retryability_changed",
      );
    }
  }
  addBlocker(blockers, Boolean(terminalEvent), "terminal_event_missing");
  if (terminalEvent && attempt) {
    addBlocker(blockers, terminalEvent.eventType === "generation.attempt.failed.v1", "terminal_event_type_mismatch");
    addBlocker(blockers, terminalEvent.outcome === "failed", "terminal_event_outcome_mismatch");
    addBlocker(blockers, terminalEvent.sequence === attempt.terminalSequence, "terminal_event_sequence_mismatch");
    addBlocker(blockers, terminalPayload.requestId === identity.generationJobId, "terminal_event_job_mismatch");
    addBlocker(blockers, terminalPayload.requestOutcome === "failed", "terminal_event_request_outcome_mismatch");
    addBlocker(blockers, terminalPayload.errorCode === attempt.errorCode, "terminal_payload_error_mismatch");
    addBlocker(blockers, terminalPayload.refundAmount === job?.costDreamcoins, "terminal_event_refund_mismatch");
  }
  addBlocker(blockers, !exactTerminalRecordExists, "exact_terminal_record_exists");
  addBlocker(blockers, dispatchOutboxes.length === 0, "immutable_dispatch_outbox_exists");

  const expectedProviderKey = `generation:${identity.attemptId}:provider`;
  addBlocker(blockers, transports.length === 3, "transport_history_mismatch");
  for (const [index, transport] of transports.entries()) {
    addBlocker(blockers, transport.transportAttemptNo === index + 1, "transport_number_mismatch");
    addBlocker(blockers, transport.idempotencyKey === expectedProviderKey, "transport_identity_mismatch");
  }
  for (const prior of [first, second]) {
    if (!prior) continue;
    addBlocker(blockers, prior.status === "running", "prior_transport_status_mismatch");
    addBlocker(blockers, prior.providerRequestId === null, "prior_transport_has_provider_request");
    addBlocker(blockers, prior.terminalRecordRef === null, "prior_transport_has_terminal_record");
    addBlocker(blockers, prior.finishedAt === null, "prior_transport_finished_unexpectedly");
  }
  addBlocker(blockers, Boolean(third), "terminal_transport_missing");
  if (third) {
    addBlocker(blockers, third.transportAttemptNo === 3, "terminal_transport_number_mismatch");
    addBlocker(blockers, third.status === "succeeded", "terminal_transport_not_succeeded");
    addBlocker(blockers, third.providerRequestId === null, "terminal_transport_provider_identity_changed");
    addBlocker(blockers, Boolean(third.terminalRecordRef), "terminal_transport_ref_missing");
    addBlocker(blockers, third.finishedAt !== null, "terminal_transport_finished_at_missing");
  }

  addBlocker(blockers, artifacts.length === 1, "artifact_count_mismatch");
  if (artifact) {
    addBlocker(blockers, artifact.ordinal === 0, "artifact_ordinal_mismatch");
    addBlocker(blockers, Boolean(artifact.providerRef), "artifact_provider_ref_missing");
    addBlocker(blockers, artifact.validationState === "late_after_failed", "artifact_not_late_after_failed");
    addBlocker(blockers, artifact.archiveState === "archived", "artifact_not_archived");
    addBlocker(blockers, artifact.assetId === null, "artifact_attached_to_media");
  }
  addBlocker(blockers, deliveries.length === 1, "delivery_count_mismatch");
  if (delivery && artifact && job) {
    addBlocker(blockers, delivery.artifactId === artifact.id, "delivery_artifact_mismatch");
    addBlocker(blockers, delivery.status === "suppressed", "delivery_not_suppressed");
    addBlocker(blockers, delivery.deliveredAt === null, "delivery_marked_delivered");
    addBlocker(blockers, delivery.targetType === "user_library", "delivery_target_type_mismatch");
    addBlocker(blockers, delivery.targetId === job.userId, "delivery_target_mismatch");
  }
  addBlocker(blockers, mediaCount === 0, "job_has_media_asset");
  addBlocker(blockers, Boolean(lateArtifactEvent), "late_artifact_event_missing");
  if (third && lateArtifactEvent) {
    addBlocker(blockers, lateMetadata.assetCount === 1, "late_artifact_event_count_mismatch");
    addBlocker(blockers, lateMetadata.terminalStatus === "failed", "late_artifact_event_status_mismatch");
    addBlocker(blockers, lateMetadata.manifestRef === third.terminalRecordRef, "late_artifact_event_ref_mismatch");
  }

  addBlocker(blockers, spendRows.length === 1, "generation_spend_count_mismatch");
  addBlocker(blockers, refundRows.length === 1, "refund_count_mismatch");
  if (job && spend && refund) {
    addBlocker(blockers, spend.userId === job.userId && refund.userId === job.userId, "settlement_user_mismatch");
    addBlocker(blockers, spend.delta === -job.costDreamcoins, "generation_spend_amount_mismatch");
    addBlocker(blockers, refund.delta === job.costDreamcoins, "refund_amount_mismatch");
    addBlocker(blockers, captured === job.costDreamcoins, "captured_total_mismatch");
    addBlocker(blockers, refunded === captured, "settlement_not_fully_refunded");
    addBlocker(blockers, settlementLinks.length === 2, "settlement_link_count_mismatch");
    addBlocker(
      blockers,
      spendLink?.requestId === job.id && spendLink.kind === "generation_spend",
      "generation_spend_link_mismatch",
    );
    addBlocker(
      blockers,
      refundLink?.requestId === job.id && refundLink.kind === "refund",
      "refund_link_mismatch",
    );
  }

  if (expected) {
    addBlocker(blockers, terminalEvent?.id === expected.terminalEventId, "terminal_event_identity_changed");
    addBlocker(
      blockers,
      first?.id === expected.priorTransportExecutionIds[0] &&
        second?.id === expected.priorTransportExecutionIds[1],
      "prior_transport_identity_changed",
    );
    addBlocker(blockers, third?.id === expected.transportExecutionId, "terminal_transport_identity_changed");
    addBlocker(blockers, third?.terminalRecordRef === expected.terminalRecordRef, "terminal_transport_ref_changed");
    addBlocker(blockers, artifact?.id === expected.artifactId, "artifact_identity_changed");
    addBlocker(blockers, artifact?.terminalRecordChecksum === expected.artifactChecksum, "artifact_checksum_changed");
    addBlocker(blockers, delivery?.id === expected.deliveryId, "delivery_identity_changed");
    addBlocker(blockers, lateArtifactEvent?.id === expected.lateArtifactEventId, "late_artifact_event_identity_changed");
    addBlocker(blockers, spend?.id === expected.spendEntryId, "spend_identity_changed");
    addBlocker(blockers, refund?.id === expected.refundEntryId, "refund_identity_changed");
    addBlocker(blockers, spendLink?.id === expected.spendSettlementLinkId, "spend_link_identity_changed");
    addBlocker(blockers, refundLink?.id === expected.refundSettlementLinkId, "refund_link_identity_changed");
  }

  const evidence: EvidenceSummary = {
    terminalEventId: terminalEvent?.id ?? null,
    transportExecutionId: third?.id ?? null,
    transportAttemptNo: third?.transportAttemptNo ?? null,
    previousTransportStatuses: [first?.status ?? "missing", second?.status ?? "missing"],
    terminalRecordRef: third?.terminalRecordRef ?? null,
    artifactId: artifact?.id ?? null,
    deliveryId: delivery?.id ?? null,
    deliveryStatus: delivery?.status ?? null,
    settlement: {
      captured,
      refunded,
      spendEntryId: spend?.id ?? null,
      refundEntryId: refund?.id ?? null,
    },
  };
  return {
    blockers,
    evidence,
    job,
    attempt,
    terminalEvent,
    first,
    second,
    third,
    artifact,
    delivery,
    lateArtifactEvent,
    spend,
    refund,
    spendLink,
    refundLink,
  };
}

export function expectedFailedSourceResidueConfirmation(
  expectation: LegacyFailedGenerationSourceRepairExpectation,
) {
  return [
    "ACKNOWLEDGE_FAILED_GENERATION_SOURCE_RESIDUE",
    expectation.queue,
    expectation.bullJobId,
    expectation.rowIdentityHash,
  ].join(" ");
}

export async function inspectLegacyFailedGenerationSourceResidue(
  db: PrismaClient,
  row: QueueJobSnapshot,
  dependencies: Pick<FailedSourceResidueDependencies, "terminalRecordProbe"> = {},
  expected?: LegacyFailedGenerationSourceRepairExpectation,
) {
  const blockers: Blocker[] = [];
  const payload = jsonRecord(row.payload);
  const generationJobId = stringValue(payload.generationJobId);
  const attemptId = stringValue(payload.attemptId);
  const attemptNo = positiveInteger(payload.attemptNo);
  const userId = stringValue(payload.userId);
  addBlocker(blockers, row.queue === GEN_QUEUES.videoGenerate, "queue_mismatch");
  addBlocker(blockers, row.state === "failed", "row_not_failed");
  addBlocker(blockers, row.finishedOn !== undefined, "row_finished_on_missing");
  addBlocker(blockers, row.processedOn !== undefined, "row_processed_on_missing");
  addBlocker(blockers, row.attemptsMade === row.maxAttempts, "row_retry_budget_not_exhausted");
  addBlocker(blockers, row.failedReason === "main generation ingest returned 503", "row_failure_reason_mismatch");
  addBlocker(blockers, Boolean(generationJobId), "row_job_identity_missing");
  addBlocker(blockers, Boolean(attemptId), "row_attempt_identity_missing");
  addBlocker(blockers, attemptNo !== null, "row_attempt_number_missing");
  addBlocker(blockers, Boolean(userId), "row_user_identity_missing");
  if (!generationJobId || !attemptId || attemptNo === null || !userId) {
    return {
      eligible: false,
      blockers,
      expectation: null,
      confirmation: null,
      evidence: null,
    } as const;
  }

  const dedupeKey = `generation:${generationJobId}`;
  addBlocker(blockers, row.dedupeKey === dedupeKey, "legacy_dedupe_identity_mismatch");
  addBlocker(blockers, row.id === bullMqJobIdForDedupeKey(dedupeKey), "legacy_bull_job_id_mismatch");
  addBlocker(blockers, payload.version === 1, "legacy_payload_version_mismatch");
  addBlocker(blockers, payload.kind === "video", "legacy_payload_kind_mismatch");
  addBlocker(blockers, stringValue(payload.requestId)?.startsWith("admin_requeue_") === true, "legacy_request_identity_mismatch");
  addBlocker(blockers, payload.outputPrefix === `gen/${generationJobId}/`, "legacy_output_prefix_mismatch");
  if (expected) {
    addBlocker(blockers, row.queue === expected.queue, "ack_queue_changed");
    addBlocker(blockers, row.id === expected.bullJobId, "ack_bull_job_id_changed");
    addBlocker(blockers, row.dedupeKey === expected.dedupeKey, "ack_dedupe_changed");
    addBlocker(blockers, failedSourceRowPayloadHash(row) === expected.payloadHash, "ack_payload_changed");
    addBlocker(blockers, failedSourceRowIdentityHash(row) === expected.rowIdentityHash, "ack_row_identity_changed");
    addBlocker(blockers, row.attemptsMade === expected.attemptsMade, "ack_attempts_made_changed");
    addBlocker(blockers, row.maxAttempts === expected.maxAttempts, "ack_max_attempts_changed");
    addBlocker(blockers, row.failedReason === expected.failedReason, "ack_failed_reason_changed");
    addBlocker(blockers, row.timestamp === expected.timestamp, "ack_timestamp_changed");
    addBlocker(blockers, row.processedOn === expected.processedOn, "ack_processed_on_changed");
    addBlocker(blockers, row.finishedOn === expected.finishedOn, "ack_finished_on_changed");
  }

  const database = await inspectDatabaseEvidence(
    db,
    { generationJobId, attemptId, attemptNo, userId },
    dependencies.terminalRecordProbe,
    expected,
  );
  blockers.push(...database.blockers);
  const eligible = blockers.length === 0;
  const expectation = eligible &&
      row.processedOn !== undefined &&
      row.finishedOn !== undefined &&
      row.failedReason &&
      database.job?.finishedAt &&
      database.attempt?.finishedAt &&
      database.attempt.errorCode &&
      database.attempt.retryability &&
      database.terminalEvent &&
      database.first &&
      database.second &&
      database.third?.terminalRecordRef &&
      database.artifact?.terminalRecordChecksum &&
      database.delivery &&
      database.lateArtifactEvent &&
      database.spend &&
      database.refund &&
      database.spendLink &&
      database.refundLink
    ? failedSourceResidueExpectationSchema.parse({
        queue: GEN_QUEUES.videoGenerate,
        bullJobId: row.id,
        dedupeKey,
        payloadHash: failedSourceRowPayloadHash(row),
        rowIdentityHash: failedSourceRowIdentityHash(row),
        attemptsMade: row.attemptsMade,
        maxAttempts: row.maxAttempts,
        failedReason: row.failedReason,
        timestamp: row.timestamp,
        processedOn: row.processedOn,
        finishedOn: row.finishedOn,
        generationJobId,
        userId,
        jobVersion: database.job.version,
        jobFinishedAt: database.job.finishedAt.toISOString(),
        attemptId,
        attemptNo,
        attemptFinishedAt: database.attempt.finishedAt.toISOString(),
        attemptErrorCode: database.attempt.errorCode,
        attemptRetryability: database.attempt.retryability,
        terminalEventId: database.terminalEvent.id,
        priorTransportExecutionIds: [database.first.id, database.second.id],
        transportExecutionId: database.third.id,
        transportAttemptNo: database.third.transportAttemptNo,
        terminalRecordRef: database.third.terminalRecordRef,
        artifactId: database.artifact.id,
        artifactChecksum: database.artifact.terminalRecordChecksum,
        deliveryId: database.delivery.id,
        lateArtifactEventId: database.lateArtifactEvent.id,
        spendEntryId: database.spend.id,
        refundEntryId: database.refund.id,
        spendSettlementLinkId: database.spendLink.id,
        refundSettlementLinkId: database.refundLink.id,
      })
    : null;
  return {
    eligible,
    blockers,
    expectation,
    confirmation: expectation
      ? expectedFailedSourceResidueConfirmation(expectation)
      : null,
    evidence: database.evidence,
  } as const;
}

export async function inspectLegacyFailedGenerationSourceRepair(
  db: PrismaClient,
  rawInput: z.input<typeof inspectInputSchema>,
  dependencies: FailedSourceResidueDependencies = {},
) {
  const input = inspectInputSchema.parse(rawInput);
  await authorizedOperator(db, input.actorId);
  const row = await findFailedRow(
    dependencies.queue ?? jobQueue,
    input.queue,
    input.bullJobId,
  );
  if (!row) {
    return {
      eligible: false,
      blockers: [{ code: "failed_row_not_found" }],
      expectation: null,
      confirmation: null,
      evidence: null,
    } as const;
  }
  return inspectLegacyFailedGenerationSourceResidue(db, row, dependencies);
}

function acknowledgementRequestHash(
  expectation: LegacyFailedGenerationSourceRepairExpectation,
) {
  return canonicalSha256({
    commandType: FAILED_SOURCE_RESIDUE_COMMAND_TYPE,
    target: {
      type: FAILED_SOURCE_RESIDUE_TARGET_TYPE,
      id: expectation.bullJobId,
    },
    payload: { expectation },
    retryMode: "idempotent",
  });
}

function sameExpectation(
  left: LegacyFailedGenerationSourceRepairExpectation,
  right: LegacyFailedGenerationSourceRepairExpectation,
) {
  return canonicalSha256(left) === canonicalSha256(right);
}

async function hasExactAcknowledgementAudit(
  db: Pick<PrismaClient, "adminAuditLog">,
  command: {
    readonly id: string;
    readonly actorId: string;
    readonly requestId: string;
    readonly requestHash: string;
    readonly targetId: string;
  },
  expectation: LegacyFailedGenerationSourceRepairExpectation,
) {
  const audits = await db.adminAuditLog.findMany({
    where: {
      actorId: command.actorId,
      action: FAILED_SOURCE_RESIDUE_AUDIT_ACTION,
      targetType: FAILED_SOURCE_RESIDUE_TARGET_TYPE,
      targetId: command.targetId,
      requestId: command.requestId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const expectationHash = canonicalSha256(expectation);
  return audits.some((audit) => {
    const after = jsonRecord(audit.after);
    return after.commandId === command.id &&
      after.requestHash === command.requestHash &&
      after.expectationHash === expectationHash &&
      after.acknowledged === true &&
      after.retainedBullEvidence === true;
  });
}

export async function isAcknowledgedLegacyFailedGenerationSourceResidue(
  db: PrismaClient,
  row: QueueJobSnapshot,
  dependencies: Pick<FailedSourceResidueDependencies, "terminalRecordProbe"> = {},
) {
  const current = await inspectLegacyFailedGenerationSourceResidue(
    db,
    row,
    dependencies,
  );
  if (!current.eligible || !current.expectation) {
    return { acknowledged: false, blockers: current.blockers } as const;
  }
  const commands = await db.controlPlaneCommand.findMany({
    where: {
      commandType: FAILED_SOURCE_RESIDUE_COMMAND_TYPE,
      targetType: FAILED_SOURCE_RESIDUE_TARGET_TYPE,
      targetId: row.id,
      status: "succeeded",
      needsReconciliation: false,
    },
    orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
  });
  for (const command of commands) {
    const payload = jsonRecord(command.requestPayload);
    const parsed = failedSourceResidueExpectationSchema.safeParse(
      payload.expectation,
    );
    if (!parsed.success || !sameExpectation(parsed.data, current.expectation)) {
      continue;
    }
    if (
      command.requestHash !== acknowledgementRequestHash(parsed.data) ||
      command.expectedVersion !== parsed.data.jobVersion
    ) {
      continue;
    }
    if (await hasExactAcknowledgementAudit(db, command, parsed.data)) {
      return {
        acknowledged: true,
        commandId: command.id,
        expectation: parsed.data,
        blockers: [],
      } as const;
    }
  }
  return {
    acknowledged: false,
    blockers: [{ code: "exact_acknowledgement_missing" }],
  } as const;
}

export async function acknowledgeLegacyFailedGenerationSourceResidue(
  db: PrismaClient,
  rawInput: z.input<typeof acknowledgeInputSchema>,
  dependencies: FailedSourceResidueDependencies = {},
) {
  const input = acknowledgeInputSchema.parse(rawInput);
  const actor = await authorizedOperator(db, input.actorId);
  if (
    input.confirmation !==
      expectedFailedSourceResidueConfirmation(input.expectation)
  ) {
    throw Errors.badRequest(
      "Typed confirmation does not match the exact failed Bull residue",
    );
  }
  const queue = dependencies.queue ?? jobQueue;
  const row = await findFailedRow(
    queue,
    input.expectation.queue,
    input.expectation.bullJobId,
  );
  if (!row) {
    throw Errors.conflict("Failed source residue is no longer present");
  }
  const reviewed = await inspectLegacyFailedGenerationSourceResidue(
    db,
    row,
    dependencies,
    input.expectation,
  );
  if (
    !reviewed.eligible ||
    !reviewed.expectation ||
    !sameExpectation(reviewed.expectation, input.expectation)
  ) {
    throw Errors.conflict(
      "Failed source residue no longer matches the reviewed acknowledgement",
      { blockers: reviewed.blockers },
    );
  }

  const scope = `${env.APP_ENV}:${actor.id}`;
  const requestHash = acknowledgementRequestHash(input.expectation);
  const existing = await db.controlPlaneCommand.findUnique({
    where: {
      scope_idempotencyKey: {
        scope,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw Errors.conflict(
        "Idempotency key is bound to another residue acknowledgement",
        { commandId: existing.id },
      );
    }
    if (
      existing.status !== "succeeded" ||
      existing.needsReconciliation ||
      !(await hasExactAcknowledgementAudit(db, existing, input.expectation))
    ) {
      throw Errors.conflict("Existing acknowledgement is not authoritative", {
        commandId: existing.id,
        status: existing.status,
      });
    }
    return {
      commandId: existing.id,
      status: "succeeded" as const,
      acknowledged: true,
      retainedBullEvidence: true,
      replayed: true,
    };
  }

  try {
    const command = await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${`generation-failed-source-residue:${input.expectation.bullJobId}`})
        )
      `;
      const raced = await tx.controlPlaneCommand.findUnique({
        where: {
          scope_idempotencyKey: {
            scope,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (raced) {
        if (raced.requestHash !== requestHash) {
          throw Errors.conflict(
            "Idempotency key raced another residue acknowledgement",
          );
        }
        return raced;
      }

      const targetReceipts = await tx.controlPlaneCommand.findMany({
        where: {
          commandType: FAILED_SOURCE_RESIDUE_COMMAND_TYPE,
          targetType: FAILED_SOURCE_RESIDUE_TARGET_TYPE,
          targetId: input.expectation.bullJobId,
          status: "succeeded",
          needsReconciliation: false,
        },
        orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
      });
      for (const receipt of targetReceipts) {
        const payload = jsonRecord(receipt.requestPayload);
        const parsed = failedSourceResidueExpectationSchema.safeParse(
          payload.expectation,
        );
        if (
          parsed.success &&
          sameExpectation(parsed.data, input.expectation) &&
          receipt.requestHash === acknowledgementRequestHash(parsed.data) &&
          await hasExactAcknowledgementAudit(tx, receipt, parsed.data)
        ) {
          throw Errors.conflict(
            "This exact residue already has an authoritative acknowledgement",
            { commandId: receipt.id },
          );
        }
      }

      const accepted = await tx.controlPlaneCommand.create({
        data: {
          scope,
          idempotencyKey: input.idempotencyKey,
          coordinationKey:
            `generation-failed-source-residue:${input.expectation.bullJobId}`,
          commandType: FAILED_SOURCE_RESIDUE_COMMAND_TYPE,
          targetType: FAILED_SOURCE_RESIDUE_TARGET_TYPE,
          targetId: input.expectation.bullJobId,
          actorId: actor.id,
          requestId: input.requestId,
          requestHash,
          requestPayload: toInputJson({ expectation: input.expectation }),
          expectedVersion: input.expectation.jobVersion,
          retryMode: "idempotent",
          status: "accepted",
          maxAttempts: 1,
        },
      });
      await transitionControlPlaneCommand(tx, {
        commandId: accepted.id,
        to: "running",
        expected: { from: "accepted" },
      });
      await transitionControlPlaneCommand(tx, {
        commandId: accepted.id,
        to: "verifying",
        expected: { from: "running" },
      });
      const succeeded = await transitionControlPlaneCommand(tx, {
        commandId: accepted.id,
        to: "succeeded",
        expected: { from: "verifying" },
        data: {
          result: toInputJson({
            acknowledged: true,
            retainedBullEvidence: true,
            expectationHash: canonicalSha256(input.expectation),
          }),
          error: Prisma.DbNull,
          needsReconciliation: false,
          finishedAt: new Date(),
        },
      });
      // SPEC: no queue mutation or generic command Outbox is emitted. The
      // acknowledgement is a conditional Main receipt; every gate invocation
      // must re-prove the retained Bull row, DB settlement, archive disposition,
      // and continued absence of a Blob terminal record.
      await tx.adminAuditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: FAILED_SOURCE_RESIDUE_AUDIT_ACTION,
          targetType: FAILED_SOURCE_RESIDUE_TARGET_TYPE,
          targetId: input.expectation.bullJobId,
          reason: input.reason,
          before: toInputJson({
            expectation: input.expectation,
            evidence: reviewed.evidence,
          }),
          after: toInputJson({
            commandId: succeeded.id,
            requestHash,
            expectationHash: canonicalSha256(input.expectation),
            acknowledged: true,
            retainedBullEvidence: true,
          }),
          requestId: input.requestId,
        },
      });
      return succeeded;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

    const currentRow = await findFailedRow(
      queue,
      input.expectation.queue,
      input.expectation.bullJobId,
    );
    const currentAuthority = currentRow
      ? await isAcknowledgedLegacyFailedGenerationSourceResidue(
          db,
          currentRow,
          dependencies,
        )
      : { acknowledged: false as const };
    if (
      command.status !== "succeeded" ||
      command.needsReconciliation ||
      !currentAuthority.acknowledged ||
      currentAuthority.commandId !== command.id
    ) {
      throw Errors.conflict("Acknowledgement receipt did not become authoritative", {
        commandId: command.id,
      });
    }
    return {
      commandId: command.id,
      status: "succeeded" as const,
      acknowledged: true,
      retainedBullEvidence: true,
      replayed: false,
    };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await db.controlPlaneCommand.findUnique({
        where: {
          scope_idempotencyKey: {
            scope,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (
        raced?.requestHash === requestHash &&
        raced.status === "succeeded" &&
        !raced.needsReconciliation &&
        await hasExactAcknowledgementAudit(db, raced, input.expectation)
      ) {
        return {
          commandId: raced.id,
          status: "succeeded" as const,
          acknowledged: true,
          retainedBullEvidence: true,
          replayed: true,
        };
      }
    }
    throw error;
  }
}
