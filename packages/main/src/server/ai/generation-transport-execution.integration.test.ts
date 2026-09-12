import { randomUUID } from "node:crypto";
import { UnrecoverableError, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { dispatchGenerationAttemptOutbox } from "@/server/modules/generation/generation-attempt-authority";
import { reconcileStaleGenerationJobs } from "./local-pipeline";
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


  it("records durable resource liveness without starting provider time, then forbids phase regression", async () => {
    const wait = { ...base, status: "waiting", error: null, occurredAt: "2026-07-11T11:00:00.000Z" };
    await expect(recordGenerationTransportExecution(wait)).resolves.toMatchObject({ acknowledged: true, status: "persisted" });
    await expect(recordGenerationTransportExecution(wait)).resolves.toMatchObject({ status: "duplicate" });
    await recordGenerationTransportExecution({ ...wait, occurredAt: "2026-07-11T11:30:00.000Z" });
    await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).resolves.toMatchObject({ status: "queued", startedAt: null });
    await expect(prisma.generationTransportExecution.count({ where: { attemptId } })).resolves.toBe(0);
    await expect(prisma.aiUsageFact.count({ where: { attemptId } })).resolves.toBe(0);
    await expect(prisma.generationAttemptEvent.count({ where: { attemptId, eventType: "generation.resource.waiting.v1" } })).resolves.toBe(2);
    await expect(recordGenerationTransportExecution({ ...wait, provider: "wrong-provider" })).rejects.toThrow("exact dispatch authority");
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
    await expect(prisma.generationAttemptEvent.count({ where: { attemptId, eventType: { not: "generation.resource.waiting.v1" } } })).resolves.toBe(2);
    await expect(recordGenerationTransportExecution({ ...base, status: "unknown", occurredAt: "2026-07-11T12:00:03.000Z", error: { code: "timeout", message: "outcome unknown" } })).rejects.toThrow("already terminal");

    await expect(recordGenerationTransportExecution({ ...base, status: "waiting", error: null })).rejects.toThrow("Resource waiting cannot follow provider entry");
    await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).resolves.toMatchObject({ startedAt: new Date(base.occurredAt) });
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
    expect(facts.every(fact => fact.userId === userId && fact.dataClass === "fixture" && fact.actorIsInternal && fact.environment === "test")).toBe(true);
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
      await expect(recordGenerationTransportExecution({
        ...base, generationJobId: cancelledJobId, attemptId: cancelledAttemptId,
        idempotencyKey: `generation:${cancelledAttemptId}:provider`, status: "waiting", error: null,
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


  it("keeps a waiting worker live but still quarantines an expired provider execution", async () => {
    const waitingAttemptId = `transport-waiting-${suffix}`;
    const old = new Date("2026-01-01T00:00:00.000Z");
    const waitingAt = "2030-01-01T12:00:00.000Z";
    await prisma.generationAttempt.create({ data: { id: waitingAttemptId, requestId: generationJobId, attemptNo: 6, status: "queued", provider: base.provider, workflowKey: base.model, workflowVersion: 1, createdAt: old } });
    await prisma.generationJob.update({ where: { id: generationJobId }, data: { updatedAt: old } });
    await createDispatchAuthority(waitingAttemptId, 6);
    await prisma.mainOutboxEvent.update({ where: { id: `transport-dispatch-${waitingAttemptId}` }, data: { createdAt: old, updatedAt: old, nextRunAt: old } });
    const input = { ...base, attemptId: waitingAttemptId, attemptNo: 6, idempotencyKey: `generation:${waitingAttemptId}:provider`, occurredAt: waitingAt, error: null };
    try {
      await recordGenerationTransportExecution({ ...input, status: "waiting" });
      await expect(reconcileStaleGenerationJobs({ now: new Date("2030-01-01T12:00:30.000Z"), timeoutMs: 60_000, generationJobIds: [generationJobId] })).resolves.toMatchObject({ quarantined: 0 });
      await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: waitingAttemptId } })).resolves.toMatchObject({ status: "queued", startedAt: null });
      await recordGenerationTransportExecution({ ...input, occurredAt: "2030-01-01T12:01:00.000Z", status: "running" });
      await expect(reconcileStaleGenerationJobs({ now: new Date("2030-01-01T12:03:00.000Z"), timeoutMs: 60_000, generationJobIds: [generationJobId] })).resolves.toMatchObject({ quarantined: 1 });
      await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: waitingAttemptId } })).resolves.toMatchObject({ status: "unknown", startedAt: new Date("2030-01-01T12:01:00.000Z") });
      await expect(recordGenerationTransportExecution({ ...input, status: "waiting" })).rejects.toThrow("after dispatch authority was revoked");
    } finally {
      await prisma.aiUsageFact.deleteMany({ where: { attemptId: waitingAttemptId } });
      await prisma.generationTransportExecution.deleteMany({ where: { attemptId: waitingAttemptId } });
      await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: waitingAttemptId } });
      await prisma.generationAttempt.deleteMany({ where: { id: waitingAttemptId } });
      await prisma.mainOutboxEvent.deleteMany({ where: { id: `transport-dispatch-${waitingAttemptId}` } });
    }
  });

  it("replaces a failed source that never reached the provider once, then settles a repeated failure as exhausted", async () => {
    const jobId = `transport-failed-source-job-${suffix}`;
    const sourceAttemptId = `transport-failed-source-${suffix}`;
    const dedupeKey = `generation:${jobId}:attempt:1`;
    // Scan with a clock past the image stale timeout of every real write below.
    const scanAt = () => new Date(Date.now() + 60 * 60_000);
    await prisma.generationJob.create({ data: { id: jobId, userId, mode: "image", status: "queued", provider: base.provider, model: base.model, controls: {}, presetIds: [], outputCount: 1 } });
    await prisma.generationAttempt.create({ data: { id: sourceAttemptId, requestId: jobId, attemptNo: 1, provider: base.provider, workflowKey: base.model, workflowVersion: 1, status: "queued" } });
    await createDispatchAuthority(sourceAttemptId, 1, jobId);
    // BullMQ fails a job that stalled past its limit without a retry or a Gen terminal record.
    const failSourceLikeStall = async () => {
      const source = await jobQueue.getByDedupeKey("ai.image.generate", dedupeKey);
      const worker = new Worker("ai.image.generate", null, { autorun: false, connection: workerConnection(), prefix: env.BULLMQ_PREFIX });
      worker.on("error", () => undefined);
      const token = `stalled-${randomUUID()}`;
      try {
        const claimed = await worker.getNextJob(token, { block: false });
        expect(claimed?.id).toBe(source?.id);
        await claimed!.moveToFailed(new UnrecoverableError("job stalled more than allowable limit"), token, false);
      } finally {
        await worker.close(true);
      }
      await expect(jobQueue.getByDedupeKey("ai.image.generate", dedupeKey)).resolves.toMatchObject({ state: "failed", attemptsMade: 1 });
    };
    try {
      await expect(dispatchGenerationAttemptOutbox(prisma, { outboxIds: [`transport-dispatch-${sourceAttemptId}`], limit: 1 })).resolves.toMatchObject({ delivered: 1 });
      await failSourceLikeStall();

      await expect(reconcileStaleGenerationJobs({ now: scanAt(), timeoutMs: 60_000, generationJobIds: [jobId] })).resolves.toMatchObject({ enqueued: 1, quarantined: 0 });
      await expect(jobQueue.getByDedupeKey("ai.image.generate", dedupeKey)).resolves.toMatchObject({ state: "waiting" });
      await expect(prisma.generationJobEvent.count({ where: { jobId, type: "failed_source_replaced" } })).resolves.toBe(1);
      await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: sourceAttemptId } })).resolves.toMatchObject({ status: "queued" });

      await failSourceLikeStall();
      await expect(reconcileStaleGenerationJobs({ now: scanAt(), timeoutMs: 60_000, generationJobIds: [jobId] })).resolves.toMatchObject({ enqueued: 0, quarantined: 1 });
      await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: sourceAttemptId } })).resolves.toMatchObject({ status: "unknown", errorCode: "generation_source_exhausted" });
      await expect(jobQueue.getByDedupeKey("ai.image.generate", dedupeKey)).resolves.toMatchObject({ state: "failed" });
      await expect(prisma.generationJobEvent.count({ where: { jobId, type: "failed_source_replaced" } })).resolves.toBe(1);
    } finally {
      await jobQueue.removeByDedupeKey("ai.image.generate", dedupeKey);
      await prisma.aiUsageFact.deleteMany({ where: { attemptId: sourceAttemptId } });
      await prisma.generationJobEvent.deleteMany({ where: { jobId } });
      await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: sourceAttemptId } });
      await prisma.generationAttempt.deleteMany({ where: { id: sourceAttemptId } });
      await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: jobId } });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
    }
  });

  function workerConnection() {
    const url = new URL(env.REDIS_URL);
    return {
      host: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : 6379,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: url.pathname && url.pathname !== "/" ? Number.parseInt(url.pathname.slice(1), 10) : 0,
      maxRetriesPerRequest: null,
    };
  }

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
