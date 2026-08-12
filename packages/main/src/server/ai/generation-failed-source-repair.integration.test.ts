import { randomUUID } from "node:crypto";
import { GEN_QUEUES } from "@idream/shared/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  bullMqJobIdForDedupeKey,
  type QueueJobSnapshot,
} from "@/server/jobs/queue";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import {
  acknowledgeLegacyFailedGenerationSourceResidue,
  FAILED_SOURCE_RESIDUE_AUDIT_ACTION,
  failedSourceRowIdentityHash,
  failedSourceRowPayloadHash,
  inspectLegacyFailedGenerationSourceRepair,
  isAcknowledgedLegacyFailedGenerationSourceResidue,
} from "./generation-failed-source-repair";
import {
  assessGenerationDispatchCutoverReadiness,
  assessGenerationQueueDrainReadiness,
  GENERATION_CUTOVER_QUEUES,
} from "./generation-dispatch-cutover";

describe("legacy failed Generation source repair", () => {
  const prefix = `generation-source-repair-${randomUUID()}`;
  const actorId = `${prefix}-actor`;
  const userId = `${prefix}-user`;
  const jobIds: string[] = [];

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: actorId, email: `${actorId}@idream.internal`, role: "admin", status: "active" },
        { id: userId, email: `${userId}@idream.internal`, role: "user", status: "active" },
      ],
    });
  });

  afterAll(async () => {
    const attempts = await prisma.generationAttempt.findMany({
      where: { requestId: { in: jobIds } },
      select: { id: true },
    });
    const attemptIds = attempts.map((row) => row.id);
    await prisma.controlPlaneCommandAttempt.deleteMany({
      where: { commandId: { startsWith: prefix } },
    });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.mainOutboxEvent.deleteMany({
      where: {
        OR: [
          { aggregateId: { in: jobIds } },
          { aggregateId: { in: attemptIds } },
        ],
      },
    });
    await prisma.generationDelivery.deleteMany({
      where: { requestId: { in: jobIds } },
    });
    await prisma.generationArtifact.deleteMany({
      where: { attemptId: { in: attemptIds } },
    });
    await prisma.generationTransportExecution.deleteMany({
      where: { attemptId: { in: attemptIds } },
    });
    await prisma.generationAttemptEvent.deleteMany({
      where: { attemptId: { in: attemptIds } },
    });
    await prisma.generationAttempt.deleteMany({
      where: { requestId: { in: jobIds } },
    });
    await prisma.generationSettlementLink.deleteMany({
      where: { requestId: { in: jobIds } },
    });
    await prisma.dreamcoinLedger.deleteMany({
      where: { sourceId: { in: jobIds } },
    });
    await prisma.generationJobEvent.deleteMany({
      where: { jobId: { in: jobIds } },
    });
    await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, userId] } } });
    await prisma.$disconnect();
  });

  async function fixture(
    label: string,
    options: { readonly terminal?: boolean } = {},
  ) {
    const jobId = `${prefix}-${label}`;
    const attemptId = `${jobId}-attempt-1`;
    const finishedAt = new Date("2026-07-25T13:48:33.342Z");
    const terminalRecordRef =
      `gen/completion-manifests/${attemptId}/completion.json`;
    const artifactId = `${jobId}-artifact-1`;
    const deliveryId = `${jobId}-delivery-1`;
    const spendId = `${jobId}-spend`;
    const refundId = `${jobId}-refund`;
    jobIds.push(jobId);

    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId,
        mode: "video",
        controls: {},
        presetIds: [],
        outputCount: 1,
        deliveredOutputCount: 0,
        status: "queued",
        costDreamcoins: 100,
        provider: "comfyui",
        model: "ltx23-gtanimation-i2v",
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: attemptId,
        requestId: jobId,
        attemptNo: 1,
        status: "queued",
        startedAt: new Date("2026-07-25T13:37:13.762Z"),
      },
    });
    await prisma.$transaction(async (tx) => {
      await recordGenerationAttemptEvent(tx, {
        eventId: `${attemptId}:queued`,
        attemptId,
        eventType: "generation.attempt.queued.v1",
        status: "queued",
        occurredAt: new Date("2026-07-25T13:37:13.741Z"),
        payload: { requestId: jobId, attemptNo: 1 },
      });
    });
    await prisma.generationTransportExecution.createMany({
      data: [
        {
          id: `${jobId}-transport-1`,
          attemptId,
          transportAttemptNo: 1,
          idempotencyKey: `generation:${attemptId}:provider`,
          status: "running",
          startedAt: new Date("2026-07-25T13:37:13.762Z"),
        },
        {
          id: `${jobId}-transport-2`,
          attemptId,
          transportAttemptNo: 2,
          idempotencyKey: `generation:${attemptId}:provider`,
          status: "running",
          startedAt: new Date("2026-07-25T13:39:19.165Z"),
        },
        {
          id: `${jobId}-transport-3`,
          attemptId,
          transportAttemptNo: 3,
          idempotencyKey: `generation:${attemptId}:provider`,
          status: "succeeded",
          latencyMs: 330_674,
          terminalRecordRef,
          startedAt: new Date("2026-07-25T13:43:02.639Z"),
          finishedAt,
        },
      ],
    });
    await prisma.dreamcoinLedger.createMany({
      data: [
        {
          id: spendId,
          userId,
          delta: -100,
          balanceAfter: 900,
          reason: "generation_spend",
          sourceId: jobId,
          idempotencyKey: `${jobId}:spend`,
        },
        {
          id: refundId,
          userId,
          delta: 100,
          balanceAfter: 1_000,
          reason: "refund",
          sourceId: jobId,
          idempotencyKey: `${jobId}:refund`,
        },
      ],
    });
    await prisma.generationSettlementLink.createMany({
      data: [
        { id: `${spendId}-link`, requestId: jobId, ledgerEntryId: spendId, kind: "generation_spend" },
        { id: `${refundId}-link`, requestId: jobId, ledgerEntryId: refundId, kind: "refund" },
      ],
    });
    await prisma.generationArtifact.create({
      data: {
        id: artifactId,
        attemptId,
        ordinal: 0,
        providerRef: `${jobId}.mp4`,
        terminalRecordChecksum: "a".repeat(64),
        validationState: "late_after_failed",
        archiveState: "archived",
      },
    });
    await prisma.generationDelivery.create({
      data: {
        id: deliveryId,
        requestId: jobId,
        artifactId,
        targetType: "user_library",
        targetId: userId,
        status: "suppressed",
      },
    });
    await prisma.generationJobEvent.create({
      data: {
        id: `${jobId}-late-artifact`,
        jobId,
        type: "late_artifact_archived",
        metadata: {
          attemptId,
          assetCount: 1,
          manifestRef: terminalRecordRef,
          terminalStatus: "failed",
        },
      },
    });
    if (options.terminal !== false) {
      await prisma.$transaction(async (tx) => {
        await recordGenerationAttemptEvent(tx, {
          eventId: `${attemptId}:terminal`,
          attemptId,
          eventType: "generation.attempt.failed.v1",
          outcome: "failed",
          occurredAt: new Date("2026-07-25T13:47:54.927Z"),
          payload: {
            requestId: jobId,
            requestOutcome: "failed",
            errorCode: "stale_timeout",
            refundAmount: 100,
          },
          errorCode: "stale_timeout",
          retryability: "retryable",
        });
        await tx.generationJob.update({
          where: { id: jobId },
          data: {
            status: "failed",
            errorCode: "stale_timeout",
            finishedAt: new Date("2026-07-25T13:47:54.904Z"),
            version: 2,
          },
        });
      });
    }

    const dedupeKey = `generation:${jobId}`;
    const row: QueueJobSnapshot = {
      id: bullMqJobIdForDedupeKey(dedupeKey),
      queue: GEN_QUEUES.videoGenerate,
      payload: {
        version: 1,
        requestId: `admin_requeue_${randomUUID()}`,
        generationJobId: jobId,
        attemptId,
        attemptNo: 1,
        userId,
        kind: "video",
        model: "ltx23-gtanimation-i2v",
        outputPrefix: `gen/${jobId}/`,
      },
      attemptsMade: 3,
      maxAttempts: 3,
      dedupeKey,
      state: "failed",
      failedReason: "main generation ingest returned 503",
      timestamp: 1_784_986_633_757,
      processedOn: 1_784_986_982_636,
      finishedOn: 1_784_987_313_550,
    };
    return { jobId, attemptId, artifactId, row };
  }

  function fakeQueue(row: QueueJobSnapshot) {
    let current = row;
    return {
      inspectFailed: async () => [current],
      current: () => current,
      replace: (next: QueueJobSnapshot) => {
        current = next;
      },
    };
  }

  function cutoverQueue(queue: ReturnType<typeof fakeQueue>) {
    return {
      inspectInFlight: async () => [],
      getByDedupeKey: async () => queue.current(),
      inspectFailed: async () => [queue.current()],
      inspectPaused: async () =>
        GENERATION_CUTOVER_QUEUES.map((name) => ({ queue: name, paused: true })),
    };
  }

  async function acknowledgeFixture(label: string) {
    const target = await fixture(label);
    const queue = fakeQueue(target.row);
    const preview = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: target.row.id },
      { queue, terminalRecordProbe: async () => false },
    );
    const result = await acknowledgeLegacyFailedGenerationSourceResidue(
      prisma,
      {
        actorId,
        reason: "Acknowledge one fully reconciled legacy source transport residue",
        requestId: `${target.jobId}:repair`,
        idempotencyKey: `${target.jobId}:repair`,
        expectation: preview.expectation!,
        confirmation: preview.confirmation!,
      },
      { queue, terminalRecordProbe: async () => false },
    );
    return { target, queue, preview, result };
  }

  it("defaults to a read-only plan and exposes an exact typed confirmation", async () => {
    const target = await fixture("dry-run");
    const queue = fakeQueue(target.row);

    const report = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: target.row.id },
      { queue, terminalRecordProbe: async () => false },
    );

    expect(report).toMatchObject({
      eligible: true,
      blockers: [],
      expectation: {
        queue: GEN_QUEUES.videoGenerate,
        bullJobId: target.row.id,
        payloadHash: failedSourceRowPayloadHash(target.row),
        rowIdentityHash: failedSourceRowIdentityHash(target.row),
        attemptsMade: 3,
        maxAttempts: 3,
        finishedOn: target.row.finishedOn,
        generationJobId: target.jobId,
        attemptId: target.attemptId,
        attemptNo: 1,
        jobVersion: 2,
      },
      evidence: {
        transportAttemptNo: 3,
        artifactId: target.artifactId,
        deliveryStatus: "suppressed",
        settlement: { captured: 100, refunded: 100 },
      },
    });
    expect(report.confirmation).toContain(target.row.id);
    expect(queue.current()).not.toBeNull();
    await expect(prisma.controlPlaneCommand.count({ where: { actorId } })).resolves.toBe(0);
    await expect(prisma.adminAuditLog.count({ where: { actorId } })).resolves.toBe(0);
  });

  it("persists an exact acknowledgement while retaining the Bull evidence", async () => {
    const target = await fixture("acknowledge");
    const queue = fakeQueue(target.row);
    const preview = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: target.row.id },
      { queue, terminalRecordProbe: async () => false },
    );

    const result = await acknowledgeLegacyFailedGenerationSourceResidue(
      prisma,
      {
        actorId,
        reason: "Acknowledge one fully reconciled legacy source transport residue",
        requestId: `${target.jobId}:repair`,
        idempotencyKey: `${target.jobId}:repair`,
        expectation: preview.expectation!,
        confirmation: preview.confirmation!,
      },
      { queue, terminalRecordProbe: async () => false },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      acknowledged: true,
      retainedBullEvidence: true,
      replayed: false,
    });
    expect(queue.current()).toEqual(target.row);
    await expect(prisma.controlPlaneCommand.findUniqueOrThrow({
      where: { id: result.commandId },
    })).resolves.toMatchObject({ status: "succeeded", needsReconciliation: false });
    await expect(prisma.adminAuditLog.count({
      where: {
        actorId,
        targetId: target.row.id,
        action: FAILED_SOURCE_RESIDUE_AUDIT_ACTION,
      },
    })).resolves.toBe(1);
    await expect(isAcknowledgedLegacyFailedGenerationSourceResidue(
      prisma,
      target.row,
      { terminalRecordProbe: async () => false },
    )).resolves.toMatchObject({ acknowledged: true, commandId: result.commandId });
    await expect(assessGenerationDispatchCutoverReadiness(prisma, {
      generationJobIds: [target.jobId],
      queueInspector: cutoverQueue(queue),
      terminalRecordProbe: async () => false,
    })).resolves.toMatchObject({
      ok: true,
      ignoredHistory: [{ queue: GEN_QUEUES.videoGenerate, bullJobId: target.row.id }],
      issues: [],
    });
    await expect(assessGenerationQueueDrainReadiness(prisma, {
      queueInspector: cutoverQueue(queue),
      dispatchPendingTerminalRecords: async () => 0,
      terminalRecordProbe: async () => false,
    })).resolves.toMatchObject({
      ok: true,
      ignoredHistory: [{
        queue: GEN_QUEUES.videoGenerate,
        bullJobId: target.row.id,
        generationJobId: target.jobId,
        attemptId: target.attemptId,
      }],
    });

    await expect(acknowledgeLegacyFailedGenerationSourceResidue(
      prisma,
      {
        actorId,
        reason: "Acknowledge one fully reconciled legacy source transport residue",
        requestId: `${target.jobId}:repair-replay`,
        idempotencyKey: `${target.jobId}:repair`,
        expectation: preview.expectation!,
        confirmation: preview.confirmation!,
      },
      { queue, terminalRecordProbe: async () => false },
    )).resolves.toMatchObject({
      commandId: result.commandId,
      status: "succeeded",
      acknowledged: true,
      retainedBullEvidence: true,
      replayed: true,
    });
    await expect(prisma.adminAuditLog.count({
      where: {
        actorId,
        targetId: target.row.id,
        action: FAILED_SOURCE_RESIDUE_AUDIT_ACTION,
      },
    })).resolves.toBe(1);
    await expect(acknowledgeLegacyFailedGenerationSourceResidue(
      prisma,
      {
        actorId,
        reason: "Acknowledge one fully reconciled legacy source transport residue",
        requestId: `${target.jobId}:different-key`,
        idempotencyKey: `${target.jobId}:different-key`,
        expectation: preview.expectation!,
        confirmation: preview.confirmation!,
      },
      { queue, terminalRecordProbe: async () => false },
    )).rejects.toThrow(
      "This exact residue already has an authoritative acknowledgement",
    );
    await expect(prisma.controlPlaneCommand.count({
      where: { targetId: target.row.id },
    })).resolves.toBe(1);
  });

  it("serializes distinct idempotency keys to one authoritative receipt", async () => {
    const target = await fixture("concurrent-keys");
    const queue = fakeQueue(target.row);
    const preview = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: target.row.id },
      { queue, terminalRecordProbe: async () => false },
    );
    const submit = (suffix: string) =>
      acknowledgeLegacyFailedGenerationSourceResidue(
        prisma,
        {
          actorId,
          reason: "Acknowledge one fully reconciled legacy source transport residue",
          requestId: `${target.jobId}:${suffix}`,
          idempotencyKey: `${target.jobId}:${suffix}`,
          expectation: preview.expectation!,
          confirmation: preview.confirmation!,
        },
        { queue, terminalRecordProbe: async () => false },
      );

    const outcomes = await Promise.allSettled([submit("a"), submit("b")]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      outcomes.find((outcome) => outcome.status === "rejected")?.reason,
    ).toMatchObject({ message: expect.stringContaining("already has") });
    await expect(prisma.controlPlaneCommand.count({
      where: { targetId: target.row.id },
    })).resolves.toBe(1);
    await expect(prisma.adminAuditLog.count({
      where: {
        targetId: target.row.id,
        action: FAILED_SOURCE_RESIDUE_AUDIT_ACTION,
      },
    })).resolves.toBe(1);
  });

  it("fails the acknowledgement closed when the retained row identity drifts", async () => {
    const target = await fixture("row-drift");
    const queue = fakeQueue(target.row);
    const preview = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: target.row.id },
      { queue, terminalRecordProbe: async () => false },
    );
    await acknowledgeLegacyFailedGenerationSourceResidue(
      prisma,
      {
        actorId,
        reason: "Acknowledge one fully reconciled legacy source transport residue",
        requestId: `${target.jobId}:repair`,
        idempotencyKey: `${target.jobId}:repair`,
        expectation: preview.expectation!,
        confirmation: preview.confirmation!,
      },
      { queue, terminalRecordProbe: async () => false },
    );

    const changed = {
      ...target.row,
      attemptsMade: target.row.attemptsMade + 1,
    };
    queue.replace(changed);
    await expect(isAcknowledgedLegacyFailedGenerationSourceResidue(
      prisma,
      changed,
      { terminalRecordProbe: async () => false },
    )).resolves.toMatchObject({ acknowledged: false });
    await expect(assessGenerationDispatchCutoverReadiness(prisma, {
      generationJobIds: [target.jobId],
      queueInspector: cutoverQueue(queue),
      terminalRecordProbe: async () => false,
    })).resolves.toMatchObject({
      ok: false,
      issues: [{
        generationJobId: target.jobId,
        attemptId: target.attemptId,
        queue: GEN_QUEUES.videoGenerate,
        bullJobId: target.row.id,
        code: "legacy_or_invalid_bull_job",
      }],
    });
    await expect(assessGenerationQueueDrainReadiness(prisma, {
      queueInspector: cutoverQueue(queue),
      dispatchPendingTerminalRecords: async () => 0,
      terminalRecordProbe: async () => false,
    })).resolves.toMatchObject({
      ok: false,
      failedRecoveryRows: [{
        queue: GEN_QUEUES.videoGenerate,
        bullJobId: target.row.id,
        generationJobId: target.jobId,
        attemptId: target.attemptId,
      }],
    });
  });

  it("blocks active, non-latest, and terminal-event-incomplete DB histories", async () => {
    const active = await fixture("active-db", { terminal: false });
    const activeReport = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: active.row.id },
      { queue: fakeQueue(active.row), terminalRecordProbe: async () => false },
    );
    expect(activeReport.blockers).toEqual(expect.arrayContaining([
      { code: "job_not_failed_terminal" },
      { code: "attempt_not_failed_terminal" },
      { code: "attempt_missing_finished_at" },
      { code: "terminal_event_missing" },
    ]));

    const newer = await fixture("newer-attempt");
    await prisma.generationAttempt.create({
      data: {
        id: `${newer.jobId}-attempt-2`,
        requestId: newer.jobId,
        attemptNo: 2,
        status: "queued",
      },
    });
    const newerReport = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: newer.row.id },
      { queue: fakeQueue(newer.row), terminalRecordProbe: async () => false },
    );
    expect(newerReport.blockers).toEqual(expect.arrayContaining([
      { code: "attempt_history_not_singleton" },
      { code: "attempt_not_latest" },
    ]));

    const missingEvent = await fixture("missing-terminal-event");
    await prisma.generationAttemptEvent.delete({
      where: { id: `${missingEvent.attemptId}:terminal` },
    });
    const missingEventReport = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: missingEvent.row.id },
      { queue: fakeQueue(missingEvent.row), terminalRecordProbe: async () => false },
    );
    expect(missingEventReport.blockers).toContainEqual({
      code: "terminal_event_missing",
    });
  });

  it("blocks transport, delivery, and settlement ambiguity", async () => {
    const transport = await fixture("extra-transport");
    await prisma.generationTransportExecution.create({
      data: {
        id: `${transport.jobId}-transport-4`,
        attemptId: transport.attemptId,
        transportAttemptNo: 4,
        idempotencyKey: `generation:${transport.attemptId}:provider`,
        status: "succeeded",
        terminalRecordRef: `gen/completion-manifests/${transport.attemptId}/other.json`,
        startedAt: new Date("2026-07-25T13:49:00.000Z"),
        finishedAt: new Date("2026-07-25T13:50:00.000Z"),
      },
    });
    const transportReport = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: transport.row.id },
      { queue: fakeQueue(transport.row), terminalRecordProbe: async () => false },
    );
    expect(transportReport.blockers).toContainEqual({
      code: "transport_history_mismatch",
    });

    const artifact = await fixture("artifact-not-archived");
    await prisma.generationArtifact.update({
      where: { id: artifact.artifactId },
      data: { archiveState: "active" },
    });
    const artifactReport = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: artifact.row.id },
      { queue: fakeQueue(artifact.row), terminalRecordProbe: async () => false },
    );
    expect(artifactReport.blockers).toContainEqual({
      code: "artifact_not_archived",
    });

    const delivery = await fixture("missing-delivery");
    await prisma.generationDelivery.deleteMany({
      where: { requestId: delivery.jobId },
    });
    const deliveryReport = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: delivery.row.id },
      { queue: fakeQueue(delivery.row), terminalRecordProbe: async () => false },
    );
    expect(deliveryReport.blockers).toContainEqual({
      code: "delivery_count_mismatch",
    });

    const settlement = await fixture("missing-settlement-link");
    await prisma.generationSettlementLink.deleteMany({
      where: { requestId: settlement.jobId, kind: "refund" },
    });
    const settlementReport = await inspectLegacyFailedGenerationSourceRepair(
      prisma,
      { actorId, queue: GEN_QUEUES.videoGenerate, bullJobId: settlement.row.id },
      { queue: fakeQueue(settlement.row), terminalRecordProbe: async () => false },
    );
    expect(settlementReport.blockers).toEqual(expect.arrayContaining([
      { code: "settlement_link_count_mismatch" },
      { code: "refund_link_mismatch" },
    ]));
  });

  it("re-blocks an acknowledged residue when Blob or command authority changes", async () => {
    const blob = await acknowledgeFixture("blob-appeared");
    await expect(isAcknowledgedLegacyFailedGenerationSourceResidue(
      prisma,
      blob.target.row,
      { terminalRecordProbe: async () => true },
    )).resolves.toMatchObject({
      acknowledged: false,
      blockers: expect.arrayContaining([{ code: "exact_terminal_record_exists" }]),
    });

    const command = await acknowledgeFixture("command-reconciliation");
    await prisma.controlPlaneCommand.update({
      where: { id: command.result.commandId },
      data: { needsReconciliation: true },
    });
    await expect(isAcknowledgedLegacyFailedGenerationSourceResidue(
      prisma,
      command.target.row,
      { terminalRecordProbe: async () => false },
    )).resolves.toMatchObject({
      acknowledged: false,
      blockers: [{ code: "exact_acknowledgement_missing" }],
    });
  });
});
