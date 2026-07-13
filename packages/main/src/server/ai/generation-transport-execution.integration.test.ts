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
    model: "flux-pro",
    providerRequestId: null,
    idempotencyKey: `generation:${attemptId}:provider`,
    occurredAt: "2026-07-11T12:00:00.000Z",
  };

  beforeAll(async () => {
    await prisma.generationAttempt.create({ data: { id: attemptId, requestId: generationJobId, attemptNo: 1, status: "queued" } });
  });

  afterAll(async () => {
    await prisma.aiUsageFact.deleteMany({ where: { attemptId } });
    await prisma.generationTransportExecution.deleteMany({ where: { attemptId } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
    await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
    await prisma.$disconnect();
  });

  it("records one provider invocation and idempotently closes its failure", async () => {
    await expect(recordGenerationTransportExecution({ ...base, status: "running", error: null })).resolves.toMatchObject({ status: "persisted" });
    await expect(recordGenerationTransportExecution({ ...base, status: "running", error: null })).resolves.toMatchObject({ status: "duplicate" });
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
  });
});
