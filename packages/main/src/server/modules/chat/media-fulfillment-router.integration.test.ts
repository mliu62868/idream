import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { compileCharacterSoul } from "@idream/shared";
import {
  REQUEST_CHARACTER_MEDIA_TOOL,
  RESEND_SESSION_MEDIA_TOOL,
} from "@idream/shared/chat/media-library";
import { CHAT_SEND_PROTOCOL_VERSION, type ChatToolEffect } from "@idream/shared/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { OPERATOR_UPLOAD_AUTHORITY_SCHEMA } from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import {
  createCharacter,
  createUser,
  dreamcoinBalance,
  grantCoins,
  purgeTestData,
} from "@/server/test/helpers";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { characterContentHash } from "@/server/modules/admin-v2/shared/character-content-identity";
import { createReferenceSetRevision } from "@/server/modules/ourdream/generation-reference-set";
import * as generation from "@/server/modules/ourdream/service";
import { libraryDescriptorHash } from "@/server/modules/character-media-library/service";
import * as mediaModels from "@/server/modules/character-media-library/media-models";
import { applyChatToolEffect } from "./tool-effect";
import { cancelChatMediaQuote, confirmChatMediaQuote } from "./media-fulfillment-router";
import { revealDueDelayedChatMedia } from "./delayed-media-reveal";
import { beginChatTurn, commitChatTerminal, createChatSession, getChatSession } from "./turn-ledger";

const prefix = `zt-media-router-${randomUUID()}-`;
const keys: string[] = [];

beforeEach(() => {
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_URL", "http://media-embedding.test.invalid/v1");
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_MODEL", "fixture-embedding");
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_DIMENSIONS", "2");
  vi.spyOn(mediaModels, "embedMediaText").mockResolvedValue({
    model: "fixture-embedding",
    dimensions: 2,
    vector: [1, 0],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.userCharacterLibraryReceipt.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.characterMediaLibraryEntry.deleteMany({ where: { id: { startsWith: prefix } } });
  await purgeTestData(prefix);
  for (const key of keys) await providers.blob.delete({ key });
});

async function seedOfficialFixture(kind: "image" | "video" = "image") {
  const id = `${prefix}${randomUUID()}`;
  await createUser({ id });
  await grantCoins(id, 100);
  const operatorId = `${id}-op`;
  await createUser({ id: operatorId });
  const character = await createCharacter({
    id: `${id}-char`,
    creatorId: id,
    source: "official",
    visibility: "public",
    advancedDetails: { imageToolEnabled: true },
  });
  const soul = compileCharacterSoul({
    name: "Mina",
    age: 24,
    gender: "female",
    characterPromise: "Warm companion",
    detailsMarkdown: "Warm and playful.",
  });
  if (!soul.ok) throw new Error("Invalid soul");
  const contentValues = {
    personaSnapshot: soul.snapshot,
    openingSnapshot: { firstMessage: "Hey there." },
    appearanceSnapshot: {},
  };
  const content = await prisma.characterContentVersion.create({
    data: {
      characterId: character.id,
      version: 1,
      sourceType: "test",
      contentHash: characterContentHash(contentValues),
      ...JSON.parse(JSON.stringify(contentValues)),
    },
  });
  await prisma.character.update({
    where: { id: character.id },
    data: { currentContentVersionId: content.id },
  });

  const bytes = kind === "image"
    ? await sharp({ create: { width: 16, height: 16, channels: 3, background: "#cc3366" } }).png().toBuffer()
    : await readFile(new URL("../../../e2e/fixtures/collection-playback.mp4", import.meta.url));
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const sourceKey = `${id}/source.${kind === "image" ? "png" : "mp4"}`;
  const libraryKey = `${id}/library.${kind === "image" ? "png" : "mp4"}`;
  const contentType = kind === "image" ? "image/png" : "video/mp4";
  keys.push(sourceKey, libraryKey);
  await providers.blob.putPrivate({ key: sourceKey, body: bytes, contentType });
  await providers.blob.putPrivate({ key: libraryKey, body: bytes, contentType });

  const sourceId = `${id}-src`;
  const source = await prisma.mediaAsset.create({
    data: {
      id: sourceId,
      ownerId: operatorId,
      characterId: character.id,
      type: kind,
      url: `/api/media/${sourceId}/content.${kind === "image" ? "png" : "mp4"}`,
      storageKey: sourceKey,
      contentType,
      safetyStatus: "passed",
      metadata: {
        source: "admin_asset_upload",
        synthetic: false,
        sha256: contentHash,
        uploadAuthority: {
          schemaVersion: OPERATOR_UPLOAD_AUTHORITY_SCHEMA,
          kind: "operator_upload",
          assetId: sourceId,
          uploadedById: operatorId,
          sha256: contentHash,
        },
      },
    },
  });

  const anchorKey = `${id}/anchor.png`;
  const anchorBytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#334455" } }).png().toBuffer();
  keys.push(anchorKey);
  await providers.blob.putPrivate({ key: anchorKey, body: anchorBytes, contentType: "image/png" });
  const anchor = await prisma.mediaAsset.create({
    data: {
      id: `${id}-anchor`,
      ownerId: operatorId,
      characterId: character.id,
      type: "image",
      url: `/api/media/${id}-anchor/content.png`,
      storageKey: anchorKey,
      contentType: "image/png",
      safetyStatus: "passed",
      metadata: { synthetic: false },
    },
  });

  const visualValues = {
    characterId: character.id,
    version: 1,
    status: "active",
    style: "realistic",
    identityPrompt: "Mina",
    negativeIdentityPrompt: null,
    faceTraits: {},
    hairTraits: {},
    bodyTraits: {},
    signatureTraits: {},
    styleTraits: {},
    anchorAssetIds: [anchor.id],
    adapterRefs: {},
    createdFrom: "test",
  };
  const visual = await prisma.characterVisualProfile.create({
    data: { ...visualValues, immutableHash: characterVisualProfileSnapshotHash(visualValues) },
  });
  await prisma.$transaction((tx) =>
    createReferenceSetRevision(tx, visual, "test", [
      { mediaAssetId: anchor.id, position: 0, role: "identity_anchor", weight: 1, selectionReason: "fixture" },
    ]),
  );

  const descriptor = {
    kind,
    description: "Mina wearing a red dress beside a rainy window.",
    facts: ["red dress", "rainy window"],
    absentFacts: ["hat", "glasses"],
    nudity: "none",
    durationSeconds: kind === "video" ? 4 : null,
    hasAudio: kind === "video" ? false : null,
  };
  const entry = await prisma.characterMediaLibraryEntry.create({
    data: {
      id: `${id}-entry`,
      characterId: character.id,
      sourceAssetId: source.id,
      visualProfileId: visual.id,
      visualProfileVersion: visual.version,
      status: "published",
      attireLevel: "clothed",
      distributionScope: "chat_library",
      nudityVerifiedById: operatorId,
      ...descriptor,
      width: 16,
      height: 16,
      contentType,
      storageKey: libraryKey,
      contentHash,
      embedding: [1, 0],
      embeddingModel: "fixture-embedding",
      embeddingDimensions: 2,
      embeddingHash: libraryDescriptorHash(descriptor),
      sourceSnapshot: {
        assetId: source.id,
        sourceStorageKey: sourceKey,
        visualProfileHash: visual.immutableHash,
      },
      createdById: operatorId,
      updatedById: operatorId,
    },
  });

  const session = await createChatSession(id, { characterId: character.id });
  await prisma.recentChat.update({ where: { sessionId: session.id }, data: { memoryEnabled: false } });
  const begin = async (text: string, allowPaidImage = false) => {
    const res = await beginChatTurn({
      sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION,
      userId: id,
      sessionId: session.id,
      content: text,
      idempotencyKey: randomUUID(),
      allowPaidImage,
    });
    if (!res.snapshot) throw new Error("No frozen turn");
    return res.snapshot;
  };
  return { id, operatorId, character, session, entry, begin };
}

describe("unified paid media fulfillment router", () => {
  it("charges 5 DreamCoins and schedules delayed curated image reveal when paid mode is authorized", async () => {
    const f = await seedOfficialFixture("image");
    const snapshot = await f.begin("Send me a photo in a red dress by a rainy window.", true);
    const effect: ChatToolEffect = {
      version: 2,
      turnId: snapshot.turnId,
      attempt: snapshot.attempt,
      callId: "call-img-1",
      name: REQUEST_CHARACTER_MEDIA_TOOL,
      effectScope: "turn_action",
      intent: { requestedNudity: "none" },
      arguments: {
        kind: "image",
        direction: "red dress by a rainy window",
        subject: "companion",
        mode: "auto",
        mustHave: ["red dress"],
        mustExclude: ["hat"],
        requestedNudity: "none",
      },
    };
    const res = await applyChatToolEffect(effect);
    expect(res).toMatchObject({
      accepted: true,
      status: "accepted",
      kind: "image",
      costDreamcoins: 5,
    });
    expect(await dreamcoinBalance(f.id)).toBe(95);

    const attachment = await prisma.chatTurnAttachment.findUniqueOrThrow({
      where: { id: res.attachmentId! },
    });
    expect(attachment.status).toBe("accepted");
    expect(attachment.mediaAssetId).toBeNull();
    expect(attachment.deliverAt).not.toBeNull();

    // Advance deliverAt to now and reveal via sweeper
    await prisma.chatTurnAttachment.update({
      where: { id: attachment.id },
      data: { deliverAt: new Date(Date.now() - 1_000) },
    });
    const revealed = await revealDueDelayedChatMedia(10);
    expect(revealed.revealed).toBeGreaterThanOrEqual(1);

    const after = await prisma.chatTurnAttachment.findUniqueOrThrow({
      where: { id: attachment.id },
    });
    expect(after.status).toBe("completed");
    expect(after.mediaAssetId).not.toBeNull();
  });

  it("returns no_match with 0 charge on curated video miss and never shows a quote card or upgrades to live video", async () => {
    const f = await seedOfficialFixture("video");
    const snapshot = await f.begin("Send me a video with audio wearing a tuxedo.", false);
    const effect: ChatToolEffect = {
      version: 2,
      turnId: snapshot.turnId,
      attempt: snapshot.attempt,
      callId: "call-vid-miss",
      name: REQUEST_CHARACTER_MEDIA_TOOL,
      effectScope: "turn_action",
      intent: { requestedNudity: "none" },
      arguments: {
        kind: "video",
        direction: "tuxedo with audio",
        subject: "companion",
        mode: "auto",
        mustHave: [],
        mustExclude: [],
        hasAudio: true,
        requestedNudity: "none",
      },
    };
    const res = await applyChatToolEffect(effect);
    expect(res).toEqual({
      accepted: true,
      duplicate: false,
      status: "no_match",
      kind: "video",
      costDreamcoins: 0,
      suggestedAction: "photo_instead",
    });
    expect(await dreamcoinBalance(f.id)).toBe(100);
  });

  it("emits an awaiting_confirmation 30-coin quote card in chat mode and settles on confirm", async () => {
    const f = await seedOfficialFixture("video");
    const snapshot = await f.begin("Send me a video in a red dress by a rainy window.", false);
    const effect: ChatToolEffect = {
      version: 2,
      turnId: snapshot.turnId,
      attempt: snapshot.attempt,
      callId: "call-vid-quote",
      name: REQUEST_CHARACTER_MEDIA_TOOL,
      effectScope: "turn_action",
      intent: { requestedNudity: "none" },
      arguments: {
        kind: "video",
        direction: "red dress rainy window",
        subject: "companion",
        mode: "auto",
        mustHave: [],
        mustExclude: [],
        requestedNudity: "none",
      },
    };
    const quote = await applyChatToolEffect(effect);
    expect(quote).toMatchObject({
      accepted: true,
      status: "awaiting_confirmation",
      kind: "video",
      costDreamcoins: 30,
    });
    expect(await dreamcoinBalance(f.id)).toBe(100);

    const confirmed = await confirmChatMediaQuote(f.id, quote.attachmentId!);
    expect(confirmed).toMatchObject({
      status: "accepted",
      kind: "video",
      attachmentId: quote.attachmentId,
      costDreamcoins: 30,
    });
    expect(await dreamcoinBalance(f.id)).toBe(70);

    // Idempotent retry does not double-charge
    const again = await confirmChatMediaQuote(f.id, quote.attachmentId!);
    expect(again).toMatchObject({ attachmentId: quote.attachmentId, duplicate: true });
    expect(await dreamcoinBalance(f.id)).toBe(70);
  });

  it("still requires a video quote on a message authorized for one paid image", async () => {
    const f = await seedOfficialFixture("video");
    const snapshot = await f.begin("Send a video in the red dress.", true);
    const quote = await applyChatToolEffect({
      version: 2, turnId: snapshot.turnId, attempt: snapshot.attempt, callId: "video-after-photo-consent",
      name: REQUEST_CHARACTER_MEDIA_TOOL, effectScope: "turn_action",
      intent: { requestedNudity: "unspecified" },
      arguments: { kind: "video", direction: "Mina in the red dress", subject: "companion", mustHave: ["red dress"] },
    });
    expect(quote).toMatchObject({ status: "awaiting_confirmation", costDreamcoins: 30 });
    expect(await dreamcoinBalance(f.id)).toBe(100);
    expect(await prisma.userCharacterLibraryReceipt.count({ where: { userId: f.id } })).toBe(0);
  });

  it("replays the same paid image quote and atomically reserves live generation once after confirmation", async () => {
    const f = await seedOfficialFixture();
    const snapshot = await f.begin("Please create a picture of the empty balcony.");
    const call: ChatToolEffect = {
      version: 2, turnId: snapshot.turnId, attempt: snapshot.attempt, callId: "live-image-quote",
      name: REQUEST_CHARACTER_MEDIA_TOOL, effectScope: "turn_action",
      intent: { requestedNudity: "unspecified" },
      arguments: { kind: "image", direction: "An empty balcony beneath overcast skies", subject: "scene", mode: "force_new" },
    };
    const [first, replay] = await Promise.all([applyChatToolEffect(call), applyChatToolEffect(call)]);
    expect(first).toMatchObject({ status: "awaiting_confirmation", confirmationKind: "paid_media_quote", costDreamcoins: 5 });
    expect(replay).toMatchObject({ status: "awaiting_confirmation", attachmentId: first.attachmentId });
    expect(await dreamcoinBalance(f.id)).toBe(100);
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
    const [confirmed, again] = await Promise.all([
      confirmChatMediaQuote(f.id, first.attachmentId!), confirmChatMediaQuote(f.id, first.attachmentId!),
    ]);
    expect(confirmed).toMatchObject({ status: "accepted", costDreamcoins: 5, generationJobId: expect.any(String) });
    expect(again.generationJobId).toBe(confirmed.generationJobId);
    expect([confirmed.duplicate, again.duplicate].sort()).toEqual([false, true]);
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(1);
    expect(await dreamcoinBalance(f.id)).toBe(95);
    await expect(applyChatToolEffect({ ...call, arguments: { ...call.arguments, direction: "A crowded train station" } }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it.each([
    { kind: "image", mode: "auto", generates: true },
    { kind: "image", mode: "existing_only", generates: false },
    { kind: "video", mode: "auto", generates: false },
  ] as const)("admits live generation only for an automatic image when the quoted $kind stock vanishes ($mode)", async ({ kind, mode, generates }) => {
    const f = await seedOfficialFixture(kind);
    const snapshot = await f.begin("Send me Mina in a red dress by the rainy window.");
    const quote = await applyChatToolEffect({
      version: 2, turnId: snapshot.turnId, attempt: snapshot.attempt, callId: "withdrawn-after-quote",
      name: REQUEST_CHARACTER_MEDIA_TOOL, effectScope: "turn_action", intent: { requestedNudity: "none" },
      arguments: { kind, mode, subject: "companion", direction: "Mina in a red dress by the rainy window", mustHave: ["red dress"], requestedNudity: "none" },
    });
    expect(quote).toMatchObject({ status: "awaiting_confirmation" });
    await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { status: "withdrawn" } });
    if (generates) {
      const receipt = await confirmChatMediaQuote(f.id, quote.attachmentId!);
      expect(receipt).toMatchObject({ attachmentId: quote.attachmentId, costDreamcoins: 5, duplicate: false, generationJobId: expect.any(String) });
      await expect(confirmChatMediaQuote(f.id, quote.attachmentId!)).resolves.toMatchObject({ generationJobId: receipt.generationJobId, duplicate: true });
    } else {
      await expect(confirmChatMediaQuote(f.id, quote.attachmentId!)).rejects.toMatchObject({ code: "conflict" });
    }
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(generates ? 1 : 0);
    expect(await prisma.userCharacterLibraryReceipt.count({ where: { userId: f.id } })).toBe(0);
    expect(await dreamcoinBalance(f.id)).toBe(generates ? 95 : 100);
  });

  it("replays the confirmed stock receipt when an earlier confirmation is still preparing live generation", async () => {
    const f = await seedOfficialFixture();
    const snapshot = await f.begin("Send me a photo of Mina beside the rainy window.");
    const quote = await applyChatToolEffect({
      version: 2, turnId: snapshot.turnId, attempt: snapshot.attempt, callId: "stock-and-live-confirmation",
      name: REQUEST_CHARACTER_MEDIA_TOOL, effectScope: "turn_action", intent: { requestedNudity: "none" },
      arguments: { kind: "image", mode: "auto", direction: "Mina beside the rainy window", subject: "companion", requestedNudity: "none" },
    });
    expect(quote).toMatchObject({ status: "awaiting_confirmation", costDreamcoins: 5 });
    const attachmentId = quote.attachmentId!;
    const preparingLive = Promise.withResolvers<void>();
    const resumeLive = Promise.withResolvers<void>();
    const admit = generation.createChatImageGenerationJob;
    vi.spyOn(generation, "createChatImageGenerationJob").mockImplementationOnce(async (...args) => {
      preparingLive.resolve();
      await resumeLive.promise;
      return admit(...args);
    });
    await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { status: "withdrawn" } });
    const first = confirmChatMediaQuote(f.id, attachmentId);
    try {
      await Promise.race([preparingLive.promise, first.then(() => { throw new Error("Live admission was not reached"); })]);
      await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { status: "published" } });
      const stock = await confirmChatMediaQuote(f.id, attachmentId);
      expect(stock).toMatchObject({ attachmentId, status: "accepted", costDreamcoins: 5, generationJobId: null, duplicate: false });
      resumeLive.resolve();
      expect(await first).toEqual({ ...stock, duplicate: true });
      expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
      expect(await prisma.userCharacterLibraryReceipt.count({ where: { userId: f.id, firstAttachmentId: attachmentId } })).toBe(1);
      expect(await dreamcoinBalance(f.id)).toBe(95);
    } finally {
      resumeLive.resolve();
      await Promise.allSettled([first]);
    }
  });

  it("treats a changed image quote price as a refusal instead of trying another fulfillment route", async () => {
    const f = await seedOfficialFixture();
    const snapshot = await f.begin("Send me a photo of Mina beside the window.");
    const quote = await applyChatToolEffect({
      version: 2, turnId: snapshot.turnId, attempt: snapshot.attempt, callId: "price-changed-after-quote",
      name: REQUEST_CHARACTER_MEDIA_TOOL, effectScope: "turn_action", intent: { requestedNudity: "none" },
      arguments: { kind: "image", mode: "auto", direction: "Mina beside the rainy window", subject: "companion", requestedNudity: "none" },
    });
    expect(quote).toMatchObject({ status: "awaiting_confirmation", costDreamcoins: 5 });
    const rule = await prisma.pricingRule.findFirstOrThrow({ where: { mode: "image", status: "active" } });
    const admit = vi.spyOn(generation, "createChatImageGenerationJob");
    try {
      await prisma.pricingRule.update({ where: { id: rule.id }, data: { baseCost: rule.baseCost + 1 } });
      await expect(confirmChatMediaQuote(f.id, quote.attachmentId!)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("price changed") });
      expect(admit).not.toHaveBeenCalled();
      expect(await dreamcoinBalance(f.id)).toBe(100);
    } finally {
      await prisma.pricingRule.update({ where: { id: rule.id }, data: { baseCost: rule.baseCost, updatedAt: rule.updatedAt } });
    }
  });

  it.each([
    { mode: "availability", mustHave: ["red dress"], status: "available" },
    { mode: "existing_only", mustHave: ["yellow coat"], status: "no_match" },
  ])("returns $status for $mode without an attachment, a job or a charge", async ({ mode, mustHave, status }) => {
    const f = await seedOfficialFixture();
    const snapshot = await f.begin("Check for a photo with those clothes.", true);
    expect(await applyChatToolEffect({
      version: 2, turnId: snapshot.turnId, attempt: snapshot.attempt, callId: "check-curated",
      name: REQUEST_CHARACTER_MEDIA_TOOL, effectScope: "turn_action",
      intent: { requestedNudity: "unspecified" },
      arguments: { kind: "image", direction: mustHave[0], subject: "companion", mode, mustHave },
    })).toEqual({ accepted: true, duplicate: false, status, kind: "image", costDreamcoins: 0 });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
    expect(await dreamcoinBalance(f.id)).toBe(100);
  });

  it("cancels an awaiting_confirmation quote card with 0 charge", async () => {
    const f = await seedOfficialFixture("video");
    const snapshot = await f.begin("Send me a video in a red dress.", false);
    const quote = await applyChatToolEffect({
      version: 2,
      turnId: snapshot.turnId,
      attempt: snapshot.attempt,
      callId: "call-vid-cancel",
      name: REQUEST_CHARACTER_MEDIA_TOOL,
      effectScope: "turn_action",
      intent: { requestedNudity: "none" },
      arguments: { kind: "video", direction: "red dress", subject: "companion", mode: "auto", mustHave: [], mustExclude: [], requestedNudity: "none" },
    });
    expect("status" in quote && quote.status).toBe("awaiting_confirmation");

    const cancelled = await cancelChatMediaQuote(f.id, quote.attachmentId!);
    expect(cancelled).toEqual({
      attachmentId: quote.attachmentId,
      status: "cancelled",
      costDreamcoins: 0,
    });
    expect(await dreamcoinBalance(f.id)).toBe(100);
  });

  it("supports free instant resend of previously delivered session media without re-charging", async () => {
    const f = await seedOfficialFixture("image");
    const turn1 = await f.begin("Send me a photo in a red dress.", true);
    const first = await applyChatToolEffect({
      version: 2,
      turnId: turn1.turnId,
      attempt: turn1.attempt,
      callId: "call-first",
      name: REQUEST_CHARACTER_MEDIA_TOOL,
      effectScope: "turn_action",
      intent: { requestedNudity: "none" },
      arguments: { kind: "image", direction: "red dress", subject: "companion", mode: "auto", mustHave: [], mustExclude: [], requestedNudity: "none" },
    });
    await prisma.chatTurnAttachment.update({
      where: { id: first.attachmentId! },
      data: { deliverAt: new Date(Date.now() - 1_000) },
    });
    await revealDueDelayedChatMedia(10);
    const revealedAttachment = await prisma.chatTurnAttachment.findUniqueOrThrow({
      where: { id: first.attachmentId! },
    });
    await commitChatTerminal({
      version: 1,
      turnId: turn1.turnId,
      sessionId: turn1.sessionId,
      assistantMessageId: turn1.assistantMessageId,
      attempt: turn1.attempt,
      status: "sent",
      content: "Here you go.",
      model: "fixture",
      promptTokens: 10,
      completionTokens: 2,
      sceneVersion: turn1.sceneVersion + 1,
      scene: {
        schemaVersion: 1,
        version: turn1.sceneVersion + 1,
        location: "window",
        time: null,
        participants: [],
        emotionalBeat: null,
        unresolvedThreads: [],
      },
      terminalEvidence: {
        authority: "test",
        prompt: {
          productPromptVersion: "v1",
          preparedTurnVersion: 6,
          systemPromptDigest: "b".repeat(64),
          soulFingerprint: "a".repeat(64),
        },
      },
    });
    expect(await dreamcoinBalance(f.id)).toBe(95);

    const turn2 = await f.begin("Show me that photo again.", false);
    const resend = await applyChatToolEffect({
      version: 2,
      turnId: turn2.turnId,
      attempt: turn2.attempt,
      callId: "call-resend",
      name: RESEND_SESSION_MEDIA_TOOL,
      effectScope: "turn_action",
      intent: { requestedNudity: "unspecified" },
      arguments: { previousMediaAssetId: revealedAttachment.mediaAssetId! },
    });
    expect(resend).toMatchObject({
      accepted: true,
      status: "completed",
      kind: "image",
      mediaAssetId: revealedAttachment.mediaAssetId,
      costDreamcoins: 0,
    });
    expect(await dreamcoinBalance(f.id)).toBe(95);

    const sessionView = await getChatSession(f.id, f.session.id);
    const allAttachments = sessionView.messages.flatMap((m) =>
      Array.isArray(m.attachments) ? (m.attachments as Array<{ id?: string }>) : [],
    );
    expect(allAttachments.some((a) => a.id === resend.attachmentId)).toBe(true);
  });
});
