import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { compileCharacterSoul } from "@idream/shared";
import { CHAT_SEND_PROTOCOL_VERSION } from "@idream/shared/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { OPERATOR_UPLOAD_AUTHORITY_SCHEMA } from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import { createCharacter, createUser, dreamcoinBalance, grantCoins, purgeTestData } from "@/server/test/helpers";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { characterContentHash } from "@/server/modules/admin-v2/shared/character-content-identity";
import { mediaAssetAuthorityDependencies } from "@/server/modules/admin-v2/shared/media-asset-authority-dependencies";
import { batchReviewCharacterMediaLibrary } from "@/server/modules/character-media-library/admin-service";
import * as mediaModels from "@/server/modules/character-media-library/media-models";
import { libraryDescriptorHash } from "@/server/modules/character-media-library/service";
import {
  cancelPendingDelayedChatMedia,
  computeCuratedMediaDeliverAt,
  CURATED_IMAGE_DELAY_RANGE_MS,
  CURATED_VIDEO_DELAY_RANGE_MS,
  revealDueDelayedChatMedia,
  schedulePaidCuratedMediaDelivery,
} from "./delayed-media-reveal";
import { beginChatTurn, commitChatTerminal, createChatSession, deleteChatMessage, deleteChatSession, getChatSession } from "./turn-ledger";

const prefix = `zt-delayed-curated-${randomUUID()}-`;
const createdKeys: string[] = [];

beforeEach(() => {
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_URL", "http://media-embedding.test.invalid/v1");
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_MODEL", "fixture-embedding");
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_DIMENSIONS", "2");
  vi.spyOn(mediaModels, "embedMediaText").mockResolvedValue({ model: "fixture-embedding", dimensions: 2, vector: [1, 0] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.characterMediaLibraryEntry.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.userCharacterLibraryReceipt.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId: { startsWith: prefix } } });
  await prisma.adminAuditLog.deleteMany({ where: { actorId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  for (const key of createdKeys) await providers.blob.delete({ key });
});

async function officialFixture(options?: {
  kind?: "image" | "video";
  source?: "official" | "user";
  coins?: number;
  status?: "draft" | "published";
  nudity?: "unknown" | "none" | "partial" | "full";
}) {
  const kind = options?.kind ?? "image";
  const sourceKind = options?.source ?? "official";
  const id = `${prefix}${randomUUID()}`;
  const adminId = `${id}-admin`;
  await createUser({ id });
  await createUser({ id: adminId, role: "admin" });
  if ((options?.coins ?? 0) > 0) {
    await grantCoins(id, options!.coins!);
  }
  const character = await createCharacter({
    id: `${id}-char`,
    creatorId: id,
    source: sourceKind,
    visibility: "public",
    status: "approved",
    advancedDetails: { imageToolEnabled: true },
  });
  const soul = compileCharacterSoul({
    name: "Luna",
    age: 26,
    gender: "female",
    characterPromise: "Warm official companion",
    detailsMarkdown: "Friendly and expressive.",
  });
  if (!soul.ok) throw new Error("Invalid fixture soul");
  const contentValues = { personaSnapshot: soul.snapshot, openingSnapshot: { firstMessage: "Hi there!" }, appearanceSnapshot: {} };
  const content = await prisma.characterContentVersion.create({
    data: {
      characterId: character.id,
      version: 1,
      sourceType: "test",
      contentHash: characterContentHash(contentValues),
      ...JSON.parse(JSON.stringify(contentValues)),
    },
  });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });

  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#cc3366" } }).png().toBuffer();
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const sourceKey = `${id}/source.${kind === "image" ? "png" : "mp4"}`;
  const libraryKey = `${id}/library.${kind === "image" ? "png" : "mp4"}`;
  const contentType = kind === "image" ? "image/png" : "video/mp4";
  createdKeys.push(sourceKey, libraryKey);
  await providers.blob.putPrivate({ key: sourceKey, body: bytes, contentType });
  await providers.blob.putPrivate({ key: libraryKey, body: bytes, contentType });

  const sourceId = `${id}-source`;
  const sourceAsset = await prisma.mediaAsset.create({
    data: {
      id: sourceId,
      ownerId: adminId,
      characterId: character.id,
      type: kind,
      url: `/api/media/${sourceId}/content`,
      storageKey: sourceKey,
      contentType,
      safetyStatus: "passed",
      metadata: {
        source: "admin_asset_upload",
        synthetic: false,
        sha256: contentHash,
        purpose: kind === "video" ? "character_video_library" : "character_library",
        uploadAuthority: {
          schemaVersion: OPERATOR_UPLOAD_AUTHORITY_SCHEMA,
          kind: "operator_upload",
          assetId: sourceId,
          uploadedById: adminId,
          sha256: contentHash,
        },
      },
    },
  });

  const visualValues = {
    characterId: character.id,
    version: 1,
    status: "active",
    style: "realistic",
    identityPrompt: "Luna official identity",
    negativeIdentityPrompt: null,
    faceTraits: {},
    hairTraits: {},
    bodyTraits: {},
    signatureTraits: {},
    styleTraits: {},
    anchorAssetIds: [sourceAsset.id],
    adapterRefs: {},
    createdFrom: "test",
  };
  const visual = await prisma.characterVisualProfile.create({
    data: { ...visualValues, immutableHash: characterVisualProfileSnapshotHash(visualValues) },
  });

  const descriptor = {
    kind,
    description: "Luna smiling in a red dress by the beach.",
    facts: ["red dress", "beach"],
    absentFacts: ["glasses"],
    nudity: options?.nudity ?? "none",
    durationSeconds: kind === "video" ? 5 : null,
    hasAudio: kind === "video" ? true : null,
  };
  const entry = await prisma.characterMediaLibraryEntry.create({
    data: {
      id: `${id}-entry`,
      characterId: character.id,
      sourceAssetId: sourceAsset.id,
      visualProfileId: visual.id,
      visualProfileVersion: visual.version,
      status: options?.status ?? "published",
      ...descriptor,
      nudityVerifiedById: (options?.nudity ?? "none") !== "unknown" ? adminId : null,
      width: 16,
      height: 16,
      contentType,
      storageKey: libraryKey,
      thumbnailKey: null,
      contentHash,
      embedding: [1, 0],
      embeddingModel: "fixture-embedding",
      embeddingDimensions: 2,
      embeddingHash: libraryDescriptorHash(descriptor),
      sourceSnapshot: { assetId: sourceAsset.id, characterId: character.id, sourceStorageKey: sourceKey, visualProfileHash: visual.immutableHash },
      createdById: adminId,
      updatedById: adminId,
    },
  });

  const session = await createChatSession(id, { characterId: character.id });
  await prisma.recentChat.update({ where: { sessionId: session.id }, data: { memoryEnabled: false } });
  const begin = async (text = "Send me a photo") => {
    const res = await beginChatTurn({
      sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION,
      userId: id,
      sessionId: session.id,
      content: text,
      idempotencyKey: randomUUID(),
      allowPaidImage: true,
    });
    if (!res.snapshot) throw new Error("Expected snapshot");
    return res.snapshot;
  };
  return { id, adminId, character, visual, sourceAsset, entry, session, begin };
}

describe("Paid delayed curated media fulfillment & write-path safety", () => {
  it("computes controlled server-side reveal windows for images (3-6s) and videos (5-12s)", () => {
    const now = new Date("2026-11-21T00:00:00.000Z");
    const imgDeliverAt = computeCuratedMediaDeliverAt("image", now);
    const imgDelta = imgDeliverAt.getTime() - now.getTime();
    expect(imgDelta).toBeGreaterThanOrEqual(CURATED_IMAGE_DELAY_RANGE_MS[0]);
    expect(imgDelta).toBeLessThanOrEqual(CURATED_IMAGE_DELAY_RANGE_MS[1]);

    const vidDeliverAt = computeCuratedMediaDeliverAt("video", now);
    const vidDelta = vidDeliverAt.getTime() - now.getTime();
    expect(vidDelta).toBeGreaterThanOrEqual(CURATED_VIDEO_DELAY_RANGE_MS[0]);
    expect(vidDelta).toBeLessThanOrEqual(CURATED_VIDEO_DELAY_RANGE_MS[1]);
  });

  it("charges 5 coins for official image, hides mediaAssetId/source until deliverAt, reveals with zero blob I/O, and prevents lifetime duplicate charges after chat deletion", async () => {
    const f = await officialFixture({ kind: "image", coins: 20 });
    const snapshot = await f.begin("Send me a beach photo");
    const attachmentId = `chatfx_${randomUUID().replace(/-/g, "")}`;
    const now = new Date("2026-11-21T01:00:00.000Z");

    const scheduled = await schedulePaidCuratedMediaDelivery({
      userId: f.id,
      turnId: snapshot.turnId,
      attempt: snapshot.attempt,
      attachmentId,
      entryId: f.entry.id,
      visualProfileId: f.visual.id,
      visualProfileVersion: f.visual.version,
      effectMetadata: { turnId: snapshot.turnId, attempt: snapshot.attempt, name: "request_character_media" },
      requestMetadata: { kind: "image", subject: "companion" },
      now,
      overrideDelayMs: 4_000,
    });
    expect(scheduled.status).toBe("accepted");
    expect(scheduled.costDreamcoins).toBe(5);
    expect(await dreamcoinBalance(f.id)).toBe(15);

    // Replay with the same attachmentId never double-charges.
    const replay = await schedulePaidCuratedMediaDelivery({
      userId: f.id,
      turnId: snapshot.turnId,
      attempt: snapshot.attempt,
      attachmentId,
      entryId: f.entry.id,
      visualProfileId: f.visual.id,
      visualProfileVersion: f.visual.version,
      effectMetadata: { turnId: snapshot.turnId, attempt: snapshot.attempt, name: "request_character_media" },
      requestMetadata: { kind: "image", subject: "companion" },
      now,
      overrideDelayMs: 4_000,
    });
    expect(replay.duplicate).toBe(true);
    expect(await dreamcoinBalance(f.id)).toBe(15);

    // Before deliverAt: public session hides mediaAssetId, mediaUrl, and internal library source.
    const sessionBefore = await getChatSession(f.id, f.session.id);
    const pendingAtt = sessionBefore.messages
      .flatMap((m) => (Array.isArray(m.attachments) ? (m.attachments as Array<Record<string, unknown>>) : []))
      .find((a) => a.id === attachmentId);
    expect(pendingAtt).toBeDefined();
    expect(pendingAtt?.status).toBe("accepted");
    expect(pendingAtt?.mediaAssetId).toBeNull();
    expect(pendingAtt?.mediaUrl).toBeUndefined();
    expect(pendingAtt?.source).toBeUndefined();

    // Sweeper before deliverAt does nothing.
    const early = await revealDueDelayedChatMedia(10, new Date(now.getTime() + 2_000));
    expect(early.revealed).toBe(0);

    // Sweeper at deliverAt reveals with ZERO blob getPrivate I/O!
    const getPrivateSpy = vi.spyOn(providers.blob, "getPrivate");
    const due = await revealDueDelayedChatMedia(10, new Date(now.getTime() + 4_500));
    expect(due.revealed).toBe(1);
    expect(getPrivateSpy).not.toHaveBeenCalled();

    const completed = await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(completed.status).toBe("completed");
    expect(completed.mediaAssetId).toBeTruthy();

    const updatedEntry = await prisma.characterMediaLibraryEntry.findUniqueOrThrow({ where: { id: f.entry.id } });
    expect(updatedEntry.paidDeliveryCount).toBe(1);

    // Cannot cancel/refund once revealed.
    await expect(cancelPendingDelayedChatMedia({ userId: f.id, attachmentId })).rejects.toMatchObject({ code: "conflict" });

    // Finish turn, delete entire chat session, open a new session: lifetime receipt STILL prevents re-selling the same asset!
    await commitChatTerminal({
      version: 1,
      turnId: snapshot.turnId,
      sessionId: snapshot.sessionId,
      assistantMessageId: snapshot.assistantMessageId,
      attempt: snapshot.attempt,
      status: "sent",
      content: "Just sent it!",
      model: "fixture",
      promptTokens: 10,
      completionTokens: 5,
      sceneVersion: snapshot.sceneVersion + 1,
      scene: {
        schemaVersion: 1,
        version: snapshot.sceneVersion + 1,
        location: "beach",
        time: null,
        participants: [],
        emotionalBeat: null,
        unresolvedThreads: [],
      },
      terminalEvidence: {
        authority: "test",
        prompt: {
          productPromptVersion: "companion-product-1",
          preparedTurnVersion: 5,
          systemPromptDigest: "a".repeat(64),
          soulFingerprint: "b".repeat(64),
        },
      },
    });
    await deleteChatSession(f.id, f.session.id);

    const newSession = await createChatSession(f.id, { characterId: f.character.id });
    await prisma.recentChat.update({ where: { sessionId: newSession.id }, data: { memoryEnabled: false } });
    const nextTurn = await beginChatTurn({
      sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION,
      userId: f.id,
      sessionId: newSession.id,
      content: "Send another beach photo",
      idempotencyKey: randomUUID(),
      allowPaidImage: true,
    });
    await expect(schedulePaidCuratedMediaDelivery({
      userId: f.id,
      turnId: nextTurn.snapshot!.turnId,
      attempt: nextTurn.snapshot!.attempt,
      attachmentId: `chatfx_${randomUUID().replace(/-/g, "")}`,
      entryId: f.entry.id,
      visualProfileId: f.visual.id,
      visualProfileVersion: f.visual.version,
      effectMetadata: {},
      requestMetadata: {},
      now,
      overrideDelayMs: 4_000,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(await dreamcoinBalance(f.id)).toBe(15);
  });

  it("charges 30 coins for official curated video (open to free user with balance), rejects insufficient balance with 402, and rejects non-official characters", async () => {
    const poor = await officialFixture({ kind: "video", coins: 25 });
    const poorTurn = await poor.begin("Send me a video");
    await expect(schedulePaidCuratedMediaDelivery({
      userId: poor.id,
      turnId: poorTurn.turnId,
      attempt: poorTurn.attempt,
      attachmentId: `chatfx_${randomUUID().replace(/-/g, "")}`,
      entryId: poor.entry.id,
      visualProfileId: poor.visual.id,
      visualProfileVersion: poor.visual.version,
      effectMetadata: {},
      requestMetadata: {},
      overrideDelayMs: 6_000,
    })).rejects.toMatchObject({ code: "payment_required" });
    expect(await dreamcoinBalance(poor.id)).toBe(25);

    const funded = await officialFixture({ kind: "video", coins: 50 });
    const fundedTurn = await funded.begin("Send me a video");
    const vidAttachmentId = `chatfx_${randomUUID().replace(/-/g, "")}`;
    const scheduled = await schedulePaidCuratedMediaDelivery({
      userId: funded.id,
      turnId: fundedTurn.turnId,
      attempt: fundedTurn.attempt,
      attachmentId: vidAttachmentId,
      entryId: funded.entry.id,
      visualProfileId: funded.visual.id,
      visualProfileVersion: funded.visual.version,
      effectMetadata: {},
      requestMetadata: {},
      overrideDelayMs: 6_000,
    });
    expect(scheduled.costDreamcoins).toBe(30);
    expect(scheduled.kind).toBe("generated_video");
    expect(await dreamcoinBalance(funded.id)).toBe(20);

    // Non-official (UGC) character is forbidden.
    const ugc = await officialFixture({ kind: "image", source: "user", coins: 50 });
    const ugcTurn = await ugc.begin("Send me a photo");
    await expect(schedulePaidCuratedMediaDelivery({
      userId: ugc.id,
      turnId: ugcTurn.turnId,
      attempt: ugcTurn.attempt,
      attachmentId: `chatfx_${randomUUID().replace(/-/g, "")}`,
      entryId: ugc.entry.id,
      visualProfileId: ugc.visual.id,
      visualProfileVersion: ugc.visual.version,
      effectMetadata: {},
      requestMetadata: {},
      overrideDelayMs: 3_000,
    })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refunds full DreamCoins and releases receipt when message is deleted before deliverAt or entry is withdrawn during delay", async () => {
    // Case A: user deletes message after text commits but before delayed media reveals.
    const f1 = await officialFixture({ kind: "image", coins: 10 });
    const t1 = await f1.begin("Send a photo");
    const att1 = `chatfx_${randomUUID().replace(/-/g, "")}`;
    await schedulePaidCuratedMediaDelivery({
      userId: f1.id,
      turnId: t1.turnId,
      attempt: t1.attempt,
      attachmentId: att1,
      entryId: f1.entry.id,
      visualProfileId: f1.visual.id,
      visualProfileVersion: f1.visual.version,
      effectMetadata: {},
      requestMetadata: {},
      overrideDelayMs: 60_000,
    });
    expect(await dreamcoinBalance(f1.id)).toBe(5);
    await commitChatTerminal({
      version: 1,
      turnId: t1.turnId,
      sessionId: t1.sessionId,
      assistantMessageId: t1.assistantMessageId,
      attempt: t1.attempt,
      status: "sent",
      content: "Hold on, sending it soon!",
      model: "fixture",
      promptTokens: 10,
      completionTokens: 5,
      sceneVersion: t1.sceneVersion + 1,
      scene: {
        schemaVersion: 1,
        version: t1.sceneVersion + 1,
        location: "beach",
        time: null,
        participants: [],
        emotionalBeat: null,
        unresolvedThreads: [],
      },
      terminalEvidence: {
        authority: "test",
        prompt: {
          productPromptVersion: "companion-product-1",
          preparedTurnVersion: 5,
          systemPromptDigest: "a".repeat(64),
          soulFingerprint: "b".repeat(64),
        },
      },
    });
    await deleteChatMessage(f1.id, t1.assistantMessageId);
    expect(await dreamcoinBalance(f1.id)).toBe(10);
    expect(await prisma.userCharacterLibraryReceipt.count({ where: { userId: f1.id, entryId: f1.entry.id } })).toBe(0);

    // Case B: operator withdraws entry during delay window -> sweeper refunds 30 coins atomically.
    const f2 = await officialFixture({ kind: "video", coins: 40 });
    const t2 = await f2.begin("Send a video");
    const att2 = `chatfx_${randomUUID().replace(/-/g, "")}`;
    const now = new Date("2026-11-21T02:00:00.000Z");
    await schedulePaidCuratedMediaDelivery({
      userId: f2.id,
      turnId: t2.turnId,
      attempt: t2.attempt,
      attachmentId: att2,
      entryId: f2.entry.id,
      visualProfileId: f2.visual.id,
      visualProfileVersion: f2.visual.version,
      effectMetadata: {},
      requestMetadata: {},
      now,
      overrideDelayMs: 5_000,
    });
    expect(await dreamcoinBalance(f2.id)).toBe(10);
    await prisma.characterMediaLibraryEntry.update({ where: { id: f2.entry.id }, data: { status: "withdrawn" } });
    const sweep = await revealDueDelayedChatMedia(10, new Date(now.getTime() + 6_000));
    expect(sweep.refunded).toBe(1);
    expect(await dreamcoinBalance(f2.id)).toBe(40);
    const refundedAtt = await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: att2 } });
    expect(refundedAtt.status).toBe("refunded");
    expect(refundedAtt.errorCode).toBe("library_entry_withdrawn");
  });

  it("blocks archiving source assets referenced by published library entries and supports fail-closed batch review", async () => {
    const f = await officialFixture({ kind: "image", status: "draft", nudity: "unknown" });
    // Draft does not block source archival yet; batch publishing without explicit nudity is rejected.
    expect((await mediaAssetAuthorityDependencies(prisma, f.sourceAsset.id)).some(d => d.kind === "character_media_library")).toBe(false);
    await expect(batchReviewCharacterMediaLibrary({
      characterId: f.character.id,
      actor: { id: f.adminId, role: "admin" },
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      body: { items: [{ entryId: f.entry.id, expectedRevision: 1, status: "published" }] },
    })).rejects.toMatchObject({ code: "bad_request" });

    // Batch publish with explicit nudity sets nudityVerifiedById and activates archival dependency guard.
    const reviewed = await batchReviewCharacterMediaLibrary({
      characterId: f.character.id,
      actor: { id: f.adminId, role: "admin" },
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      body: { items: [{ entryId: f.entry.id, expectedRevision: 1, status: "published", nudity: "partial" }] },
    });
    expect(reviewed.entries).toHaveLength(1);
    expect(reviewed.entries[0]?.status).toBe("published");
    expect(reviewed.entries[0]?.nudity).toBe("partial");
    const row = await prisma.characterMediaLibraryEntry.findUniqueOrThrow({ where: { id: f.entry.id } });
    expect(row.nudityVerifiedById).toBe(f.adminId);
    const deps = await mediaAssetAuthorityDependencies(prisma, f.sourceAsset.id);
    expect(deps).toContainEqual(expect.objectContaining({ kind: "character_media_library", entryId: f.entry.id }));
  });
});
