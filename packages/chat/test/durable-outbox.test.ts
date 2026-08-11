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
      updateMany: vi.fn(async (input: Record<string, unknown>) => {
        updates.push(input);
        return { count: 1 };
      }),
    },
  } as unknown as ChatPrismaClient;
  return { prisma, updates };
}

function concurrentFakePrisma() {
  let liveRow = {
    id: "chat-event-race",
    eventType: "chat.session.created",
    aggregateType: "session",
    aggregateId: "session-race",
    payload: { userId: "user-race" },
    schemaVersion: 1,
    status: "pending",
    attempts: 7,
    nextRunAt: new Date(0),
    createdAt: new Date("2026-08-11T12:00:00.000Z"),
    deliveredAt: null as Date | null,
  };
  let reads = 0;
  let releaseReads!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  const waiters = new Map<string, Array<() => void>>();

  const apply = (data: Record<string, unknown>) => {
    liveRow = { ...liveRow, ...data } as typeof liveRow;
    for (const resolve of waiters.get(liveRow.status) ?? []) resolve();
    waiters.delete(liveRow.status);
  };
  const matches = (where: Record<string, unknown>) => {
    if (where.id !== undefined && where.id !== liveRow.id) return false;
    if (where.attempts !== undefined && where.attempts !== liveRow.attempts) return false;
    if (typeof where.status === "string" && where.status !== liveRow.status) return false;
    if (where.status && typeof where.status === "object" && "in" in where.status) {
      const statuses = (where.status as { in: string[] }).in;
      if (!statuses.includes(liveRow.status)) return false;
    }
    return true;
  };
  const mutate = async (input: Record<string, unknown>) => {
    const where = input.where as Record<string, unknown>;
    if (!matches(where)) return { count: 0 };
    apply(input.data as Record<string, unknown>);
    return { count: 1 };
  };
  const prisma = {
    chatOutboxEvent: {
      findMany: vi.fn(async () => {
        const snapshot = { ...liveRow };
        reads += 1;
        if (reads === 2) releaseReads();
        await bothRead;
        return [snapshot];
      }),
      update: vi.fn(mutate),
      updateMany: vi.fn(mutate),
    },
  } as unknown as ChatPrismaClient;

  return {
    prisma,
    current: () => ({ ...liveRow }),
    waitForStatus(status: string): Promise<void> {
      if (liveRow.status === status) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.set(status, [...(waiters.get(status) ?? []), resolve]);
      });
    },
  };
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

  it("does not let a late failure regress an event after durable ACK", async () => {
    const state = concurrentFakePrisma();
    const acknowledged = deliverPendingOutbox(state.prisma, 1, async () => {});
    const lateFailure = deliverPendingOutbox(state.prisma, 1, async () => {
      await state.waitForStatus("delivered");
      throw new Error("late transport failure");
    });

    expect(await Promise.all([acknowledged, lateFailure])).toEqual([
      { delivered: 1, failed: 0 },
      { delivered: 0, failed: 0 },
    ]);
    expect(state.current()).toMatchObject({ status: "delivered", attempts: 7 });
  });

  it("lets a durable ACK repair a concurrent retry-exhausted failure", async () => {
    const state = concurrentFakePrisma();
    const failed = deliverPendingOutbox(state.prisma, 1, async () => {
      throw new Error("transport failure");
    });
    const acknowledged = deliverPendingOutbox(state.prisma, 1, async () => {
      await state.waitForStatus("failed");
    });

    await Promise.all([failed, acknowledged]);
    expect(state.current()).toMatchObject({ status: "delivered", attempts: 8 });
  });
});
