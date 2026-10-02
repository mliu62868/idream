import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPrometheusMetrics, resetMetricsForTests } from "@idream/shared";
import { MAIN_TO_CHAT_EVENTS, type DurableEventEnvelope } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import {
  dispatchPendingChatEvents,
  recordMainToChatEvent,
  resolveChatDurableIngestUrl,
} from "./chat-outbox";

const eventId = "durable_main_chat_event_1";

beforeEach(async () => {
  resetMetricsForTests();
  await prisma.mainOutboxEvent.deleteMany({ where: { id: { startsWith: eventId } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function waitForOutboxStatus(status: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = await prisma.mainOutboxEvent.findUnique({ where: { id: eventId } });
    if (row?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${eventId} to become ${status}`);
}

describe("main to chat durable outbox", () => {
  it.each([
    [MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1, "headers"],
    [MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1, "body"],
    [MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2, "headers"],
    [MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2, "body"],
  ] as const)("retries %s after stalled response %s and continues another aggregate", async (eventType, phase) => {
    const hangingId = `${eventId}-hanging`;
    const followingId = `${eventId}-following`;
    const oldest = await prisma.mainOutboxEvent.findFirst({
      orderBy: { createdAt: "asc" }, select: { createdAt: true },
    });
    const fixtureCreatedAt = Math.min(0, oldest?.createdAt.getTime() ?? 0) - 2;
    for (const [index, id] of [hangingId, followingId].entries()) {
      const type = index === 0 ? eventType : MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1;
      await recordMainToChatEvent({
        eventId: id,
        eventType: type,
        schemaVersion: type === MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2 ? 2 : 1,
        aggregateType: type === MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2 ? "user" : "chat_turn",
        aggregateId: id,
        payload: type === MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2
          ? { userId: id }
          : { version: 1, userId: id, turnId: id, attempt: 1 },
      });
      await prisma.mainOutboxEvent.update({
        where: { id }, data: { createdAt: new Date(fixtureCreatedAt + index), nextRunAt: new Date(0) },
      });
    }
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    // Keep real DB timers; shorten only the HTTP deadline for this regression.
    const deadline = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(25));
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => { entered = resolve; });
    let releaseResponse = () => {};
    const acknowledgement = eventType === MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1
      ? { ok: true }
      : { acknowledged: true, status: "persisted", receiptId: hangingId };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const isHanging = eventType === MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1
        ? url.includes(encodeURIComponent(hangingId))
        : url.endsWith("/internal/events/account-deletion-v2/ingest");
      if (!isHanging) return Response.json({ ok: true });
      const signal = init?.signal;
      if (phase === "headers") {
        return new Promise<Response>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          releaseResponse = () => resolve(Response.json(acknowledgement));
          entered();
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          releaseResponse = () => {
            if (signal?.aborted) return;
            controller.enqueue(new TextEncoder().encode(JSON.stringify(acknowledgement)));
            controller.close();
          };
          entered();
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    }));
    // These two oldest rows make an isolated batch in the shared test database.
    const dispatch = dispatchPendingChatEvents({ lane: "lifecycle", batch: 2 });
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await requestEntered;
      const result = await Promise.race([
        dispatch,
        new Promise<null>((resolve) => { guard = setTimeout(() => resolve(null), 500); }),
      ]);
      expect(result).toEqual({ delivered: 1, failed: 1 });
      expect(deadline).toHaveBeenCalledWith(30_000);
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: hangingId } }))
        .resolves.toMatchObject({
          status: "pending", attempts: 1, leaseToken: null, leaseExpiresAt: null,
          lastError: { message: expect.stringMatching(/timeout|aborted/iu) },
        });
      const retried = await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: hangingId } });
      expect(retried.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: followingId } }))
        .resolves.toMatchObject({ status: "delivered", attempts: 1 });
    } finally {
      clearTimeout(guard);
      // The old implementation has no deadline; release its fixture after the
      // failed assertion so the dispatcher/heartbeat cannot leak into another test.
      releaseResponse();
      await dispatch;
      deadline.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1,
    MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1,
  ])("delivers cancellation, purge and account deletion while an older %s is blocked", async (memoryEventType) => {
    const memoryId = `${eventId}-slow-memory`;
    const urgentTypes = [
      MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1,
      MAIN_TO_CHAT_EVENTS.companionMemoryPurgeRequestedV1,
      MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
    ] as const;
    for (const [index, eventType] of [memoryEventType, ...urgentTypes].entries()) {
      const id = index === 0 ? memoryId : `${eventId}-urgent-${index}`;
      await recordMainToChatEvent({
        eventId: id,
        eventType,
        aggregateType: "chat_relationship",
        aggregateId: "slow-memory-user:character",
        payload: { userId: "slow-memory-user", characterId: "character" },
      });
      await prisma.mainOutboxEvent.update({
        where: { id },
        data: { createdAt: new Date(index), nextRunAt: new Date(0) },
      });
    }
    let releaseMemory!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseMemory = resolve; });
    const delivered: string[] = [];
    const deliver = async (event: DurableEventEnvelope) => {
      if (event.sourceEventId === memoryId) await blocked;
      // The lanes drain every pending row in the shared test DB; record only this test's.
      if (event.sourceEventId.startsWith(eventId)) delivered.push(event.eventType);
    };
    const dispatch = Promise.all([
      dispatchPendingChatEvents({ lane: "memory", batch: 100, deliver }),
      dispatchPendingChatEvents({ lane: "lifecycle", batch: 100, deliver }),
    ]);
    try {
      await expect.poll(() => [...delivered], { timeout: 1_000 }).toEqual(urgentTypes);
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: memoryId },
      })).resolves.toMatchObject({ status: "processing", attempts: 1 });
    } finally {
      releaseMemory();
      await dispatch;
    }
    expect(delivered).toEqual([...urgentTypes, memoryEventType]);
  });

  it("derives the single durable ingest endpoint from the required Chat service URL", () => {
    expect(() => resolveChatDurableIngestUrl(undefined)).toThrow("CHAT_SERVICE_URL");
    expect(resolveChatDurableIngestUrl("https://chat.internal/")).toBe(
      "https://chat.internal/internal/events/account-deletion-v2/ingest",
    );
    expect(resolveChatDurableIngestUrl(
      "https://chat.internal/",
      MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
    )).toBe(
      "https://chat.internal/internal/events/account-deletion-v2/ingest",
    );
  });

  it("keeps the row pending on ingest failure and delivers after durable ACK", async () => {
    await recordMainToChatEvent({
      eventId,
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      schemaVersion: 2,
      aggregateType: "user",
      aggregateId: "user-1",
      payload: { userId: "user-1" },
    });
    const first = await dispatchPendingChatEvents({
      lane: "lifecycle",
      deliver: async (event) => {
        if (event.sourceEventId === eventId) throw new Error("chat down");
      },
    });
    expect(first.failed).toBe(1);
    expect(renderPrometheusMetrics()).toMatch(
      /main_outbox_pending_age_seconds\{queue="chat"\} \d+(?:\.\d+)?/,
    );
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: eventId } })).toMatchObject({
      status: "pending",
      attempts: 1,
    });

    await prisma.mainOutboxEvent.update({ where: { id: eventId }, data: { nextRunAt: new Date(0) } });
    const deliver = vi.fn(async () => {});
    expect(await dispatchPendingChatEvents({ lane: "lifecycle", deliver })).toEqual(expect.objectContaining({ failed: 0 }));
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ sourceEventId: eventId }));
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: eventId } })).toMatchObject({ status: "delivered" });
  });

  it("does not deliver or age a product-scheduled event before deliverAfter", async () => {
    const deliverAfter = new Date(Date.now() + 60_000);
    await recordMainToChatEvent({
      eventId,
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      schemaVersion: 2,
      aggregateType: "user",
      aggregateId: "user-1",
      payload: { userId: "user-1" },
      deliverAfter,
    });
    const deliver = vi.fn(async () => {});

    await expect(dispatchPendingChatEvents({ lane: "lifecycle", deliver })).resolves.toEqual({
      delivered: 0,
      failed: 0,
    });
    expect(deliver).not.toHaveBeenCalled();
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    })).resolves.toMatchObject({
      status: "pending",
      attempts: 0,
      nextRunAt: deliverAfter,
    });
    expect(renderPrometheusMetrics()).toContain(
      'main_outbox_pending_age_seconds{queue="chat"} 0',
    );
  });

  it("keeps account deletion v2 pending across a rolled-back Chat capability window", async () => {
    await recordMainToChatEvent({
      eventId,
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      schemaVersion: 2,
      aggregateType: "user",
      aggregateId: "user-1",
      payload: { userId: "user-1" },
    });
    await prisma.mainOutboxEvent.update({
      where: { id: eventId },
      data: { attempts: 7, nextRunAt: new Date(0) },
    });

    await expect(dispatchPendingChatEvents({
      lane: "lifecycle",
      deliver: async () => {
        throw new Error("rolled-back Chat has no v2 route");
      },
    })).resolves.toEqual({ delivered: 0, failed: 1 });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    })).resolves.toMatchObject({
      status: "pending",
      attempts: 8,
    });
  });

  it("commits the v2 request ACK only after Chat reports Main completion projection", async () => {
    await recordMainToChatEvent({
      eventId,
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      schemaVersion: 2,
      aggregateType: "user",
      aggregateId: "user-1",
      payload: { userId: "user-1" },
    });
    await prisma.mainOutboxEvent.update({
      where: { id: eventId },
      data: { nextRunAt: new Date(0) },
    });

    let completionProjected = false;
    await expect(dispatchPendingChatEvents({
      lane: "lifecycle",
      deliver: async () => {
        await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
          where: { id: eventId },
        })).resolves.toMatchObject({ status: "processing", attempts: 1 });
        completionProjected = true;
      },
    })).resolves.toEqual({ delivered: 1, failed: 0 });

    expect(completionProjected).toBe(true);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    })).resolves.toMatchObject({ status: "delivered" });
  });

  it("leases one event to one reconciler and never double-delivers it", async () => {
    await recordMainToChatEvent({
      eventId,
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      schemaVersion: 2,
      aggregateType: "user",
      aggregateId: "user-1",
      payload: { userId: "user-1" },
    });
    await prisma.mainOutboxEvent.update({
      where: { id: eventId },
      data: { attempts: 7, nextRunAt: new Date(0) },
    });

    let releaseDelivery!: () => void;
    const deliveryEntered = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const acknowledged = dispatchPendingChatEvents({
      lane: "lifecycle",
      deliver: async (event) => {
        if (event.sourceEventId === eventId) await deliveryEntered;
      },
    });
    await waitForOutboxStatus("processing");
    const competingDeliver = vi.fn(async () => {});
    await expect(dispatchPendingChatEvents({ lane: "lifecycle", deliver: competingDeliver })).resolves.toEqual({
      delivered: 0,
      failed: 0,
    });
    expect(competingDeliver).not.toHaveBeenCalled();
    releaseDelivery();

    await acknowledged;
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: eventId } })).toMatchObject({
      status: "delivered",
      attempts: 8,
    });
  });

  it.each(["memory", "lifecycle"] as const)("keeps the same aggregate in order across competing %s reconcilers", async (lane) => {
    const firstId = `${eventId}-ordered-first`;
    const secondId = `${eventId}-ordered-second`;
    for (const [index, id] of [firstId, secondId].entries()) {
      await recordMainToChatEvent({
        eventId: id,
        eventType: lane === "memory"
          ? MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1
          : MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1,
        aggregateType: "chat_relationship",
        aggregateId: "ordered-user:character",
        payload: { userId: "ordered-user", characterId: "character" },
      });
      await prisma.mainOutboxEvent.update({
        where: { id },
        data: { createdAt: new Date(index), nextRunAt: new Date(0) },
      });
    }
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const delivered: string[] = [];
    const firstDispatch = dispatchPendingChatEvents({
      lane,
      deliver: async (event) => {
        if (event.sourceEventId === firstId) await blocked;
        delivered.push(event.sourceEventId);
      },
    });
    try {
      await expect.poll(async () => (await prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: firstId },
      })).status).toBe("processing");
      await expect(dispatchPendingChatEvents({
        lane,
        deliver: async (event) => { delivered.push(event.sourceEventId); },
      })).resolves.toEqual({ delivered: 0, failed: 0 });
      expect(delivered).toEqual([]);
    } finally {
      releaseFirst();
      await firstDispatch;
    }
    expect(delivered).toEqual([firstId, secondId]);
  });

  it("reclaims an expired processing lease without accepting the stale owner", async () => {
    await recordMainToChatEvent({
      eventId,
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      schemaVersion: 2,
      aggregateType: "user",
      aggregateId: "user-1",
      payload: { userId: "user-1" },
    });
    await prisma.mainOutboxEvent.update({
      where: { id: eventId },
      data: { attempts: 7, nextRunAt: new Date(0) },
    });

    await prisma.mainOutboxEvent.update({
      where: { id: eventId },
      data: {
        status: "processing",
        leaseToken: "expired-owner",
        leaseExpiresAt: new Date(0),
      },
    });
    const delivered = vi.fn(async () => {});

    await expect(dispatchPendingChatEvents({ lane: "lifecycle", deliver: delivered })).resolves.toEqual({
      delivered: 1,
      failed: 0,
    });
    expect(delivered).toHaveBeenCalledOnce();
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: eventId } })).toMatchObject({
      status: "delivered",
      attempts: 8,
    });
  });
});
