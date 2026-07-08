// main-event-consumer effects: chat→main events update main authority tables.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAT_TO_MAIN_EVENTS, idempotencyKeys } from "@idream/shared/contracts";
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

const P = "zt-chatimg-";

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
});

describe("applyChatEvent", () => {
  it("chat.message.completed bumps character chatsCount", async () => {
    const character = await prisma.character.create({
      data: {
        name: "EC Test",
        age: 24,
        description: "d",
        appearance: {},
        advancedDetails: {},
        stats: { create: { chatsCount: 0 } },
      },
      include: { stats: true },
    });

    await applyChatEvent({
      eventId: "ec1",
      eventType: "chat.message.completed",
      aggregateId: "msg1",
      payload: { characterId: character.id },
    });

    const stats = await prisma.characterStats.findUnique({ where: { characterId: character.id } });
    expect(stats?.chatsCount).toBe(1);
  });

  it("chat.safety.flagged records a moderation event", async () => {
    await applyChatEvent({
      eventId: "ec2",
      eventType: "chat.safety.flagged",
      aggregateId: "msg_flagged",
      payload: { layer: "output", policyCode: "unsafe_request" },
    });
    const event = await prisma.moderationEvent.findFirst({
      where: { targetId: "msg_flagged", status: "flagged" },
    });
    expect(event?.policyCode).toBe("unsafe_request");
  });

  it("maintains the recent-chats projection across created → completed → deleted", async () => {
    const user = await prisma.user.create({ data: { email: `ec-proj-${Date.now()}@t.dev`, status: "active" } });
    const character = await prisma.character.create({
      data: { name: "ProjChar", age: 24, description: "d", appearance: {}, advancedDetails: {} },
    });
    const sessionId = `sess_proj_${Date.now()}`;

    // session.created seeds the projection row
    await applyChatEvent({
      eventId: "p1",
      eventType: "chat.session.created",
      aggregateId: sessionId,
      payload: { userId: user.id, characterId: character.id },
    });
    let row = await prisma.recentChat.findUnique({ where: { sessionId } });
    expect(row?.userId).toBe(user.id);
    expect(row?.status).toBe("active");

    // message.completed bumps lastMessageAt
    await applyChatEvent({
      eventId: "p2",
      eventType: "chat.message.completed",
      aggregateId: "msg_x",
      payload: { sessionId, userId: user.id, characterId: character.id },
    });
    row = await prisma.recentChat.findUnique({ where: { sessionId } });
    expect(row?.lastMessageAt).toBeTruthy();

    // session.deleted hides it from the library
    await applyChatEvent({ eventId: "p3", eventType: "chat.session.deleted", aggregateId: sessionId, payload: { userId: user.id } });
    row = await prisma.recentChat.findUnique({ where: { sessionId } });
    expect(row?.status).toBe("deleted");
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

    await runQueuedGenerationJobs(8);
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
        createdFrom: "test",
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
  });

  it("reuses approved character chat assets before creating a new generation job", async () => {
    const suffix = `${Date.now()}`;
    const userId = `${P}reuse-user-${suffix}`;
    const operatorId = `${P}reuse-ops-${suffix}`;
    const characterId = `${P}reuse-char-${suffix}`;
    const attachmentId = `${P}reuse-att-${suffix}`;
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
        width: 512,
        height: 640,
        visibility: "public_pack",
        safetyStatus: "passed",
        prompt: "sunset beach selfie",
        metadata: {
          platformAsset: {
            status: "approved",
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
        id: `${P}reuse-item-${suffix}`,
        batchId: batch.id,
        mediaAssetId: asset.id,
        status: "approved",
        tags: ["sunset", "beach", "selfie"],
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
    const snapshot = await jobQueue.getByDedupeKey(
      "chat.inbound",
      idempotencyKeys.chatInbox(completedEventId),
    );
    expect(snapshot).toBeTruthy();
    const callback = snapshot?.payload as {
      payload?: { mediaAssetId?: string; generationJobId?: string | null; reused?: boolean };
    } | null;
    expect(callback?.payload).toMatchObject({
      mediaAssetId: asset.id,
      generationJobId: null,
      reused: true,
    });
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
