import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { ingestDurableServiceEvent } from "./durable-ingest";

describe("durable metric event eligibility classification", () => {
  const suffix = randomUUID();
  const customerId = `metric-customer-${suffix}`;
  const staffId = `metric-staff-${suffix}`;
  const fixtureId = `metric-fixture-${suffix}`;
  const sourceIds = [customerId, staffId, fixtureId, `missing-${suffix}`];

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: customerId, email: `${customerId}@customer.example`, role: "user", status: "active" },
        { id: staffId, email: `${staffId}@idream.internal`, role: "admin", status: "active" },
        { id: fixtureId, email: `${fixtureId}@example.test`, role: "user", status: "active" },
      ],
    });
  });

  afterAll(async () => {
    const events = await prisma.analyticsEvent.findMany({
      where: { sourceService: "chat-classification-test", sourceEventId: { in: sourceIds } },
      select: { id: true },
    });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: events.map((event) => event.id) } } });
    await prisma.analyticsEvent.deleteMany({
      where: { sourceService: "chat-classification-test", sourceEventId: { in: sourceIds } },
    });
    await prisma.inboundEventReceipt.deleteMany({
      where: { sourceService: "chat-classification-test", sourceEventId: { in: sourceIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [customerId, staffId, fixtureId] } } });
    await prisma.$disconnect();
  });

  async function ingest(sourceEventId: string, userId: string) {
    await ingestDurableServiceEvent({
      sourceService: "chat-classification-test",
      sourceEventId,
      eventType: "classification.fixture.v2",
      schemaVersion: 2,
      occurredAt: "2026-07-11T12:00:00.000Z",
      aggregateType: "user",
      aggregateId: userId,
      payload: { userId },
    });
    return prisma.analyticsEvent.findUniqueOrThrow({
      where: { sourceService_sourceEventId: { sourceService: "chat-classification-test", sourceEventId } },
    });
  }

  it("derives customer, internal, fixture, and missing-user classes from main authority", async () => {
    await expect(ingest(customerId, customerId)).resolves.toMatchObject({
      dataClass: "customer",
      actor: expect.objectContaining({ userId: customerId, isInternal: false }),
    });
    await expect(ingest(staffId, staffId)).resolves.toMatchObject({
      dataClass: "internal",
      actor: expect.objectContaining({ userId: staffId, isInternal: true }),
    });
    await expect(ingest(fixtureId, fixtureId)).resolves.toMatchObject({
      dataClass: "fixture",
      actor: expect.objectContaining({ userId: fixtureId, isInternal: true }),
    });
    await expect(ingest(sourceIds[3], sourceIds[3])).resolves.toMatchObject({
      dataClass: "internal",
      actor: expect.objectContaining({ userId: sourceIds[3], isInternal: true }),
    });
  });
});
