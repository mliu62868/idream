import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { DurableEventEnvelope } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { scheduleCompanionMemoryProjection, scheduleCompanionMemoryRebuild } from "@/server/modules/chat/companion-memory-authority";
import { dispatchPendingChatEvents } from "./chat-outbox";

const prefix = `zt-outbox-lanes-${randomUUID()}-`;

afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.companionMemoryAuthority.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
});

describe("memory lane concurrency", () => {
  it("delivers distinct relationships in parallel while one relationship stays in order", async () => {
    const slow = { userId: `${prefix}slow`, characterId: "c" };
    const fast = { userId: `${prefix}fast`, characterId: "c" };
    const slowRebuild = await prisma.$transaction((tx) => scheduleCompanionMemoryRebuild(tx, slow));
    const slowProjection = await prisma.$transaction((tx) => scheduleCompanionMemoryProjection(tx, slow));
    const fastProjection = await prisma.$transaction((tx) => scheduleCompanionMemoryProjection(tx, fast));

    const order: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const deliver = async (event: DurableEventEnvelope) => {
      if (!event.aggregateId.startsWith(prefix)) return;
      order.push(`start:${event.sourceEventId}`);
      if (event.sourceEventId === slowRebuild) await slowGate;
      if (event.sourceEventId === fastProjection) releaseSlow();
      order.push(`end:${event.sourceEventId}`);
    };
    await expect(dispatchPendingChatEvents({ lane: "memory", batch: 1_000, deliver })).resolves.toMatchObject({ failed: 0 });

    // The fast relationship finished while the slow rebuild was still running…
    expect(order.indexOf(`end:${fastProjection}`)).toBeLessThan(order.indexOf(`end:${slowRebuild}`));
    // …and the slow relationship's projection only started after its rebuild ended.
    expect(order.indexOf(`end:${slowRebuild}`)).toBeLessThan(order.indexOf(`start:${slowProjection}`));
    const rows = await prisma.mainOutboxEvent.findMany({ where: { id: { in: [slowRebuild, slowProjection, fastProjection] } } });
    expect(rows.every((row) => row.status === "delivered")).toBe(true);
  });
});
