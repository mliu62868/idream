import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { recordGenerationTransportExecution } from "./generation-transport-execution";

describe("Generation TransportExecution authority", () => {
  const suffix = randomUUID();
  const attemptId = `transport-attempt-${suffix}`;
  const generationJobId = `transport-job-${suffix}`;
  const userId = `transport-user-${suffix}`;
  const base = {
    version: 1 as const,
    attemptId,
    attemptNo: 1,
    generationJobId,
    transportAttemptNo: 1,
    provider: "pipeline-image",
    model: "flux-pro",
    providerRequestId: null,
    idempotencyKey: `generation:${attemptId}:provider`,
    occurredAt: "2026-07-11T12:00:00.000Z",
  };

  beforeAll(async () => {
    await prisma.user.create({ data: {
      id: userId,
      email: `${userId}@example.test`,
      status: "active",
    } });
    await prisma.generationJob.create({ data: {
      id: generationJobId,
      userId,
      mode: "image",
      status: "running",
      provider: base.provider,
      model: base.model,
      controls: {},
      presetIds: [],
      outputCount: 1,
    } });
    await prisma.generationAttempt.create({
      data: {
        id: attemptId,
        requestId: generationJobId,
        attemptNo: 1,
        provider: base.provider,
        workflowKey: base.model,
        workflowVersion: 1,
        status: "queued",
      },
    });
    await createDispatchAuthority(attemptId, 1);
  });

  afterAll(async () => {
    await prisma.aiUsageFact.deleteMany({ where: { attemptId } });
    await prisma.generationTransportExecution.deleteMany({ where: { attemptId } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
    await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: generationJobId },
    });
    await prisma.generationJob.deleteMany({ where: { id: generationJobId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("records one provider invocation and idempotently closes its failure", async () => {
    await expect(recordGenerationTransportExecution({ ...base, status: "running", error: null })).resolves.toMatchObject({ status: "persisted" });
    await expect(recordGenerationTransportExecution({ ...base, status: "running", error: null })).resolves.toMatchObject({ status: "duplicate" });
    await expect(recordGenerationTransportExecution({
      ...base,
      provider: "different-provider",
      status: "running",
      error: null,
    })).rejects.toThrow("exact dispatch authority");
    await expect(recordGenerationTransportExecution({
      ...base,
      idempotencyKey: "different-idempotency-key",
      status: "running",
      error: null,
    })).rejects.toThrow("exact dispatch authority");
    await expect(recordGenerationTransportExecution({
      ...base,
      status: "failed",
      occurredAt: "2026-07-11T12:00:02.000Z",
      error: { code: "rate_limited", message: "capacity exhausted" },
      accounting: { usage: { images: 0 }, latencyMs: 2000, costMicros: 50_000, pricingVersion: "pipeline-v1" },
    })).resolves.toMatchObject({ status: "persisted" });
    await expect(prisma.generationTransportExecution.findUnique({ where: { attemptId_transportAttemptNo: { attemptId, transportAttemptNo: 1 } } })).resolves.toMatchObject({
      status: "failed",
      idempotencyKey: base.idempotencyKey,
      latencyMs: 2000,
      costMicros: BigInt(50_000),
      pricingVersion: "pipeline-v1",
    });
    await expect(prisma.generationAttemptEvent.count({ where: { attemptId } })).resolves.toBe(2);
    await expect(recordGenerationTransportExecution({ ...base, status: "unknown", occurredAt: "2026-07-11T12:00:03.000Z", error: { code: "timeout", message: "outcome unknown" } })).rejects.toThrow("already terminal");

    const retry = { ...base, transportAttemptNo: 2, occurredAt: "2026-07-11T12:00:04.000Z" };
    await recordGenerationTransportExecution({ ...retry, status: "running", error: null });
    await recordGenerationTransportExecution({
      ...retry,
      status: "failed",
      occurredAt: "2026-07-11T12:00:05.000Z",
      error: { code: "overloaded", message: "provider overloaded" },
      accounting: { usage: { images: 0 }, latencyMs: 1000, costMicros: 75_000, pricingVersion: "pipeline-v1" },
    });
    const unpriced = { ...base, transportAttemptNo: 3, occurredAt: "2026-07-11T12:00:06.000Z" };
    await recordGenerationTransportExecution({ ...unpriced, status: "running", error: null });
    await recordGenerationTransportExecution({
      ...unpriced,
      status: "unknown",
      occurredAt: "2026-07-11T12:00:07.000Z",
      error: { code: "timeout", message: "provider outcome unknown" },
      accounting: { usage: {}, latencyMs: 1000, costMicros: null, pricingVersion: null },
    });

    const facts = await prisma.aiUsageFact.findMany({ where: { attemptId }, orderBy: { sourceEventId: "asc" } });
    expect(facts).toHaveLength(3);
    expect(facts.reduce((total, fact) => total + (fact.costMicros ?? BigInt(0)), BigInt(0))).toBe(BigInt(125_000));
    expect(facts.map((fact) => fact.costMicros)).toEqual([BigInt(50_000), BigInt(75_000), null]);

    const pinnedProviderRequest = {
      ...base,
      transportAttemptNo: 4,
      providerRequestId: "provider-request-4",
      occurredAt: "2026-07-11T12:00:08.000Z",
    };
    await recordGenerationTransportExecution({
      ...pinnedProviderRequest,
      status: "running",
      error: null,
    });
    await expect(recordGenerationTransportExecution({
      ...pinnedProviderRequest,
      providerRequestId: null,
      status: "failed",
      occurredAt: "2026-07-11T12:00:09.000Z",
      error: { code: "timeout", message: "provider request identity lost" },
    })).rejects.toThrow("identity changed");

    const concurrent = {
      ...base,
      transportAttemptNo: 5,
      occurredAt: "2026-07-11T12:00:10.000Z",
    };
    await recordGenerationTransportExecution({
      ...concurrent,
      status: "running",
      error: null,
    });
    const terminalRace = await Promise.allSettled([
      recordGenerationTransportExecution({
        ...concurrent,
        status: "failed",
        occurredAt: "2026-07-11T12:00:11.000Z",
        error: { code: "failed", message: "provider failed" },
      }),
      recordGenerationTransportExecution({
        ...concurrent,
        status: "unknown",
        occurredAt: "2026-07-11T12:00:11.000Z",
        error: { code: "unknown", message: "provider outcome unknown" },
      }),
    ]);
    expect(terminalRace.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    await expect(prisma.generationTransportExecution.findUniqueOrThrow({
      where: {
        attemptId_transportAttemptNo: { attemptId, transportAttemptNo: 5 },
      },
    })).resolves.toMatchObject({ status: expect.stringMatching(/^(failed|unknown)$/) });
  });

  it("makes a terminal-record persistence failure an operator-reconciled unknown Attempt", async () => {
    const terminalFailureAttemptId = `transport-terminal-failure-${suffix}`;
    await prisma.generationAttempt.create({
      data: {
        id: terminalFailureAttemptId,
        requestId: generationJobId,
        attemptNo: 2,
        provider: base.provider,
        workflowKey: base.model,
        workflowVersion: 1,
        status: "running",
      },
    });
    await createDispatchAuthority(terminalFailureAttemptId, 2);
    const input = {
      ...base,
      attemptId: terminalFailureAttemptId,
      attemptNo: 2,
      idempotencyKey: `generation:${terminalFailureAttemptId}:provider`,
      status: "unknown" as const,
      occurredAt: "2026-07-11T12:01:00.000Z",
      error: {
        code: "terminal_record_persist_failed",
        message: "Provider completed but terminal evidence could not be persisted",
      },
      accounting: {
        usage: { images: 1 },
        latencyMs: 60_000,
        costMicros: null,
        pricingVersion: null,
      },
    };

    try {
      await expect(recordGenerationTransportExecution(input)).resolves.toMatchObject({
        acknowledged: true,
        status: "persisted",
      });
      await expect(prisma.generationAttempt.findUniqueOrThrow({
        where: { id: terminalFailureAttemptId },
      })).resolves.toMatchObject({
        status: "unknown",
        errorClass: "durable_terminal_evidence_persistence",
        errorCode: "terminal_record_persist_failed",
        retryability: "operator_retry",
        finishedAt: expect.any(Date),
      });
      await expect(prisma.generationAttemptEvent.findUniqueOrThrow({
        where: { id: `${terminalFailureAttemptId}:terminal-record-persistence-unknown` },
      })).resolves.toMatchObject({
        outcome: "unknown",
        terminalScope: "terminal",
      });
    } finally {
      await prisma.mainOutboxEvent.deleteMany({
        where: { aggregateId: terminalFailureAttemptId },
      });
      await prisma.aiUsageFact.deleteMany({ where: { attemptId: terminalFailureAttemptId } });
      await prisma.generationTransportExecution.deleteMany({
        where: { attemptId: terminalFailureAttemptId },
      });
      await prisma.generationAttemptEvent.deleteMany({
        where: { attemptId: terminalFailureAttemptId },
      });
      await prisma.generationAttempt.deleteMany({
        where: { id: terminalFailureAttemptId },
      });
    }
  });

  it("rejects the pre-provider running handshake after cancellation revokes dispatch authority", async () => {
    const cancelledJobId = `transport-cancelled-job-${suffix}`;
    const cancelledAttemptId = `transport-cancelled-attempt-${suffix}`;
    await prisma.generationJob.create({
      data: {
        id: cancelledJobId,
        userId,
        mode: "image",
        status: "cancelled",
        provider: base.provider,
        model: base.model,
        controls: {},
        presetIds: [],
        outputCount: 1,
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: cancelledAttemptId,
        requestId: cancelledJobId,
        attemptNo: 1,
        provider: base.provider,
        workflowKey: base.model,
        workflowVersion: 1,
        status: "cancelled",
        finishedAt: new Date(base.occurredAt),
      },
    });
    await createDispatchAuthority(cancelledAttemptId, 1, cancelledJobId);
    await prisma.mainOutboxEvent.update({
      where: { id: `transport-dispatch-${cancelledAttemptId}` },
      data: { status: "cancelled" },
    });

    try {
      await expect(recordGenerationTransportExecution({
        ...base,
        generationJobId: cancelledJobId,
        attemptId: cancelledAttemptId,
        idempotencyKey: `generation:${cancelledAttemptId}:provider`,
        status: "running",
        error: null,
      })).rejects.toThrow("after dispatch authority was revoked");
      await expect(prisma.generationTransportExecution.count({
        where: { attemptId: cancelledAttemptId },
      })).resolves.toBe(0);
    } finally {
      await prisma.mainOutboxEvent.deleteMany({
        where: { aggregateId: cancelledJobId },
      });
      await prisma.generationAttempt.deleteMany({
        where: { id: cancelledAttemptId },
      });
      await prisma.generationJob.deleteMany({ where: { id: cancelledJobId } });
    }
  });

  async function createDispatchAuthority(
    reservedAttemptId: string,
    attemptNo: number,
    requestId = generationJobId,
  ) {
    await prisma.mainOutboxEvent.create({ data: {
      id: `transport-dispatch-${reservedAttemptId}`,
      eventType: "generation.retry.dispatch.v2",
      aggregateType: "generation_request",
      aggregateId: requestId,
      payload: {
        generationJobId: requestId,
        attemptId: reservedAttemptId,
        attemptNo,
        queueInput: {
          queue: "ai.image.generate",
          dedupeKey: `generation:${requestId}:attempt:${attemptNo}`,
          maxAttempts: 5,
          // Must stay shape-complete: dispatch authority accepts only an
          // envelope the real queue-input writer could have produced.
          payload: {
            version: 1,
            kind: "image",
            requestId: `generation_dispatch_${reservedAttemptId}`,
            generationJobId: requestId,
            attemptId: reservedAttemptId,
            attemptNo,
            provider: base.provider,
            model: base.model,
            controls: { workflowKey: base.model, workflowVersion: 1 },
            userId,
            characterId: null,
            prompt: "transport authority test",
            negativePrompt: null,
            presetIds: [],
            orientation: "portrait",
            count: 1,
            seed: requestId,
            outputPrefix:
              `gen/${requestId}/attempts/${reservedAttemptId}/`,
          },
        },
      },
    } });
  }
});
