import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPrometheusMetrics, resetMetricsForTests } from "@idream/shared";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import {
  dispatchPendingChatEvents,
  recordMainToChatEvent,
  resolveChatDurableIngestUrl,
} from "./chat-outbox";

const eventId = "durable_main_chat_event_1";

beforeEach(async () => {
  resetMetricsForTests();
  await prisma.mainOutboxEvent.deleteMany({ where: { id: eventId } });
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
  it("derives the single durable ingest endpoint from the required Chat service URL", () => {
    expect(() => resolveChatDurableIngestUrl(undefined)).toThrow("CHAT_SERVICE_URL");
    expect(resolveChatDurableIngestUrl("https://chat.internal/")).toBe(
      "https://chat.internal/internal/events/ingest",
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
      eventType: MAIN_TO_CHAT_EVENTS.entitlementUpdated,
      aggregateType: "user",
      aggregateId: "user-1",
      payload: { userId: "user-1" },
    });
    const first = await dispatchPendingChatEvents(100, async (event) => {
      if (event.sourceEventId === eventId) throw new Error("chat down");
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
    expect(await dispatchPendingChatEvents(100, deliver)).toEqual(expect.objectContaining({ failed: 0 }));
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

    await expect(dispatchPendingChatEvents(100, deliver)).resolves.toEqual({
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

    await expect(dispatchPendingChatEvents(100, async () => {
      throw new Error("rolled-back Chat has no v2 route");
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
    await expect(dispatchPendingChatEvents(100, async () => {
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: eventId },
      })).resolves.toMatchObject({ status: "pending" });
      completionProjected = true;
    })).resolves.toEqual({ delivered: 1, failed: 0 });

    expect(completionProjected).toBe(true);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    })).resolves.toMatchObject({ status: "delivered" });
  });

  it("does not let a late failure regress an event after durable ACK", async () => {
    await recordMainToChatEvent({
      eventId,
      eventType: MAIN_TO_CHAT_EVENTS.entitlementUpdated,
      aggregateType: "user",
      aggregateId: "user-1",
      payload: { userId: "user-1" },
    });
    await prisma.mainOutboxEvent.update({
      where: { id: eventId },
      data: { attempts: 7, nextRunAt: new Date(0) },
    });

    let releaseFailure!: () => void;
    const failureEntered = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const acknowledged = dispatchPendingChatEvents(100, async (event) => {
      if (event.sourceEventId === eventId) await failureEntered;
    });
    const lateFailure = dispatchPendingChatEvents(100, async (event) => {
      if (event.sourceEventId !== eventId) return;
      releaseFailure();
      await waitForOutboxStatus("delivered");
      throw new Error("late transport failure");
    });

    await Promise.all([acknowledged, lateFailure]);
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: eventId } })).toMatchObject({
      status: "delivered",
      attempts: 7,
    });
  });

  it("lets a durable ACK repair a concurrent retry-exhausted failure", async () => {
    await recordMainToChatEvent({
      eventId,
      eventType: MAIN_TO_CHAT_EVENTS.entitlementUpdated,
      aggregateType: "user",
      aggregateId: "user-1",
      payload: { userId: "user-1" },
    });
    await prisma.mainOutboxEvent.update({
      where: { id: eventId },
      data: { attempts: 7, nextRunAt: new Date(0) },
    });

    let releaseSuccess!: () => void;
    const successEntered = new Promise<void>((resolve) => {
      releaseSuccess = resolve;
    });
    const failed = dispatchPendingChatEvents(100, async (event) => {
      if (event.sourceEventId !== eventId) return;
      await successEntered;
      throw new Error("transport failure");
    });
    const acknowledged = dispatchPendingChatEvents(100, async (event) => {
      if (event.sourceEventId !== eventId) return;
      releaseSuccess();
      await waitForOutboxStatus("failed");
    });

    await Promise.all([failed, acknowledged]);
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: eventId } })).toMatchObject({
      status: "delivered",
      attempts: 8,
    });
  });
});
