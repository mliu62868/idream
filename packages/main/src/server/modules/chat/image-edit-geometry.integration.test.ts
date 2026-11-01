import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { compileCharacterSoul } from "@idream/shared";
import { CONFIRMED_IMAGE_EDIT_VERSION } from "@idream/shared/chat/image-action";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { createCharacter, createUser, dreamcoinBalance, grantCoins, purgeTestData, api, expectOk } from "@/server/test/helpers";
import { createReferenceSetRevision } from "../ourdream/generation-reference-set";
import { applyChatToolEffect } from "./tool-effect";
import { beginChatTurn, commitChatTerminal, createChatSession, regenerateChatTurn, editChatTurn, getChatSession } from "./turn-ledger";

import { cancelChatImageEdit, confirmChatImageEdit, readChatImageEditSource, reviewChatImageEdit } from "./image-edit-review";
import * as generationCreate from "../ourdream/generation-job-create";
import { parseChatImageEditReviewResponse } from "@/lib/public-api-contracts";

const prefix = `zt-chat-edit-size-${randomUUID()}-`;
const sourceKeys: string[] = [];
afterAll(async () => {
  await purgeTestData(prefix);
  for (const key of sourceKeys) await providers.blob.delete({ key });
  await prisma.$disconnect();
});

async function fixture(subject: "companion" | "scene", width: number, height: number) {
  const userId = `${prefix}${randomUUID()}`;
  await createUser({ id: userId });
  await grantCoins(userId, 40);
  const character = await createCharacter({ id: `${userId}-character`, creatorId: userId, source: "user", visibility: "private", advancedDetails: { imageToolEnabled: true } });
  const soul = compileCharacterSoul({ name: "Avery", age: 28, gender: "female", characterPromise: "A warm photographer", detailsMarkdown: "Warm and curious." });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const content = await prisma.characterContentVersion.create({ data: { characterId: character.id, version: 1, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint, personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {} } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  const key = `${userId}-source.png`;
  sourceKeys.push(key);
  const pixels = await sharp({ create: { width, height, channels: 3, background: "#7296b0" } }).png().toBuffer();
  await providers.blob.putPrivate({ key, body: pixels, contentType: "image/png" });
  // Deliberately stale row dimensions: the admitted bytes must own geometry.
  const source = await prisma.mediaAsset.create({ data: { id: `${userId}-source`, ownerId: userId, characterId: subject === "companion" ? character.id : null, type: "image", url: `/api/media/${userId}-source/content.png`, storageKey: key, contentType: "image/png", visibility: "private", safetyStatus: "passed", width: 64, height: 64, metadata: {} } });
  if (subject === "companion") {
    const visual = await prisma.characterVisualProfile.create({ data: { characterId: character.id, status: "active", identityPrompt: "Avery", faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [source.id], adapterRefs: {}, createdFrom: "test" } });
    await prisma.$transaction(tx => createReferenceSetRevision(tx, visual, "test", [{ mediaAssetId: source.id, position: 0, role: "primary_face", weight: 1, selectionReason: "primary_identity_anchor" }]));
  }
  const session = await createChatSession(userId, { characterId: character.id });
  await prisma.recentChat.update({ where: { sessionId: session.id }, data: { memoryEnabled: false } });
  const begin = (text: string) => beginChatTurn({ userId, sessionId: session.id, content: text, idempotencyKey: randomUUID() });
  const first = (await begin("Send me the existing green mug photo.")).snapshot;
  if (!first) throw new Error("Missing source Turn");
  await prisma.chatTurnAttachment.create({ data: { id: `${userId}-attachment`, turnId: first.turnId, kind: "generated_image", status: "completed", mediaAssetId: source.id, metadata: { attempt: first.attempt } } });
  await commitChatTerminal({ version: 1, turnId: first.turnId, sessionId: first.sessionId, assistantMessageId: first.assistantMessageId, attempt: first.attempt, status: "sent", content: "Here is the photo.", model: "test", promptTokens: 1, completionTokens: 1, sceneVersion: first.sceneVersion + 1,
    scene: { schemaVersion: 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [], ...first.scene, version: first.sceneVersion + 1 },
    terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
  const next = (await begin("Change only the mug to red. Keep everything else unchanged.")).snapshot;
  if (!next) throw new Error("Missing edit Turn");
  const effect = { version: 2 as const, turnId: next.turnId, attempt: next.attempt, callId: randomUUID(), name: "edit_last_image" as const, effectScope: "turn_action" as const, intent: { requestedNudity: "unspecified" as const }, arguments: { instruction: "Change only the mug to red. Preserve the composition, subject, clothing, pose and background." } };
  return { userId, source, key, snapshot: next, sessionId: session.id, effect: { ...effect, arguments: { ...effect.arguments, editScope: { mode: "local" as const, target: "mug", selection: "one" as const } } } };
}

function hash(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }

async function draftFor(subject: "companion" | "scene" = "scene", width = 640, height = 960) {
  const f = await fixture(subject, width, height);
  const receipt = await applyChatToolEffect(f.effect);
  expect(receipt).toMatchObject({ accepted: true, status: "awaiting_confirmation", costDreamcoins: 0, generationJobId: null });
  if (!receipt.accepted || typeof receipt.attachmentId !== "string") throw new Error("Missing edit draft");
  const attachmentId = receipt.attachmentId;
  const review = await reviewChatImageEdit(f.userId, attachmentId);
  const mask = Buffer.alloc(width * height);
  mask.fill(255, 0, Math.ceil(mask.length / 4));
  const png = await sharp(mask, { raw: { width, height, channels: 1 } }).toColourspace("b-w").png().toBuffer();
  const body = { attempt: review.attempt, draftFingerprint: review.draftFingerprint, sourceSha256: review.source.sha256,
    maskPngBase64: png.toString("base64"), maskSha256: hash(png), operation: { kind: "recolor" as const, color: "#cf2136" }, quoteAuthority: review.quotes.recolor! };
  return { ...f, attachmentId, review, body };
}

async function finish(f: Awaited<ReturnType<typeof draftFor>>) {
  const snapshot = f.snapshot;
  await commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId,
    assistantMessageId: snapshot.assistantMessageId, attempt: snapshot.attempt, status: "sent", content: "Please confirm the area you want to change.",
    model: "test", promptTokens: 1, completionTokens: 1, sceneVersion: snapshot.sceneVersion + 1,
    scene: { schemaVersion: 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [], ...snapshot.scene, version: snapshot.sceneVersion + 1 },
    terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
}

describe("Chat confirmed source image editing", () => {
  it("rejects a new edit with no scope instead of silently repainting the whole image", async () => {
    const { userId, effect } = await fixture("companion", 832, 832);
    await expect(applyChatToolEffect({ ...effect, arguments: { instruction: effect.arguments.instruction } })).rejects.toMatchObject({ code: "bad_request" });
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(40);
  });

  it.each([
    { subject: "companion" as const, width: 832, height: 832 },
    { subject: "scene" as const, width: 640, height: 960 },
  ])("freezes decoded $width × $height pixels, then admits only the confirmed $subject edit", async ({ subject, width, height }) => {
    const f = await draftFor(subject, width, height);
    expect(await prisma.generationJob.count({ where: { userId: f.userId } })).toBe(0);
    expect(await dreamcoinBalance(f.userId)).toBe(40);
    const source = await readChatImageEditSource(f.userId, f.attachmentId);
    expect(hash(source)).toBe(f.review.source.sha256);
    expect(await sharp(source).metadata()).toMatchObject({ width, height, hasAlpha: true });
    await finish(f);
    expect(f.review.quotes.generate).not.toBeNull();
    const accepted = await confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), { ...f.body, operation: { kind: "generate" }, quoteAuthority: f.review.quotes.generate });
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: accepted.generationJobId } });
    expect(job).toMatchObject({ orientation: "original", controls: expect.objectContaining({ orientation: "original", width, height, sourceImageAssetId: f.source.id }) });
    expect(job.controls).toMatchObject({ referenceSnapshots: expect.arrayContaining([expect.objectContaining({ assetId: f.source.id, role: "source_image", sha256: f.review.source.sha256, snapshotId: f.review.source.snapshotId })]),
      localizedEdit: { version: CONFIRMED_IMAGE_EDIT_VERSION, sourceSha256: f.review.source.sha256, maskSha256: f.body.maskSha256, operation: { kind: "generate" } } });
    expect(await applyChatToolEffect({ ...f.effect, arguments: { ...f.effect.arguments, editScope: { mode: "whole_image" } }, callId: randomUUID() })).toMatchObject({ accepted: true, duplicate: true, generationJobId: job.id });
    expect(await prisma.generationJob.count({ where: { userId: f.userId } })).toBe(1);
    expect(await dreamcoinBalance(f.userId)).toBe(40 - job.costDreamcoins);
  });

  it.each([{ width: 831, height: 832 }, { width: 2048, height: 2048 }])("offers zero-cost recoloring for $width × $height without resizing or a diffusion quote", async ({ width, height }) => {
    const f = await draftFor("scene", width, height);
    expect(f.review.quotes.generate).toBeNull();
    expect(f.review.quotes.recolor).toMatchObject({ profileId: "chat-image-recolor", outputCount: 1, costDreamcoins: 0 });
    const accepted = await confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), f.body);
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: accepted.generationJobId } })).toMatchObject({ provider: "local-image", costDreamcoins: 0, controls: expect.objectContaining({ width, height }) });
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: accepted.generationJobId } })).toBe(0);
    expect(await prisma.generationJobEvent.count({ where: { jobId: accepted.generationJobId, type: { in: ["reserved", "refunded"] } } })).toBe(0);
    expect(await dreamcoinBalance(f.userId)).toBe(40);
  });

  it("deduplicates concurrent confirmation across tabs and rejects a changed operation", async () => {
    const f = await draftFor();
    await finish(f);
    const paid = { ...f.body, operation: { kind: "generate" as const }, quoteAuthority: f.review.quotes.generate! };
    const accepted = await Promise.all([confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), paid), confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), paid)]);
    expect(accepted[0].generationJobId).toBe(accepted[1].generationJobId);
    expect(await prisma.generationJob.count({ where: { userId: f.userId } })).toBe(1);
    expect(await prisma.generationAttempt.count({ where: { requestId: accepted[0].generationJobId } })).toBe(1);
    await expect(confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), { ...f.body, operation: { kind: "recolor", color: "#abcdef" } })).rejects.toMatchObject({ code: "conflict" });
    expect(await confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), { ...paid, quoteAuthority: { ...paid.quoteAuthority, costDreamcoins: 999 } })).toMatchObject({ generationJobId: accepted[0].generationJobId, costDreamcoins: paid.quoteAuthority.costDreamcoins });
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: accepted[0].generationJobId, reason: "generation_spend" } })).toBe(1);
    expect(await dreamcoinBalance(f.userId)).toBe(40 - paid.quoteAuthority.costDreamcoins);
  });

  it("canonicalizes opaque browser RGBA without changing selection, and replays equivalent PNG encodings", async () => {
    const f = await draftFor();
    const rgba = await sharp(Buffer.from(f.body.maskPngBase64, "base64")).toColourspace("srgb").ensureAlpha().png().toBuffer();
    const accepted = await confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), { ...f.body, maskPngBase64: rgba.toString("base64"), maskSha256: hash(rgba) });
    const replay = await confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), f.body);
    expect(replay.generationJobId).toBe(accepted.generationJobId);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: accepted.generationJobId } });
    expect(job.controls).toMatchObject({ localizedEdit: { maskPngBase64: f.body.maskPngBase64, maskSha256: f.body.maskSha256 } });
  });

  it("admits the frozen frame after the original Blob changes and keeps old historical drafts usable", async () => {
    const f = await draftFor();
    await finish(f);
    await beginChatTurn({ userId: f.userId, sessionId: f.sessionId, content: "A later unrelated question.", idempotencyKey: randomUUID() });
    const replacement = await sharp({ create: { width: 32, height: 32, channels: 3, background: "red" } }).png().toBuffer();
    await providers.blob.putPrivate({ key: f.key, body: replacement, contentType: "image/png" });
    expect(hash(await readChatImageEditSource(f.userId, f.attachmentId))).toBe(f.review.source.sha256);
    const accepted = await confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), f.body);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: accepted.generationJobId } });
    expect(job.controls).toMatchObject({ width: 640, height: 960, referenceSnapshots: [expect.objectContaining({ snapshotId: f.review.source.snapshotId, sha256: f.review.source.sha256 })] });
  });

  it("rejects malformed masks and stale source/price before creating any Job", async () => {
    const f = await draftFor();
    const noSelection = await sharp(Buffer.alloc(640 * 960), { raw: { width: 640, height: 960, channels: 1 } }).toColourspace("b-w").png().toBuffer();
    const alpha = await sharp({ create: { width: 640, height: 960, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.5 } } }).png().toBuffer();
    for (const png of [noSelection, alpha]) await expect(confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), { ...f.body, maskPngBase64: png.toString("base64"), maskSha256: hash(png) })).rejects.toMatchObject({ code: "bad_request" });
    await expect(confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), { ...f.body, sourceSha256: "a".repeat(64) })).rejects.toMatchObject({ code: "conflict" });
    await expect(confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), { ...f.body, quoteAuthority: { ...f.body.quoteAuthority, pricingFingerprint: "a".repeat(64) } })).rejects.toMatchObject({ code: "conflict" });
    expect(await prisma.generationJob.count({ where: { userId: f.userId } })).toBe(0);
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: f.attachmentId } })).toMatchObject({ status: "awaiting_confirmation" });
  });

  it("rechecks changed pricing under admission locks and keeps the unpaid draft intact", async () => {
    const f = await draftFor();
    const rule = await prisma.pricingRule.findFirstOrThrow({ where: { mode: "image", status: "active" } });
    const prepare = generationCreate.prepareGenerationJobForUser;
    const spy = vi.spyOn(generationCreate, "prepareGenerationJobForUser").mockImplementationOnce(async (...args) => {
      const admitted = await prepare(...args);
      await prisma.pricingRule.update({ where: { id: rule.id }, data: { multiplier: rule.multiplier + 0.25 } });
      return admitted;
    });
    try {
      await expect(confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), f.body)).rejects.toMatchObject({ code: "conflict" });
      expect(await prisma.generationJob.count({ where: { userId: f.userId } })).toBe(0);
      expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: f.attachmentId } })).toMatchObject({ status: "awaiting_confirmation", generationJobId: null });
      expect(await dreamcoinBalance(f.userId)).toBe(40);
    } finally { spy.mockRestore(); await prisma.pricingRule.update({ where: { id: rule.id }, data: { multiplier: rule.multiplier } }); }
  });

  it("rejects a source deleted after review before any reservation", async () => {
    const f = await draftFor();
    await prisma.mediaAsset.update({ where: { id: f.source.id }, data: { deletedAt: new Date() } });
    await expect(readChatImageEditSource(f.userId, f.attachmentId)).rejects.toMatchObject({ code: "gone" });
    await expect(confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), f.body)).rejects.toMatchObject({ code: "gone" });
    expect(await prisma.generationJob.count({ where: { userId: f.userId } })).toBe(0);
  });

  it.each(["deleted", "ownership revoked"] as const)("keeps a %s source's unpaid draft reviewable and cancellable without exposing pixels or reserving funds", async reason => {
    const f = await draftFor();
    await finish(f);
    const ledgerBefore = await prisma.dreamcoinLedger.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    const other = `${prefix}${randomUUID()}`;
    await createUser({ id: other });
    await prisma.mediaAsset.update({ where: { id: f.source.id }, data: reason === "deleted" ? { deletedAt: new Date() } : { ownerId: other } });
    const path = `chat/attachments/${f.attachmentId}/edit-review`;
    const review = await api("GET", path, { userId: f.userId, ageGate: true });
    expectOk(review);
    const current = parseChatImageEditReviewResponse({ ok: true, data: review.data });
    expect(current).toMatchObject({ attachmentId: f.attachmentId, attempt: f.body.attempt, draftFingerprint: f.body.draftFingerprint,
      source: { sha256: f.review.source.sha256, width: 640, height: 960 }, quotes: { generate: null, recolor: null },
      unavailable: { generate: "The original image is no longer available for editing.", recolor: "The original image is no longer available for editing." } });
    const source = await api("GET", `${path}/source`, { userId: f.userId, ageGate: true });
    expect(source.status).toBe(410);
    expect(source.bytes).toBeUndefined();
    for (const body of [f.body, { ...f.body, operation: { kind: "generate" }, quoteAuthority: f.review.quotes.generate }]) {
      const confirm = await api("POST", `${path}/confirm`, { userId: f.userId, ageGate: true, body, headers: { "Idempotency-Key": randomUUID(), "x-idream-viewer-scope": `user:${f.userId}` } });
      expect(confirm.status).toBe(410);
    }
    const identity = { attempt: current.attempt, draftFingerprint: current.draftFingerprint };
    const cancel = (userId: string, body = identity) => api("POST", `${path}/cancel`, { userId, ageGate: true, body, headers: { "x-idream-viewer-scope": `user:${userId}` } });
    expect((await api("GET", path, { userId: other, ageGate: true })).status).toBe(404);
    expect((await cancel(other)).status).toBe(404);
    expect((await cancel(f.userId, { ...identity, draftFingerprint: "a".repeat(64) })).status).toBe(409);
    expectOk(await cancel(f.userId));
    expectOk(await cancel(f.userId));
    const regenerate = await regenerateChatTurn(f.userId, f.snapshot.assistantMessageId);
    expect(regenerate.snapshot.recoveredMediaAction).toMatchObject({ attachmentId: f.attachmentId, status: "cancelled", generationJobId: null, costDreamcoins: 0 });
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: f.attachmentId } })).toMatchObject({ status: "cancelled", generationJobId: null });
    expect(await prisma.generationJob.count({ where: { userId: f.userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(ledgerBefore);
    expect(await dreamcoinBalance(f.userId)).toBe(40);
  });

  it("cancels an unpaid draft once, and regenerate carries the actual cancelled receipt", async () => {
    const f = await draftFor();
    await finish(f);
    const identity = { attempt: f.body.attempt, draftFingerprint: f.body.draftFingerprint };
    await cancelChatImageEdit(f.userId, f.attachmentId, identity);
    await cancelChatImageEdit(f.userId, f.attachmentId, identity);
    const regenerate = await regenerateChatTurn(f.userId, f.snapshot.assistantMessageId);
    expect(regenerate.snapshot.recoveredMediaAction).toMatchObject({ name: "edit_last_image", attachmentId: f.attachmentId, status: "cancelled", generationJobId: null, sourceMediaAssetId: f.source.id, costDreamcoins: 0 });
    expect(await prisma.generationJob.count({ where: { userId: f.userId } })).toBe(0);
    expect(await dreamcoinBalance(f.userId)).toBe(40);
  });

  it("rebinds a draft on reply regeneration, while editing user words invalidates it", async () => {
    const f = await draftFor();
    await finish(f);
    const regenerated = await regenerateChatTurn(f.userId, f.snapshot.assistantMessageId);
    expect(regenerated.snapshot.recoveredMediaAction).toMatchObject({ attachmentId: f.attachmentId, status: "awaiting_confirmation", sourceMediaAssetId: f.source.id });
    const refreshed = await reviewChatImageEdit(f.userId, f.attachmentId);
    expect(refreshed).toMatchObject({ attempt: regenerated.attempt, draftFingerprint: f.review.draftFingerprint, source: { sha256: f.review.source.sha256 } });
    expect((await getChatSession(f.userId, f.sessionId)).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.snapshot.assistantMessageId, attachments: [expect.objectContaining({ id: f.attachmentId, status: "awaiting_confirmation" })] })]));
    await expect(confirmChatImageEdit(f.userId, f.attachmentId, randomUUID(), f.body)).rejects.toMatchObject({ code: "conflict" });
    const changed = await draftFor();
    await finish(changed);
    await editChatTurn(changed.userId, changed.snapshot.userMessageId, "Change the background instead.");
    await expect(readChatImageEditSource(changed.userId, changed.attachmentId)).rejects.toMatchObject({ code: "conflict" });
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: changed.attachmentId } })).toMatchObject({ status: "cancelled", promptHint: null });
  });

  it("uses owner and viewer scope for review and confirmation HTTP routes", async () => {
    const f = await draftFor();
    const review = await api("GET", `chat/attachments/${f.attachmentId}/edit-review`, { userId: f.userId, ageGate: true });
    expectOk(review);
    const source = await api("GET", `chat/attachments/${f.attachmentId}/edit-review/source`, { userId: f.userId, ageGate: true });
    expectOk(source); expect(hash(source.bytes!)).toBe(f.review.source.sha256);
    expect(source.headers.get("cache-control")).toContain("private, no-store");
    expect(parseChatImageEditReviewResponse({ ok: true, data: review.data })).toMatchObject({ attachmentId: f.attachmentId });
    const other = `${prefix}${randomUUID()}`; await createUser({ id: other });
    expect((await api("GET", `chat/attachments/${f.attachmentId}/edit-review`, { userId: other, ageGate: true })).status).toBe(404);
    const rejected = await api("POST", `chat/attachments/${f.attachmentId}/edit-review/confirm`, { userId: f.userId, ageGate: true, body: f.body, headers: { "Idempotency-Key": randomUUID(), "x-idream-viewer-scope": `user:${other}` } });
    expect(rejected.status).toBe(409);
    const accepted = await api("POST", `chat/attachments/${f.attachmentId}/edit-review/confirm`, { userId: f.userId, ageGate: true, body: f.body, headers: { "Idempotency-Key": randomUUID(), "x-idream-viewer-scope": `user:${f.userId}` } });
    expectOk(accepted, 202); expect(accepted.data).toMatchObject({ attachmentId: f.attachmentId, costDreamcoins: 0 });
  });
});
