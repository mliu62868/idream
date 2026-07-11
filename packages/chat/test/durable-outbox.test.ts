import { describe, expect, it, vi } from "vitest";
import { deliverPendingOutbox } from "../src/outbox.js";
import type { ChatPrismaClient } from "../src/db.js";

function fakePrisma() {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    chatOutboxEvent: {
      findMany: vi.fn(async () => [{
        id: "chat-event-1",
        eventType: "chat.session.created",
        aggregateType: "session",
        aggregateId: "session-1",
        payload: { userId: "user-1" },
        status: "pending",
        attempts: 0,
        nextRunAt: new Date(0),
        createdAt: new Date("2026-07-11T12:00:00.000Z"),
        deliveredAt: null,
      }]),
      update: vi.fn(async (input: Record<string, unknown>) => {
        updates.push(input);
        return input;
      }),
    },
  } as unknown as ChatPrismaClient;
  return { prisma, updates };
}

describe("chat durable outbox delivery", () => {
  it("does not mark delivered when main durable ACK fails", async () => {
    const { prisma, updates } = fakePrisma();
    const result = await deliverPendingOutbox(prisma, 100, async () => {
      throw new Error("main unavailable");
    });
    expect(result).toEqual({ delivered: 0, failed: 1 });
    expect(updates[0]).toMatchObject({ data: { status: "pending", attempts: 1 } });
  });

  it("marks delivered only after the injected durable ACK returns", async () => {
    const { prisma, updates } = fakePrisma();
    const acknowledge = vi.fn(async () => {});
    expect(await deliverPendingOutbox(prisma, 100, acknowledge)).toEqual({ delivered: 1, failed: 0 });
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({
      sourceService: "chat",
      sourceEventId: "chat-event-1",
      occurredAt: "2026-07-11T12:00:00.000Z",
    }));
    expect(updates[0]).toMatchObject({ data: { status: "delivered" } });
  });
});
