import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  generationTerminalRecordChecksum,
  GEN_QUEUES,
  idempotencyKeys,
  MAIN_QUEUES,
} from "@idream/shared/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  bullMqJobIdForDedupeKey,
  type QueueJobSnapshot,
} from "@/server/jobs/queue";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import { reserveInitialGenerationAttempt } from "@/server/modules/generation/generation-attempt-authority";
import { providers } from "@/server/providers";
import {
  assessGenerationDispatchCutoverReadiness,
  assessGenerationQueueDrainReadiness,
  GENERATION_CUTOVER_QUEUES,
} from "./generation-dispatch-cutover";

describe("Generation dispatch cutover gate", () => {
  const prefix = `generation-cutover-${randomUUID()}`;
  const userId = `${prefix}-user`;
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@idream.internal`,
        role: "user",
        status: "active",
      },
    });
  });

  afterAll(async () => {
    const attempts = await prisma.generationAttempt.findMany({
      where: { requestId: { in: createdJobIds } },
      select: { id: true },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: {
        OR: [
          { aggregateId: { in: createdJobIds } },
          { aggregateId: { in: attempts.map((attempt) => attempt.id) } },
        ],
      },
    });
    await prisma.generationAttemptEvent.deleteMany({
      where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
    });
    await prisma.generationAttempt.deleteMany({
      where: { requestId: { in: createdJobIds } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: createdJobIds } },
    });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function createActiveJob(label: string, mode = "image") {
    const id = `${prefix}-${label}`;
    createdJobIds.push(id);
    return prisma.generationJob.create({
      data: {
        id,
        userId,
        mode,
        controls: {},
        presetIds: [],
        outputCount: 1,
        status: "queued",
        provider: "mock",
      },
    });
  }

  function queueInspector(rows: readonly QueueJobSnapshot[]) {
    return {
      inspectInFlight: async (queues: readonly string[]) =>
        rows.filter(
          (row) =>
            queues.includes(row.queue) &&
            !["completed", "failed"].includes(row.state),
        ),
      getByDedupeKey: async (queue: string, dedupeKey: string) =>
        rows.find(
          (row) => row.queue === queue && row.dedupeKey === dedupeKey,
        ) ?? null,
      inspectFailed: async (
        queues: readonly string[],
        options?: { limit?: number; offset?: number },
      ) =>
        rows.filter(
          (row) => queues.includes(row.queue) && row.state === "failed",
        ).slice(
          options?.offset ?? 0,
          (options?.offset ?? 0) + (options?.limit ?? 100),
        ),
    };
  }

  function bullRow(input: {
    readonly queue: string;
    readonly payload: Prisma.JsonValue;
    readonly dedupeKey: string;
    readonly state?: string;
    readonly failedReason?: string;
  }): QueueJobSnapshot {
    return {
      id: bullMqJobIdForDedupeKey(input.dedupeKey),
      queue: input.queue,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
      attemptsMade: 0,
      maxAttempts: 3,
      state: input.state ?? "waiting",
      ...(input.failedReason ? { failedReason: input.failedReason } : {}),
      timestamp: Date.now(),
    };
  }

  function dispatchQueueInput(
    outbox: { readonly payload: Prisma.JsonValue },
  ) {
    const payload = outbox.payload as Record<string, unknown>;
    return payload.queueInput as Record<string, unknown>;
  }

  function terminalRelayPayload(input: {
    readonly jobId: string;
    readonly attemptId: string;
    readonly attemptNo: number;
    readonly mode: "image" | "video";
    readonly checksumOverride?: string;
  }) {
    const terminalRecord = {
      version: 1 as const,
      outcome: "succeeded" as const,
      attemptId: input.attemptId,
      attemptNo: input.attemptNo,
      transportAttemptNo: 1,
      providerIdempotencyKey: `generation:${input.attemptId}:provider`,
      requestId: `generation_dispatch_${input.attemptId}`,
      generationJobId: input.jobId,
      mode: input.mode,
      provider: "mock",
      providerInvoked: true,
      model: input.mode === "video" ? "unresolved-video-model" : "mock",
      providerRequestId: `${input.attemptId}-provider-request`,
      completedAt: "2026-08-02T12:00:00.000Z",
      usage: {},
      assets: [{
        ordinal: 0,
        key:
          `gen/${input.jobId}/attempts/${input.attemptId}/${input.mode}.${input.mode === "video" ? "mp4" : "png"}`,
        contentType: input.mode === "video" ? "video/mp4" : "image/png",
        providerKey: `${input.attemptId}-provider-asset`,
      }],
    };
    return {
      terminalRecordRef:
        `gen/terminal-records/${input.attemptId}/terminal.json`,
      terminalRecordChecksum:
        input.checksumOverride ??
        generationTerminalRecordChecksum(terminalRecord),
      terminalRecord,
    };
  }

  async function createFinalizeOutbox(input: {
    readonly jobId: string;
    readonly attemptId: string;
    readonly attemptNo: number;
    readonly payloadOverride?: Readonly<Record<string, unknown>>;
  }) {
    const payload = input.payloadOverride ?? {
      version: 1,
      kind: "generation.failed",
      requestId: `generation_dispatch_${input.attemptId}`,
      generationJobId: input.jobId,
      attemptId: input.attemptId,
      attemptNo: input.attemptNo,
      terminalRecordRef: `gen/terminal-records/${input.attemptId}/terminal.json`,
      terminalRecordChecksum: "a".repeat(64),
      mode: "image",
      error: {
        code: "provider_error",
        message: "provider failed",
        retryable: false,
      },
    };
    const payloadRecord = payload as Record<string, unknown>;
    await prisma.generationAttempt.update({
      where: { id: input.attemptId },
      data: {
        terminalRecordRef:
          typeof payloadRecord.terminalRecordRef === "string"
            ? payloadRecord.terminalRecordRef
            : `gen/terminal-records/${input.attemptId}/terminal.json`,
      },
    });
    const outbox = await prisma.mainOutboxEvent.create({
      data: {
        id: `${input.attemptId}-terminal-outbox`,
        eventType: "generation.terminal_record.accepted.v1",
        aggregateType: "generation_attempt",
        aggregateId: input.attemptId,
        payload: payload as Prisma.InputJsonValue,
      },
    });
    return { outbox, payload: payload as Prisma.JsonValue };
  }

  async function createFinalizedUnknown(input: {
    readonly jobId: string;
    readonly attemptId: string;
    readonly attemptNo: number;
    readonly includeRequestEvent?: boolean;
  }) {
    const terminalRecordRef =
      `gen/terminal-records/${input.attemptId}/unknown.json`;
    const terminal = await createFinalizeOutbox({
      ...input,
      payloadOverride: {
        version: 1,
        kind: "generation.failed",
        requestId: `generation_dispatch_${input.attemptId}`,
        generationJobId: input.jobId,
        attemptId: input.attemptId,
        attemptNo: input.attemptNo,
        terminalRecordRef,
        terminalRecordChecksum: "b".repeat(64),
        mode: "image",
        error: {
          code: "provider_outcome_unknown",
          message: "Provider outcome requires operator reconciliation",
          retryable: false,
          attemptOutcome: "unknown",
          retryability: "operator_retry",
        },
      },
    });
    await prisma.$transaction((tx) =>
      recordGenerationAttemptEvent(tx, {
        eventId: `${input.attemptId}:terminal`,
        attemptId: input.attemptId,
        eventType: "generation.attempt.unknown.v1",
        outcome: "unknown",
        occurredAt: new Date(),
        payload: {
          requestId: input.jobId,
          requestOutcome: "needs_reconciliation",
          errorCode: "provider_outcome_unknown",
        },
        terminalRecordRef,
        errorCode: "provider_outcome_unknown",
        errorClass: "ambiguous_provider_outcome",
        errorSignature:
          "ambiguous_provider_outcome:provider_outcome_unknown",
        retryability: "operator_retry",
        operatorGuidance: "Reconcile provider evidence before settlement.",
      }),
    );
    if (input.includeRequestEvent !== false) {
      await prisma.generationJobEvent.create({
        data: {
          id: `${input.attemptId}:request-unknown`,
          jobId: input.jobId,
          type: "provider_outcome_unknown",
          message: "Provider outcome requires operator reconciliation",
          metadata: {
            attemptId: input.attemptId,
            terminalRecordRef,
            terminalRecordChecksum: "b".repeat(64),
          },
        },
      });
    }
    await prisma.mainOutboxEvent.update({
      where: { id: terminal.outbox.id },
      data: { status: "delivered", deliveredAt: new Date() },
    });
    return terminal;
  }

  it("accepts an exact Attempt-bound image Bull row", async () => {
    const job = await createActiveJob("exact");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const queueInput = dispatchQueueInput(reserved.outbox);
    const row = bullRow({
      queue: queueInput.queue as string,
      payload: queueInput.payload as Prisma.JsonValue,
      dedupeKey: queueInput.dedupeKey as string,
    });

    await expect(
      assessGenerationDispatchCutoverReadiness(prisma, {
        generationJobIds: [job.id],
        queueInspector: queueInspector([row]),
      }),
    ).resolves.toEqual({
      ok: true,
      activeRequests: 1,
      inFlightBullRows: 1,
      pendingTerminalOutboxes: 0,
      issues: [],
    });
  });

  it("does not report a paused queue as drained while an exact Bull row is active", async () => {
    const dedupeKey = `${prefix}-active-drain`;
    const row = bullRow({
      queue: "ai.image.generate",
      payload: {
        generationJobId: `${prefix}-active-drain-job`,
        attemptId: `${prefix}-active-drain-attempt`,
      },
      dedupeKey,
      state: "active",
    });
    const db = {
      mainOutboxEvent: { count: async () => 0 },
    } as unknown as PrismaClient;

    await expect(
      assessGenerationQueueDrainReadiness(db, {
        queueInspector: {
          inspectInFlight: async () => [row],
          inspectPaused: async () =>
            GENERATION_CUTOVER_QUEUES.map((queue) => ({
              queue,
              paused: true,
            })),
        },
      }),
    ).resolves.toEqual({
      ok: false,
      queues: GENERATION_CUTOVER_QUEUES.map((queue) => ({
        queue,
        paused: true,
      })),
      activeBullRows: [
        {
          queue: "ai.image.generate",
          bullJobId: bullMqJobIdForDedupeKey(dedupeKey),
          generationJobId: `${prefix}-active-drain-job`,
          attemptId: `${prefix}-active-drain-attempt`,
        },
      ],
      pendingTerminalOutboxes: 0,
    });
  });

  it("rechecks Bull after dispatching terminal Outbox work across the drain fence", async () => {
    const row = bullRow({
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload: { attemptId: `${prefix}-fence-race-attempt` },
      dedupeKey: `${prefix}-fence-race`,
      state: "active",
    });
    const order: string[] = [];
    let inspection = 0;
    const db = {
      mainOutboxEvent: {
        count: async () => {
          order.push("count");
          return 0;
        },
      },
    } as unknown as PrismaClient;

    const report = await assessGenerationQueueDrainReadiness(db, {
      dispatchPendingTerminalRecords: async () => {
        order.push("dispatch");
        return 1;
      },
      queueInspector: {
        inspectPaused: async () =>
          GENERATION_CUTOVER_QUEUES.map((queue) => ({ queue, paused: true })),
        inspectInFlight: async () => {
          inspection += 1;
          order.push(`inspect-${inspection}`);
          return inspection === 1 ? [] : [row];
        },
      },
    });

    expect(order).toEqual(["inspect-1", "dispatch", "inspect-2", "count"]);
    expect(report).toMatchObject({
      ok: false,
      activeBullRows: [expect.objectContaining({ bullJobId: row.id })],
    });
  });

  it("accepts an exact Attempt-bound video Bull row", async () => {
    const job = await createActiveJob("exact-video", "video");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const queueInput = dispatchQueueInput(reserved.outbox);
    const row = bullRow({
      queue: queueInput.queue as string,
      payload: queueInput.payload as Prisma.JsonValue,
      dedupeKey: queueInput.dedupeKey as string,
    });

    await expect(
      assessGenerationDispatchCutoverReadiness(prisma, {
        generationJobIds: [job.id],
        queueInspector: queueInspector([row]),
      }),
    ).resolves.toEqual({
      ok: true,
      activeRequests: 1,
      inFlightBullRows: 1,
      pendingTerminalOutboxes: 0,
      issues: [],
    });
  });

  it("accepts an exact nested-identity terminal relay Bull row", async () => {
    const job = await createActiveJob("exact-terminal-relay", "video");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const dedupeKey = idempotencyKeys.generationTerminalRelay(
      reserved.attempt.id,
    );
    const row = bullRow({
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload: terminalRelayPayload({
        jobId: job.id,
        attemptId: reserved.attempt.id,
        attemptNo: reserved.attempt.attemptNo,
        mode: "video",
      }) as Prisma.JsonValue,
      dedupeKey,
    });

    await expect(assessGenerationDispatchCutoverReadiness(prisma, {
      generationJobIds: [job.id],
      queueInspector: queueInspector([row]),
    })).resolves.toEqual({
      ok: true,
      activeRequests: 1,
      inFlightBullRows: 1,
      pendingTerminalOutboxes: 0,
      issues: [],
    });
  });

  it("fails closed for a terminal relay row with tampered evidence", async () => {
    const job = await createActiveJob("invalid-terminal-relay", "video");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const dedupeKey = idempotencyKeys.generationTerminalRelay(
      reserved.attempt.id,
    );
    const row = bullRow({
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload: terminalRelayPayload({
        jobId: job.id,
        attemptId: reserved.attempt.id,
        attemptNo: reserved.attempt.attemptNo,
        mode: "video",
        checksumOverride: "f".repeat(64),
      }) as Prisma.JsonValue,
      dedupeKey,
    });

    const inspector = queueInspector([row]);
    const report = await assessGenerationDispatchCutoverReadiness(prisma, {
      generationJobIds: [job.id],
      queueInspector: inspector,
    });

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual({
      generationJobId: job.id,
      attemptId: reserved.attempt.id,
      queue: MAIN_QUEUES.generationTerminalIngest,
      bullJobId: bullMqJobIdForDedupeKey(dedupeKey),
      code: "legacy_or_invalid_bull_job",
    });
  });

  it("treats an exact failed terminal relay as a paused durable carrier", async () => {
    const job = await createActiveJob("failed-terminal-relay", "video");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const dedupeKey = idempotencyKeys.generationTerminalRelay(
      reserved.attempt.id,
    );
    const row = bullRow({
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload: terminalRelayPayload({
        jobId: job.id,
        attemptId: reserved.attempt.id,
        attemptNo: reserved.attempt.attemptNo,
        mode: "video",
      }) as Prisma.JsonValue,
      dedupeKey,
      state: "failed",
      failedReason: "Main unavailable",
    });

    const inspector = queueInspector([row]);
    const report = await assessGenerationDispatchCutoverReadiness(prisma, {
      generationJobIds: [job.id],
      queueInspector: inspector,
    });

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report).toMatchObject({
      recoverableFailedRows: [{
        queue: MAIN_QUEUES.generationTerminalIngest,
        bullJobId: bullMqJobIdForDedupeKey(dedupeKey),
      }],
    });
    const drainDb = {
      generationAttempt: prisma.generationAttempt,
      generationJob: prisma.generationJob,
      mainOutboxEvent: {
        findMany: (args: Prisma.MainOutboxEventFindManyArgs) =>
          prisma.mainOutboxEvent.findMany(args),
        count: async () => 0,
      },
    } as unknown as PrismaClient;
    await expect(assessGenerationQueueDrainReadiness(drainDb, {
      dispatchPendingTerminalRecords: async () => 0,
      queueInspector: {
        inspectInFlight: inspector.inspectInFlight,
        inspectFailed: inspector.inspectFailed,
        inspectPaused: async () =>
          GENERATION_CUTOVER_QUEUES.map((queue) => ({ queue, paused: true })),
      },
    })).resolves.toMatchObject({
      ok: true,
      recoverableFailedRows: [{
        queue: MAIN_QUEUES.generationTerminalIngest,
        bullJobId: row.id,
      }],
    });
  });

  it("keeps an invalid failed terminal relay as a structured blocker", async () => {
    const job = await createActiveJob("failed-invalid-terminal-relay", "video");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const dedupeKey = idempotencyKeys.generationTerminalRelay(
      reserved.attempt.id,
    );
    const row = bullRow({
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload: terminalRelayPayload({
        jobId: job.id,
        attemptId: reserved.attempt.id,
        attemptNo: reserved.attempt.attemptNo,
        mode: "video",
        checksumOverride: "e".repeat(64),
      }) as Prisma.JsonValue,
      dedupeKey,
      state: "failed",
    });

    const report = await assessGenerationDispatchCutoverReadiness(prisma, {
      generationJobIds: [job.id],
      queueInspector: queueInspector([row]),
    });

    expect(report.issues).toContainEqual({
      generationJobId: job.id,
      attemptId: reserved.attempt.id,
      queue: MAIN_QUEUES.generationTerminalIngest,
      bullJobId: bullMqJobIdForDedupeKey(dedupeKey),
      reason: "checksum_mismatch",
      code: "legacy_or_invalid_terminal_relay",
    });
  });

  it("blocks cutover for an exact failed source row without Blob terminal evidence", async () => {
    const job = await createActiveJob("failed-source-video", "video");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const queueInput = dispatchQueueInput(reserved.outbox);
    const row = bullRow({
      queue: queueInput.queue as string,
      payload: queueInput.payload as Prisma.JsonValue,
      dedupeKey: queueInput.dedupeKey as string,
      state: "failed",
      failedReason: "terminal relay admission exhausted",
    });

    const report = await assessGenerationDispatchCutoverReadiness(prisma, {
      generationJobIds: [job.id],
      queueInspector: queueInspector([row]),
    });

    expect(report.issues).toContainEqual({
      generationJobId: job.id,
      attemptId: reserved.attempt.id,
      queue: "ai.video.generate",
      bullJobId: row.id,
      code: "failed_generation_source_pending_redrive",
    });
  });

  it("treats an exact Blob-backed failed source row as a paused durable carrier", async () => {
    const job = await createActiveJob("failed-source-blob-carrier", "video");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const queueInput = dispatchQueueInput(reserved.outbox);
    const sourcePayload = queueInput.payload as Record<string, unknown>;
    const terminalRecord = {
      ...terminalRelayPayload({
        jobId: job.id,
        attemptId: reserved.attempt.id,
        attemptNo: reserved.attempt.attemptNo,
        mode: "video",
      }).terminalRecord,
      requestId: sourcePayload.requestId as string,
      provider: sourcePayload.provider as string,
      model: sourcePayload.model as string,
    };
    await providers.blob.putPrivate({
      key: `gen/terminal-records/${reserved.attempt.id}/terminal.json`,
      body: new TextEncoder().encode(JSON.stringify(terminalRecord)),
      contentType: "application/json",
    });
    const row = bullRow({
      queue: queueInput.queue as string,
      payload: queueInput.payload as Prisma.JsonValue,
      dedupeKey: queueInput.dedupeKey as string,
      state: "failed",
    });
    const inspector = queueInspector([row]);

    await expect(assessGenerationDispatchCutoverReadiness(prisma, {
      generationJobIds: [job.id],
      queueInspector: inspector,
    })).resolves.toMatchObject({
      ok: true,
      issues: [],
      recoverableFailedRows: [{ queue: row.queue, bullJobId: row.id }],
    });
    await expect(assessGenerationQueueDrainReadiness(prisma, {
      dispatchPendingTerminalRecords: async () => 0,
      queueInspector: {
        inspectInFlight: inspector.inspectInFlight,
        inspectFailed: inspector.inspectFailed,
        inspectPaused: async () =>
          GENERATION_CUTOVER_QUEUES.map((queue) => ({ queue, paused: true })),
      },
    })).resolves.toMatchObject({
      ok: true,
      recoverableFailedRows: [{ queue: row.queue, bullJobId: row.id }],
    });
  });

  it("ignores exact terminal source history even after a newer Attempt becomes active", async () => {
    const job = await createActiveJob("terminal-source-history", "image");
    const first = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch-1`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const queueInput = dispatchQueueInput(first.outbox);
    const failedRow = bullRow({
      queue: queueInput.queue as string,
      payload: queueInput.payload as Prisma.JsonValue,
      dedupeKey: queueInput.dedupeKey as string,
      state: "failed",
      failedReason: "cancel raced active provider worker",
    });
    await prisma.generationAttempt.update({
      where: { id: first.attempt.id },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    const secondAttemptId = `${job.id}-attempt-2`;
    await prisma.generationAttempt.create({
      data: {
        id: secondAttemptId,
        requestId: job.id,
        attemptNo: 2,
        provider: "mock",
        status: "queued",
      },
    });
    const firstQueuePayload = queueInput.payload as Record<string, unknown>;
    await prisma.mainOutboxEvent.create({
      data: {
        id: `${job.id}-dispatch-2`,
        eventType: "generation.retry.dispatch.v2",
        aggregateType: "generation_request",
        aggregateId: job.id,
        payload: {
          generationJobId: job.id,
          attemptId: secondAttemptId,
          attemptNo: 2,
          queueInput: {
            ...queueInput,
            dedupeKey: idempotencyKeys.generationAttempt(job.id, 2),
            payload: {
              ...firstQueuePayload,
              requestId: `generation_dispatch_${secondAttemptId}`,
              attemptId: secondAttemptId,
              attemptNo: 2,
              outputPrefix: `gen/${job.id}/attempts/${secondAttemptId}/`,
            },
          },
        },
      },
    });
    const inspector = queueInspector([failedRow]);

    await expect(assessGenerationDispatchCutoverReadiness(prisma, {
      generationJobIds: [job.id],
      queueInspector: inspector,
    })).resolves.toMatchObject({
      ok: true,
      issues: [],
      ignoredHistory: [{
        queue: GEN_QUEUES.imageGenerate,
        bullJobId: failedRow.id,
      }],
    });

    await expect(assessGenerationQueueDrainReadiness(prisma, {
      queueInspector: {
        inspectInFlight: inspector.inspectInFlight,
        inspectFailed: inspector.inspectFailed,
        inspectPaused: async () =>
          GENERATION_CUTOVER_QUEUES.map((queue) => ({ queue, paused: true })),
      },
    })).resolves.toMatchObject({
      ok: true,
      ignoredHistory: [{
        queue: GEN_QUEUES.imageGenerate,
        bullJobId: failedRow.id,
        generationJobId: job.id,
        attemptId: first.attempt.id,
      }],
    });
  });

  it("does not report an active terminal relay row as drained", async () => {
    const payload = terminalRelayPayload({
      jobId: `${prefix}-relay-drain-job`,
      attemptId: `${prefix}-relay-drain-attempt`,
      attemptNo: 1,
      mode: "video",
    });
    const dedupeKey = idempotencyKeys.generationTerminalRelay(
      payload.terminalRecord.attemptId,
    );
    const row = bullRow({
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload: payload as Prisma.JsonValue,
      dedupeKey,
      state: "active",
    });
    const db = {
      mainOutboxEvent: { count: async () => 0 },
    } as unknown as PrismaClient;

    await expect(assessGenerationQueueDrainReadiness(db, {
      queueInspector: {
        inspectInFlight: async () => [row],
        inspectPaused: async () =>
          GENERATION_CUTOVER_QUEUES.map((queue) => ({ queue, paused: true })),
      },
    })).resolves.toMatchObject({
      ok: false,
      activeBullRows: [{
        queue: MAIN_QUEUES.generationTerminalIngest,
        generationJobId: payload.terminalRecord.generationJobId,
        attemptId: payload.terminalRecord.attemptId,
      }],
    });
  });

  it("accepts an exact Attempt-bound finalize Bull row", async () => {
    const job = await createActiveJob("exact-finalize");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const terminal = await createFinalizeOutbox({
      jobId: job.id,
      attemptId: reserved.attempt.id,
      attemptNo: reserved.attempt.attemptNo,
    });
    const dedupeKey =
      `generation-terminal-record-finalize:${reserved.attempt.id}`;

    await expect(
      assessGenerationDispatchCutoverReadiness(prisma, {
        generationJobIds: [job.id],
        queueInspector: queueInspector([
          bullRow({
            queue: "app.ai.finalize",
            payload: terminal.payload,
            dedupeKey,
          }),
        ]),
      }),
    ).resolves.toEqual({
      ok: true,
      activeRequests: 1,
      inFlightBullRows: 1,
      pendingTerminalOutboxes: 1,
      issues: [],
    });
  });

  it("fails closed when a delivered terminal Outbox has no finalize Bull row", async () => {
    const job = await createActiveJob("stranded-finalize-missing");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const terminal = await createFinalizeOutbox({
      jobId: job.id,
      attemptId: reserved.attempt.id,
      attemptNo: reserved.attempt.attemptNo,
    });
    await prisma.mainOutboxEvent.update({
      where: { id: terminal.outbox.id },
      data: { status: "delivered", deliveredAt: new Date() },
    });

    await expect(
      assessGenerationDispatchCutoverReadiness(prisma, {
        generationJobIds: [job.id],
        queueInspector: queueInspector([]),
      }),
    ).resolves.toEqual({
      ok: false,
      activeRequests: 1,
      inFlightBullRows: 0,
      pendingTerminalOutboxes: 0,
      issues: [
        {
          generationJobId: job.id,
          attemptId: reserved.attempt.id,
          queue: "app.ai.finalize",
          code: "active_terminal_attempt_without_finalize",
        },
      ],
    });
  });

  it("treats an exact failed finalize row as a paused durable carrier", async () => {
    const job = await createActiveJob("stranded-finalize-failed");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const terminal = await createFinalizeOutbox({
      jobId: job.id,
      attemptId: reserved.attempt.id,
      attemptNo: reserved.attempt.attemptNo,
    });
    await prisma.mainOutboxEvent.update({
      where: { id: terminal.outbox.id },
      data: { status: "delivered", deliveredAt: new Date() },
    });
    const dedupeKey =
      `generation-terminal-record-finalize:${reserved.attempt.id}`;
    const failedRow = bullRow({
      queue: "app.ai.finalize",
      payload: terminal.payload,
      dedupeKey,
      state: "failed",
    });

    const inspector = queueInspector([failedRow]);
    await expect(
      assessGenerationDispatchCutoverReadiness(prisma, {
        generationJobIds: [job.id],
        queueInspector: inspector,
      }),
    ).resolves.toMatchObject({
      ok: true,
      activeRequests: 1,
      inFlightBullRows: 0,
      pendingTerminalOutboxes: 0,
      issues: [],
      recoverableFailedRows: [
        {
          queue: "app.ai.finalize",
          bullJobId: bullMqJobIdForDedupeKey(dedupeKey),
        },
      ],
    });
    const drainDb = {
      generationAttempt: prisma.generationAttempt,
      generationJob: prisma.generationJob,
      mainOutboxEvent: {
        findMany: (args: Prisma.MainOutboxEventFindManyArgs) =>
          prisma.mainOutboxEvent.findMany(args),
        count: async () => 0,
      },
    } as unknown as PrismaClient;
    await expect(assessGenerationQueueDrainReadiness(drainDb, {
      dispatchPendingTerminalRecords: async () => 0,
      queueInspector: {
        inspectInFlight: inspector.inspectInFlight,
        inspectFailed: inspector.inspectFailed,
        inspectPaused: async () =>
          GENERATION_CUTOVER_QUEUES.map((queue) => ({ queue, paused: true })),
      },
    })).resolves.toMatchObject({
      ok: true,
      recoverableFailedRows: [{
        queue: MAIN_QUEUES.aiFinalize,
        bullJobId: failedRow.id,
      }],
    });
  });

  it("validates a delivered terminal Outbox even when its Bull row is exact", async () => {
    const job = await createActiveJob("tampered-delivered-terminal");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const terminal = await createFinalizeOutbox({
      jobId: job.id,
      attemptId: reserved.attempt.id,
      attemptNo: reserved.attempt.attemptNo,
    });
    await prisma.mainOutboxEvent.update({
      where: { id: terminal.outbox.id },
      data: {
        status: "delivered",
        deliveredAt: new Date(),
        payload: {
          ...(terminal.payload as Record<string, unknown>),
          requestId: job.id,
        },
      },
    });
    const dedupeKey =
      `generation-terminal-record-finalize:${reserved.attempt.id}`;

    const report = await assessGenerationDispatchCutoverReadiness(prisma, {
      generationJobIds: [job.id],
      queueInspector: queueInspector([
        bullRow({
          queue: "app.ai.finalize",
          payload: terminal.payload,
          dedupeKey,
        }),
      ]),
    });

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual({
      generationJobId: job.id,
      attemptId: reserved.attempt.id,
      outboxId: terminal.outbox.id,
      code: "legacy_or_invalid_terminal_outbox",
    });
  });

  it.each(["completed", "removed"] as const)(
    "accepts explicit unknown finalization evidence with a %s finalize Bull row",
    async (finalizeState) => {
      const job = await createActiveJob(`finalized-unknown-${finalizeState}`);
      const reserved = await prisma.$transaction((tx) =>
        reserveInitialGenerationAttempt(tx, {
          requestId: job.id,
          dispatch: {
            outboxId: `${job.id}-dispatch`,
            eventType: "generation.retry.dispatch.v2",
          },
        }),
      );
      const terminal = await createFinalizedUnknown({
        jobId: job.id,
        attemptId: reserved.attempt.id,
        attemptNo: reserved.attempt.attemptNo,
      });
      const dedupeKey =
        `generation-terminal-record-finalize:${reserved.attempt.id}`;
      const rows = finalizeState === "completed"
        ? [
            bullRow({
              queue: "app.ai.finalize",
              payload: terminal.payload,
              dedupeKey,
              state: "completed",
            }),
          ]
        : [];

      await expect(
        assessGenerationDispatchCutoverReadiness(prisma, {
          generationJobIds: [job.id],
          queueInspector: queueInspector(rows),
        }),
      ).resolves.toEqual({
        ok: true,
        activeRequests: 1,
        inFlightBullRows: 0,
        pendingTerminalOutboxes: 0,
        issues: [],
      });
    },
  );

  it("fails closed when an unknown Attempt lacks the request reconciliation event", async () => {
    const job = await createActiveJob("unknown-missing-request-event");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const terminal = await createFinalizedUnknown({
      jobId: job.id,
      attemptId: reserved.attempt.id,
      attemptNo: reserved.attempt.attemptNo,
      includeRequestEvent: false,
    });

    const report = await assessGenerationDispatchCutoverReadiness(prisma, {
      generationJobIds: [job.id],
      queueInspector: queueInspector([]),
    });

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual({
      generationJobId: job.id,
      attemptId: reserved.attempt.id,
      outboxId: terminal.outbox.id,
      code: "unknown_attempt_without_finalization_evidence",
    });
  });

  it("fails closed for active legacy requests without Attempt authority", async () => {
    const job = await createActiveJob("legacy-no-attempt");

    await expect(
      assessGenerationDispatchCutoverReadiness(prisma, {
        generationJobIds: [job.id],
        queueInspector: queueInspector([]),
      }),
    ).resolves.toEqual({
      ok: false,
      activeRequests: 1,
      inFlightBullRows: 0,
      pendingTerminalOutboxes: 0,
      issues: [
        {
          generationJobId: job.id,
          attemptId: null,
          code: "active_request_without_attempt",
        },
      ],
    });
  });

  it("fails closed when an active Attempt has no immutable dispatch envelope", async () => {
    const job = await createActiveJob("legacy-no-dispatch");
    const attempt = await prisma.generationAttempt.create({
      data: {
        requestId: job.id,
        attemptNo: 1,
        provider: "mock",
        status: "queued",
      },
    });

    await expect(
      assessGenerationDispatchCutoverReadiness(prisma, {
        generationJobIds: [job.id],
        queueInspector: queueInspector([]),
      }),
    ).resolves.toEqual({
      ok: false,
      activeRequests: 1,
      inFlightBullRows: 0,
      pendingTerminalOutboxes: 0,
      issues: [
        {
          generationJobId: job.id,
          attemptId: attempt.id,
          code: "active_attempt_without_dispatch",
        },
      ],
    });
  });

  it("fails closed for a legacy request-level dispatch dedupe key", async () => {
    const job = await createActiveJob("legacy-request-dedupe");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const payload = reserved.outbox.payload as Record<string, unknown>;
    const queueInput = payload.queueInput as Record<string, unknown>;
    await prisma.mainOutboxEvent.update({
      where: { id: reserved.outbox.id },
      data: {
        payload: {
          ...payload,
          queueInput: {
            ...queueInput,
            dedupeKey: `generation:${job.id}`,
          },
        },
      },
    });

    await expect(
      assessGenerationDispatchCutoverReadiness(prisma, {
        generationJobIds: [job.id],
        queueInspector: queueInspector([]),
      }),
    ).resolves.toEqual({
      ok: false,
      activeRequests: 1,
      inFlightBullRows: 0,
      pendingTerminalOutboxes: 0,
      issues: [
        {
          generationJobId: job.id,
          attemptId: reserved.attempt.id,
          code: "legacy_or_invalid_dispatch_envelope",
        },
      ],
    });
  });

  it("fails closed for a legacy generation Bull row without Attempt identity", async () => {
    const job = await createActiveJob("legacy-bull-row");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const queueInput = dispatchQueueInput(reserved.outbox);
    const legacyPayload = {
      ...(queueInput.payload as Record<string, unknown>),
    };
    delete legacyPayload.attemptId;
    delete legacyPayload.attemptNo;
    const dedupeKey = `generation:${job.id}`;
    const row = bullRow({
      queue: "ai.image.generate",
      payload: legacyPayload as Prisma.JsonValue,
      dedupeKey,
    });

    await expect(
      assessGenerationDispatchCutoverReadiness(prisma, {
        generationJobIds: [job.id],
        queueInspector: queueInspector([row]),
      }),
    ).resolves.toEqual({
      ok: false,
      activeRequests: 1,
      inFlightBullRows: 1,
      pendingTerminalOutboxes: 0,
      issues: [
        {
          generationJobId: job.id,
          attemptId: null,
          queue: "ai.image.generate",
          bullJobId: bullMqJobIdForDedupeKey(dedupeKey),
          code: "legacy_or_invalid_bull_job",
        },
      ],
    });
  });

  it("fails closed for a legacy finalize row that could target the latest retry", async () => {
    const job = await createActiveJob("legacy-finalize-row");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    const legacyPayload = {
      version: 1,
      kind: "generation.failed",
      requestId: job.id,
      generationJobId: job.id,
      mode: "image",
      error: {
        code: "provider_error",
        message: "legacy failure",
        retryable: false,
      },
    };
    await createFinalizeOutbox({
      jobId: job.id,
      attemptId: reserved.attempt.id,
      attemptNo: reserved.attempt.attemptNo,
      payloadOverride: legacyPayload,
    });
    const dedupeKey = `generation-terminal-record-finalize:${job.id}`;
    const row = bullRow({
      queue: "app.ai.finalize",
      payload: legacyPayload as Prisma.JsonValue,
      dedupeKey,
    });

    await expect(
      assessGenerationDispatchCutoverReadiness(prisma, {
        generationJobIds: [job.id],
        queueInspector: queueInspector([row]),
      }),
    ).resolves.toEqual({
      ok: false,
      activeRequests: 1,
      inFlightBullRows: 1,
      pendingTerminalOutboxes: 1,
      issues: [
        {
          generationJobId: job.id,
          attemptId: reserved.attempt.id,
          outboxId: `${reserved.attempt.id}-terminal-outbox`,
          code: "legacy_or_invalid_terminal_outbox",
        },
        {
          generationJobId: job.id,
          attemptId: null,
          queue: "app.ai.finalize",
          bullJobId: bullMqJobIdForDedupeKey(dedupeKey),
          code: "legacy_or_invalid_bull_job",
        },
      ],
    });
  });

  it("fails closed for a legacy pending terminal Outbox without a Bull row", async () => {
    const job = await createActiveJob("legacy-terminal-outbox");
    const reserved = await prisma.$transaction((tx) =>
      reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        dispatch: {
          outboxId: `${job.id}-dispatch`,
          eventType: "generation.retry.dispatch.v2",
        },
      }),
    );
    await createFinalizeOutbox({
      jobId: job.id,
      attemptId: reserved.attempt.id,
      attemptNo: reserved.attempt.attemptNo,
      payloadOverride: {
        version: 1,
        kind: "generation.failed",
        requestId: job.id,
        generationJobId: job.id,
        mode: "image",
        error: {
          code: "provider_error",
          message: "legacy failure",
          retryable: false,
        },
      },
    });

    await expect(
      assessGenerationDispatchCutoverReadiness(prisma, {
        generationJobIds: [job.id],
        queueInspector: queueInspector([]),
      }),
    ).resolves.toEqual({
      ok: false,
      activeRequests: 1,
      inFlightBullRows: 0,
      pendingTerminalOutboxes: 1,
      issues: [
        {
          generationJobId: job.id,
          attemptId: reserved.attempt.id,
          outboxId: `${reserved.attempt.id}-terminal-outbox`,
          code: "legacy_or_invalid_terminal_outbox",
        },
      ],
    });
  });
});
