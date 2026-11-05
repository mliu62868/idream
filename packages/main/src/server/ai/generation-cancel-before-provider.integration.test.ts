import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { GENERATION_TRANSPORT_AUTHORITY_REVOKED_REASON, generationProviderIdempotencyKey } from "@idream/shared/contracts";
import { POST as transportRoute } from "@/app/api/internal/generation/transports/route";
import { GET as snapshotRoute } from "@/app/api/internal/generation/source-snapshot/route";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { dispatchGenerationAttemptOutbox, reserveInitialGenerationAttempt } from "@/server/modules/generation/generation-attempt-authority";
import { api, createUser, dreamcoinBalance, expectError, expectOk, grantCoins } from "@/server/test/helpers";
import { recordGenerationTransportExecution } from "./generation-transport-execution";

const COST = 7;
const created: Array<{ jobId: string; attemptId: string; userId: string; dedupeKey: string }> = [];

// A real dispatch: attempts=1 and a real Bull row, the state every accepted request is
// in by the time its POST returns, and the one the old guard could never cancel from.
async function acceptedRequest(options: { sourceType?: string; dispatch?: boolean } = {}) {
  const id = randomUUID();
  const userId = `cancel-entry-user-${id}`, jobId = `cancel-entry-job-${id}`;
  const outboxId = `generation_initial_${jobId}`;
  const dedupeKey = `generation:${jobId}:attempt:1`;
  await createUser({ id: userId });
  await grantCoins(userId, 100);
  await prisma.generationJob.create({ data: { id: jobId, userId, mode: "image", model: "mock-image-v1", controls: {}, presetIds: [], outputCount: 1, costDreamcoins: COST, status: "queued", provider: "mock", sourceType: options.sourceType ?? "generator" } });
  await prisma.dreamcoinLedger.create({ data: { userId, delta: -COST, balanceAfter: 100 - COST, reason: "generation_spend", sourceId: jobId, idempotencyKey: `cancel-entry-spend-${id}` } });
  const { attempt } = await prisma.$transaction(tx => reserveInitialGenerationAttempt(tx, {
    requestId: jobId, dispatch: { outboxId, eventType: "generation.retry.dispatch.v2" },
  }));
  const attemptId = attempt.id;
  created.push({ jobId, attemptId, userId, dedupeKey });
  if (options.dispatch !== false) {
    await expect(dispatchGenerationAttemptOutbox(prisma, { outboxIds: [outboxId] })).resolves.toMatchObject({ delivered: 1 });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).resolves.toMatchObject({ status: "delivered", attempts: 1 });
  }
  const outbox = await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outboxId } });
  const model = ((outbox.payload as { queueInput: { payload: { model: string } } }).queueInput.payload.model);
  const event = (status: "waiting" | "running", occurredAt = new Date().toISOString()) => ({
    version: 1 as const, attemptId, attemptNo: 1, generationJobId: jobId, transportAttemptNo: 1,
    provider: "mock", model, providerRequestId: null, idempotencyKey: generationProviderIdempotencyKey(attemptId),
    status, occurredAt, error: null,
  });
  return { userId, jobId, attemptId, dedupeKey, event };
}

const cancel = (request: { jobId: string; userId: string }) =>
  api("POST", `generation/jobs/${request.jobId}/cancel`, { userId: request.userId, ageGate: true });
const readJob = async (request: { jobId: string; userId: string }) => {
  const response = await api("GET", `generation/jobs/${request.jobId}`, { userId: request.userId, ageGate: true });
  expectOk(response);
  return response.data.job as { status: string; canCancel: boolean; queueAhead: number | null };
};

async function expectCancelledOnce(request: { jobId: string; attemptId: string; userId: string }) {
  await expect(prisma.generationJob.findUniqueOrThrow({ where: { id: request.jobId } })).resolves.toMatchObject({ status: "cancelled" });
  await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: request.attemptId } })).resolves.toMatchObject({ status: "cancelled" });
  await expect(prisma.dreamcoinLedger.count({ where: { sourceId: request.jobId, reason: "refund" } })).resolves.toBe(1);
  await expect(dreamcoinBalance(request.userId)).resolves.toBe(100);
}

// A worker holds this row, the way one waiting on the device lease does.
async function claimBullRow() {
  const url = new URL(env.REDIS_URL);
  const worker = new Worker("ai.image.generate", null, { autorun: false, prefix: env.BULLMQ_PREFIX, connection: {
    host: url.hostname, port: url.port ? Number.parseInt(url.port, 10) : 6379,
    db: url.pathname && url.pathname !== "/" ? Number.parseInt(url.pathname.slice(1), 10) : 0, maxRetriesPerRequest: null,
  } });
  worker.on("error", () => undefined);
  await worker.getNextJob(`held-${randomUUID()}`, { block: false });
  return worker;
}

function postTransport(body: unknown) {
  return transportRoute(new Request("http://main.test/api/internal/generation/transports", {
    method: "POST", headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN }, body: JSON.stringify(body),
  }));
}

describe("cancelling a Generation Request before provider entry", () => {
  afterEach(async () => {
    await Promise.all(created.map(row => jobQueue.removeByDedupeKey("ai.image.generate", row.dedupeKey).catch(() => false)));
  });
  afterAll(async () => {
    for (const { jobId, attemptId, userId } of created) {
      await prisma.aiUsageFact.deleteMany({ where: { attemptId } });
      await prisma.generationTransportExecution.deleteMany({ where: { attemptId } });
      await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
      await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
      await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: jobId } });
      await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: attemptId } });
      await prisma.generationJobEvent.deleteMany({ where: { jobId } });
      await prisma.generationSettlementLink.deleteMany({ where: { requestId: jobId } });
      await prisma.dreamcoinLedger.deleteMany({ where: { userId } });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("cancels a request waiting in Bull after dispatch, removes its row and refunds once", async () => {
    const request = await acceptedRequest();
    await expect(jobQueue.getByDedupeKey("ai.image.generate", request.dedupeKey)).resolves.toMatchObject({ state: "waiting" });
    await expect(readJob(request)).resolves.toMatchObject({ status: "queued", canCancel: true });

    const cancelled = await cancel(request);
    expectOk(cancelled);
    expect(cancelled.data).toMatchObject({ status: "cancelled", refundAmount: COST });

    await expectCancelledOnce(request);
    await expect(jobQueue.getByDedupeKey("ai.image.generate", request.dedupeKey)).resolves.toBeNull();
    await expect(readJob(request)).resolves.toMatchObject({ status: "cancelled", canCancel: false, queueAhead: null });
  });

  it("cancels a request waiting on the device lease and refuses its worker for good", async () => {
    const request = await acceptedRequest();
    const worker = await claimBullRow();
    try {
      await expect(jobQueue.getByDedupeKey("ai.image.generate", request.dedupeKey)).resolves.toMatchObject({ state: "active" });
      await expect(recordGenerationTransportExecution(request.event("waiting"))).resolves.toMatchObject({ acknowledged: true });
      await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: request.attemptId } })).resolves.toMatchObject({ status: "queued", startedAt: null });
      await expect(readJob(request)).resolves.toMatchObject({ canCancel: true });

      expectOk(await cancel(request));
      await expectCancelledOnce(request);
      // Bull will not remove a row a worker holds, so Main's refusal is what stops it.
      await expect(jobQueue.getByDedupeKey("ai.image.generate", request.dedupeKey)).resolves.toMatchObject({ state: "active" });

      for (const status of ["waiting", "running"] as const) {
        const refused = await postTransport(request.event(status));
        expect(refused.status).toBe(409);
        await expect(refused.json()).resolves.toMatchObject({ reason: GENERATION_TRANSPORT_AUTHORITY_REVOKED_REASON });
      }
      await expect(prisma.generationTransportExecution.count({ where: { attemptId: request.attemptId } })).resolves.toBe(0);
    } finally {
      await worker.close(true);
    }
  });

  it("refuses to cancel once the worker won the race to running, and charges nothing back", async () => {
    const request = await acceptedRequest();
    await expect(recordGenerationTransportExecution(request.event("running"))).resolves.toMatchObject({ status: "persisted" });
    await expect(readJob(request)).resolves.toMatchObject({ status: "running", canCancel: false, queueAhead: null });

    const refused = await cancel(request);
    expectError(refused, 409, "conflict");
    expect(refused.error?.details).toMatchObject({ reason: "processing_started" });

    await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: request.attemptId } })).resolves.toMatchObject({ status: "running" });
    await expect(prisma.generationJob.findUniqueOrThrow({ where: { id: request.jobId } })).resolves.toMatchObject({ status: "queued" });
    await expect(prisma.dreamcoinLedger.count({ where: { sourceId: request.jobId, reason: "refund" } })).resolves.toBe(0);
    await expect(jobQueue.getByDedupeKey("ai.image.generate", request.dedupeKey)).resolves.not.toBeNull();
  });

  it("lets exactly one side win when cancel and the running event truly race", async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 6; round += 1) {
      const request = await acceptedRequest();
      const [cancelled, running] = await Promise.all([
        cancel(request),
        recordGenerationTransportExecution(request.event("running")).then(() => "entered", (error: unknown) => error),
      ]);
      const transports = await prisma.generationTransportExecution.count({ where: { attemptId: request.attemptId } });
      const refunds = await prisma.dreamcoinLedger.count({ where: { sourceId: request.jobId, reason: "refund" } });
      if (running === "entered") {
        outcomes.add("worker");
        expectError(cancelled, 409, "conflict");
        expect([transports, refunds]).toEqual([1, 0]);
      } else {
        outcomes.add("cancel");
        expectOk(cancelled);
        expect((running as { details: { reason: string } }).details.reason).toBe(GENERATION_TRANSPORT_AUTHORITY_REVOKED_REASON);
        expect([transports, refunds]).toEqual([0, 1]);
      }
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });

  it("replays a repeated cancel without a second refund", async () => {
    const request = await acceptedRequest();
    expectOk(await cancel(request));
    const repeated = await cancel(request);
    expectOk(repeated);
    expect(repeated.data).toMatchObject({ status: "cancelled", refundAmount: 0 });
    await expectCancelledOnce(request);
    await expect(prisma.generationJobEvent.count({ where: { jobId: request.jobId, type: "refunded" } })).resolves.toBe(1);
  });

  it("keeps a request whose result another flow is waiting on out of the user cancel", async () => {
    const request = await acceptedRequest({ sourceType: "chat_image" });
    await expect(readJob(request)).resolves.toMatchObject({ canCancel: false });
    expectError(await cancel(request), 404, "not_found");
    await expect(prisma.generationJob.findUniqueOrThrow({ where: { id: request.jobId } })).resolves.toMatchObject({ status: "queued" });
  });

  it("tells Gen a snapshot read is over for good only when the reader's Attempt is closed", async () => {
    const request = await acceptedRequest();
    const read = () => snapshotRoute(new Request(`http://main.test/api/internal/generation/source-snapshot?snapshotId=unpinned&jobId=${request.jobId}&attemptId=${request.attemptId}`, {
      headers: { "x-internal-token": env.INTERNAL_TOKEN },
    }));
    expect((await read()).status).toBe(404);
    expectOk(await cancel(request));
    expect((await read()).status).toBe(410);
  });
});
