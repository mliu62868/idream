import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAIN_TO_CHAT_EVENTS,
  MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
  durableEnvelopeHash,
} from "@idream/shared/contracts";
import { createChatPrisma } from "./db.js";
import { persistInboundEvent } from "./inbox.js";
import {
  discardMainToChatTargetMissing,
  inspectMainToChatReceiverAuthority,
} from "./main-outbox-authority.js";

const prisma = createChatPrisma();
const prefix = `chat-target-missing-${process.pid}`;

function envelope(id: string) {
  return {
    sourceService: "main",
    sourceEventId: id,
    eventType: MAIN_TO_CHAT_EVENTS.chatImageFailed,
    schemaVersion: 1,
    occurredAt: "2026-08-11T12:00:00.000Z",
    aggregateType: "chat_image",
    aggregateId: `${id}-aggregate`,
    payload: {
      version: 1,
      kind: "chat.image.failed",
      attachmentId: `${id}-missing-attachment`,
      generationJobId: `${id}-generation`,
      status: "failed" as const,
      errorCode: "provider_unavailable",
    },
  };
}

beforeEach(async () => {
  await prisma.chatInboxEvent.deleteMany({
    where: { sourceEventId: { startsWith: prefix } },
  });
});

afterAll(async () => {
  await prisma.chatInboxEvent.deleteMany({
    where: { sourceEventId: { startsWith: prefix } },
  });
  await prisma.$disconnect();
});

describe("Main to Chat target-missing terminal receipt", () => {
  it("inspects a missing target without writing a receipt", async () => {
    const event = envelope(`${prefix}-inspect`);
    await expect(inspectMainToChatReceiverAuthority({ events: [event] }, prisma))
      .resolves.toMatchObject({
        results: [{
          sourceEventId: event.sourceEventId,
          disposition: "expected_target_missing",
          target: { kind: "attachment", id: event.payload.attachmentId },
          targetStatus: null,
          receipt: null,
        }],
      });
    await expect(prisma.chatInboxEvent.count({
      where: { sourceEventId: event.sourceEventId },
    })).resolves.toBe(0);
  });

  it("persists the original payload/hash as an explicit terminal non-delivery", async () => {
    const event = envelope(`${prefix}-discard`);
    const request = {
      events: [{
        envelope: event,
        expectedEnvelopeHash: durableEnvelopeHash(event),
        expectedTarget: { kind: "attachment" as const, id: event.payload.attachmentId },
      }],
      confirmation: MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
    };

    await expect(discardMainToChatTargetMissing(request, prisma)).resolves.toMatchObject({
      results: [{
        sourceEventId: event.sourceEventId,
        outcome: "discarded_target_missing",
        receiptId: `main:${event.sourceEventId}`,
      }],
    });
    await expect(prisma.chatInboxEvent.findUniqueOrThrow({
      where: {
        sourceService_sourceEventId: {
          sourceService: "main",
          sourceEventId: event.sourceEventId,
        },
      },
    })).resolves.toMatchObject({
      payloadHash: durableEnvelopeHash(event),
      eventType: event.eventType,
      payload: event.payload,
      status: "discarded_target_missing",
      attempts: 0,
      consumedAt: null,
      processedAt: expect.any(Date),
    });

    // A normal delivery may observe the terminal evidence, but it must never
    // translate it into a successful duplicate ACK.
    await expect(persistInboundEvent(event, prisma)).resolves.toMatchObject({
      acknowledged: false,
      status: "discarded_target_missing",
      receiptId: `main:${event.sourceEventId}`,
    });
    await expect(discardMainToChatTargetMissing(request, prisma)).resolves.toMatchObject({
      results: [{ outcome: "already_discarded_target_missing" }],
    });
  });

  it("does not overwrite an ordinary durable receipt", async () => {
    const event = envelope(`${prefix}-receipt-conflict`);
    await expect(persistInboundEvent(event, prisma)).resolves.toMatchObject({
      acknowledged: true,
      status: "persisted",
    });
    await expect(discardMainToChatTargetMissing({
      events: [{
        envelope: event,
        expectedEnvelopeHash: durableEnvelopeHash(event),
        expectedTarget: { kind: "attachment", id: event.payload.attachmentId },
      }],
      confirmation: MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
    }, prisma)).resolves.toMatchObject({
      results: [{ outcome: "receipt_conflict" }],
    });
    await expect(prisma.chatInboxEvent.findUniqueOrThrow({
      where: {
        sourceService_sourceEventId: {
          sourceService: "main",
          sourceEventId: event.sourceEventId,
        },
      },
    })).resolves.toMatchObject({ status: "pending" });
  });
});
