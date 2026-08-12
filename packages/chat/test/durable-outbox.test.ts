import { describe, expect, it, vi } from "vitest";
import {
  deliverPendingOutbox,
  deliverRequestBoundAccountErasureCompletion,
} from "../src/outbox.js";
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

function requestBoundFakePrisma(initialStatus = "request_bound") {
  let row = {
    id: "chat-account-erasure-v2-1",
    eventType: "chat.account_erasure.completed.v2",
    aggregateType: "user",
    aggregateId: "user-1",
    payload: {
      version: 2,
      binding: "request_bound",
      userId: "user-1",
      fileMutationId: "file-mutation-1",
      deletionRequestEventId: "main-deletion-request-1",
    },
    schemaVersion: 2,
    status: initialStatus,
    attempts: 0,
    nextRunAt: new Date(0),
    createdAt: new Date("2026-08-11T12:00:00.000Z"),
    deliveredAt: initialStatus === "delivered" ? new Date() : null,
  };
  const prisma = {
    chatOutboxEvent: {
      findFirst: vi.fn(async () => ({ ...row })),
      findUnique: vi.fn(async () => ({ status: row.status })),
      updateMany: vi.fn(async (input: {
        where: { status?: string; attempts?: number };
        data: Partial<typeof row>;
      }) => {
        if (
          (input.where.status && input.where.status !== row.status) ||
          (input.where.attempts !== undefined &&
            input.where.attempts !== row.attempts)
        ) {
          return { count: 0 };
        }
        row = { ...row, ...input.data };
        return { count: 1 };
      }),
    },
  } as unknown as ChatPrismaClient;
  return { prisma, current: () => ({ ...row }) };
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

  it("keeps request-bound completion out of delivered when rolled-back Main has no capability route", async () => {
    const state = requestBoundFakePrisma();
    await expect(deliverRequestBoundAccountErasureCompletion(
      "main-deletion-request-1",
      state.prisma,
      async () => {
        throw new Error("rolled-back Main returned 404");
      },
    )).rejects.toThrow("rolled-back Main returned 404");
    expect(state.current()).toMatchObject({
      status: "request_bound",
      attempts: 1,
    });
  });

  it("marks request-bound completion delivered only after Main projection ACK", async () => {
    const state = requestBoundFakePrisma();
    let projected = false;
    await expect(deliverRequestBoundAccountErasureCompletion(
      "main-deletion-request-1",
      state.prisma,
      async (event) => {
        expect(state.current().status).toBe("request_bound");
        expect(event).toMatchObject({
          eventType: "chat.account_erasure.completed.v2",
          schemaVersion: 2,
          payload: { binding: "request_bound" },
        });
        projected = true;
      },
    )).resolves.toMatchObject({ delivered: true });
    expect(projected).toBe(true);
    expect(state.current().status).toBe("delivered");
  });

  it("redelivers a prior delivered marker through the dedicated route for forward repair", async () => {
    const state = requestBoundFakePrisma("delivered");
    const acknowledge = vi.fn(async () => {});
    await expect(deliverRequestBoundAccountErasureCompletion(
      "main-deletion-request-1",
      state.prisma,
      acknowledge,
    )).resolves.toMatchObject({ delivered: true });
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
});
