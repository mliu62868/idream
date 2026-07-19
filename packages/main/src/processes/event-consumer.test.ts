// main-event-consumer effects: chat→main events update main authority tables.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_TO_MAIN_EVENTS,
  MAIN_TO_CHAT_EVENTS,
  idempotencyKeys,
  type DurableEventEnvelope,
} from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import {
  createCharacter,
  createUser,
  dreamcoinBalance,
  grantCoins,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";
import { applyChatEvent } from "./event-consumer";
import { dispatchPendingChatEvents } from "./chat-outbox";
import { findReusableChatImage } from "@/server/modules/ourdream/chat-image-reuse";

const P = "zt-chatimg-";
const CHAT_PROJECTION_RECEIPT_SOURCE = "main.product_projection:chat";

beforeAll(async () => {
  await prisma.chatExchangeFact.deleteMany({
    where: { exchangeId: { startsWith: P } },
  });
  await prisma.inboundEventReceipt.deleteMany({
    where: {
      sourceService: CHAT_PROJECTION_RECEIPT_SOURCE,
      sourceEventId: { startsWith: P },
    },
  });
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.chatExchangeFact.deleteMany({
    where: { exchangeId: { startsWith: P } },
  });
  await prisma.inboundEventReceipt.deleteMany({
    where: {
      sourceService: CHAT_PROJECTION_RECEIPT_SOURCE,
      sourceEventId: { startsWith: P },
    },
  });
});

describe("applyChatEvent", () => {
  it("applies chat.message.completed exactly once when the same source event is replayed", async () => {
    const user = await createUser({
      id: `${P}engagement-customer`,
      dataClass: "customer",
    });
    const character = await prisma.character.create({
      data: {
        id: `${P}engagement-character`,
        name: "EC Test",
        age: 24,
        description: "d",
        appearance: {},
        advancedDetails: {},
        stats: { create: { chatsCount: 0 } },
      },
      include: { stats: true },
    });

    const event = {
      eventId: `${P}engagement-message`,
      eventType: CHAT_TO_MAIN_EVENTS.messageCompleted,
      aggregateId: `${P}engagement-message`,
      occurredAt: "2026-07-16T12:45:40Z",
      payload: { userId: user.id, characterId: character.id },
    };

    await expect(applyChatEvent(event)).resolves.toEqual({ status: "applied" });
    await expect(applyChatEvent({
      ...event,
      occurredAt: "2026-07-16T12:45:40.000Z",
      sourceService: "chat",
      schemaVersion: 1,
    })).resolves.toEqual({
      status: "duplicate",
      outcome: "applied",
    });

    const stats = await prisma.characterStats.findUnique({ where: { characterId: character.id } });
    expect(stats?.chatsCount).toBe(1);
    await expect(prisma.inboundEventReceipt.findUnique({
      where: {
        sourceService_sourceEventId: {
          sourceService: CHAT_PROJECTION_RECEIPT_SOURCE,
          sourceEventId: event.eventId,
        },
      },
    })).resolves.toMatchObject({
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      processingState: "processed",
      processedAt: expect.any(Date),
      quarantinedAt: null,
    });
  });

  it("serializes concurrent delivery of one source event across database transactions", async () => {
    const user = await createUser({
      id: `${P}concurrent-customer`,
      dataClass: "customer",
    });
    const character = await prisma.character.create({
      data: {
        id: `${P}concurrent-character`,
        name: "Concurrent delivery target",
        age: 24,
        description: "d",
        appearance: {},
        advancedDetails: {},
        stats: { create: { chatsCount: 0 } },
      },
    });
    const event = {
      eventId: `${P}concurrent-message`,
      eventType: CHAT_TO_MAIN_EVENTS.messageCompleted,
      aggregateId: `${P}concurrent-message`,
      payload: { userId: user.id, characterId: character.id },
    };

    const results = await Promise.all([
      applyChatEvent(event),
      applyChatEvent(event),
    ]);

    expect(results).toEqual(expect.arrayContaining([
      { status: "applied" },
      { status: "duplicate", outcome: "applied" },
    ]));
    await expect(prisma.characterStats.findUniqueOrThrow({
      where: { characterId: character.id },
    })).resolves.toMatchObject({ chatsCount: 1 });
    await expect(prisma.inboundEventReceipt.count({
      where: {
        sourceService: CHAT_PROJECTION_RECEIPT_SOURCE,
        sourceEventId: event.eventId,
      },
    })).resolves.toBe(1);
  });

  it("quarantines a reused source event id whose projection payload changes", async () => {
    const user = await createUser({
      id: `${P}conflict-customer`,
      dataClass: "customer",
    });
    const [firstCharacter, secondCharacter] = await Promise.all([
      prisma.character.create({
        data: {
          id: `${P}conflict-character-a`,
          name: "Conflict target A",
          age: 24,
          description: "d",
          appearance: {},
          advancedDetails: {},
          stats: { create: { chatsCount: 0 } },
        },
      }),
      prisma.character.create({
        data: {
          id: `${P}conflict-character-b`,
          name: "Conflict target B",
          age: 24,
          description: "d",
          appearance: {},
          advancedDetails: {},
          stats: { create: { chatsCount: 0 } },
        },
      }),
    ]);
    const eventId = `${P}conflicting-message`;
    const originalEvent = {
      eventId,
      eventType: CHAT_TO_MAIN_EVENTS.messageCompleted,
      aggregateId: eventId,
      payload: { userId: user.id, characterId: firstCharacter.id },
    };
    const conflictingEvent = {
      ...originalEvent,
      payload: { userId: user.id, characterId: secondCharacter.id },
    };

    await expect(applyChatEvent(originalEvent)).resolves.toEqual({ status: "applied" });
    await expect(applyChatEvent(conflictingEvent)).resolves.toEqual({
      status: "quarantined",
      reason: "payload_hash_conflict",
    });
    await expect(applyChatEvent(originalEvent)).resolves.toEqual({
      status: "quarantined",
      reason: "source_event_quarantined",
    });

    await expect(prisma.characterStats.findMany({
      where: { characterId: { in: [firstCharacter.id, secondCharacter.id] } },
      orderBy: { characterId: "asc" },
      select: { characterId: true, chatsCount: true },
    })).resolves.toEqual([
      { characterId: firstCharacter.id, chatsCount: 1 },
      { characterId: secondCharacter.id, chatsCount: 0 },
    ]);
    await expect(prisma.inboundEventReceipt.findUniqueOrThrow({
      where: {
        sourceService_sourceEventId: {
          sourceService: CHAT_PROJECTION_RECEIPT_SOURCE,
          sourceEventId: eventId,
        },
      },
    })).resolves.toMatchObject({
      processingState: "quarantined",
      processedAt: expect.any(Date),
      quarantinedAt: expect.any(Date),
      error: {
        code: "payload_hash_conflict",
        expectedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        receivedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("rolls back the domain effect when processing crashes before its receipt commits", async () => {
    const user = await createUser({
      id: `${P}crash-customer`,
      dataClass: "customer",
    });
    const character = await prisma.character.create({
      data: {
        id: `${P}crash-character`,
        name: "Crash rollback target",
        age: 24,
        description: "d",
        appearance: {},
        advancedDetails: {},
        stats: { create: { chatsCount: 0 } },
      },
    });
    const event = {
      eventId: `${P}crash-message`,
      eventType: CHAT_TO_MAIN_EVENTS.messageCompleted,
      aggregateId: `${P}crash-message`,
      payload: { userId: user.id, characterId: character.id },
    };

    await expect(applyChatEvent(event, {
      afterEffect: async () => {
        throw new Error("injected crash before projection receipt");
      },
    })).rejects.toThrow("injected crash before projection receipt");
    await expect(prisma.characterStats.findUniqueOrThrow({
      where: { characterId: character.id },
    })).resolves.toMatchObject({ chatsCount: 0 });
    await expect(prisma.inboundEventReceipt.findUnique({
      where: {
        sourceService_sourceEventId: {
          sourceService: CHAT_PROJECTION_RECEIPT_SOURCE,
          sourceEventId: event.eventId,
        },
      },
    })).resolves.toBeNull();

    await expect(applyChatEvent(event)).resolves.toEqual({ status: "applied" });
    await expect(prisma.characterStats.findUniqueOrThrow({
      where: { characterId: character.id },
    })).resolves.toMatchObject({ chatsCount: 1 });
  });

  it("does not turn fixture chat traffic into public engagement", async () => {
    const user = await createUser({ id: `${P}engagement-fixture` });
    const character = await prisma.character.create({
      data: {
        id: `${P}fixture-engagement-character`,
        name: "Fixture traffic target",
        age: 24,
        description: "d",
        appearance: {},
        advancedDetails: {},
        stats: { create: { chatsCount: 0 } },
      },
    });

    await applyChatEvent({
      eventId: `${P}fixture-message`,
      eventType: CHAT_TO_MAIN_EVENTS.messageCompleted,
      aggregateId: `${P}fixture-message`,
      payload: { userId: user.id, characterId: character.id },
    });

    const stats = await prisma.characterStats.findUniqueOrThrow({
      where: { characterId: character.id },
    });
    expect(stats.chatsCount).toBe(0);
  });

  it("typed-skips recent-chat projection when customer or character authority is missing", async () => {
    const customer = await createUser({
      id: `${P}projection-authority-customer`,
      dataClass: "customer",
    });
    const character = await prisma.character.create({
      data: {
        id: `${P}projection-authority-character`,
        name: "Projection authority",
        age: 24,
        description: "d",
        appearance: {},
        advancedDetails: {},
      },
    });
    const missingCustomerSessionId = `${P}missing-customer-session`;
    const missingCharacterSessionId = `${P}missing-character-session`;

    await expect(applyChatEvent({
      eventId: `${P}missing-customer-event`,
      eventType: CHAT_TO_MAIN_EVENTS.sessionCreated,
      aggregateId: missingCustomerSessionId,
      payload: {
        userId: `${P}missing-customer`,
        characterId: character.id,
      },
    })).resolves.toEqual({
      status: "skipped",
      reason: "chat_projection_customer_authority_missing",
    });
    await expect(applyChatEvent({
      eventId: `${P}missing-character-event`,
      eventType: CHAT_TO_MAIN_EVENTS.messageCompleted,
      aggregateId: `${P}missing-character-message`,
      payload: {
        sessionId: missingCharacterSessionId,
        userId: customer.id,
        characterId: `${P}missing-character`,
      },
    })).resolves.toEqual({
      status: "skipped",
      reason: "chat_projection_character_authority_missing",
    });
    await expect(prisma.recentChat.findMany({
      where: {
        sessionId: {
          in: [missingCustomerSessionId, missingCharacterSessionId],
        },
      },
    })).resolves.toHaveLength(0);
  });

  it("chat.safety.flagged records a moderation event", async () => {
    const user = await createUser({
      id: `${P}safety-customer`,
      dataClass: "customer",
    });
    const targetId = `${P}flagged-message`;
    await applyChatEvent({
      eventId: `${P}safety-event`,
      eventType: "chat.safety.flagged",
      aggregateId: targetId,
      payload: {
        userId: user.id,
        layer: "output",
        policyCode: "unsafe_request",
      },
    });
    const event = await prisma.moderationEvent.findFirst({
      where: { targetId, status: "flagged" },
    });
    expect(event?.policyCode).toBe("unsafe_request");
  });

  it("does not project audit probe safety traffic into customer moderation", async () => {
    const user = await createUser({
      id: `${P}safety-audit`,
      dataClass: "audit",
    });
    const targetId = `${P}flagged-audit-message`;

    await expect(applyChatEvent({
      eventId: `${P}safety-audit-event`,
      eventType: CHAT_TO_MAIN_EVENTS.safetyFlagged,
      aggregateId: targetId,
      payload: {
        userId: user.id,
        layer: "input",
        policyCode: "audit_probe",
      },
    })).resolves.toEqual({
      status: "skipped",
      reason: "chat_projection_customer_authority_missing",
    });
    await expect(prisma.moderationEvent.findFirst({
      where: { targetId },
    })).resolves.toBeNull();
  });

  it("maintains the recent-chats projection across created → completed → deleted", async () => {
    const suffix = `${Date.now()}`;
    const user = await createUser({
      id: `${P}projection-customer-${suffix}`,
      dataClass: "customer",
    });
    const character = await prisma.character.create({
      data: {
        id: `${P}projection-character-${suffix}`,
        name: "ProjChar",
        age: 24,
        description: "d",
        appearance: {},
        advancedDetails: {},
      },
    });
    const sessionId = `${P}projection-session-${suffix}`;

    // session.created seeds the projection row
    await applyChatEvent({
      eventId: `${P}projection-created-${suffix}`,
      eventType: "chat.session.created",
      aggregateId: sessionId,
      payload: { userId: user.id, characterId: character.id },
    });
    let row = await prisma.recentChat.findUnique({ where: { sessionId } });
    expect(row?.userId).toBe(user.id);
    expect(row?.status).toBe("active");

    // message.completed bumps lastMessageAt
    await applyChatEvent({
      eventId: `${P}projection-completed-${suffix}`,
      eventType: "chat.message.completed",
      aggregateId: "msg_x",
      payload: { sessionId, userId: user.id, characterId: character.id },
    });
    row = await prisma.recentChat.findUnique({ where: { sessionId } });
    expect(row?.lastMessageAt).toBeTruthy();

    // session.deleted hides it from the library
    await applyChatEvent({
      eventId: `${P}projection-deleted-${suffix}`,
      eventType: "chat.session.deleted",
      aggregateId: sessionId,
      payload: { userId: user.id },
    });
    row = await prisma.recentChat.findUnique({ where: { sessionId } });
    expect(row?.status).toBe("deleted");
  });

  it("redacts chat-image source text when a logical exchange correction arrives", async () => {
    const user = await createUser({
      id: `${P}privacy-correction-user`,
      dataClass: "customer",
    });
    const sessionId = `${P}privacy-correction-session`;
    const userMessageId = `${P}privacy-correction-user-message`;
    const assistantMessageId = `${P}privacy-correction-assistant-message`;
    const matching = await prisma.generationJob.create({
      data: {
        id: `${P}privacy-correction-job`,
        userId: user.id,
        mode: "image",
        controls: {},
        presetIds: [],
        sourceType: "chat_image",
        sourceId: `${P}privacy-correction-attachment`,
        sourceMeta: {
          sessionId,
          exchangeId: userMessageId,
          messageId: assistantMessageId,
          characterReleaseId: null,
          promptHint: "private correction prompt",
          conversationContext: "user: private correction context",
        },
      },
    });
    const unaffected = await prisma.generationJob.create({
      data: {
        id: `${P}privacy-unaffected-job`,
        userId: user.id,
        mode: "image",
        controls: {},
        presetIds: [],
        sourceType: "chat_image",
        sourceId: `${P}privacy-unaffected-attachment`,
        sourceMeta: {
          sessionId: `${P}privacy-unaffected-session`,
          exchangeId: `${P}privacy-unaffected-exchange`,
          messageId: `${P}privacy-unaffected-message`,
          promptHint: "keep this prompt",
          conversationContext: "keep this context",
        },
      },
    });
    const eventId = `${P}privacy-correction-event`;

    await expect(applyChatEvent({
      eventId,
      eventType: CHAT_TO_MAIN_EVENTS.exchangeCorrectedV2,
      aggregateId: userMessageId,
      occurredAt: "2026-07-18T20:00:00.000Z",
      payload: {
        exchangeId: userMessageId,
        correctionType: "deleted",
        correctionRevision: 1,
        userId: user.id,
        sessionId,
        messageIds: [userMessageId, assistantMessageId],
      },
    })).resolves.toEqual({ status: "applied" });

    await expect(prisma.generationJob.findUniqueOrThrow({
      where: { id: matching.id },
      select: { sourceMeta: true },
    })).resolves.toEqual({
      sourceMeta: {
        sessionId,
        exchangeId: userMessageId,
        messageId: assistantMessageId,
        characterReleaseId: null,
        promptHint: null,
        conversationContext: null,
        privacyRedaction: {
          reason: "logical_exchange_deleted",
          sourceEventId: eventId,
          redactedAt: "2026-07-18T20:00:00.000Z",
        },
      },
    });
    await expect(prisma.generationJob.findUniqueOrThrow({
      where: { id: unaffected.id },
      select: { sourceMeta: true },
    })).resolves.toMatchObject({
      sourceMeta: {
        promptHint: "keep this prompt",
        conversationContext: "keep this context",
      },
    });
  });

  it("uses the existing exchange fact to redact legacy chat-image jobs", async () => {
    const user = await createUser({
      id: `${P}privacy-legacy-user`,
      dataClass: "customer",
    });
    const exchangeId = `${P}privacy-legacy-exchange`;
    const sessionId = `${P}privacy-legacy-session`;
    const assistantMessageId = `${P}privacy-legacy-assistant`;
    const characterId = `${P}privacy-legacy-character`;
    await createCharacter({
      id: characterId,
      creatorId: user.id,
      visibility: "public",
      status: "approved",
    });
    await grantCoins(user.id, 100, "privacy-race-seed");
    await prisma.chatExchangeFact.create({
      data: {
        exchangeId,
        sourceService: "chat",
        sourceEventId: `${P}privacy-legacy-completed-event`,
        userMessageId: exchangeId,
        assistantMessageId,
        selectedAssistantMessageId: assistantMessageId,
        assistantAttemptNo: 1,
        correctionRevision: 2,
        correctionType: "deleted",
        sessionId,
        engagementSessionId: `${P}privacy-legacy-engagement`,
        userId: user.id,
        characterId,
        characterContentVersionId: `${P}privacy-legacy-content`,
        environment: "development",
        dataClass: "customer",
        trustClass: "canonical",
        actorIsInternal: false,
        eligible: true,
        occurredAt: new Date("2026-07-18T19:00:00.000Z"),
        productDay: new Date("2026-07-18T00:00:00.000Z"),
        sourceUpdatedAt: new Date("2026-07-18T19:00:00.000Z"),
        validFrom: new Date("2026-07-18T19:00:00.000Z"),
      },
    });
    const job = await prisma.generationJob.create({
      data: {
        id: `${P}privacy-legacy-job`,
        userId: user.id,
        mode: "image",
        controls: {},
        presetIds: [],
        sourceType: "chat_image",
        sourceId: `${P}privacy-legacy-attachment`,
        sourceMeta: {
          sessionId,
          messageId: assistantMessageId,
          promptHint: "legacy private prompt",
          conversationContext: "legacy private context",
        },
      },
    });

    await applyChatEvent({
      eventId: `${P}privacy-legacy-correction-event`,
      eventType: CHAT_TO_MAIN_EVENTS.exchangeCorrectedV2,
      aggregateId: exchangeId,
      payload: {
        exchangeId,
        correctionType: "deleted",
        correctionRevision: 2,
        userId: user.id,
      },
    });

    await expect(prisma.generationJob.findUniqueOrThrow({
      where: { id: job.id },
      select: { sourceMeta: true },
    })).resolves.toMatchObject({
      sourceMeta: {
        sessionId,
        messageId: assistantMessageId,
        promptHint: null,
        conversationContext: null,
        privacyRedaction: { reason: "logical_exchange_deleted" },
      },
    });

    const lateAttachmentId = `${P}privacy-legacy-late-attachment`;
    await applyChatEvent({
      eventId: `${P}privacy-legacy-late-image-event`,
      eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
      aggregateId: lateAttachmentId,
      payload: {
        version: 1,
        kind: "chat.image.requested",
        requestId: `${P}privacy-legacy-late-request`,
        attachmentId: lateAttachmentId,
        sessionId,
        exchangeId,
        messageId: assistantMessageId,
        userId: user.id,
        characterId,
        promptHint: "must not be resurrected",
        conversationContext: "user: must not be resurrected",
        controls: { orientation: "4:5", outputCount: 1 },
      },
    });
    await expect(prisma.generationJob.count({
      where: { sourceType: "chat_image", sourceId: lateAttachmentId },
    })).resolves.toBe(0);
    await expect(dreamcoinBalance(user.id)).resolves.toBe(100);
  });

  it("redacts every derived chat-image source text when a session is deleted", async () => {
    const user = await createUser({
      id: `${P}privacy-session-user`,
      dataClass: "customer",
    });
    const sessionId = `${P}privacy-session-id`;
    const characterId = `${P}privacy-session-character`;
    await createCharacter({
      id: characterId,
      creatorId: user.id,
      visibility: "public",
      status: "approved",
    });
    await grantCoins(user.id, 100, "privacy-session-race-seed");
    await prisma.recentChat.create({
      data: {
        sessionId,
        userId: user.id,
        characterId,
        status: "active",
      },
    });
    const jobs = await Promise.all(
      ["one", "two"].map((suffix) => prisma.generationJob.create({
        data: {
          id: `${P}privacy-session-job-${suffix}`,
          userId: user.id,
          mode: "image",
          controls: {},
          presetIds: [],
          sourceType: "chat_image",
          sourceId: `${P}privacy-session-attachment-${suffix}`,
          sourceMeta: {
            sessionId,
            messageId: `${P}privacy-session-message-${suffix}`,
            promptHint: `private session prompt ${suffix}`,
            conversationContext: `private session context ${suffix}`,
          },
        },
      })),
    );

    await applyChatEvent({
      eventId: `${P}privacy-session-deleted-event`,
      eventType: CHAT_TO_MAIN_EVENTS.sessionDeleted,
      aggregateId: sessionId,
      occurredAt: "2026-07-18T21:00:00.000Z",
      payload: { userId: user.id },
    });

    await expect(prisma.generationJob.findMany({
      where: { id: { in: jobs.map((job) => job.id) } },
      orderBy: { id: "asc" },
      select: { sourceMeta: true },
    })).resolves.toEqual([
      {
        sourceMeta: expect.objectContaining({
          sessionId,
          promptHint: null,
          conversationContext: null,
          privacyRedaction: {
            reason: "session_deleted",
            sourceEventId: `${P}privacy-session-deleted-event`,
            redactedAt: "2026-07-18T21:00:00.000Z",
          },
        }),
      },
      {
        sourceMeta: expect.objectContaining({
          sessionId,
          promptHint: null,
          conversationContext: null,
          privacyRedaction: {
            reason: "session_deleted",
            sourceEventId: `${P}privacy-session-deleted-event`,
            redactedAt: "2026-07-18T21:00:00.000Z",
          },
        }),
      },
    ]);

    const lateAttachmentId = `${P}privacy-session-late-attachment`;
    await applyChatEvent({
      eventId: `${P}privacy-session-late-image-event`,
      eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
      aggregateId: lateAttachmentId,
      payload: {
        version: 1,
        kind: "chat.image.requested",
        requestId: `${P}privacy-session-late-request`,
        attachmentId: lateAttachmentId,
        sessionId,
        messageId: `${P}privacy-session-late-message`,
        userId: user.id,
        characterId,
        promptHint: "must not survive session deletion",
        conversationContext: "user: must not survive session deletion",
        controls: { orientation: "4:5", outputCount: 1 },
      },
    });
    await expect(prisma.generationJob.count({
      where: { sourceType: "chat_image", sourceId: lateAttachmentId },
    })).resolves.toBe(0);
    await expect(dreamcoinBalance(user.id)).resolves.toBe(100);
  });

  it("creates an idempotent generation job for chat image requests and emits completion callback", async () => {
    const userId = `${P}user`;
    const characterId = `${P}char`;
    const attachmentId = `${P}att`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, visibility: "public", status: "approved" });
    await grantCoins(userId, 100, "seed");

    const event = {
      eventId: `${P}evt`,
      eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
      aggregateId: attachmentId,
      payload: {
        version: 1,
        kind: "chat.image.requested",
        requestId: `${P}req`,
        attachmentId,
        sessionId: `${P}sess`,
        messageId: `${P}msg`,
        userId,
        characterId,
        promptHint: "send me a photo at sunset",
        conversationContext: "user: send me a photo at sunset",
        controls: { orientation: "4:5", outputCount: 1 },
      },
    };

    await applyChatEvent(event);
    await applyChatEvent(event);

    const jobs = await prisma.generationJob.findMany({
      where: { sourceType: "chat_image", sourceId: attachmentId },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      userId,
      characterId,
      mode: "image",
      costDreamcoins: 5,
      sourceType: "chat_image",
      sourceId: attachmentId,
    });
    expect(jobs[0]?.prompt).toContain("portrait photo of Test Character");
    expect(jobs[0]?.prompt).toContain("send me a photo at sunset");
    expect(jobs[0]?.prompt).not.toContain("Recent chat context");
    expect(jobs[0]?.negativePrompt).toContain("chat bubbles");
    expect(await dreamcoinBalance(userId)).toBe(95);

    const acceptedEventId = `chat_image_accepted_${attachmentId}_${jobs[0].id}`;
    expect(await jobQueue.getByDedupeKey("chat.inbound", idempotencyKeys.chatInbox(acceptedEventId))).toBeTruthy();

    await runQueuedGenerationJobs(8, [
      "ai.image.generate",
      "app.ai.finalize",
    ]);
    const asset = await prisma.mediaAsset.findFirst({ where: { sourceJobId: jobs[0].id } });
    expect(asset?.id).toBeTruthy();
    const completedEventId = `chat_image_completed_${attachmentId}_${jobs[0].id}_${asset?.id}`;
    const completedJob = await jobQueue.getByDedupeKey(
      "chat.inbound",
      idempotencyKeys.chatInbox(completedEventId),
    );
    expect(completedJob).toBeTruthy();
    // P4 Task 5: the completed payload carries a summary for chat-side photo awareness.
    expect(completedJob?.payload).toMatchObject({
      payload: { summary: expect.stringContaining("send me a photo at sunset") },
    });
  });

  it("carries the requested visualProfileId from a chat.image.requested payload onto the generation job", async () => {
    const userId = `${P}vp-user`;
    const characterId = `${P}vp-char`;
    const attachmentId = `${P}vp-att`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, visibility: "public", status: "approved" });
    await grantCoins(userId, 100, "seed");
    const visualProfile = await prisma.characterVisualProfile.create({
      data: {
        id: `${P}vp-cvp`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Test Character, adult woman, chestnut hair",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        referenceAssetIds: [],
        adapterRefs: {},
        createdFrom: "generation_bootstrap:test",
      },
    });

    await applyChatEvent({
      eventId: `${P}vp-evt`,
      eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
      aggregateId: attachmentId,
      payload: {
        version: 1,
        kind: "chat.image.requested",
        requestId: `${P}vp-req`,
        attachmentId,
        sessionId: `${P}vp-sess`,
        messageId: `${P}vp-msg`,
        userId,
        characterId,
        characterReleaseId: `${P}vp-release`,
        promptHint: "send me a photo at sunset",
        conversationContext: "user: send me a photo at sunset",
        controls: { orientation: "4:5", outputCount: 1 },
        visualProfileId: visualProfile.id,
        visualProfileVersion: visualProfile.version,
      },
    });

    const job = await prisma.generationJob.findFirstOrThrow({
      where: { sourceType: "chat_image", sourceId: attachmentId },
    });
    expect(job.visualProfileId).toBe(visualProfile.id);
    expect(job.sourceMeta).toMatchObject({
      characterReleaseId: `${P}vp-release`,
    });
  });

  it("routes a chat.image.requested payload carrying controls.sourceImageAssetId to the chat-image-edit profile", async () => {
    const suffix = `${Date.now()}`;
    const userId = `${P}edit-user-${suffix}`;
    const characterId = `${P}edit-char-${suffix}`;
    const attachmentId = `${P}edit-att-${suffix}`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, visibility: "public", status: "approved" });
    await grantCoins(userId, 100, "seed");

    await prisma.generationModelProfile.create({
      data: {
        id: `${P}edit-profile-${suffix}`,
        profileKey: "chat-image-edit",
        label: "Chat Image Edit (Qwen-Edit)",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey: "qwen-image-edit-img2img",
        runnerConfig: {
          capabilities: { textToImage: false, stableSeed: true, referenceImages: false, initImage: true, lora: false },
        },
        defaultWidth: 832,
        defaultHeight: 1216,
        allowedOrientations: ["4:5"],
        costMultiplier: 1.5,
        status: "active",
        enabled: true,
        version: 1,
      },
    });
    const sourceAsset = await prisma.mediaAsset.create({
      data: {
        id: `${P}edit-source-asset-${suffix}`,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `test-fixtures/${P}edit-source-asset-${suffix}.webp`,
        width: 512,
        height: 640,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });

    await applyChatEvent({
      eventId: `${P}edit-evt-${suffix}`,
      eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
      aggregateId: attachmentId,
      payload: {
        version: 1,
        kind: "chat.image.requested",
        requestId: `${P}edit-req-${suffix}`,
        attachmentId,
        sessionId: `${P}edit-sess-${suffix}`,
        messageId: `${P}edit-msg-${suffix}`,
        userId,
        characterId,
        promptHint: "make it sunset",
        conversationContext: "user: make it sunset",
        controls: { orientation: "4:5", outputCount: 1, sourceImageAssetId: sourceAsset.id },
      },
    });

    const job = await prisma.generationJob.findFirstOrThrow({
      where: { sourceType: "chat_image", sourceId: attachmentId },
    });
    expect(job.profileId).toBe("chat-image-edit");
    expect(job.model).toBe("qwen-image-edit-img2img");
    expect(job.controls).toMatchObject({ sourceImageAssetId: sourceAsset.id });
  });

  it("fails closed without dropping source intent when no compatible edit profile is available", async () => {
    const suffix = `${Date.now()}`;
    const userId = `${P}fallback-user-${suffix}`;
    const characterId = `${P}fallback-char-${suffix}`;
    const attachmentId = `${P}fallback-att-${suffix}`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, visibility: "public", status: "approved" });
    await grantCoins(userId, 100, "seed");

    const sourceAsset = await prisma.mediaAsset.create({
      data: {
        id: `${P}fallback-source-asset-${suffix}`,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `test-fixtures/${P}fallback-source-asset-${suffix}.webp`,
        width: 512,
        height: 640,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });

    // Simulate the dedicated source-edit route being unavailable. A different
    // text-to-image profile must never be allowed to reinterpret the request
    // after silently removing sourceImageAssetId.
    await prisma.generationModelProfile.updateMany({
      where: { profileKey: "chat-image-edit" },
      data: { enabled: false },
    });
    try {
      await applyChatEvent({
        eventId: `${P}fallback-evt-${suffix}`,
        eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
        aggregateId: attachmentId,
        payload: {
          version: 1,
          kind: "chat.image.requested",
          requestId: `${P}fallback-req-${suffix}`,
          attachmentId,
          sessionId: `${P}fallback-sess-${suffix}`,
          messageId: `${P}fallback-msg-${suffix}`,
          userId,
          characterId,
          promptHint: "make it sunset",
          conversationContext: "user: make it sunset",
          controls: { orientation: "4:5", outputCount: 1, sourceImageAssetId: sourceAsset.id },
        },
      });

      const jobs = await prisma.generationJob.findMany({
        where: { sourceType: "chat_image", sourceId: attachmentId },
      });
      expect(jobs).toHaveLength(0);
      await expect(dreamcoinBalance(userId)).resolves.toBe(100);
      const failedEventId = `chat_image_failed_${attachmentId}`;
      const failure = await jobQueue.getByDedupeKey(
        "chat.inbound",
        idempotencyKeys.chatInbox(failedEventId),
      );
      expect(failure?.payload).toMatchObject({
        eventType: "chat.image.failed",
        payload: {
          attachmentId,
          generationJobId: null,
          status: "failed",
          errorCode: "conflict",
        },
      });
    } finally {
      await prisma.generationModelProfile.updateMany({
        where: { profileKey: "chat-image-edit" },
        data: { enabled: true },
      });
    }
  });

  it("reuses only the exact chat asset pinned by the session Release", async () => {
    const suffix = `${Date.now()}`;
    const userId = `${P}reuse-user-${suffix}`;
    const operatorId = `${P}reuse-ops-${suffix}`;
    const characterId = `${P}reuse-char-${suffix}`;
    const attachmentId = `${P}reuse-att-${suffix}`;
    const projectId = `${P}reuse-project-${suffix}`;
    const releaseId = `${P}reuse-release-${suffix}`;
    const wrongReleaseId = `${P}reuse-release-wrong-${suffix}`;
    const itemId = `${P}reuse-item-${suffix}`;
    await createUser({ id: userId });
    await createUser({ id: operatorId, role: "ops" });
    await createCharacter({ id: characterId, creatorId: userId, visibility: "public", status: "approved" });

    const asset = await prisma.mediaAsset.create({
      data: {
        id: `${P}reuse-asset-${suffix}`,
        ownerId: operatorId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `test-fixtures/${P}reuse-asset-${suffix}.webp`,
        width: 512,
        height: 640,
        visibility: "private",
        safetyStatus: "passed",
        prompt: "sunset beach selfie",
        metadata: {
          platformAsset: {
            purpose: "character_chat",
            tags: ["sunset", "beach", "selfie"],
            description: "Candid sunset beach selfie in warm light.",
          },
        },
      },
    });
    const batch = await prisma.contentProductionBatch.create({
      data: {
        id: `${P}reuse-batch-${suffix}`,
        title: `${P}reuse-batch-${suffix}`,
        purpose: "character_chat",
        targetType: "character",
        targetId: characterId,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "completed",
        createdById: operatorId,
      },
    });
    await prisma.contentProductionItem.create({
      data: {
        id: itemId,
        batchId: batch.id,
        mediaAssetId: asset.id,
        status: "approved",
        tags: ["sunset", "beach", "selfie"],
      },
    });
    const distractorAssets = Array.from({ length: 100 }, (_, index) => ({
      id: `${P}reuse-asset-${String(index).padStart(3, "0")}-${suffix}`,
      ownerId: operatorId,
      characterId,
      type: "image",
      url: "/images/ourdream/card-sarah-mercer.webp",
      thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
      storageKey: `test-fixtures/${P}reuse-distractor-${String(index).padStart(3, "0")}-${suffix}.webp`,
      width: 512,
      height: 640,
      visibility: "public_pack",
      safetyStatus: "passed",
      prompt: "unrelated studio portrait",
      metadata: {
        platformAsset: {
          status: "approved",
          purpose: "character_chat",
          tags: ["studio", "portrait"],
          description: "Unrelated studio portrait.",
        },
      },
    }));
    await prisma.mediaAsset.createMany({ data: distractorAssets });
    await prisma.contentProductionItem.createMany({
      data: distractorAssets.map((distractor, index) => ({
        id: `${P}reuse-item-${String(index).padStart(3, "0")}-${suffix}`,
        batchId: batch.id,
        mediaAssetId: distractor.id,
        itemIndex: index + 1,
        status: "approved",
        tags: ["studio", "portrait"],
      })),
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "live_management",
        audience: {},
        successCriteria: [],
      },
    });
    const placement = (
      slotKey: "character_avatar" | "character_hero" | "character_chat",
      assetId: string,
      productionItemId: string,
    ) => ({
      slotKey,
      assetId,
      slotVersion: 1,
      runId: batch.id,
      itemId: productionItemId,
      reviewDecisionId: `${P}${slotKey}-decision-${suffix}`,
      generationJobId: `${P}${slotKey}-job-${suffix}`,
    });
    await prisma.characterRelease.createMany({
      data: [
        {
          id: releaseId,
          projectId,
          revisionId: `${P}reuse-revision-${suffix}`,
          characterContentVersionId: `${P}reuse-content-${suffix}`,
          generationProvenance: {},
          releasePlacementManifest: {
            schemaVersion: 2,
            placements: [
              placement(
                "character_avatar",
                distractorAssets[1]!.id,
                `${P}reuse-item-001-${suffix}`,
              ),
              placement(
                "character_hero",
                distractorAssets[2]!.id,
                `${P}reuse-item-002-${suffix}`,
              ),
              placement("character_chat", asset.id, itemId),
            ],
          },
          snapshotHash: `${P}reuse-snapshot-${suffix}`,
          readiness: "ready",
          status: "published",
        },
        {
          id: wrongReleaseId,
          projectId,
          revisionId: `${P}reuse-revision-wrong-${suffix}`,
          characterContentVersionId: `${P}reuse-content-${suffix}`,
          generationProvenance: {},
          releasePlacementManifest: {
            schemaVersion: 2,
            placements: [
              placement(
                "character_avatar",
                distractorAssets[1]!.id,
                `${P}reuse-item-001-${suffix}`,
              ),
              placement(
                "character_hero",
                distractorAssets[2]!.id,
                `${P}reuse-item-002-${suffix}`,
              ),
              placement(
                "character_chat",
                distractorAssets[0]!.id,
                `${P}reuse-item-000-${suffix}`,
              ),
            ],
          },
          snapshotHash: `${P}reuse-snapshot-wrong-${suffix}`,
          readiness: "ready",
          status: "published",
        },
      ],
    });
    const setAssetStatus = (status: string) =>
      prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          metadata: {
            platformAsset: {
              status,
              purpose: "character_chat",
              tags: ["sunset", "beach", "selfie"],
              description: "Candid sunset beach selfie in warm light.",
            },
          },
        },
      });

    await applyChatEvent({
      eventId: `${P}reuse-evt-${suffix}`,
      eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
      aggregateId: attachmentId,
      payload: {
        version: 1,
        kind: "chat.image.requested",
        requestId: `${P}reuse-req-${suffix}`,
        attachmentId,
        sessionId: `${P}reuse-sess-${suffix}`,
        messageId: `${P}reuse-msg-${suffix}`,
        userId,
        characterId,
        characterReleaseId: releaseId,
        promptHint: "send me a sunset beach selfie",
        conversationContext: "user: send me a sunset beach selfie",
        controls: { orientation: "4:5", outputCount: 1 },
      },
    });

    await expect(
      prisma.generationJob.findMany({ where: { sourceType: "chat_image", sourceId: attachmentId } }),
    ).resolves.toHaveLength(0);
    await expect(dreamcoinBalance(userId)).resolves.toBe(0);

    const completedEventId = `chat_image_completed_${attachmentId}_reused_${asset.id}`;
    const durableCallback = await prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: completedEventId },
    });
    expect(durableCallback).toMatchObject({
      eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
      aggregateType: "chat_effect",
      aggregateId: completedEventId,
    });
    expect(durableCallback.payload).toMatchObject({
      sourceService: "main",
      sourceEventId: completedEventId,
      eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
      payload: {
        mediaAssetId: asset.id,
        generationJobId: null,
        reused: true,
        summary: "Candid sunset beach selfie in warm light.",
      },
    });

    await prisma.mainOutboxEvent.update({
      where: { id: completedEventId },
      data: {
        status: "pending",
        attempts: 0,
        nextRunAt: new Date(0),
        createdAt: new Date(0),
        deliveredAt: null,
        lastError: undefined,
      },
    });
    const delivered: DurableEventEnvelope[] = [];
    const delivery = await dispatchPendingChatEvents(1, async (envelope) => {
      delivered.push(envelope);
    });
    expect(delivery).toEqual({ delivered: 1, failed: 0 });
    expect(delivered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceService: "main",
          sourceEventId: completedEventId,
          eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
          payload: expect.objectContaining({
            mediaAssetId: asset.id,
            generationJobId: null,
            reused: true,
          }),
        }),
      ]),
    );
    await expect(
      prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: completedEventId },
      }),
    ).resolves.toMatchObject({
      status: "delivered",
      deliveredAt: expect.any(Date),
    });

    const request = {
      version: 1 as const,
      kind: "chat.image.requested" as const,
      requestId: `${P}reuse-eligibility-req-${suffix}`,
      attachmentId: `${P}reuse-eligibility-att-${suffix}`,
      sessionId: `${P}reuse-eligibility-sess-${suffix}`,
      messageId: `${P}reuse-eligibility-msg-${suffix}`,
      userId,
      characterId,
      characterReleaseId: releaseId,
      promptHint: "send me a sunset beach selfie",
      conversationContext: "user: send me a sunset beach selfie",
      controls: { orientation: "4:5", outputCount: 1 },
    };

    await setAssetStatus("archived");
    await expect(findReusableChatImage(request)).resolves.toBeNull();

    await setAssetStatus("rejected");
    await expect(findReusableChatImage(request)).resolves.toBeNull();

    await setAssetStatus("approved");
    await expect(
      findReusableChatImage({ ...request, characterReleaseId: undefined }),
    ).resolves.toBeNull();
    await expect(
      findReusableChatImage({ ...request, characterReleaseId: wrongReleaseId }),
    ).resolves.toBeNull();
    await expect(
      findReusableChatImage({
        ...request,
        promptHint: "send a photo",
        conversationContext: "user: send me a sunset beach selfie",
      }),
    ).resolves.toMatchObject({ asset: { id: asset.id } });
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { status: "superseded" },
    });
    await expect(findReusableChatImage(request)).resolves.toMatchObject({
      asset: { id: asset.id },
    });
    await expect(
      findReusableChatImage({
        ...request,
        promptHint: "sunset portrait",
        conversationContext: "user: sunset portrait",
      }),
    ).resolves.toBeNull();
    await expect(
      findReusableChatImage({
        ...request,
        controls: { ...request.controls, sourceImageAssetId: asset.id },
      }),
    ).resolves.toBeNull();
    await expect(
      findReusableChatImage({ ...request, controls: { orientation: "1:1", outputCount: 1 } }),
    ).resolves.toBeNull();
  });

  it("maps a transient image-request failure to a retryable 'failed' status, not 'rejected'", async () => {
    const userId = `${P}user-transient`;
    const characterId = `${P}char-transient`;
    const attachmentId = `${P}att-transient`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, visibility: "public", status: "approved" });
    // No coins granted → the in-tx balance check throws Errors.paymentRequired. That is a
    // transient condition (the user can top up and retry), so the callback must be a
    // confirmable 'failed', NOT 'rejected' (which the chat confirm endpoint refuses forever).

    await applyChatEvent({
      eventId: `${P}evt-transient`,
      eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
      aggregateId: attachmentId,
      payload: {
        version: 1,
        kind: "chat.image.requested",
        requestId: `${P}req-transient`,
        attachmentId,
        sessionId: `${P}sess-transient`,
        messageId: `${P}msg-transient`,
        userId,
        characterId,
        promptHint: "send me a photo",
        conversationContext: "user: send me a photo",
        controls: { orientation: "4:5", outputCount: 1 },
      },
    });

    // The spend tx rolled back, so no job exists...
    const jobs = await prisma.generationJob.findMany({
      where: { sourceType: "chat_image", sourceId: attachmentId },
    });
    expect(jobs).toHaveLength(0);

    // ...and the failure callback is retryable 'failed' with the underlying transient code.
    const failedEventId = `chat_image_failed_${attachmentId}`;
    const snapshot = await jobQueue.getByDedupeKey(
      "chat.inbound",
      idempotencyKeys.chatInbox(failedEventId),
    );
    expect(snapshot).toBeTruthy();
    const callback = snapshot?.payload as { payload?: { status?: string; errorCode?: string } } | null;
    expect(callback?.payload?.status).toBe("failed");
    expect(callback?.payload?.errorCode).toBe("payment_required");
  });
});
