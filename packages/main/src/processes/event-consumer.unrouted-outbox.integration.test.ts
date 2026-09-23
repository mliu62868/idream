import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { recordUnroutedMainOutboxEvents } from "./event-consumer";

// SPEC: 路由表（MAIN_OUTBOX_TRANSPORT_QUEUES）之外的 outbox 行是领域记录，终态 recorded；
// 路由表里的行仍然等待投递，不被这条 lane 碰。
describe("unrouted outbox settlement", () => {
  const prefix = `unrouted-outbox-${randomUUID()}`;

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.$disconnect();
  });

  it("records audit-only events and leaves transport events pending", async () => {
    const row = (suffix: string, eventType: string, status = "pending") => ({
      id: `${prefix}-${suffix}`, eventType, aggregateType: "test", aggregateId: suffix, payload: {}, status,
    });
    await prisma.mainOutboxEvent.createMany({
      data: [
        row("audit", "generation.request.cancelled.v2"),
        row("review", "creative.review.decided.v2"),
        row("transport", "product.event.persisted.v2"),
        row("delivered-audit", "creative.review.decided.v2", "delivered"),
      ],
    });

    await recordUnroutedMainOutboxEvents();

    const statuses = Object.fromEntries((await prisma.mainOutboxEvent.findMany({
      where: { id: { startsWith: prefix } }, select: { id: true, status: true },
    })).map((entry) => [entry.id.slice(prefix.length + 1), entry.status]));
    expect(statuses).toEqual({
      audit: "recorded",
      review: "recorded",
      transport: "pending",
      "delivered-audit": "delivered",
    });
  });
});
