import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { renderPrometheusMetrics, resetMetricsForTests } from "@idream/shared";
import {
  generationTerminalRecordChecksum,
  generationTerminalRecordSchema,
  idempotencyKeys,
  MAIN_QUEUES,
} from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { drainLocalAiPipeline, reconcileStaleGenerationJobs } from "./local-pipeline";
import {
  dispatchPendingGenerationTerminalRecords,
  ingestGenerationTerminalRecord,
} from "./generation-terminal-record-ingest";
import { jobQueue } from "@/server/jobs/queue";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import { recordGenerationTransportExecution } from "./generation-transport-execution";
import { reserveInitialGenerationAttempt } from "@/server/modules/generation/generation-attempt-authority";
import { redriveFailedGenerationTerminalRelays } from "./generation-terminal-relay";

const attemptId = "durable_terminal_record_attempt_1";
const outboxId = `generation_terminal_record_${attemptId}`;
const authorityUserId = "durable_terminal_record_authority_user_1";
const dispatchOutboxId = `generation_initial_${terminalRecordJobId()}`;

function terminalRecordJobId() {
  return "durable_terminal_record_job_1";
}

const terminalRecordBase = {
  version: 1 as const,
  attemptId,
  attemptNo: 1,
  transportAttemptNo: 2,
  providerIdempotencyKey: `generation:${attemptId}:provider`,
  requestId: `generation_dispatch_${attemptId}`,
  generationJobId: terminalRecordJobId(),
  mode: "image" as const,
  provider: "mock-image",
  providerInvoked: true,
  model: "mock-image-v2",
  providerRequestId: "provider-1",
  completedAt: "2026-07-11T12:00:00.000Z",
  usage: { gpuSeconds: 1.2, model: "mock-image" },
  accounting: {
    usage: { images: 1, gpuSeconds: 1.2 },
    latencyMs: 640,
    costMicros: 125_000,
    pricingVersion: "mock-image-pricing-v2",
  },
};

const terminalRecord = {
  ...terminalRecordBase,
  outcome: "succeeded" as const,
  assets: [{
    ordinal: 0,
    key: `gen/${terminalRecordJobId()}/attempts/${attemptId}/image-1.webp`,
    contentType: "image/webp",
    width: 1024,
    height: 1024,
    providerKey: "provider-asset-1",
  }],
};

beforeEach(async () => {
  await prisma.mainOutboxEvent.deleteMany({
    where: {
      OR: [
        { id: { in: [outboxId, dispatchOutboxId] } },
        { aggregateId: { in: [attemptId, terminalRecordJobId()] } },
      ],
    },
  });
  await prisma.inboundEventReceipt.deleteMany({
    where: {
      sourceService: {
        in: [
          "gen",
          "gen_quarantine",
          "gen_resolution",
          "gen_resolution_quarantine",
        ],
      },
      sourceEventId: { startsWith: attemptId },
    },
  });
  await prisma.generationArtifact.deleteMany({ where: { attemptId } });
  await prisma.generationTransportExecution.deleteMany({ where: { attemptId } });
  await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
  await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
  await prisma.aiUsageFact.deleteMany({ where: { attemptId } });
  await prisma.generationJobEvent.deleteMany({ where: { jobId: terminalRecordJobId() } });
  await prisma.generationDelivery.deleteMany({ where: { requestId: terminalRecordJobId() } });
  await prisma.generationJob.deleteMany({ where: { id: terminalRecordJobId() } });
  await prisma.user.deleteMany({ where: { id: authorityUserId } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("generation terminal record durable ingest", () => {
  it("atomically records receipt, transport, artifact and finalize outbox for a reserved Attempt", async () => {
    resetMetricsForTests();
    await reserveAttempt();
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };
    expect(await ingestGenerationTerminalRecord(input)).toMatchObject({ acknowledged: true, status: "persisted" });
    expect(await ingestGenerationTerminalRecord(input)).toMatchObject({ acknowledged: true, status: "duplicate" });
    expect(renderPrometheusMetrics()).toContain(
      "generation_terminal_record_replay_total{outcome=\"durable_duplicate\"} 1",
    );

    expect(await prisma.inboundEventReceipt.count({ where: { sourceService: "gen", sourceEventId: attemptId } })).toBe(1);
    expect(await prisma.generationAttempt.findUnique({ where: { id: attemptId } })).toMatchObject({
      requestId: terminalRecord.generationJobId,
      status: "running",
      terminalRecordRef: input.terminalRecordRef,
    });
    expect(await prisma.generationAttemptEvent.findMany({ where: { attemptId } })).toEqual([
      expect.objectContaining({
        sequence: 1,
        eventType: "generation.attempt.terminal_record_ingested.v1",
        outcome: null,
      }),
    ]);
    expect(await prisma.generationTransportExecution.findUnique({ where: { attemptId_transportAttemptNo: { attemptId, transportAttemptNo: 2 } } })).toMatchObject({
      status: "succeeded",
      idempotencyKey: terminalRecord.providerIdempotencyKey,
      latencyMs: terminalRecord.accounting.latencyMs,
      costMicros: BigInt(terminalRecord.accounting.costMicros),
      pricingVersion: terminalRecord.accounting.pricingVersion,
      terminalRecordRef: input.terminalRecordRef,
    });
    expect(await prisma.aiUsageFact.findMany({ where: { attemptId } })).toEqual([
      expect.objectContaining({
        requestId: terminalRecord.generationJobId,
        provider: terminalRecord.provider,
        model: terminalRecord.model,
        latencyMs: terminalRecord.accounting.latencyMs,
        costMicros: BigInt(terminalRecord.accounting.costMicros),
        pricingVersion: terminalRecord.accounting.pricingVersion,
      }),
    ]);
    expect(await prisma.generationArtifact.count({ where: { attemptId } })).toBe(1);
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: outboxId } })).toMatchObject({
      eventType: "generation.terminal_record.accepted.v1",
      payload: expect.objectContaining({
        provider: terminalRecord.provider,
        model: terminalRecord.model,
        terminalRecordRef: input.terminalRecordRef,
      }),
    });
  });

  it("redrives an exhausted exact finalize row after worker restart", async () => {
    await reserveAttempt();
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };
    await ingestGenerationTerminalRecord(input);
    const dedupeKey = `generation-terminal-record-finalize:${attemptId}`;
    try {
      await dispatchPendingGenerationTerminalRecords({
        outboxIds: [outboxId],
        queue: {
          enqueue: (queued) => jobQueue.enqueue({ ...queued, maxAttempts: 1 }),
        },
      });
      await expect(jobQueue.processNext({
        queue: MAIN_QUEUES.aiFinalize,
        workerId: "finalizer-exhaust-before-restart",
        processor: async () => { throw new Error("finalizer process crashed"); },
      })).resolves.toMatchObject({ status: "failed" });
      await expect(jobQueue.getByDedupeKey(
        MAIN_QUEUES.aiFinalize,
        dedupeKey,
      )).resolves.toMatchObject({ state: "failed", attemptsMade: 1 });

      await expect(redriveFailedGenerationTerminalRelays({
        cursor: { offset: 0 },
      })).resolves.toMatchObject({ redriven: 1, invalid: [] });
      await expect(drainLocalAiPipeline({
        queues: [MAIN_QUEUES.aiFinalize],
        limit: 1,
        workerId: "finalizer-after-restart",
      })).resolves.toMatchObject({ processed: 1 });
      await expect(prisma.generationJob.findUniqueOrThrow({
        where: { id: terminalRecord.generationJobId },
      })).resolves.toMatchObject({ status: "completed" });
    } finally {
      await jobQueue.removeByDedupeKey(MAIN_QUEUES.aiFinalize, dedupeKey);
    }
  });

  it("accepts terminal evidence against a production-reserved immutable dispatch envelope", async () => {
    const suffix = crypto.randomUUID();
    const userId = `terminal-production-user-${suffix}`;
    const jobId = `terminal-production-job-${suffix}`;
    let productionAttemptId: string | null = null;
    try {
      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@idream.internal`,
          status: "active",
        },
      });
      const job = await prisma.generationJob.create({
        data: {
          id: jobId,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          outputCount: 1,
          status: "queued",
          provider: "mock",
        },
      });
      const reserved = await prisma.$transaction((tx) =>
        reserveInitialGenerationAttempt(tx, {
          requestId: job.id,
          dispatch: {
            outboxId: `generation_initial_${job.id}`,
            eventType: "generation.retry.dispatch.v2",
            payload: { source: "terminal_ingest_production_test" },
          },
        })
      );
      productionAttemptId = reserved.attempt.id;
      const outboxPayload = reserved.outbox.payload as Record<string, unknown>;
      const queueInput = outboxPayload.queueInput as Record<string, unknown>;
      const queuePayload = queueInput.payload as Record<string, unknown>;
      const record = generationTerminalRecordSchema.parse({
        version: 1,
        attemptId: reserved.attempt.id,
        attemptNo: reserved.attempt.attemptNo,
        transportAttemptNo: 1,
        providerIdempotencyKey: `generation:${reserved.attempt.id}:provider`,
        requestId: queuePayload.requestId,
        generationJobId: job.id,
        mode: "image",
        provider: queuePayload.provider,
        providerInvoked: true,
        model: queuePayload.model,
        providerRequestId: `provider-${suffix}`,
        completedAt: "2026-07-11T12:00:00.000Z",
        usage: { images: 1 },
        outcome: "succeeded",
        assets: [{
          ordinal: 0,
          key: `${queuePayload.outputPrefix as string}image-1.webp`,
          contentType: "image/webp",
          width: 1024,
          height: 1024,
          providerKey: `provider-asset-${suffix}`,
        }],
      });
      const input = {
        terminalRecordRef: `gen/terminal-records/${reserved.attempt.id}/terminal.json`,
        terminalRecordChecksum: generationTerminalRecordChecksum(record),
        terminalRecord: record,
      };

      await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
        acknowledged: true,
        status: "persisted",
      });
    } finally {
      if (productionAttemptId) {
        await prisma.inboundEventReceipt.deleteMany({
          where: { sourceService: "gen", sourceEventId: productionAttemptId },
        });
        await prisma.generationArtifact.deleteMany({ where: { attemptId: productionAttemptId } });
        await prisma.generationTransportExecution.deleteMany({ where: { attemptId: productionAttemptId } });
        await prisma.aiUsageFact.deleteMany({ where: { attemptId: productionAttemptId } });
        await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: productionAttemptId } });
        await prisma.generationAttempt.deleteMany({ where: { id: productionAttemptId } });
      }
      await prisma.mainOutboxEvent.deleteMany({
        where: { OR: [{ aggregateId: jobId }, { aggregateId: productionAttemptId ?? "" }] },
      });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("ACKs concurrent identical terminal delivery as one persist and one duplicate", async () => {
    await reserveAttempt();
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };

    const results = await Promise.all([
      ingestGenerationTerminalRecord(input),
      ingestGenerationTerminalRecord(input),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "duplicate",
      "persisted",
    ]);
    await expect(prisma.inboundEventReceipt.count({
      where: { sourceService: "gen", sourceEventId: attemptId },
    })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({ where: { id: outboxId } })).resolves.toBe(1);
    await expect(prisma.aiUsageFact.count({ where: { attemptId } })).resolves.toBe(1);
  });

  it("does not let stale reconciliation overwrite terminal evidence committed while the Job lock waits", async () => {
    await reserveAttempt();
    const staleAt = new Date("2026-01-01T00:00:00.000Z");
    await prisma.generationJob.update({
      where: { id: terminalRecord.generationJobId },
      data: { status: "running", updatedAt: staleAt },
    });
    await prisma.generationAttempt.update({
      where: { id: attemptId },
      data: { status: "running", startedAt: staleAt, createdAt: staleAt },
    });
    await prisma.generationTransportExecution.create({
      data: {
        attemptId,
        transportAttemptNo: terminalRecord.transportAttemptNo,
        providerRequestId: terminalRecord.providerRequestId,
        idempotencyKey: terminalRecord.providerIdempotencyKey,
        status: "running",
        startedAt: staleAt,
      },
    });
    await prisma.mainOutboxEvent.updateMany({
      where: { aggregateId: terminalRecord.generationJobId },
      data: { createdAt: staleAt, updatedAt: staleAt, nextRunAt: staleAt },
    });
    let releaseJobLock = () => {};
    let reportJobLocked = () => {};
    const jobLocked = new Promise<void>((resolve) => {
      reportJobLocked = resolve;
    });
    const holdJobLock = new Promise<void>((resolve) => {
      releaseJobLock = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM generation_jobs
        WHERE id = ${terminalRecord.generationJobId}
        FOR UPDATE
      `;
      reportJobLocked();
      await holdJobLock;
    });
    await jobLocked;
    const reconciliation = reconcileStaleGenerationJobs({
      now: new Date("2030-01-01T00:00:00.000Z"),
      timeoutMs: 60_000,
    });
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };
    try {
      await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
        acknowledged: true,
        status: "persisted",
      });
    } finally {
      releaseJobLock();
      await blocker;
    }

    await expect(reconciliation).resolves.toMatchObject({ quarantined: 0 });
    await expect(prisma.generationAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    })).resolves.toMatchObject({
      status: "running",
      terminalRecordRef: input.terminalRecordRef,
    });
    await expect(prisma.generationTransportExecution.findFirstOrThrow({
      where: { attemptId },
    })).resolves.toMatchObject({ status: "succeeded" });
  });

  it("does not quarantine stale work while an exact terminal relay is recoverable", async () => {
    await reserveAttempt();
    const staleAt = new Date("2026-01-01T00:00:00.000Z");
    await prisma.generationJob.update({
      where: { id: terminalRecord.generationJobId },
      data: { status: "running", updatedAt: staleAt },
    });
    await prisma.generationAttempt.update({
      where: { id: attemptId },
      data: { status: "running", startedAt: staleAt, createdAt: staleAt },
    });
    await prisma.generationTransportExecution.create({
      data: {
        attemptId,
        transportAttemptNo: terminalRecord.transportAttemptNo,
        providerRequestId: terminalRecord.providerRequestId,
        idempotencyKey: terminalRecord.providerIdempotencyKey,
        status: "running",
        startedAt: staleAt,
      },
    });
    await prisma.mainOutboxEvent.updateMany({
      where: { aggregateId: terminalRecord.generationJobId },
      data: { createdAt: staleAt, updatedAt: staleAt, nextRunAt: staleAt },
    });
    const relayKey = idempotencyKeys.generationTerminalRelay(attemptId);
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };
    await jobQueue.enqueue({
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload: input,
      dedupeKey: relayKey,
      maxAttempts: 1,
    });
    try {
      await expect(reconcileStaleGenerationJobs({
        now: new Date("2030-01-01T00:00:00.000Z"),
        timeoutMs: 60_000,
        generationJobIds: [terminalRecord.generationJobId],
      })).resolves.toMatchObject({ quarantined: 0 });
      await expect(prisma.generationAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      })).resolves.toMatchObject({ status: "running", terminalRecordRef: null });

      await expect(drainLocalAiPipeline({
        queues: [MAIN_QUEUES.generationTerminalIngest],
        limit: 1,
        workerId: "stale-terminal-relay-proof",
      })).resolves.toMatchObject({ processed: 1 });
      await expect(prisma.generationAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      })).resolves.toMatchObject({
        status: "running",
        terminalRecordRef: input.terminalRecordRef,
      });
    } finally {
      await jobQueue.removeByDedupeKey(
        MAIN_QUEUES.generationTerminalIngest,
        relayKey,
      );
    }
  });

  it("links late terminal evidence after stale quarantine without rewriting the unknown Attempt", async () => {
    await reserveAttempt();
    const staleAt = new Date("2026-01-01T00:00:00.000Z");
    await prisma.generationJob.update({
      where: { id: terminalRecord.generationJobId },
      data: { status: "running", updatedAt: staleAt },
    });
    await prisma.generationAttempt.update({
      where: { id: attemptId },
      data: { status: "running", startedAt: staleAt, createdAt: staleAt },
    });
    await prisma.generationTransportExecution.create({
      data: {
        attemptId,
        transportAttemptNo: terminalRecord.transportAttemptNo,
        providerRequestId: terminalRecord.providerRequestId,
        idempotencyKey: terminalRecord.providerIdempotencyKey,
        status: "running",
        startedAt: staleAt,
      },
    });
    await prisma.mainOutboxEvent.updateMany({
      where: { aggregateId: terminalRecord.generationJobId },
      data: { createdAt: staleAt, updatedAt: staleAt, nextRunAt: staleAt },
    });

    await expect(reconcileStaleGenerationJobs({
      now: new Date("2030-01-01T00:00:00.000Z"),
      timeoutMs: 60_000,
    })).resolves.toMatchObject({ quarantined: 1 });
    await expect(prisma.generationTransportExecution.findFirstOrThrow({
      where: { attemptId },
    })).resolves.toMatchObject({ status: "unknown", terminalRecordRef: null });

    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };
    await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
      acknowledged: true,
      status: "persisted",
    });
    await expect(prisma.generationAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    })).resolves.toMatchObject({ status: "unknown", terminalRecordRef: null });
    await expect(prisma.generationTransportExecution.findFirstOrThrow({
      where: { attemptId },
    })).resolves.toMatchObject({
      status: "unknown",
      terminalRecordRef: null,
    });
    await expect(prisma.generationArtifact.findFirstOrThrow({
      where: { attemptId },
    })).resolves.toMatchObject({
      validationState: "late_after_unknown",
      archiveState: "archived",
    });
  });

  it("does not let more than one page of unknown Attempts starve a newer stale provider lease", async () => {
    const suffix = crypto.randomUUID();
    const userId = `stale-page-user-${suffix}`;
    const unknownJobIds = Array.from(
      { length: 26 },
      (_, index) => `stale-page-unknown-job-${index}-${suffix}`,
    );
    const unknownAttemptIds = unknownJobIds.map(
      (_, index) => `stale-page-unknown-attempt-${index}-${suffix}`,
    );
    const targetJobId = `stale-page-target-job-${suffix}`;
    const targetAttemptId = `stale-page-target-attempt-${suffix}`;
    const targetOutboxId = `stale-page-target-outbox-${suffix}`;
    const staleAt = new Date("2025-01-01T00:00:00.000Z");
    try {
      await prisma.user.create({
        data: { id: userId, email: `${userId}@idream.internal`, status: "active" },
      });
      await prisma.generationJob.createMany({
        data: [
          ...unknownJobIds.map((id) => ({
            id,
            userId,
            mode: "image",
            controls: {},
            presetIds: [],
            status: "running",
            updatedAt: staleAt,
          })),
          {
            id: targetJobId,
            userId,
            mode: "image",
            controls: {},
            presetIds: [],
            status: "running",
            updatedAt: staleAt,
          },
        ],
      });
      await prisma.generationAttempt.createMany({
        data: [
          ...unknownAttemptIds.map((id, index) => ({
            id,
            requestId: unknownJobIds[index]!,
            attemptNo: 1,
            status: "unknown",
            createdAt: staleAt,
            startedAt: staleAt,
            finishedAt: staleAt,
          })),
          {
            id: targetAttemptId,
            requestId: targetJobId,
            attemptNo: 1,
            provider: "mock-image",
            status: "running",
            createdAt: staleAt,
            startedAt: staleAt,
          },
        ],
      });
      await prisma.generationTransportExecution.create({
        data: {
          attemptId: targetAttemptId,
          transportAttemptNo: 1,
          idempotencyKey: `generation:${targetAttemptId}:provider`,
          status: "running",
          startedAt: staleAt,
        },
      });
      await prisma.mainOutboxEvent.create({
        data: {
          id: targetOutboxId,
          eventType: "generation.retry.dispatch.v2",
          aggregateType: "generation_request",
          aggregateId: targetJobId,
          payload: {
            attemptId: targetAttemptId,
            queueInput: {
              queue: "ai.image.generate",
              dedupeKey: `generation:${targetJobId}:attempt:1`,
            },
          },
          createdAt: staleAt,
          updatedAt: staleAt,
          nextRunAt: staleAt,
        },
      });

      await expect(reconcileStaleGenerationJobs({
        now: new Date("2030-01-01T00:00:00.000Z"),
        timeoutMs: 60_000,
        limit: 25,
        generationJobIds: [...unknownJobIds, targetJobId],
      })).resolves.toMatchObject({ scanned: 1, quarantined: 1 });
      await expect(prisma.generationAttempt.findUniqueOrThrow({
        where: { id: targetAttemptId },
      })).resolves.toMatchObject({ status: "unknown" });
    } finally {
      await prisma.mainOutboxEvent.deleteMany({ where: { id: targetOutboxId } });
      await prisma.generationTransportExecution.deleteMany({
        where: { attemptId: targetAttemptId },
      });
      await prisma.generationAttemptEvent.deleteMany({
        where: { attemptId: { in: [...unknownAttemptIds, targetAttemptId] } },
      });
      await prisma.generationAttempt.deleteMany({
        where: { id: { in: [...unknownAttemptIds, targetAttemptId] } },
      });
      await prisma.generationJobEvent.deleteMany({
        where: { jobId: { in: [...unknownJobIds, targetJobId] } },
      });
      await prisma.generationJob.deleteMany({
        where: { id: { in: [...unknownJobIds, targetJobId] } },
      });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("quarantines an exact record replayed under a different terminal reference", async () => {
    await reserveAttempt();
    const checksum = generationTerminalRecordChecksum(terminalRecord);
    const originalRef = `gen/terminal-records/${attemptId}/terminal.json`;
    await ingestGenerationTerminalRecord({
      terminalRecordRef: originalRef,
      terminalRecordChecksum: checksum,
      terminalRecord,
    });

    await expect(ingestGenerationTerminalRecord({
      terminalRecordRef: `gen/terminal-records/${attemptId}/other.json`,
      terminalRecordChecksum: checksum,
      terminalRecord,
    })).resolves.toMatchObject({
      acknowledged: false,
      status: "quarantined",
    });
    await expect(prisma.generationAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    })).resolves.toMatchObject({ terminalRecordRef: originalRef });
    await expect(prisma.inboundEventReceipt.findUniqueOrThrow({
      where: {
        sourceService_sourceEventId: {
          sourceService: "gen",
          sourceEventId: attemptId,
        },
      },
    })).resolves.toMatchObject({
      processingState: "processed",
      error: null,
    });
    await expect(prisma.inboundEventReceipt.findFirstOrThrow({
      where: {
        sourceService: "gen_quarantine",
        sourceEventId: { startsWith: `${attemptId}:` },
      },
    })).resolves.toMatchObject({
      processingState: "quarantined",
      error: expect.objectContaining({ code: "terminal_record_envelope_conflict" }),
    });
    await expect(ingestGenerationTerminalRecord({
      terminalRecordRef: originalRef,
      terminalRecordChecksum: checksum,
      terminalRecord,
    })).resolves.toMatchObject({ acknowledged: true, status: "duplicate" });
  });

  it("claims a terminal Outbox with CAS so concurrent dispatch cannot regress delivered state", async () => {
    await reserveAttempt();
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };
    await ingestGenerationTerminalRecord(input);

    const enqueue = vi.fn(async () => undefined);
    const queue = { enqueue };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        dispatchPendingGenerationTerminalRecords({
          outboxIds: [outboxId],
          queue,
        })
      ),
    );
    try {
      expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: outboxId },
      })).resolves.toMatchObject({
        status: "delivered",
        attempts: 1,
        deliveredAt: expect.any(Date),
      });
    } finally {
      // The injected queue is side-effect free; keep this cleanup for a failed
      // assertion after a future test change switches back to BullMQ.
      await jobQueue.removeByDedupePrefix(
        `generation-terminal-record-finalize:${attemptId}`,
        ["app.ai.finalize"],
      );
    }
  });

  it("rejects a checksum mismatch before creating authority rows", async () => {
    const result = await ingestGenerationTerminalRecord({
      terminalRecordRef: "gen/bad.json",
      terminalRecordChecksum: "0".repeat(64),
      terminalRecord,
    });
    expect(result).toEqual({ acknowledged: false, status: "quarantined", receiptId: null });
    expect(await prisma.generationAttempt.findUnique({ where: { id: attemptId } })).toBeNull();
  });

  it.each([
    {
      label: "request id",
      code: "generation_dispatch_identity_mismatch",
      mutate: (record: typeof terminalRecord) => ({
        ...record,
        requestId: "generation_dispatch_tampered",
      }),
    },
    {
      label: "mode",
      code: "generation_terminal_mode_mismatch",
      mutate: (record: typeof terminalRecord) => ({
        ...record,
        mode: "video" as const,
        assets: record.assets.map((asset) => ({
          ...asset,
          contentType: "video/mp4",
        })),
      }),
    },
    {
      label: "model",
      code: "generation_dispatch_model_mismatch",
      mutate: (record: typeof terminalRecord) => ({
        ...record,
        model: "tampered-model",
      }),
    },
    {
      label: "asset ordinals",
      code: "generation_terminal_asset_ordinals_invalid",
      mutate: (record: typeof terminalRecord) => ({
        ...record,
        assets: record.assets.map((asset) => ({ ...asset, ordinal: 1 })),
      }),
    },
    {
      label: "provider invocation key",
      code: "generation_dispatch_provider_invocation_identity_mismatch",
      mutate: (record: typeof terminalRecord) => ({
        ...record,
        providerIdempotencyKey: "generation:tampered:provider",
      }),
    },
    {
      label: "transport attempt budget",
      code: "generation_dispatch_transport_identity_mismatch",
      mutate: (record: typeof terminalRecord) => ({
        ...record,
        transportAttemptNo: 4,
      }),
    },
    {
      label: "purchased output count",
      code: "generation_terminal_asset_count_mismatch",
      mutate: (record: typeof terminalRecord) => ({
        ...record,
        assets: [
          record.assets[0],
          {
            ...record.assets[0],
            ordinal: 1,
            key:
              `gen/${terminalRecordJobId()}/attempts/${attemptId}/image-2.webp`,
          },
        ],
      }),
    },
    {
      label: "asset storage prefix",
      code: "generation_terminal_asset_storage_authority_mismatch",
      mutate: (record: typeof terminalRecord) => ({
        ...record,
        assets: record.assets.map((asset) => ({
          ...asset,
          key: "gen/another-job/image-1.webp",
        })),
      }),
    },
    {
      label: "duplicate asset keys",
      code: "generation_terminal_asset_storage_authority_mismatch",
      mutate: (record: typeof terminalRecord) => ({
        ...record,
        assets: [
          record.assets[0],
          { ...record.assets[0], ordinal: 1 },
        ],
      }),
    },
  ])("quarantines terminal evidence whose $label differs from dispatch authority", async ({
    code,
    mutate,
  }) => {
    await reserveAttempt();
    const changed = generationTerminalRecordSchema.parse(mutate(terminalRecord));
    const result = await ingestGenerationTerminalRecord({
      terminalRecordRef: `gen/terminal-records/${attemptId}/tampered.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(changed),
      terminalRecord: changed,
    });

    expect(result).toMatchObject({ acknowledged: false, status: "quarantined" });
    expect(result.receiptId).not.toBeNull();
    await expect(prisma.inboundEventReceipt.findUniqueOrThrow({
      where: { id: result.receiptId! },
    })).resolves.toMatchObject({
      sourceService: "gen_quarantine",
      processingState: "quarantined",
      error: expect.objectContaining({ code }),
    });
    await expect(prisma.generationAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    })).resolves.toMatchObject({ status: "queued", terminalRecordRef: null });
  });

  it("quarantines an unreserved Attempt without ACK and recovers after reservation", async () => {
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };

    const first = await ingestGenerationTerminalRecord(input);
    expect(first).toMatchObject({
      acknowledged: false,
      status: "quarantined",
      receiptId: expect.any(String),
    });
    await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
      acknowledged: false,
      status: "quarantined",
    });
    await expect(prisma.generationAttempt.findUnique({ where: { id: attemptId } })).resolves.toBeNull();
    await expect(prisma.inboundEventReceipt.findUniqueOrThrow({
      where: { id: first.receiptId! },
    })).resolves.toMatchObject({
      sourceService: "gen_quarantine",
      processingState: "quarantined",
      error: expect.objectContaining({ code: "generation_attempt_not_reserved" }),
    });

    await reserveAttempt();
    await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
      acknowledged: true,
      status: "persisted",
    });
  });

  it("rejects a request-scoped output prefix even when the asset key matches it", async () => {
    await reserveAttempt();
    const dispatchId = `generation_dispatch_authority_${attemptId}`;
    const dispatch = await prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: dispatchId },
    });
    const payload = dispatch.payload as Record<string, unknown>;
    const queueInput = payload.queueInput as Record<string, unknown>;
    const queuePayload = queueInput.payload as Record<string, unknown>;
    await prisma.mainOutboxEvent.update({
      where: { id: dispatchId },
      data: {
        payload: {
          ...payload,
          queueInput: {
            ...queueInput,
            payload: {
              ...queuePayload,
              outputPrefix: `gen/${terminalRecordJobId()}/`,
            },
          },
        } as Prisma.InputJsonValue,
      },
    });
    const requestScopedRecord = generationTerminalRecordSchema.parse({
      ...terminalRecord,
      assets: terminalRecord.assets.map((asset) => ({
        ...asset,
        key: `gen/${terminalRecordJobId()}/image-1.webp`,
      })),
    });

    const result = await ingestGenerationTerminalRecord({
      terminalRecordRef: `gen/terminal-records/${attemptId}/request-prefix.json`,
      terminalRecordChecksum:
        generationTerminalRecordChecksum(requestScopedRecord),
      terminalRecord: requestScopedRecord,
    });

    expect(result).toMatchObject({ acknowledged: false, status: "quarantined" });
    await expect(prisma.inboundEventReceipt.findUniqueOrThrow({
      where: { id: result.receiptId! },
    })).resolves.toMatchObject({
      error: expect.objectContaining({
        code: "generation_terminal_asset_storage_authority_mismatch",
      }),
    });
  });

  it.each([
    {
      outcome: "failed",
      evidence: {
        error: {
          code: "provider_timeout",
          message: "Provider timed out after accepting the request",
          retryability: "retryable",
        },
      },
      transportStatus: "failed",
      finalizer: {
        kind: "generation.failed",
        error: expect.objectContaining({
          code: "provider_timeout",
          retryability: "retryable",
        }),
      },
    },
    {
      outcome: "unknown",
      evidence: {
        error: {
          code: "provider_outcome_unknown",
          message: "Provider accepted the request but its result is ambiguous",
          retryability: "operator_retry",
        },
      },
      transportStatus: "unknown",
      finalizer: {
        kind: "generation.unknown",
        error: expect.objectContaining({
          code: "provider_outcome_unknown",
          retryability: "operator_retry",
        }),
      },
    },
    {
      outcome: "blocked",
      evidence: {
        block: {
          policyCode: "provider_policy_blocked",
          message: "Provider rejected the request",
          layer: "provider",
        },
      },
      transportStatus: "succeeded",
      finalizer: {
        kind: "generation.blocked",
        policyCode: "provider_policy_blocked",
        layer: "provider",
      },
    },
  ] as const)("persists $outcome as terminal evidence without fabricating artifacts", async ({
    outcome,
    evidence,
    transportStatus,
    finalizer,
  }) => {
    await reserveAttempt();
    const record = generationTerminalRecordSchema.parse({
      ...terminalRecordBase,
      outcome,
      ...evidence,
    });
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(record),
      terminalRecord: record,
    };

    await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
      acknowledged: true,
      status: "persisted",
    });
    await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).resolves.toMatchObject({
      status: "running",
      terminalRecordRef: input.terminalRecordRef,
    });
    await expect(prisma.generationTransportExecution.findFirstOrThrow({ where: { attemptId } })).resolves.toMatchObject({
      status: transportStatus,
      terminalRecordRef: input.terminalRecordRef,
    });
    await expect(prisma.generationArtifact.count({ where: { attemptId } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).resolves.toMatchObject({
      eventType: "generation.terminal_record.accepted.v1",
      payload: expect.objectContaining({
        ...finalizer,
        terminalRecordRef: input.terminalRecordRef,
        terminalRecordChecksum: input.terminalRecordChecksum,
      }),
    });
  });

  it("does not fabricate TransportExecution or usage when provider was not invoked", async () => {
    await reserveAttempt();
    const record = generationTerminalRecordSchema.parse({
      ...terminalRecordBase,
      providerInvoked: false,
      providerRequestId: null,
      accounting: undefined,
      usage: {},
      outcome: "blocked",
      block: {
        policyCode: "input_blocked",
        message: "Input moderation blocked before provider invocation",
        layer: "input",
      },
    });
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(record),
      terminalRecord: record,
    };

    await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
      acknowledged: true,
      status: "persisted",
    });
    await expect(prisma.generationTransportExecution.count({ where: { attemptId } })).resolves.toBe(0);
    await expect(prisma.aiUsageFact.count({ where: { attemptId } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).resolves.toMatchObject({
      payload: expect.objectContaining({ kind: "generation.blocked", layer: "input" }),
    });
  });

  it("preserves a blocked terminal record through Request, Attempt, event, and Outbox finalization", async () => {
    const userId = "durable_terminal_record_user_1";
    const jobId = terminalRecordBase.generationJobId;
    const record = generationTerminalRecordSchema.parse({
      ...terminalRecordBase,
      outcome: "blocked",
      block: {
        policyCode: "provider_policy_blocked",
        message: "Provider rejected the request",
        layer: "provider",
      },
    });
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(record),
      terminalRecord: record,
    };

    try {
      await prisma.user.create({
        data: { id: userId, email: `${userId}@idream.internal`, status: "active" },
      });
      await prisma.generationJob.create({
        data: {
          id: jobId,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          outputCount: 1,
          costDreamcoins: 0,
          status: "running",
        },
      });
      await reserveAttempt();
      await recordGenerationTransportExecution({
        version: 1,
        attemptId,
        attemptNo: 1,
        generationJobId: jobId,
        transportAttemptNo: terminalRecordBase.transportAttemptNo,
        provider: terminalRecordBase.provider,
        model: terminalRecordBase.model,
        providerRequestId: terminalRecordBase.providerRequestId,
        idempotencyKey: terminalRecordBase.providerIdempotencyKey,
        occurredAt: "2026-07-11T11:59:59.000Z",
        status: "running",
        error: null,
      });

      await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
        acknowledged: true,
        status: "persisted",
      });
      await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
        acknowledged: true,
        status: "duplicate",
      });
      await expect(dispatchPendingGenerationTerminalRecords()).resolves.toBe(1);
      await expect(drainLocalAiPipeline({
        queues: ["app.ai.finalize"],
        limit: 1,
        workerId: "terminal-record-blocked-finalizer",
      })).resolves.toMatchObject({ processed: 1 });

      await expect(prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).resolves.toMatchObject({
        status: "blocked",
        errorCode: "provider_policy_blocked",
        deliveredOutputCount: 0,
        completedAt: null,
        finishedAt: expect.any(Date),
      });
      await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).resolves.toMatchObject({
        status: "blocked",
        terminalRecordRef: input.terminalRecordRef,
        errorCode: "provider_policy_blocked",
        retryability: "not_retryable",
        finishedAt: expect.any(Date),
      });
      await expect(prisma.generationAttemptEvent.findFirstOrThrow({
        where: { attemptId, terminalScope: "terminal" },
      })).resolves.toMatchObject({
        eventType: "generation.attempt.blocked.v1",
        outcome: "blocked",
      });
      await expect(prisma.generationTransportExecution.findUniqueOrThrow({
        where: {
          attemptId_transportAttemptNo: {
            attemptId,
            transportAttemptNo: terminalRecordBase.transportAttemptNo,
          },
        },
      })).resolves.toMatchObject({ status: "succeeded" });
      await expect(prisma.aiUsageFact.count({ where: { attemptId } })).resolves.toBe(1);
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).resolves.toMatchObject({
        status: "delivered",
        deliveredAt: expect.any(Date),
      });
    } finally {
      await jobQueue.removeByDedupePrefix(
        `generation-terminal-record-finalize:${attemptId}`,
        ["app.ai.finalize"],
      );
      await prisma.moderationEvent.deleteMany({ where: { targetId: jobId } });
      await prisma.mainOutboxEvent.deleteMany({ where: { id: outboxId } });
      await prisma.inboundEventReceipt.deleteMany({ where: { sourceService: "gen", sourceEventId: attemptId } });
      await prisma.generationJobEvent.deleteMany({ where: { jobId } });
      await prisma.generationDelivery.deleteMany({ where: { requestId: jobId } });
      await prisma.generationArtifact.deleteMany({ where: { attemptId } });
      await prisma.generationTransportExecution.deleteMany({ where: { attemptId } });
      await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
      await prisma.aiUsageFact.deleteMany({ where: { attemptId } });
      await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
      await prisma.generationSettlementLink.deleteMany({ where: { requestId: jobId } });
      await prisma.dreamcoinLedger.deleteMany({ where: { sourceId: jobId } });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("fails closed instead of overwriting pinned Attempt provider authority", async () => {
    await prisma.generationAttempt.create({
      data: {
        id: attemptId,
        requestId: terminalRecord.generationJobId,
        attemptNo: terminalRecord.attemptNo,
        provider: "pinned-provider",
        status: "queued",
      },
    });
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };

    await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
      acknowledged: false,
      status: "quarantined",
    });
    await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).resolves.toMatchObject({
      provider: "pinned-provider",
      status: "queued",
      terminalRecordRef: null,
    });
    await expect(prisma.inboundEventReceipt.count({
      where: {
        sourceService: "gen_quarantine",
        sourceEventId: { startsWith: `${attemptId}:` },
      },
    })).resolves.toBe(1);
  });

  it("does not let a wrong transport model or invocation key poison a later correct terminal record", async () => {
    await reserveAttempt();
    const transport = {
      version: 1 as const,
      attemptId,
      attemptNo: terminalRecord.attemptNo,
      generationJobId: terminalRecord.generationJobId,
      transportAttemptNo: terminalRecord.transportAttemptNo,
      provider: terminalRecord.provider,
      model: terminalRecord.model,
      providerRequestId: terminalRecord.providerRequestId,
      idempotencyKey: terminalRecord.providerIdempotencyKey,
      status: "running" as const,
      occurredAt: "2026-07-11T11:59:59.000Z",
      error: null,
    };

    await expect(recordGenerationTransportExecution({
      ...transport,
      model: "tampered-model",
    })).rejects.toThrow("exact dispatch authority");
    await expect(recordGenerationTransportExecution({
      ...transport,
      idempotencyKey: "generation:tampered:provider",
    })).rejects.toThrow("exact dispatch authority");
    await expect(prisma.generationTransportExecution.count({ where: { attemptId } }))
      .resolves.toBe(0);
    await expect(prisma.generationAttemptEvent.count({ where: { attemptId } }))
      .resolves.toBe(0);

    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };
    await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
      acknowledged: true,
      status: "persisted",
    });
    await expect(prisma.generationTransportExecution.findUniqueOrThrow({
      where: {
        attemptId_transportAttemptNo: {
          attemptId,
          transportAttemptNo: terminalRecord.transportAttemptNo,
        },
      },
    })).resolves.toMatchObject({
      idempotencyKey: terminalRecord.providerIdempotencyKey,
      status: "succeeded",
    });
  });

  it("quarantines a terminal accounting replay that conflicts with the canonical usage fact", async () => {
    await reserveAttempt();
    const transportBase = {
      version: 1 as const,
      attemptId,
      attemptNo: terminalRecord.attemptNo,
      generationJobId: terminalRecord.generationJobId,
      transportAttemptNo: terminalRecord.transportAttemptNo,
      provider: terminalRecord.provider,
      model: terminalRecord.model,
      providerRequestId: terminalRecord.providerRequestId,
      idempotencyKey: terminalRecord.providerIdempotencyKey,
    };
    await recordGenerationTransportExecution({
      ...transportBase,
      status: "running",
      occurredAt: "2026-07-11T11:59:58.000Z",
      error: null,
    });
    await recordGenerationTransportExecution({
      ...transportBase,
      status: "failed",
      occurredAt: "2026-07-11T11:59:59.000Z",
      error: { code: "provider_failed", message: "Provider failed" },
      accounting: terminalRecord.accounting,
    });
    const conflictingRecord = generationTerminalRecordSchema.parse({
      ...terminalRecordBase,
      outcome: "failed",
      error: {
        code: "provider_failed",
        message: "Provider failed",
        retryability: "not_retryable",
      },
      accounting: {
        ...terminalRecord.accounting,
        costMicros: terminalRecord.accounting.costMicros + 1,
      },
    });
    const result = await ingestGenerationTerminalRecord({
      terminalRecordRef: `gen/terminal-records/${attemptId}/conflicting-accounting.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(conflictingRecord),
      terminalRecord: conflictingRecord,
    });

    expect(result).toMatchObject({ acknowledged: false, status: "quarantined" });
    await expect(prisma.inboundEventReceipt.findUniqueOrThrow({
      where: { id: result.receiptId! },
    })).resolves.toMatchObject({
      sourceService: "gen_quarantine",
      error: expect.objectContaining({
        code: "generation_terminal_accounting_replay_conflict",
      }),
    });
    await expect(prisma.aiUsageFact.findFirstOrThrow({ where: { attemptId } }))
      .resolves.toMatchObject({
        costMicros: BigInt(terminalRecord.accounting.costMicros),
      });
    await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
      .resolves.toMatchObject({ terminalRecordRef: null });
  });

  it("does not rewrite a terminal TransportExecution when a conflicting terminal record arrives", async () => {
    await reserveAttempt();
    await prisma.generationAttempt.update({
      where: { id: attemptId },
      data: { status: "running" },
    });
    await prisma.generationTransportExecution.create({
      data: {
        attemptId,
        transportAttemptNo: terminalRecord.transportAttemptNo,
        idempotencyKey: terminalRecord.providerIdempotencyKey,
        status: "failed",
        finishedAt: new Date("2026-07-11T11:59:00.000Z"),
      },
    });
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/conflict.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };

    const result = await ingestGenerationTerminalRecord(input);
    expect(result).toMatchObject({ acknowledged: false, status: "quarantined" });
    await expect(prisma.inboundEventReceipt.findUniqueOrThrow({
      where: { id: result.receiptId! },
    })).resolves.toMatchObject({
      sourceService: "gen_quarantine",
      error: expect.objectContaining({
        code: "generation_terminal_transport_status_conflict",
      }),
    });
    await expect(prisma.generationTransportExecution.findUniqueOrThrow({
      where: { attemptId_transportAttemptNo: { attemptId, transportAttemptNo: terminalRecord.transportAttemptNo } },
    })).resolves.toMatchObject({ status: "failed", terminalRecordRef: null });
    await expect(prisma.inboundEventReceipt.count({ where: { sourceService: "gen", sourceEventId: attemptId } })).resolves.toBe(0);
    await expect(prisma.generationArtifact.count({ where: { attemptId } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({ where: { id: outboxId } })).resolves.toBe(0);
  });

  it("does not reopen a succeeded business Attempt from a late terminal record", async () => {
    await reserveAttempt();
    await prisma.generationAttempt.update({
      where: { id: attemptId },
      data: { status: "succeeded", finishedAt: new Date() },
    });
    const input = {
      terminalRecordRef: `gen/terminal-records/${attemptId}/late.json`,
      terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };

    await expect(ingestGenerationTerminalRecord(input)).rejects.toThrow("cannot reopen a terminal Generation Attempt");
    await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).resolves.toMatchObject({ status: "succeeded" });
    await expect(prisma.inboundEventReceipt.count({ where: { sourceService: "gen", sourceEventId: attemptId } })).resolves.toBe(0);
    await expect(prisma.generationTransportExecution.count({ where: { attemptId } })).resolves.toBe(0);
    await expect(prisma.generationArtifact.count({ where: { attemptId } })).resolves.toBe(0);
  });

  it("attaches recovered terminal evidence without rewriting an unknown business outcome", async () => {
    const suffix = crypto.randomUUID();
    const userId = `unknown-recovery-user-${suffix}`;
    const jobId = `unknown-recovery-job-${suffix}`;
    const unknownAttemptId = `unknown-recovery-attempt-${suffix}`;
    const recoveredRecord = {
      ...terminalRecord,
      attemptId: unknownAttemptId,
      generationJobId: jobId,
      requestId: `generation_dispatch_${unknownAttemptId}`,
      providerIdempotencyKey: `generation:${unknownAttemptId}:provider`,
      assets: terminalRecord.assets.map((asset) => ({
        ...asset,
        key: `gen/${jobId}/attempts/${unknownAttemptId}/image-1.webp`,
      })),
    };
    const recoveredRef = `gen/terminal-records/${unknownAttemptId}/terminal.json`;
    try {
      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@idream.internal`,
          status: "active",
        },
      });
      await prisma.generationJob.create({
        data: {
          id: jobId,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          status: "running",
        },
      });
      await prisma.generationAttempt.create({
        data: {
          id: unknownAttemptId,
          requestId: jobId,
          attemptNo: 1,
          provider: recoveredRecord.provider,
          status: "running",
        },
      });
      await ensureDispatchAuthority(recoveredRecord);
      await prisma.generationTransportExecution.create({
        data: {
          attemptId: unknownAttemptId,
          transportAttemptNo: recoveredRecord.transportAttemptNo,
          providerRequestId: recoveredRecord.providerRequestId,
          idempotencyKey: recoveredRecord.providerIdempotencyKey,
          status: "unknown",
          finishedAt: new Date(),
        },
      });
      await prisma.$transaction((tx) =>
        recordGenerationAttemptEvent(tx, {
          eventId: `${unknownAttemptId}:terminal-record-persistence-unknown`,
          attemptId: unknownAttemptId,
          eventType: "generation.attempt.unknown.v1",
          outcome: "unknown",
          occurredAt: new Date(),
          payload: { requestId: jobId, code: "terminal_record_persist_failed" },
          errorCode: "terminal_record_persist_failed",
          retryability: "operator_retry",
        }),
      );
      const input = {
        terminalRecordRef: recoveredRef,
        terminalRecordChecksum: generationTerminalRecordChecksum(recoveredRecord),
        terminalRecord: recoveredRecord,
      };

      await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
        acknowledged: true,
        status: "persisted",
      });
      await expect(prisma.generationAttempt.findUniqueOrThrow({
        where: { id: unknownAttemptId },
      })).resolves.toMatchObject({ status: "unknown", terminalRecordRef: null });
      await expect(prisma.generationTransportExecution.findFirstOrThrow({
        where: { attemptId: unknownAttemptId },
      })).resolves.toMatchObject({
        status: "unknown",
        terminalRecordRef: null,
      });
      await expect(prisma.generationArtifact.findFirstOrThrow({
        where: { attemptId: unknownAttemptId },
      })).resolves.toMatchObject({
        validationState: "late_after_unknown",
        archiveState: "archived",
        assetId: null,
      });
      await expect(prisma.generationDelivery.findFirstOrThrow({
        where: { requestId: jobId },
      })).resolves.toMatchObject({ status: "suppressed", deliveredAt: null });
      await expect(prisma.mainOutboxEvent.findUnique({
        where: { id: `generation_terminal_record_${unknownAttemptId}` },
      })).resolves.toBeNull();
      await expect(prisma.generationJobEvent.findFirstOrThrow({
        where: {
          jobId,
          type: "unknown_terminal_resolution_evidence_recovered",
        },
      })).resolves.toMatchObject({
        metadata: expect.objectContaining({ terminalRecordRef: recoveredRef }),
      });
    } finally {
      await prisma.mainOutboxEvent.deleteMany({
        where: { aggregateId: { in: [unknownAttemptId, jobId] } },
      });
      await prisma.inboundEventReceipt.deleteMany({
        where: {
          sourceService: { in: ["gen_resolution", "gen_resolution_quarantine"] },
          sourceEventId: { startsWith: unknownAttemptId },
        },
      });
      await prisma.generationJobEvent.deleteMany({ where: { jobId } });
      await prisma.generationDelivery.deleteMany({ where: { requestId: jobId } });
      await prisma.generationArtifact.deleteMany({ where: { attemptId: unknownAttemptId } });
      await prisma.aiUsageFact.deleteMany({ where: { attemptId: unknownAttemptId } });
      await prisma.generationTransportExecution.deleteMany({ where: { attemptId: unknownAttemptId } });
      await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: unknownAttemptId } });
      await prisma.generationAttempt.deleteMany({ where: { id: unknownAttemptId } });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("archives late artifacts without delivery when the business Attempt is cancelled", async () => {
    const suffix = crypto.randomUUID();
    const userId = `late-user-${suffix}`;
    const jobId = `late-job-${suffix}`;
    const cancelledAttemptId = `late-attempt-${suffix}`;
    const lateTerminalRecord = {
      ...terminalRecord,
      attemptId: cancelledAttemptId,
      generationJobId: jobId,
      requestId: `generation_dispatch_${cancelledAttemptId}`,
      providerIdempotencyKey: `generation:${cancelledAttemptId}:provider`,
      assets: terminalRecord.assets.map((asset) => ({
        ...asset,
        key: `gen/${jobId}/attempts/${cancelledAttemptId}/image-1.webp`,
      })),
    };
    const lateOutboxId = `generation_terminal_record_${cancelledAttemptId}`;
    try {
      await prisma.user.create({ data: { id: userId, email: `${userId}@idream.internal`, status: "active" } });
      await prisma.generationJob.create({ data: { id: jobId, userId, mode: "image", controls: {}, presetIds: [], status: "cancelled" } });
      await prisma.generationAttempt.create({ data: {
        id: cancelledAttemptId,
        requestId: jobId,
        attemptNo: 1,
        provider: lateTerminalRecord.provider,
        status: "cancelled",
        finishedAt: new Date(),
      } });
      await ensureDispatchAuthority(lateTerminalRecord);
      const input = { terminalRecordRef: `gen/terminal-records/${cancelledAttemptId}/terminal.json`, terminalRecordChecksum: generationTerminalRecordChecksum(lateTerminalRecord), terminalRecord: lateTerminalRecord };
      await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({ acknowledged: true, status: "persisted" });
      await expect(prisma.generationArtifact.findMany({ where: { attemptId: cancelledAttemptId } })).resolves.toEqual([expect.objectContaining({ validationState: "late_after_cancel", archiveState: "archived", assetId: null })]);
      await expect(prisma.generationDelivery.findFirst({ where: { requestId: jobId } })).resolves.toMatchObject({
        status: "suppressed",
        deliveredAt: null,
      });
      await expect(prisma.mainOutboxEvent.findUnique({ where: { id: lateOutboxId } })).resolves.toBeNull();
      await expect(prisma.generationJob.findUnique({ where: { id: jobId } })).resolves.toMatchObject({ status: "cancelled", completedAt: null });
    } finally {
      await prisma.mainOutboxEvent.deleteMany({ where: { OR: [{ id: lateOutboxId }, { aggregateId: jobId }] } });
      await prisma.inboundEventReceipt.deleteMany({ where: { sourceService: "gen", sourceEventId: cancelledAttemptId } });
      await prisma.generationJobEvent.deleteMany({ where: { jobId } });
      await prisma.generationDelivery.deleteMany({ where: { requestId: jobId } });
      await prisma.generationArtifact.deleteMany({ where: { attemptId: cancelledAttemptId } });
      await prisma.generationTransportExecution.deleteMany({ where: { attemptId: cancelledAttemptId } });
      await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: cancelledAttemptId } });
      await prisma.generationAttempt.deleteMany({ where: { id: cancelledAttemptId } });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("archives late artifacts without delivery after a stale-failed Attempt", async () => {
    const suffix = crypto.randomUUID();
    const userId = `late-failed-user-${suffix}`;
    const jobId = `late-failed-job-${suffix}`;
    const failedAttemptId = `late-failed-attempt-${suffix}`;
    const lateTerminalRecord = {
      ...terminalRecord,
      attemptId: failedAttemptId,
      generationJobId: jobId,
      requestId: `generation_dispatch_${failedAttemptId}`,
      providerIdempotencyKey: `generation:${failedAttemptId}:provider`,
      assets: terminalRecord.assets.map((asset) => ({
        ...asset,
        key: `gen/${jobId}/attempts/${failedAttemptId}/image-1.webp`,
      })),
    };
    try {
      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@idream.internal`,
          status: "active",
        },
      });
      await prisma.generationJob.create({
        data: {
          id: jobId,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          status: "failed",
          errorCode: "stale_timeout",
        },
      });
      await prisma.generationAttempt.create({
        data: {
          id: failedAttemptId,
          requestId: jobId,
          attemptNo: 1,
          provider: lateTerminalRecord.provider,
          status: "failed",
          errorCode: "stale_timeout",
          finishedAt: new Date(),
        },
      });
      await ensureDispatchAuthority(lateTerminalRecord);
      const input = {
        terminalRecordRef: `gen/terminal-records/${failedAttemptId}/terminal.json`,
        terminalRecordChecksum: generationTerminalRecordChecksum(lateTerminalRecord),
        terminalRecord: lateTerminalRecord,
      };

      await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({
        acknowledged: true,
        status: "persisted",
      });
      await expect(
        prisma.generationArtifact.findMany({
          where: { attemptId: failedAttemptId },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          validationState: "late_after_failed",
          archiveState: "archived",
          assetId: null,
        }),
      ]);
      await expect(
        prisma.generationDelivery.findFirst({ where: { requestId: jobId } }),
      ).resolves.toMatchObject({ status: "suppressed", deliveredAt: null });
    } finally {
      await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: jobId } });
      await prisma.inboundEventReceipt.deleteMany({
        where: { sourceService: "gen", sourceEventId: failedAttemptId },
      });
      await prisma.generationJobEvent.deleteMany({ where: { jobId } });
      await prisma.generationDelivery.deleteMany({ where: { requestId: jobId } });
      await prisma.generationArtifact.deleteMany({
        where: { attemptId: failedAttemptId },
      });
      await prisma.generationTransportExecution.deleteMany({
        where: { attemptId: failedAttemptId },
      });
      await prisma.generationAttemptEvent.deleteMany({
        where: { attemptId: failedAttemptId },
      });
      await prisma.generationAttempt.deleteMany({
        where: { id: failedAttemptId },
      });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

async function reserveAttempt() {
  await ensureDispatchAuthority(terminalRecord);
  return prisma.generationAttempt.create({
    data: {
      id: attemptId,
      requestId: terminalRecord.generationJobId,
      attemptNo: terminalRecord.attemptNo,
      provider: terminalRecord.provider,
      status: "queued",
    },
  });
}

async function ensureDispatchAuthority(record: {
  attemptId: string;
  attemptNo: number;
  requestId: string;
  generationJobId: string;
  mode: "image" | "video";
  provider: string;
  model?: string;
  assets?: readonly unknown[];
}) {
  const existingJob = await prisma.generationJob.findUnique({
    where: { id: record.generationJobId },
    select: { userId: true },
  });
  let userId = existingJob?.userId ?? authorityUserId;
  if (!existingJob) {
    await prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        email: `${userId}@idream.internal`,
        status: "active",
      },
      update: {},
    });
    await prisma.generationJob.create({
      data: {
        id: record.generationJobId,
        userId,
        mode: record.mode,
        controls: {},
        presetIds: [],
        outputCount: record.assets?.length ?? 1,
        costDreamcoins: 0,
        status: "running",
        provider: record.provider,
        model: record.model,
      },
    });
  }
  userId = existingJob?.userId ?? userId;
  const queuePayload = {
    version: 1,
    kind: record.mode,
    requestId: record.requestId,
    generationJobId: record.generationJobId,
    attemptId: record.attemptId,
    attemptNo: record.attemptNo,
    provider: record.provider,
    userId,
    characterId: null,
    prompt: "terminal authority test",
    negativePrompt: null,
    controls: {},
    seed: record.generationJobId,
    model: record.model,
    outputPrefix:
      `gen/${record.generationJobId}/attempts/${record.attemptId}/`,
    ...(record.mode === "image"
      ? { presetIds: [], orientation: "portrait", count: record.assets?.length ?? 1 }
      : { seconds: 4 }),
  };
  await prisma.mainOutboxEvent.upsert({
    where: { id: `generation_dispatch_authority_${record.attemptId}` },
    create: {
      id: `generation_dispatch_authority_${record.attemptId}`,
      eventType: "generation.retry.dispatch.v2",
      aggregateType: "generation_request",
      aggregateId: record.generationJobId,
      payload: {
        generationJobId: record.generationJobId,
        attemptId: record.attemptId,
        attemptNo: record.attemptNo,
        queueInput: {
          queue: `ai.${record.mode}.generate`,
          payload: queuePayload,
          dedupeKey: `generation:${record.generationJobId}:attempt:${record.attemptNo}`,
          maxAttempts: 3,
        },
      },
    },
    update: {},
  });
}
