import { afterAll, describe, expect, it } from "vitest";
import { generationTerminalFinalizeDedupeKey, generationTerminalRecordChecksum, idempotencyKeys, MAIN_QUEUES } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { dispatchGenerationAttemptOutbox, reserveInitialGenerationAttempt } from "@/server/modules/generation/generation-attempt-authority";
import { generationJobDTO, generationJobInclude } from "@/server/modules/ourdream/generation-job-read-model";
import { dispatchPendingGenerationTerminalRecords, ingestGenerationTerminalRecord } from "./generation-terminal-record-ingest";
import { drainLocalAiPipeline, reconcileStaleGenerationJobs } from "./local-pipeline";

const requests: string[] = [];
const attempts: string[] = [];
afterAll(async () => {
  for (const id of requests) {
    await jobQueue.removeByDedupeKey("ai.image.generate", idempotencyKeys.generationAttempt(id, 1));
  }
  for (const attemptId of attempts) await jobQueue.removeByDedupeKey(MAIN_QUEUES.aiFinalize, generationTerminalFinalizeDedupeKey(attemptId));
  await prisma.$disconnect();
});

async function reserveChargedRequest() {
  const id = `preparation-${crypto.randomUUID()}`;
  requests.push(id);
  const user = await prisma.user.create({ data: { id: `${id}-user`, email: `${id}@test.invalid` } });
  const job = await prisma.generationJob.create({ data: {
    id, userId: user.id, mode: "image", prompt: "A test portrait", controls: {}, presetIds: [],
    provider: "mock", model: "mock-image", outputCount: 1, costDreamcoins: 5,
  } });
  const reservation = await prisma.$transaction(async (tx) => {
    await postDreamcoinEntry(tx, { kind: "signup_bonus", userId: user.id, amount: 20, sourceId: `${id}-bonus`, idempotencyKey: `${id}:bonus` });
    await postDreamcoinEntry(tx, { kind: "generation_spend", userId: user.id, amount: 5, sourceId: id, idempotencyKey: `${id}:spend` });
    return reserveInitialGenerationAttempt(tx, {
      requestId: id,
      dispatch: { eventType: "generation.retry.dispatch.v2", outboxId: `generation_initial_${id}` },
    });
  });
  attempts.push(reservation.attempt.id);
  return { job, user, ...reservation };
}

describe("generation preparation failure recovery", () => {
  it("finalizes a reserved non-invoked preparation failure and refunds exactly once without provider facts", async () => {
    const { job, user, attempt } = await reserveChargedRequest();
    const terminalRecord = {
      version: 1 as const, attemptId: attempt.id, attemptNo: 1, transportAttemptNo: 3,
      providerIdempotencyKey: `generation:${attempt.id}:provider`,
      requestId: `generation_dispatch_${attempt.id}`, generationJobId: job.id,
      mode: "image" as const, provider: "mock", model: "mock-image", providerInvoked: false,
      providerRequestId: null, completedAt: new Date().toISOString(), usage: {},
      outcome: "failed" as const,
      error: { code: "preparation_failed", message: "Input references could not be prepared", retryability: "retryable" as const },
    };
    const input = { terminalRecord, terminalRecordRef: `gen/terminal-records/${attempt.id}/terminal.json`, terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord) };
    await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({ acknowledged: true, status: "persisted" });
    await expect(ingestGenerationTerminalRecord(input)).resolves.toMatchObject({ acknowledged: true, status: "duplicate" });
    await dispatchPendingGenerationTerminalRecords();
    await drainLocalAiPipeline();
    await ingestGenerationTerminalRecord(input);
    await dispatchPendingGenerationTerminalRecords();
    await drainLocalAiPipeline();
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "failed", errorCode: "preparation_failed" });
    expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: "failed", errorCode: "preparation_failed" });
    expect(await prisma.dreamcoinLedger.findMany({ where: { userId: user.id, sourceId: job.id }, orderBy: { createdAt: "asc" }, select: { reason: true, delta: true } })).toEqual([
      { reason: "generation_spend", delta: -5 }, { reason: "refund", delta: 5 },
    ]);
    expect(await prisma.generationTransportExecution.count({ where: { attemptId: attempt.id } })).toBe(0);
    expect(await prisma.aiUsageFact.count({ where: { attemptId: attempt.id } })).toBe(0);
    expect(await prisma.generationArtifact.count({ where: { attemptId: attempt.id } })).toBe(0);
    expect(await prisma.generationDelivery.count({ where: { requestId: job.id } })).toBe(0);
  });

  it("quarantines an exhausted exact source without terminal evidence instead of resetting its budget or refunding", async () => {
    const { job, attempt, outbox } = await reserveChargedRequest();
    await dispatchGenerationAttemptOutbox(prisma, { outboxIds: [outbox.id] });
    // The real Bull row is exhausted by a worker failure. No provider fact is
    // invented from the error message, which could follow an ambiguous call.
    await jobQueue.processNext({ queue: "ai.image.generate", workerId: `preparation-${job.id}`, processor: async () => { throw new Error("Unrecoverable fixture transport"); } });
    const source = await jobQueue.getByDedupeKey("ai.image.generate", idempotencyKeys.generationAttempt(job.id, 1));
    expect(source).not.toBeNull();
    const { Queue } = await import("bullmq");
    const { env } = await import("@/server/lib/env");
    const { redisConnectionOptions } = await import("@idream/shared/env");
    const queue = new Queue("ai.image.generate", { connection: redisConnectionOptions(env.REDIS_URL), prefix: env.BULLMQ_PREFIX });
    try {
      const row = await queue.getJob(source!.id);
      await row!.changeDelay(0);
      for (let index = 0; index < 2; index += 1) {
        await jobQueue.processNext({ queue: "ai.image.generate", workerId: `preparation-${job.id}-${index}`, processor: async () => { throw new Error("Unrecoverable fixture transport"); } });
        if (index === 0) await row!.changeDelay(0);
      }
      expect(await row!.getState()).toBe("failed");
      const failed = await jobQueue.getByDedupeKey("ai.image.generate", idempotencyKeys.generationAttempt(job.id, 1));
      expect(failed).toMatchObject({ state: "failed", attemptsMade: 3, maxAttempts: 3 });
      const now = new Date(Date.now() + 60_000);
      await expect(reconcileStaleGenerationJobs({ generationJobIds: [job.id], now, timeoutMs: 1, videoTimeoutMs: 1 })).resolves.toMatchObject({ enqueued: 0, quarantined: 1 });
      await expect(reconcileStaleGenerationJobs({ generationJobIds: [job.id], now: new Date(now.getTime() + 60_000), timeoutMs: 1, videoTimeoutMs: 1 })).resolves.toMatchObject({ enqueued: 0, quarantined: 0 });
      expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: "unknown", retryability: "operator_retry" });
      const current = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id }, include: generationJobInclude() });
      expect(generationJobDTO(current, "unknown")).toMatchObject({ status: "queued", errorCode: "provider_outcome_unknown" });
      expect(await jobQueue.getByDedupeKey("ai.image.generate", idempotencyKeys.generationAttempt(job.id, 1))).toMatchObject({ state: "failed", attemptsMade: 3 });
      expect(await prisma.generationJobEvent.count({ where: { jobId: job.id, type: "provider_outcome_unknown" } })).toBe(1);
      expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: attempt.id, eventType: "generation.incident.correlate.v2" } })).toBe(1);
      expect(await prisma.dreamcoinLedger.count({ where: { sourceId: job.id, reason: "refund" } })).toBe(0);
      expect(await prisma.generationTransportExecution.count({ where: { attemptId: attempt.id } })).toBe(0);
    } finally { await queue.close(); }
  });
});
