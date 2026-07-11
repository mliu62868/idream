import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import {
  dispatchPendingChatEvents,
  durableChatIngressEnabled,
  recordMainToChatEvent,
} from "./chat-outbox";

const eventId = "durable_main_chat_event_1";

beforeEach(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { id: eventId } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("main to chat durable outbox", () => {
  it("requires an explicit durable ingest endpoint instead of inferring cutover from the BFF URL", () => {
    expect(durableChatIngressEnabled(undefined)).toBe(false);
    expect(durableChatIngressEnabled("https://chat.internal/internal/events/ingest")).toBe(true);
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
});
