import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { recordGenerationTransportExecution } from "./generation-transport-execution";

describe("Generation TransportExecution authority", () => {
  const suffix = randomUUID();
  const attemptId = `transport-attempt-${suffix}`;
  const generationJobId = `transport-job-${suffix}`;
  const base = {
    version: 1 as const,
    attemptId,
    attemptNo: 1,
    generationJobId,
    transportAttemptNo: 1,
    provider: "pipeline-image",
    providerRequestId: null,
    idempotencyKey: `generation:${attemptId}:provider`,
    occurredAt: "2026-07-11T12:00:00.000Z",
  };

  beforeAll(async () => {
    await prisma.generationAttempt.create({ data: { id: attemptId, requestId: generationJobId, attemptNo: 1, status: "queued" } });
  });

  afterAll(async () => {
    await prisma.generationTransportExecution.deleteMany({ where: { attemptId } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
    await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
    await prisma.$disconnect();
  });

  it("records one provider invocation and idempotently closes its failure", async () => {
    await expect(recordGenerationTransportExecution({ ...base, status: "running", error: null })).resolves.toMatchObject({ status: "persisted" });
    await expect(recordGenerationTransportExecution({ ...base, status: "running", error: null })).resolves.toMatchObject({ status: "duplicate" });
    await expect(recordGenerationTransportExecution({ ...base, status: "failed", occurredAt: "2026-07-11T12:00:02.000Z", error: { code: "rate_limited", message: "capacity exhausted" } })).resolves.toMatchObject({ status: "persisted" });
    await expect(prisma.generationTransportExecution.findUnique({ where: { attemptId_transportAttemptNo: { attemptId, transportAttemptNo: 1 } } })).resolves.toMatchObject({ status: "failed", idempotencyKey: base.idempotencyKey });
    await expect(prisma.generationAttemptEvent.count({ where: { attemptId } })).resolves.toBe(2);
    await expect(recordGenerationTransportExecution({ ...base, status: "unknown", occurredAt: "2026-07-11T12:00:03.000Z", error: { code: "timeout", message: "outcome unknown" } })).rejects.toThrow("already terminal");
  });
});
