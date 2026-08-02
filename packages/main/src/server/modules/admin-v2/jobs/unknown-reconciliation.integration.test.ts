import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generationJobQuerySchema,
  generationJobDetailResponseSchema,
  unknownGenerationReconciliationResultSchema,
} from "@idream/shared/admin";
import {
  generationTerminalRecordChecksum,
  generationTerminalRecordSchema,
} from "@idream/shared/contracts";
import { GET as getJobRoute } from "@/app/api/v2/admin/jobs/[id]/route";
import { POST as reconcileUnknownRoute } from "@/app/api/v2/admin/jobs/[id]/commands/reconcile-unknown/route";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import { queryGenerationJobsV2Authority } from "./query";
import { scanDueUnknownGenerationReviews } from "./unknown-review-reminder";
import { reserveInitialGenerationAttempt } from "@/server/modules/generation/generation-attempt-authority";
import {
  dispatchPendingGenerationTerminalRecords,
  ingestGenerationTerminalRecord,
} from "@/server/ai/generation-terminal-record-ingest";
import { drainLocalAiPipeline } from "@/server/ai/local-pipeline";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import { retryGenerationRequest } from "@/server/ai/generation-request-lifecycle";

describe("unknown Generation Attempt operator reconciliation", () => {
  const suffix = randomUUID();
  const actorId = `unknown-reconcile-admin-${suffix}`;
  const customerId = `unknown-reconcile-customer-${suffix}`;
  const requestId = `unknown-reconcile-request-${suffix}`;
  const attemptId = `unknown-reconcile-attempt-${suffix}`;
  const attemptEventId = `unknown-reconcile-event-${suffix}`;
  const transportId = `unknown-reconcile-transport-${suffix}`;
  const spendId = `unknown-reconcile-spend-${suffix}`;
  const providerRequestId = `provider-unknown-${suffix}`;

  function commandRequest(
    idempotencyKey: string,
    body: Record<string, unknown>,
  ) {
    return new Request(
      `http://localhost/api/v2/admin/jobs/${requestId}/commands/reconcile-unknown`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify(body),
      },
    );
  }

  function readRequest() {
    return new Request(`http://localhost/api/v2/admin/jobs/${requestId}`, {
      headers: {
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
      },
    });
  }

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      {
        id: actorId,
        email: `${actorId}@example.test`,
        role: "admin",
        status: "active",
      },
      {
        id: customerId,
        email: `${customerId}@example.test`,
        role: "user",
        status: "active",
      },
    ] });
    await prisma.generationJob.create({ data: {
      id: requestId,
      userId: customerId,
      mode: "video",
      status: "running",
      provider: "provider-beta",
      model: "video-model",
      sourceType: "generator",
      sourceId: `unknown-reconcile-source-${suffix}`,
      controls: {},
      presetIds: [],
      outputCount: 1,
      deliveredOutputCount: 0,
      costDreamcoins: 11,
    } });
    const occurredAt = new Date(Date.now() - 60_000);
    await prisma.generationAttempt.create({ data: {
      id: attemptId,
      requestId,
      attemptNo: 1,
      provider: "provider-beta",
      status: "unknown",
      terminalSequence: 1,
      errorClass: "ambiguous_provider_outcome",
      errorCode: "provider_outcome_unknown",
      errorSignature: "ambiguous_provider_outcome:provider_outcome_unknown",
      retryability: "not_retryable",
      operatorGuidance: "Reconcile provider evidence before settling.",
      startedAt: new Date(occurredAt.getTime() - 30_000),
      finishedAt: occurredAt,
    } });
    await prisma.generationAttemptEvent.create({ data: {
      id: attemptEventId,
      attemptId,
      sequence: 1,
      eventType: "generation.attempt.unknown.v1",
      outcome: "unknown",
      terminalScope: "terminal",
      occurredAt,
      payload: { requestId, providerRequestId },
      payloadHash: `unknown-reconcile-hash-${suffix}`,
    } });
    await prisma.generationTransportExecution.create({ data: {
      id: transportId,
      attemptId,
      transportAttemptNo: 1,
      providerRequestId,
      idempotencyKey: `unknown-provider-invocation-${suffix}`,
      status: "unknown",
      startedAt: new Date(occurredAt.getTime() - 30_000),
      finishedAt: occurredAt,
    } });
    await prisma.dreamcoinLedger.create({ data: {
      id: spendId,
      userId: customerId,
      delta: -11,
      balanceAfter: 89,
      reason: "generation_spend",
      sourceId: requestId,
      idempotencyKey: `unknown-reconcile-spend-${suffix}`,
    } });
    await prisma.mainOutboxEvent.create({
      data: {
        id: `unknown-reconcile-dispatch-${suffix}`,
        eventType: "generation.retry.dispatch.v2",
        aggregateType: "generation_request",
        aggregateId: requestId,
        payload: {
          generationJobId: requestId,
          attemptId,
          attemptNo: 1,
          queueInput: {
            queue: "ai.video.generate",
            dedupeKey: `generation:${requestId}`,
            payload: { generationJobId: requestId, attemptId, attemptNo: 1 },
          },
        },
      },
    });
  });

  afterAll(async () => {
    for (const attemptNo of [1, 2]) {
      await jobQueue.removeByDedupeKey(
        "ai.video.generate",
        `generation:${requestId}:attempt:${attemptNo}`,
      );
    }
    await jobQueue.removeByDedupeKey(
      "ai.video.generate",
      `generation:${requestId}`,
    );
    const commands = await prisma.controlPlaneCommand.findMany({
      where: { targetId: requestId },
      select: { id: true },
    });
    await prisma.controlPlaneCommandAttempt.deleteMany({
      where: { commandId: { in: commands.map((command) => command.id) } },
    });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: requestId } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: requestId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { targetId: requestId } });
    await prisma.generationSettlementLink.deleteMany({ where: { requestId } });
    await prisma.dreamcoinLedger.deleteMany({ where: { sourceId: requestId } });
    const attempts = await prisma.generationAttempt.findMany({
      where: { requestId },
      select: { id: true },
    });
    const attemptIds = attempts.map((attempt) => attempt.id);
    await prisma.generationTransportExecution.deleteMany({
      where: { attemptId: { in: attemptIds } },
    });
    await prisma.generationAttemptEvent.deleteMany({
      where: { attemptId: { in: attemptIds } },
    });
    await prisma.generationAttempt.deleteMany({ where: { requestId } });
    await prisma.generationJob.deleteMany({ where: { id: requestId } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, customerId] } } });
  });

  it("audits remain_unknown with a next review and leaves settlement open", async () => {
    const nextReviewAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    const response = await reconcileUnknownRoute(commandRequest(
      `unknown-remain-${suffix}`,
      {
        resolution: "remain_unknown",
        entityVersion: 1,
        reason: "Provider support is still tracing the durable request.",
        providerEvidenceRefs: [`provider-request:${providerRequestId}`],
        nextReviewAt,
        confirmation: `${requestId}:remain_unknown`,
      },
    ), { params: Promise.resolve({ id: requestId }) });

    expect(response.status).toBe(200);
    const result = unknownGenerationReconciliationResultSchema.parse(
      (await response.json()).data,
    );
    expect(result).toMatchObject({
      requestId,
      attemptId,
      attemptStatus: "unknown",
      resolution: "remain_unknown",
      requestStatus: "running",
      version: 1,
      refundAmount: 0,
      deliveredCount: 0,
      nextReviewAt,
    });
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: requestId } }))
      .toMatchObject({ status: "running", version: 1 });
    expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
      .toMatchObject({ status: "unknown", terminalSequence: 1 });
    expect(await prisma.dreamcoinLedger.count({
      where: { sourceId: requestId, reason: "refund" },
    })).toBe(0);

    const dueAt = new Date(new Date(nextReviewAt).getTime() + 1_000);
    await expect(scanDueUnknownGenerationReviews({
      now: dueAt,
      generationJobIds: [requestId],
    })).resolves.toMatchObject({
      scanned: 1,
      reminded: 1,
    });
    await expect(scanDueUnknownGenerationReviews({
      now: dueAt,
      generationJobIds: [requestId],
    })).resolves.toMatchObject({
      reminded: 0,
    });
    const detail = generationJobDetailResponseSchema.parse(
      (await (await getJobRoute(
        readRequest(),
        { params: Promise.resolve({ id: requestId }) },
      )).json()).data,
    );
    expect(detail.request.requestOutcome).toBe("needs_reconciliation");
    expect(detail.unknownReconciliations).toEqual([
      expect.objectContaining({
        attemptId,
        actorId,
        resolution: "remain_unknown",
        providerEvidenceRefs: [`provider-request:${providerRequestId}`],
        nextReviewAt,
        reviewStatus: "due",
      }),
    ]);
    const list = await queryGenerationJobsV2Authority({
      db: prisma,
      query: generationJobQuerySchema.parse({ mode: "all", limit: 100 }),
      now: dueAt,
    });
    expect(list.items.find((item) => item.id === requestId)?.unknownReview)
      .toEqual({ status: "due", nextReviewAt });
  });

  it("idempotently confirms failure, refunds, and preserves the unknown Attempt fact", async () => {
    const key = `unknown-confirm-failed-${suffix}`;
    const body = {
      resolution: "confirm_failed",
      entityVersion: 1,
      reason: "Provider support confirmed that the request produced no output.",
      providerEvidenceRefs: [
        `provider-request:${providerRequestId}`,
        `provider-ticket:case-${suffix}`,
      ],
      confirmation: `${requestId}:confirm_failed`,
    };
    const firstResponse = await reconcileUnknownRoute(
      commandRequest(key, body),
      { params: Promise.resolve({ id: requestId }) },
    );
    expect(firstResponse.status).toBe(200);
    const first = unknownGenerationReconciliationResultSchema.parse(
      (await firstResponse.json()).data,
    );
    const oldAttemptKey = `generation:${requestId}`;
    const laterAttemptKey = `generation:${requestId}:attempt:2`;
    await jobQueue.enqueue({
      queue: "ai.video.generate",
      dedupeKey: oldAttemptKey,
      payload: { requestId, attemptId },
    });
    await jobQueue.enqueue({
      queue: "ai.video.generate",
      dedupeKey: laterAttemptKey,
      payload: { requestId, attemptId: `later-${attemptId}` },
    });
    const replayResponse = await reconcileUnknownRoute(
      commandRequest(key, body),
      { params: Promise.resolve({ id: requestId }) },
    );
    const replay = unknownGenerationReconciliationResultSchema.parse(
      (await replayResponse.json()).data,
    );

    expect(replay).toEqual(first);
    expect(await jobQueue.getByDedupeKey("ai.video.generate", oldAttemptKey)).toBeNull();
    expect(await jobQueue.getByDedupeKey("ai.video.generate", laterAttemptKey))
      .toMatchObject({ dedupeKey: laterAttemptKey });
    expect(first).toMatchObject({
      requestId,
      attemptId,
      attemptStatus: "unknown",
      resolution: "confirm_failed",
      requestStatus: "failed",
      version: 2,
      refundAmount: 11,
      deliveredCount: 0,
      nextReviewAt: null,
    });
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: requestId } }))
      .toMatchObject({
        status: "failed",
        version: 2,
        errorCode: "operator_confirmed_provider_failure",
      });
    expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
      .toMatchObject({ status: "unknown", terminalSequence: 1 });
    expect(await prisma.generationAttemptEvent.count({ where: { attemptId } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({
      where: { sourceId: requestId, reason: "refund", delta: 11 },
    })).toBe(1);
    expect(await prisma.adminAuditLog.count({
      where: { targetId: requestId, action: "generation.request.unknown.confirm_failed" },
    })).toBe(1);
    expect(await prisma.generationJobEvent.count({
      where: { jobId: requestId, type: "unknown_reconciliation_confirm_failed" },
    })).toBe(1);
    const terminalDetail = generationJobDetailResponseSchema.parse(
      (await (await getJobRoute(
        readRequest(),
        { params: Promise.resolve({ id: requestId }) },
      )).json()).data,
    );
    expect(terminalDetail.request).toMatchObject({
      requestOutcome: "failed",
      unknownReview: { status: "not_applicable", nextReviewAt: null },
    });
    expect(terminalDetail.unknownReconciliations.at(-1)).toMatchObject({
      attemptId,
      resolution: "confirm_failed",
    });
    const terminalList = await queryGenerationJobsV2Authority({
      db: prisma,
      query: generationJobQuerySchema.parse({ mode: "all", limit: 100 }),
    });
    expect(terminalList.items.find((item) => item.id === requestId)).toMatchObject({
      requestOutcome: "failed",
      unknownReview: { status: "not_applicable", nextReviewAt: null },
    });

    const repeatedConfirm = await reconcileUnknownRoute(commandRequest(
      `unknown-confirm-failed-again-${suffix}`,
      { ...body, entityVersion: 2 },
    ), { params: Promise.resolve({ id: requestId }) });
    expect(repeatedConfirm.status).toBe(409);
    const remainAfterTerminal = await reconcileUnknownRoute(commandRequest(
      `unknown-remain-after-terminal-${suffix}`,
      {
        resolution: "remain_unknown",
        entityVersion: 2,
        reason: "Attempting to schedule another review after final settlement.",
        providerEvidenceRefs: [`provider-request:${providerRequestId}`],
        nextReviewAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
        confirmation: `${requestId}:remain_unknown`,
      },
    ), { params: Promise.resolve({ id: requestId }) });
    expect(remainAfterTerminal.status).toBe(409);
    expect(await prisma.controlPlaneCommand.count({ where: { targetId: requestId } }))
      .toBe(2);
    expect(await prisma.adminAuditLog.count({ where: { targetId: requestId } }))
      .toBe(2);
    expect(await prisma.generationJobEvent.count({
      where: {
        jobId: requestId,
        type: {
          in: [
            "unknown_reconciliation_confirm_failed",
            "unknown_reconciliation_remain_unknown",
          ],
        },
      },
    })).toBe(2);
    expect(await prisma.mainOutboxEvent.count({
      where: {
        aggregateId: requestId,
        eventType: "generation.request.unknown_reconciled.v2",
      },
    })).toBe(2);

    const retryInput = {
      requestId,
      expectedVersion: first.version,
      actor: { id: actorId, role: "admin" },
      reason: "Create a new Attempt after provider failure was confirmed.",
      idempotencyKey: `unknown-confirm-failed-retry-${suffix}`,
      traceId: `unknown-confirm-failed-retry-trace-${suffix}`,
    };
    const firstRetry = await retryGenerationRequest(retryInput);
    const retryReplay = await retryGenerationRequest(retryInput);
    expect(retryReplay).toEqual(firstRetry);
    expect(firstRetry).toEqual(expect.objectContaining({
      requestId,
      attemptNo: 2,
      status: "queued",
    }));
    const retryResult = firstRetry as {
      commandId: string;
      attemptId: string;
    };
    await expect(prisma.generationAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    })).resolves.toMatchObject({
      status: "unknown",
      retryability: "not_retryable",
      terminalSequence: 1,
    });
    await expect(prisma.generationAttempt.count({
      where: { requestId },
    })).resolves.toBe(2);
    const retryOutboxId = `generation_retry_${retryResult.commandId}`;
    await expect(prisma.mainOutboxEvent.count({
      where: { id: retryOutboxId },
    })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: retryOutboxId },
    })).resolves.toMatchObject({
      aggregateType: "generation_request",
      aggregateId: requestId,
      eventType: "generation.retry.dispatch.v2",
      payload: expect.objectContaining({
        generationJobId: requestId,
        attemptId: retryResult.attemptId,
        attemptNo: 2,
        queueInput: expect.objectContaining({
          dedupeKey: `generation:${requestId}:attempt:2`,
          payload: expect.objectContaining({
            generationJobId: requestId,
            attemptId: retryResult.attemptId,
            attemptNo: 2,
            outputPrefix:
              `gen/${requestId}/attempts/${retryResult.attemptId}/`,
          }),
        }),
      }),
    });
  });

  it("keeps reversed cross-Attempt recovered success isolated while adopting the latest Attempt atomically", async () => {
    const adoptRequestId = `unknown-adopt-request-${suffix}`;
    const adoptCustomerId = `unknown-adopt-customer-${suffix}`;
    const dispatchId = `unknown-adopt-dispatch-${suffix}`;
    let adoptAttemptId: string | null = null;
    let staleAttemptId: string | null = null;
    try {
      await prisma.user.create({ data: {
        id: adoptCustomerId,
        email: `${adoptCustomerId}@example.test`,
        role: "user",
        status: "active",
      } });
      await prisma.generationJob.create({ data: {
        id: adoptRequestId,
        userId: adoptCustomerId,
        mode: "image",
        status: "queued",
        provider: "mock",
        model: "mock-image-v2",
        prompt: "A recovered portrait",
        sourceType: "generator",
        controls: {},
        presetIds: [],
        outputCount: 2,
        deliveredOutputCount: 0,
        costDreamcoins: 10,
      } });
      const reservation = await prisma.$transaction((tx) =>
        reserveInitialGenerationAttempt(tx, {
          requestId: adoptRequestId,
          dispatch: {
            outboxId: dispatchId,
            eventType: "generation.retry.dispatch.v2",
            payload: { source: "unknown_adoption_test" },
          },
        })
      );
      adoptAttemptId = reservation.attempt.id;
      const dispatchPayload = reservation.outbox.payload as Record<string, unknown>;
      const queueInput = dispatchPayload.queueInput as Record<string, unknown>;
      const queuePayload = queueInput.payload as Record<string, unknown>;
      const providerRequestId = `unknown-adopt-provider-${suffix}`;
      await prisma.generationJob.update({
        where: { id: adoptRequestId },
        data: { status: "running" },
      });
      await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
        eventId: `unknown-adopt-attempt-event-${suffix}`,
        attemptId: adoptAttemptId!,
        expectedSequence: 2,
        eventType: "generation.attempt.unknown.v1",
        outcome: "unknown",
        occurredAt: new Date(),
        payload: { requestId: adoptRequestId, providerRequestId },
        errorClass: "ambiguous_provider_outcome",
        errorCode: "provider_outcome_unknown",
        retryability: "operator_retry",
      }));
      await prisma.generationTransportExecution.create({ data: {
        attemptId: adoptAttemptId,
        transportAttemptNo: 1,
        providerRequestId,
        idempotencyKey: `generation:${adoptAttemptId}:provider`,
        status: "unknown",
        finishedAt: new Date(),
      } });
      await prisma.dreamcoinLedger.create({ data: {
        userId: adoptCustomerId,
        delta: -10,
        balanceAfter: 90,
        reason: "generation_spend",
        sourceId: adoptRequestId,
        idempotencyKey: `unknown-adopt-spend-${suffix}`,
      } });
      const terminalRecord = generationTerminalRecordSchema.parse({
        version: 1,
        outcome: "succeeded",
        attemptId: adoptAttemptId,
        attemptNo: 1,
        transportAttemptNo: 1,
        providerIdempotencyKey: `generation:${adoptAttemptId}:provider`,
        requestId: queuePayload.requestId,
        generationJobId: adoptRequestId,
        mode: "image",
        provider: queuePayload.provider,
        providerInvoked: true,
        model: queuePayload.model,
        providerRequestId,
        completedAt: new Date().toISOString(),
        usage: { images: 1 },
        assets: [{
          ordinal: 0,
          key: `${queuePayload.outputPrefix as string}recovered.webp`,
          contentType: "image/webp",
          width: 768,
          height: 1024,
          providerKey: `unknown-adopt-asset-${suffix}`,
        }],
      });
      if (terminalRecord.outcome !== "succeeded") {
        throw new Error("Recovered adoption fixture must be a success record");
      }
      const terminalRecordRef = `gen/terminal-records/${adoptAttemptId}/terminal.json`;
      const terminalRecordChecksum = generationTerminalRecordChecksum(terminalRecord);
      await expect(ingestGenerationTerminalRecord({
        terminalRecordRef,
        terminalRecordChecksum,
        terminalRecord,
      })).resolves.toMatchObject({ acknowledged: true, status: "persisted" });
      const legacyReceipt = await prisma.inboundEventReceipt.findUniqueOrThrow({
        where: {
          sourceService_sourceEventId: {
            sourceService: "gen_resolution",
            sourceEventId: adoptAttemptId,
          },
        },
      });
      await prisma.$transaction([
        prisma.inboundEventReceipt.update({
          where: { id: legacyReceipt.id },
          data: { sourceService: "gen" },
        }),
        prisma.generationJobEvent.update({
          where: { id: `generation_unknown_resolution_${adoptAttemptId}` },
          data: { type: "unknown_terminal_evidence_recovered" },
        }),
        prisma.generationAttempt.update({
          where: { id: adoptAttemptId },
          data: { terminalRecordRef },
        }),
        prisma.generationTransportExecution.update({
          where: {
            attemptId_transportAttemptNo: {
              attemptId: adoptAttemptId,
              transportAttemptNo: 1,
            },
          },
          data: { terminalRecordRef },
        }),
      ]);

      staleAttemptId = `unknown-adopt-stale-attempt-${suffix}`;
      const currentRecoveredEvent = await prisma.generationJobEvent.findUniqueOrThrow({
        where: { id: `generation_unknown_resolution_${adoptAttemptId}` },
      });
      const currentRecoveredMetadata = currentRecoveredEvent.metadata;
      if (
        !currentRecoveredMetadata ||
        typeof currentRecoveredMetadata !== "object" ||
        Array.isArray(currentRecoveredMetadata)
      ) {
        throw new Error("Recovered event metadata fixture must be an object");
      }
      const currentRecoveredSuccess = currentRecoveredMetadata.recoveredSuccess;
      if (
        !currentRecoveredSuccess ||
        typeof currentRecoveredSuccess !== "object" ||
        Array.isArray(currentRecoveredSuccess)
      ) {
        throw new Error("Recovered success fixture must be an object");
      }
      const staleTerminalRecordRef = `gen/terminal-records/${staleAttemptId}/terminal.json`;
      const staleTerminalRecordChecksum = "a".repeat(64);
      await prisma.generationJobEvent.create({
        data: {
          id: `generation_unknown_resolution_stale_${suffix}`,
          jobId: adoptRequestId,
          type: "unknown_terminal_evidence_recovered",
          message: "An older Attempt success arrived after the latest Attempt evidence",
          createdAt: new Date(Date.now() + 1_000),
          metadata: {
            ...currentRecoveredMetadata,
            attemptId: staleAttemptId,
            terminalRecordRef: staleTerminalRecordRef,
            terminalRecordChecksum: staleTerminalRecordChecksum,
            recoveredSuccess: {
              ...currentRecoveredSuccess,
              attemptId: staleAttemptId,
              attemptNo: 1,
              terminalRecordRef: staleTerminalRecordRef,
              terminalRecordChecksum: staleTerminalRecordChecksum,
            },
          },
        },
      });

      const detailBeforeAdoption = generationJobDetailResponseSchema.parse(
        (await (await getJobRoute(
          new Request(`http://localhost/api/v2/admin/jobs/${adoptRequestId}`, {
            headers: {
              "x-idream-user-id": actorId,
              "x-idream-role": "admin",
            },
          }),
          { params: Promise.resolve({ id: adoptRequestId }) },
        )).json()).data,
      );
      expect(detailBeforeAdoption.unknownTerminalEvidence).toMatchObject({
        attemptId: adoptAttemptId,
        terminalRecordRef,
        adoptable: true,
      });

      const bodyBase = {
        entityVersion: 1,
        reason: "Validated late terminal record contains the customer output.",
        providerEvidenceRefs: [`terminal-record:${terminalRecordRef}`],
      };
      const confirmResponse = await reconcileUnknownRoute(new Request(
        `http://localhost/api/v2/admin/jobs/${adoptRequestId}/commands/reconcile-unknown`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `unknown-adopt-wrong-failed-${suffix}`,
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
          },
          body: JSON.stringify({
            ...bodyBase,
            resolution: "confirm_failed",
            confirmation: `${adoptRequestId}:confirm_failed`,
          }),
        },
      ), { params: Promise.resolve({ id: adoptRequestId }) });
      expect(confirmResponse.status).toBe(409);
      await expect(prisma.generationJob.findUniqueOrThrow({
        where: { id: adoptRequestId },
      })).resolves.toMatchObject({ status: "running", version: 1 });

      const adoptResponse = await reconcileUnknownRoute(new Request(
        `http://localhost/api/v2/admin/jobs/${adoptRequestId}/commands/reconcile-unknown`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `unknown-adopt-${suffix}`,
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
          },
          body: JSON.stringify({
            ...bodyBase,
            resolution: "adopt_succeeded",
            confirmation: `${adoptRequestId}:adopt_succeeded`,
          }),
        },
      ), { params: Promise.resolve({ id: adoptRequestId }) });
      const adoptJson = await adoptResponse.json();
      expect(adoptResponse.status, JSON.stringify(adoptJson)).toBe(200);
      const adopted = unknownGenerationReconciliationResultSchema.parse(adoptJson.data);
      expect(adopted).toMatchObject({
        requestId: adoptRequestId,
        attemptId: adoptAttemptId,
        attemptStatus: "unknown",
        resolution: "adopt_succeeded",
        requestStatus: "completed",
        version: 3,
        refundAmount: 5,
        deliveredCount: 1,
        nextReviewAt: null,
      });
      await expect(prisma.generationJob.findUniqueOrThrow({
        where: { id: adoptRequestId },
      })).resolves.toMatchObject({
        status: "completed",
        version: 3,
        deliveredOutputCount: 1,
      });
      await expect(prisma.generationAttempt.findUniqueOrThrow({
        where: { id: adoptAttemptId },
      })).resolves.toMatchObject({ status: "unknown", terminalRecordRef });
      await expect(prisma.generationTransportExecution.findFirstOrThrow({
        where: { attemptId: adoptAttemptId },
      })).resolves.toMatchObject({ status: "unknown", terminalRecordRef });
      const asset = await prisma.mediaAsset.findFirstOrThrow({
        where: { sourceJobId: adoptRequestId },
      });
      expect(asset).toMatchObject({
        ownerId: adoptCustomerId,
        storageKey: terminalRecord.assets[0].key,
        providerAssetId: terminalRecord.assets[0].providerKey,
        safetyStatus: "passed",
      });
      expect(asset.sourcePromptHash).toMatch(/^prompt_/);
      await expect(prisma.generationArtifact.findFirstOrThrow({
        where: { attemptId: adoptAttemptId },
      })).resolves.toMatchObject({
        validationState: "valid",
        archiveState: "active",
        assetId: asset.id,
      });
      await expect(prisma.generationDelivery.findFirstOrThrow({
        where: { requestId: adoptRequestId },
      })).resolves.toMatchObject({ status: "delivered", deliveredAt: expect.any(Date) });
      await expect(prisma.dreamcoinLedger.findFirstOrThrow({
        where: { sourceId: adoptRequestId, reason: "refund" },
      })).resolves.toMatchObject({ delta: 5 });
      const adoptedList = await queryGenerationJobsV2Authority({
        db: prisma,
        query: generationJobQuerySchema.parse({ mode: "all", limit: 100 }),
      });
      expect(adoptedList.items.find((item) => item.id === adoptRequestId))
        .toMatchObject({
          requestOutcome: "partially_succeeded",
          unknownReview: { status: "not_applicable", nextReviewAt: null },
        });
      const remainAfterAdoption = await reconcileUnknownRoute(new Request(
        `http://localhost/api/v2/admin/jobs/${adoptRequestId}/commands/reconcile-unknown`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `unknown-adopt-remain-after-terminal-${suffix}`,
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
          },
          body: JSON.stringify({
            ...bodyBase,
            entityVersion: 3,
            resolution: "remain_unknown",
            nextReviewAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
            confirmation: `${adoptRequestId}:remain_unknown`,
          }),
        },
      ), { params: Promise.resolve({ id: adoptRequestId }) });
      expect(remainAfterAdoption.status).toBe(409);
      await expect(prisma.controlPlaneCommand.count({
        where: { targetId: adoptRequestId },
      })).resolves.toBe(1);
    } finally {
      if (adoptAttemptId) {
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
            sourceEventId: { startsWith: adoptAttemptId },
          },
        });
      }
      const commands = await prisma.controlPlaneCommand.findMany({
        where: { targetId: adoptRequestId },
        select: { id: true },
      });
      await prisma.controlPlaneCommandAttempt.deleteMany({
        where: { commandId: { in: commands.map((command) => command.id) } },
      });
      await prisma.adminAuditLog.deleteMany({ where: { targetId: adoptRequestId } });
      await prisma.controlPlaneCommand.deleteMany({ where: { targetId: adoptRequestId } });
      await prisma.mainOutboxEvent.deleteMany({
        where: {
          OR: [
            { aggregateId: adoptRequestId },
            ...(adoptAttemptId ? [{ aggregateId: adoptAttemptId }] : []),
            { id: `product_metric_generation-delivery_${adoptRequestId}_v2` },
          ],
        },
      });
      await prisma.analyticsEvent.deleteMany({
        where: {
          sourceService: "main",
          sourceEventId: `generation-delivery:${adoptRequestId}:v2`,
        },
      });
      await prisma.generationSettlementLink.deleteMany({
        where: { requestId: adoptRequestId },
      });
      await prisma.dreamcoinLedger.deleteMany({ where: { sourceId: adoptRequestId } });
      await prisma.generationDelivery.deleteMany({ where: { requestId: adoptRequestId } });
      await prisma.mediaAsset.deleteMany({ where: { sourceJobId: adoptRequestId } });
      const adoptAttemptIds = [adoptAttemptId, staleAttemptId].filter(
        (id): id is string => id !== null,
      );
      if (adoptAttemptIds.length > 0) {
        await prisma.generationArtifact.deleteMany({ where: { attemptId: { in: adoptAttemptIds } } });
        await prisma.generationTransportExecution.deleteMany({ where: { attemptId: { in: adoptAttemptIds } } });
        await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: { in: adoptAttemptIds } } });
        await prisma.generationAttempt.deleteMany({ where: { id: { in: adoptAttemptIds } } });
      }
      await prisma.generationJobEvent.deleteMany({ where: { jobId: adoptRequestId } });
      await prisma.generationJob.deleteMany({ where: { id: adoptRequestId } });
      await prisma.user.deleteMany({ where: { id: adoptCustomerId } });
    }
  });

  it("keeps an ACKed unknown terminal fact immutable while a separate provider resolution is adopted once", async () => {
    const explicitRequestId = `unknown-explicit-request-${suffix}`;
    const explicitCustomerId = `unknown-explicit-customer-${suffix}`;
    const explicitDispatchId = `unknown-explicit-dispatch-${suffix}`;
    let explicitAttemptId: string | null = null;
    try {
      await prisma.user.create({ data: {
        id: explicitCustomerId,
        email: `${explicitCustomerId}@example.test`,
        role: "user",
        status: "active",
      } });
      await prisma.generationJob.create({ data: {
        id: explicitRequestId,
        userId: explicitCustomerId,
        mode: "image",
        status: "queued",
        provider: "mock",
        model: "mock-image-v2",
        sourceType: "content_production_item",
        controls: {},
        presetIds: [],
        outputCount: 1,
        costDreamcoins: 9,
      } });
      const reservation = await prisma.$transaction((tx) =>
        reserveInitialGenerationAttempt(tx, {
          requestId: explicitRequestId,
          dispatch: {
            outboxId: explicitDispatchId,
            eventType: "generation.retry.dispatch.v2",
            payload: { source: "explicit_unknown_resolution_test" },
          },
        })
      );
      explicitAttemptId = reservation.attempt.id;
      const dispatchPayload = reservation.outbox.payload as Record<string, unknown>;
      const queueInput = dispatchPayload.queueInput as Record<string, unknown>;
      const queuePayload = queueInput.payload as Record<string, unknown>;
      const providerRequestId = `unknown-explicit-provider-${suffix}`;
      await prisma.generationJob.update({
        where: { id: explicitRequestId },
        data: { status: "running" },
      });
      const unknownRecord = generationTerminalRecordSchema.parse({
        version: 1,
        outcome: "unknown",
        attemptId: explicitAttemptId,
        attemptNo: 1,
        transportAttemptNo: 1,
        providerIdempotencyKey: `generation:${explicitAttemptId}:provider`,
        requestId: queuePayload.requestId,
        generationJobId: explicitRequestId,
        mode: "image",
        provider: queuePayload.provider,
        providerInvoked: true,
        model: queuePayload.model,
        providerRequestId,
        completedAt: new Date().toISOString(),
        usage: {},
        error: {
          code: "provider_outcome_unknown",
          message: "Provider accepted the request but could not yet resolve it",
          retryability: "operator_retry",
        },
      });
      const unknownRef = `gen/terminal-records/${explicitAttemptId}/unknown.json`;
      const unknownInput = {
        terminalRecordRef: unknownRef,
        terminalRecordChecksum: generationTerminalRecordChecksum(unknownRecord),
        terminalRecord: unknownRecord,
      };
      await expect(ingestGenerationTerminalRecord(unknownInput)).resolves.toMatchObject({
        acknowledged: true,
        status: "persisted",
      });
      await dispatchPendingGenerationTerminalRecords({
        outboxIds: [`generation_terminal_record_${explicitAttemptId}`],
      });
      await expect(drainLocalAiPipeline({
        limit: 1,
        queues: ["app.ai.finalize"],
      })).resolves.toMatchObject({ processed: 1 });
      await expect(prisma.generationJob.findUniqueOrThrow({
        where: { id: explicitRequestId },
      })).resolves.toMatchObject({ status: "running", version: 1 });
      const canonicalReceiptBefore = await prisma.inboundEventReceipt.findUniqueOrThrow({
        where: {
          sourceService_sourceEventId: {
            sourceService: "gen",
            sourceEventId: explicitAttemptId,
          },
        },
      });
      const successRecord = generationTerminalRecordSchema.parse({
        version: 1,
        outcome: "succeeded",
        attemptId: explicitAttemptId,
        attemptNo: 1,
        transportAttemptNo: 1,
        providerIdempotencyKey: `generation:${explicitAttemptId}:provider`,
        requestId: queuePayload.requestId,
        generationJobId: explicitRequestId,
        mode: "image",
        provider: queuePayload.provider,
        providerInvoked: true,
        model: queuePayload.model,
        providerRequestId,
        completedAt: new Date(Date.now() + 1_000).toISOString(),
        usage: { images: 1 },
        assets: [{
          ordinal: 0,
          key: `${queuePayload.outputPrefix as string}resolved.webp`,
          contentType: "image/webp",
          width: 832,
          height: 1024,
          providerKey: null,
        }],
      });
      if (successRecord.outcome !== "succeeded") {
        throw new Error("Unknown resolution fixture must be a success record");
      }
      const successInput = {
        terminalRecordRef: `gen/terminal-records/${explicitAttemptId}/resolved.json`,
        terminalRecordChecksum: generationTerminalRecordChecksum(successRecord),
        terminalRecord: successRecord,
      };
      const resolution = await ingestGenerationTerminalRecord(successInput);
      expect(resolution).toMatchObject({ acknowledged: true, status: "persisted" });
      await expect(ingestGenerationTerminalRecord(successInput)).resolves.toMatchObject({
        acknowledged: true,
        status: "duplicate",
        receiptId: resolution.receiptId,
      });
      const conflict = await ingestGenerationTerminalRecord({
        ...successInput,
        terminalRecordRef: `gen/terminal-records/${explicitAttemptId}/conflict.json`,
      });
      expect(conflict).toMatchObject({ acknowledged: false, status: "quarantined" });
      await expect(prisma.inboundEventReceipt.findUniqueOrThrow({
        where: {
          sourceService_sourceEventId: {
            sourceService: "gen",
            sourceEventId: explicitAttemptId,
          },
        },
      })).resolves.toMatchObject({
        id: canonicalReceiptBefore.id,
        payloadHash: canonicalReceiptBefore.payloadHash,
        processingState: "processed",
      });
      await expect(prisma.inboundEventReceipt.findUniqueOrThrow({
        where: {
          sourceService_sourceEventId: {
            sourceService: "gen_resolution",
            sourceEventId: explicitAttemptId,
          },
        },
      })).resolves.toMatchObject({
        id: resolution.receiptId,
        processingState: "processed",
      });
      await expect(prisma.inboundEventReceipt.findUniqueOrThrow({
        where: { id: conflict.receiptId! },
      })).resolves.toMatchObject({
        sourceService: "gen_resolution_quarantine",
        processingState: "quarantined",
      });
      await expect(prisma.generationAttempt.findUniqueOrThrow({
        where: { id: explicitAttemptId },
      })).resolves.toMatchObject({ status: "unknown", terminalRecordRef: unknownRef });
      await expect(prisma.generationTransportExecution.findFirstOrThrow({
        where: { attemptId: explicitAttemptId },
      })).resolves.toMatchObject({ status: "unknown", terminalRecordRef: unknownRef });

      const command = async (
        idempotencyKey: string,
        resolutionName: "confirm_failed" | "adopt_succeeded",
      ) => reconcileUnknownRoute(new Request(
        `http://localhost/api/v2/admin/jobs/${explicitRequestId}/commands/reconcile-unknown`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
          },
          body: JSON.stringify({
            resolution: resolutionName,
            entityVersion: 1,
            reason: "Provider supplied a validated append-only resolution record.",
            providerEvidenceRefs: [`terminal-record:${successInput.terminalRecordRef}`],
            confirmation: `${explicitRequestId}:${resolutionName}`,
          }),
        },
      ), { params: Promise.resolve({ id: explicitRequestId }) });
      await expect(command(
        `unknown-explicit-confirm-${suffix}`,
        "confirm_failed",
      )).resolves.toMatchObject({ status: 409 });
      const adoptResponse = await command(
        `unknown-explicit-adopt-${suffix}`,
        "adopt_succeeded",
      );
      const adoptJson = await adoptResponse.json();
      expect(adoptResponse.status, JSON.stringify(adoptJson)).toBe(200);
      const adopted = unknownGenerationReconciliationResultSchema.parse(adoptJson.data);
      expect(adopted).toMatchObject({
        resolution: "adopt_succeeded",
        requestStatus: "completed",
        version: 3,
        refundAmount: 0,
        deliveredCount: 1,
      });
      const replay = await command(
        `unknown-explicit-adopt-${suffix}`,
        "adopt_succeeded",
      );
      expect(await replay.json()).toMatchObject({ data: adopted });
      await expect(prisma.mediaAsset.count({ where: { sourceJobId: explicitRequestId } }))
        .resolves.toBe(1);
      const asset = await prisma.mediaAsset.findFirstOrThrow({
        where: { sourceJobId: explicitRequestId },
      });
      expect(asset.providerAssetId).toBe(successRecord.assets[0].key);
      await expect(prisma.generationDelivery.count({
        where: { requestId: explicitRequestId, status: "delivered" },
      })).resolves.toBe(1);
      await expect(prisma.dreamcoinLedger.count({
        where: { sourceId: explicitRequestId, reason: "refund" },
      })).resolves.toBe(0);
    } finally {
      await jobQueue.removeByDedupeKey(
        "app.ai.finalize",
        `generation-terminal-record-finalize:${explicitAttemptId ?? "missing"}`,
      );
      if (explicitAttemptId) {
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
            sourceEventId: { startsWith: explicitAttemptId },
          },
        });
      }
      const commands = await prisma.controlPlaneCommand.findMany({
        where: { targetId: explicitRequestId },
        select: { id: true },
      });
      await prisma.controlPlaneCommandAttempt.deleteMany({
        where: { commandId: { in: commands.map((row) => row.id) } },
      });
      await prisma.adminAuditLog.deleteMany({ where: { targetId: explicitRequestId } });
      await prisma.controlPlaneCommand.deleteMany({ where: { targetId: explicitRequestId } });
      await prisma.mainOutboxEvent.deleteMany({
        where: {
          OR: [
            { aggregateId: explicitRequestId },
            ...(explicitAttemptId ? [{ aggregateId: explicitAttemptId }] : []),
            { id: `product_metric_generation-delivery_${explicitRequestId}_v2` },
          ],
        },
      });
      await prisma.analyticsEvent.deleteMany({
        where: {
          sourceService: "main",
          sourceEventId: `generation-delivery:${explicitRequestId}:v2`,
        },
      });
      await prisma.moderationEvent.deleteMany({ where: { targetId: explicitRequestId } });
      await prisma.generationSettlementLink.deleteMany({
        where: { requestId: explicitRequestId },
      });
      await prisma.dreamcoinLedger.deleteMany({ where: { sourceId: explicitRequestId } });
      await prisma.generationDelivery.deleteMany({ where: { requestId: explicitRequestId } });
      await prisma.mediaAsset.deleteMany({ where: { sourceJobId: explicitRequestId } });
      if (explicitAttemptId) {
        await prisma.generationArtifact.deleteMany({ where: { attemptId: explicitAttemptId } });
        await prisma.aiUsageFact.deleteMany({ where: { attemptId: explicitAttemptId } });
        await prisma.generationTransportExecution.deleteMany({ where: { attemptId: explicitAttemptId } });
        await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: explicitAttemptId } });
        await prisma.generationAttempt.deleteMany({ where: { id: explicitAttemptId } });
      }
      await prisma.generationJobEvent.deleteMany({ where: { jobId: explicitRequestId } });
      await prisma.generationJob.deleteMany({ where: { id: explicitRequestId } });
      await prisma.user.deleteMany({ where: { id: explicitCustomerId } });
    }
  });
});
