import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { compileCharacterSoul } from "@idream/shared";
import { searchCharacterMediaResultSchema, sendCharacterMediaResultSchema, type SearchCharacterMediaArgs } from "@idream/shared/chat/media-library";
import { CONFIRMED_IMAGE_EDIT_VERSION } from "@idream/shared/chat/image-action";
import { generationTerminalRecordChecksum } from "@idream/shared/contracts/durable-server";
import { recolorRgba } from "@idream/shared/media/image-recolor";
import type { ChatExecutionSnapshot, ChatToolEffect } from "@idream/shared/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as userContentRoute } from "@/app/user-content/[id]/[filename]/route";
import { prisma } from "@/server/lib/db";
import { OPERATOR_UPLOAD_AUTHORITY_SCHEMA, resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import { dispatchPendingGenerationTerminalRecords, ingestGenerationTerminalRecord } from "@/server/ai/generation-terminal-record-ingest";
import { drainGenerationFinalization } from "@/server/ai/generation-finalize-drain";
import { api, createCharacter, createUser, dreamcoinBalance, expectOk, purgeTestData } from "@/server/test/helpers";
import { lockCharacterGenerationAndMediaAssetAuthorities } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { characterContentHash } from "@/server/modules/admin-v2/shared/character-content-identity";
import { createReferenceSetRevision } from "@/server/modules/ourdream/generation-reference-set";
import { libraryDescriptorHash } from "@/server/modules/character-media-library/service";
import * as mediaModels from "@/server/modules/character-media-library/media-models";
import { applyChatToolEffect } from "./tool-effect";
import { loadChatAuthoritySnapshot } from "./chat-authority-snapshot";
import { createToolEffectAttachment, transitionToolEffectAttachment } from "./tool-effect-attachment";
import { lockChatScope } from "./turn-scope";
import { parseGenerationContextResponse } from "@/lib/public-api-contracts";
import { beginChatTurn, commitChatTerminal, createChatSession, editChatTurn, getChatSession, regenerateChatTurn } from "./turn-ledger";

const prefix = `zt-chat-library-${randomUUID()}-`;
const keys: string[] = [];
beforeEach(() => {
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_URL", "http://media-embedding.test.invalid/v1");
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_MODEL", "fixture-embedding");
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_DIMENSIONS", "2");
  vi.spyOn(mediaModels, "embedMediaText").mockResolvedValue({ model: "fixture-embedding", dimensions: 2, vector: [1, 0] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => {
  await prisma.characterMediaLibraryEntry.deleteMany({ where: { id: { startsWith: prefix } } });
  await purgeTestData(prefix);
  for (const key of keys) await providers.blob.delete({ key });
});

async function fixture(kind: "image" | "video" = "image") {
  const id = `${prefix}${randomUUID()}`;
  await createUser({ id });
  const sourceOwnerId = `${id}-operator`;
  await createUser({ id: sourceOwnerId });
  const character = await createCharacter({ id: `${id}-character`, creatorId: id, source: "user", visibility: "private", advancedDetails: { imageToolEnabled: true } });
  const soul = compileCharacterSoul({ name: "Avery", age: 28, gender: "female", characterPromise: "A photographer", detailsMarkdown: "Warm and curious." });
  if (!soul.ok) throw new Error("Invalid fixture soul");
  const contentValues = { personaSnapshot: soul.snapshot, openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {} };
  const content = await prisma.characterContentVersion.create({ data: { characterId: character.id, version: 1,
    sourceType: "test", contentHash: characterContentHash(contentValues), ...JSON.parse(JSON.stringify(contentValues)) } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  const bytes = kind === "image" ? await sharp({ create: { width: 8, height: 8, channels: 3, background: "#aa2255" } }).png().toBuffer()
    : await readFile(new URL("../../../e2e/fixtures/collection-playback.mp4", import.meta.url));
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const sourceKey = `${id}/source.${kind === "image" ? "png" : "mp4"}`;
  const libraryKey = `${id}/library.${kind === "image" ? "png" : "mp4"}`;
  const contentType = kind === "image" ? "image/png" : "video/mp4";
  keys.push(sourceKey, libraryKey);
  await providers.blob.putPrivate({ key: sourceKey, body: bytes, contentType });
  await providers.blob.putPrivate({ key: libraryKey, body: bytes, contentType });
  const thumbnailKey = kind === "video" ? `${id}/poster.jpg` : null;
  const posterBytes = thumbnailKey ? await sharp({ create: { width: 8, height: 8, channels: 3, background: "#2255aa" } }).jpeg().toBuffer() : null;
  if (thumbnailKey && posterBytes) {
    keys.push(thumbnailKey);
    await providers.blob.putPrivate({ key: thumbnailKey, body: posterBytes, contentType: "image/jpeg" });
  }
  const sourceId = `${id}-source`;
  const source = await prisma.mediaAsset.create({ data: { id: sourceId, ownerId: sourceOwnerId, characterId: character.id, type: kind,
    url: `/api/media/${sourceId}/content.${kind === "image" ? "png" : "mp4"}`, storageKey: sourceKey, contentType,
    safetyStatus: "passed", metadata: { source: "admin_asset_upload", synthetic: false, sha256: contentHash,
      uploadAuthority: { schemaVersion: OPERATOR_UPLOAD_AUTHORITY_SCHEMA, kind: "operator_upload", assetId: sourceId, uploadedById: sourceOwnerId, sha256: contentHash } },
  } });
  // Source ownership is independent from the Character identity anchor. An
  // operator leaving must not need to delete somebody else's reference pin.
  const anchorKey = `${id}/anchor.png`;
  const anchorBytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#aa2255" } }).png().toBuffer();
  keys.push(anchorKey);
  await providers.blob.putPrivate({ key: anchorKey, body: anchorBytes, contentType: "image/png" });
  const anchor = await prisma.mediaAsset.create({ data: { id: `${id}-anchor`, ownerId: id, characterId: character.id, type: "image",
    url: `/api/media/${id}-anchor/content.png`, storageKey: anchorKey, contentType: "image/png", safetyStatus: "passed", metadata: { synthetic: false } } });
  const visualValues = { characterId: character.id, version: 1, status: "active", style: "realistic", identityPrompt: "Avery",
    negativeIdentityPrompt: null, faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {},
    anchorAssetIds: [anchor.id], adapterRefs: {}, createdFrom: "test" };
  const visual = await prisma.characterVisualProfile.create({ data: { ...visualValues, immutableHash: characterVisualProfileSnapshotHash(visualValues) } });
  await prisma.$transaction(tx => createReferenceSetRevision(tx, visual, "test",
    [{ mediaAssetId: anchor.id, position: 0, role: "identity_anchor", weight: 1, selectionReason: "fixture" }]));
  const descriptor = { kind, description: "Avery in a red dress beside a rainy window.", facts: ["red dress", "rainy window"], absentFacts: ["hat"],
    nudity: "none", durationSeconds: kind === "video" ? 1 : null, hasAudio: kind === "video" ? false : null };
  const entry = await prisma.characterMediaLibraryEntry.create({ data: {
    id: `${id}-entry`, characterId: character.id, sourceAssetId: source.id, visualProfileId: visual.id, visualProfileVersion: visual.version,
    status: "published", ...descriptor, width: 8, height: 8, contentType, storageKey: libraryKey, thumbnailKey, contentHash,
    embedding: [1, 0], embeddingModel: "fixture-embedding", embeddingDimensions: 2, embeddingHash: libraryDescriptorHash(descriptor),
    sourceSnapshot: { assetId: source.id, sourceStorageKey: sourceKey, visualProfileHash: visual.immutableHash }, createdById: id, updatedById: id,
  } });
  const session = await createChatSession(id, { characterId: character.id });
  await prisma.recentChat.update({ where: { sessionId: session.id }, data: { memoryEnabled: false } });
  const begin = async (text = "Send me one in a red dress beside a rainy window.") => {
    const result = await beginChatTurn({ userId: id, sessionId: session.id, content: text, idempotencyKey: randomUUID() });
    if (!result.snapshot) throw new Error("No frozen turn");
    return result.snapshot;
  };
  return { id, character, session, visual, entry, source, sourceOwnerId, sourceKey, libraryKey, bytes, posterBytes, begin };
}

async function deliveredScene(kind: "image" | "video" = "image") {
  const f = await fixture(kind);
  const snapshot = await f.begin("Send the scene.");
  const sceneKey = `${f.id}/scene.${kind === "image" ? "png" : "mp4"}`;
  keys.push(sceneKey);
  await providers.blob.putPrivate({ key: sceneKey, body: f.bytes, contentType: f.source.contentType! });
  const asset = await prisma.mediaAsset.create({ data: {
    id: `${f.id}-scene`, ownerId: f.id, characterId: null, type: kind,
    url: `/api/media/${f.id}-scene/content`, storageKey: sceneKey, contentType: f.source.contentType,
    safetyStatus: "passed", metadata: { synthetic: false },
  } });
  const attachment = await prisma.chatTurnAttachment.create({ data: {
    id: `${f.id}-scene-delivery`, turnId: snapshot.turnId, kind: kind === "image" ? "generated_image" : "generated_video",
    status: "completed", mediaAssetId: asset.id, metadata: { attempt: snapshot.attempt, request: { subject: "scene" } },
  } });
  await complete(snapshot);
  return { ...f, snapshot, asset, attachment };
}

async function deliveredEdit(confirmed = true) {
  const f = await deliveredScene();
  const source = await sharp(f.bytes).ensureAlpha().png().toBuffer();
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const mask = Buffer.alloc(64); mask.fill(255, 0, 16);
  const maskPng = await sharp(mask, { raw: { width: 8, height: 8, channels: 1 } }).toColourspace("b-w").png().toBuffer();
  const operation = { kind: "recolor" as const, color: "#2563eb" };
  const pin = { version: CONFIRMED_IMAGE_EDIT_VERSION, mode: "local" as const, target: "the mug", selection: "one" as const,
    sourceSnapshotId: `${f.id}-frozen`, sourceSha256: hash(source), width: 8, height: 8,
    maskPngBase64: maskPng.toString("base64"), maskSha256: hash(maskPng), confirmationId: `${f.id}-confirmed`,
    confirmedAt: new Date().toISOString(), operation };
  const rgba = await sharp(source).raw().toBuffer();
  const edited = recolorRgba({ pixels: rgba, mask, color: operation.color });
  const bytes = await sharp(edited, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
  const jobId = `${f.id}-edit-job`, attemptId = `${f.id}-edit-attempt`;
  const key = `gen/${jobId}/attempts/${attemptId}/image-1.png`;
  keys.push(key);
  await providers.blob.putPrivate({ key, body: bytes, contentType: "image/png" });
  await prisma.generationJob.create({ data: { id: jobId, userId: f.id, mode: "image", provider: "local-image", model: "local-recolor",
    controls: {}, presetIds: [], outputCount: 1, costDreamcoins: 0, status: "running" } });
  await prisma.generationAttempt.create({ data: { id: attemptId, requestId: jobId, attemptNo: 1, provider: "local-image", status: "queued" } });
  const controls = { orientation: "original", width: 8, height: 8, sourceImageAssetId: f.asset.id,
    ...(confirmed ? { localizedEdit: pin } : {}) };
  const dispatch = { generationJobId: jobId, attemptId, attemptNo: 1, queueInput: { queue: "ai.image.generate",
    dedupeKey: `generation:${jobId}:attempt:1`, maxAttempts: 3, payload: {
      version: 1, kind: "image", requestId: `generation_dispatch_${attemptId}`, generationJobId: jobId, attemptId, attemptNo: 1,
      provider: "local-image", userId: f.id, characterId: null, prompt: "Requested local edit", negativePrompt: null,
      controls, seed: jobId, model: "local-recolor", outputPrefix: `gen/${jobId}/attempts/${attemptId}/`, presetIds: [], orientation: "original", count: 1,
      referenceImages: [{ assetId: f.asset.id, role: "source_image", sourceSnapshotId: pin.sourceSnapshotId, contentSha256: pin.sourceSha256 }],
    } } };
  const dispatchId = `${f.id}-edit-dispatch`;
  await prisma.mainOutboxEvent.create({ data: { id: dispatchId, eventType: "generation.retry.dispatch.v2", aggregateType: "generation_request",
    aggregateId: jobId, payload: dispatch } });
  const proof = { ...pin, status: "ok", regionAuthority: "user_confirmation", maskCorrectnessCertified: false,
    sourceAssetId: f.asset.id, frozenSourceSha256: pin.sourceSha256, canonicalSourceSha256: pin.sourceSha256,
    decodeConvention: "sharp-auto-orient-srgb-rgba-v1", sampling: "hsl-lightness-preserving-1", maskPixels: 16, totalPixels: 64,
    protectedPixels: 48, changedProtectedPixels: 0, changedTargetPixels: 16, candidateSha256: hash(bytes), resultSha256: hash(bytes), intentVerified: false };
  const terminal = { version: 1 as const, attemptId, attemptNo: 1, transportAttemptNo: 1,
    providerIdempotencyKey: `generation:${attemptId}:provider`, requestId: `generation_dispatch_${attemptId}`, generationJobId: jobId,
    mode: "image" as const, provider: "local-image", model: "local-recolor", providerRequestId: null, providerInvoked: true,
    outcome: "succeeded" as const, completedAt: new Date().toISOString(), usage: { model: "local-recolor" },
    assets: [{ ordinal: 0, key, providerKey: null, contentType: "image/png", width: 8, height: 8,
      quality: { schemaVersion: "1" as const, evaluatorVersion: "fixture", artifact: { status: "passed" as const },
        identity: { status: "unscored" as const }, intent: { status: "unscored" as const }, faceCount: { status: "unscored" as const }, preservation: proof } }] };
  expect(await ingestGenerationTerminalRecord({ version: 1, terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
    terminalRecordChecksum: generationTerminalRecordChecksum(terminal), terminalRecord: terminal })).toMatchObject({ status: "persisted" });
  await dispatchPendingGenerationTerminalRecords({ outboxIds: [`generation_terminal_record_${attemptId}`] });
  await drainGenerationFinalization({ queues: ["app.ai.finalize"], limit: 1, workerId: `${f.id}-finalizer` });
  const asset = await prisma.mediaAsset.findFirstOrThrow({ where: { sourceJobId: jobId } });
  expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ status: "succeeded" });
  const snapshot = await f.begin("Recolor the selected mug area blue.");
  const attachment = await prisma.chatTurnAttachment.create({ data: { id: `${f.id}-edit-delivery`, turnId: snapshot.turnId,
    kind: "generated_image", status: "completed", mediaAssetId: asset.id, generationJobId: jobId, metadata: { attempt: snapshot.attempt } } });
  await complete(snapshot);
  return { ...f, source: f.asset, snapshot, asset, attachment, jobId, attemptId, dispatchId, dispatch,
    editProvenance: { sourceMediaAssetId: f.asset.id, requestedTarget: pin.target, operation } };
}

function effect(snapshot: ChatExecutionSnapshot, name: ChatToolEffect["name"], args: Record<string, unknown>): ChatToolEffect {
  return { version: 2, turnId: snapshot.turnId, attempt: snapshot.attempt, callId: randomUUID(), name,
    effectScope: name === "search_character_media" ? "attempt" : "turn_action", intent: { requestedNudity: "unspecified" }, arguments: args };
}
async function search(snapshot: ChatExecutionSnapshot, kind: "image" | "video" = "image", extras: Partial<SearchCharacterMediaArgs> = {}) {
  const args = { kind, query: "red dress rainy window without a hat", ...extras };
  const call = effect(snapshot, "search_character_media", args);
  call.intent.requestedNudity = args.requestedNudity ?? "unspecified";
  return searchCharacterMediaResultSchema.parse(await applyChatToolEffect(call));
}
async function send(snapshot: ChatExecutionSnapshot, candidateToken: string) {
  return sendCharacterMediaResultSchema.parse(await applyChatToolEffect(effect(snapshot, "send_character_media", { candidateToken })));
}
async function resend(snapshot: ChatExecutionSnapshot, previousMediaAssetId: string) {
  return sendCharacterMediaResultSchema.parse(await applyChatToolEffect(effect(snapshot, "send_character_media", { previousMediaAssetId })));
}
async function complete(snapshot: ChatExecutionSnapshot, attachmentId?: string) {
  return commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content: attachmentId ? "" : "Here is one by the rainy window.", model: "fixture", promptTokens: 1, completionTokens: 1,
    sceneVersion: snapshot.sceneVersion + 1, scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: "rainy window", time: null,
      participants: [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "test", ...(attachmentId ? { mediaResponse: { version: 1, attachmentId } } : {}), prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 5,
      systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
}

describe("Main Character media delivery authority", () => {
  it.each(["image", "video"] as const)("recovers textless %s delivery before another tool call and without another charge", async kind => {
    const f = await fixture(kind);
    const snapshot = await f.begin();
    const token = (await search(snapshot, kind)).matches[0]!.candidateToken;
    const delivered = await send(snapshot, token);
    await complete(snapshot, delivered.attachmentId);
    expect((await getChatSession(f.id, f.session.id)).messages.find(message => message.id === snapshot.assistantMessageId))
      .toMatchObject({ status: "sent", content: "", attachments: [expect.objectContaining({ id: delivered.attachmentId, mediaAssetId: delivered.mediaAssetId })] });

    const regenerated = (await regenerateChatTurn(f.id, snapshot.assistantMessageId)).snapshot;
    expect(regenerated.attempt).toBe(2);
    expect(regenerated.recoveredMediaAction).toMatchObject({ name: "send_character_media", attachmentId: delivered.attachmentId, status: "completed", mediaAssetId: delivered.mediaAssetId, costDreamcoins: 0 });
    await expect(complete(regenerated, delivered.attachmentId)).resolves.toMatchObject({ accepted: true, duplicate: false });
    expect(await send(regenerated, token)).toMatchObject({ duplicate: true, attachmentId: delivered.attachmentId, mediaAssetId: delivered.mediaAssetId });
    expect((await getChatSession(f.id, f.session.id)).messages.find(message => message.id === snapshot.assistantMessageId))
      .toMatchObject({ status: "sent", content: "", attempt: 2, attachments: [expect.objectContaining({ id: delivered.attachmentId })] });

    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(1);
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.id, reason: "generation_spend" } })).toBe(0);
  });

  it.each(["image", "video"] as const)("rejects the prior %s attachment as a textless answer after the user edits their request", async kind => {
    const f = await fixture(kind);
    const snapshot = await f.begin();
    const delivered = await send(snapshot, (await search(snapshot, kind)).matches[0]!.candidateToken);
    await complete(snapshot, delivered.attachmentId);
    const edited = (await editChatTurn(f.id, snapshot.userMessageId, "Send a different picture beside the garden.")).snapshot;
    if (!edited) throw new Error("Edited Turn was not admitted");
    await expect(complete(edited, delivered.attachmentId)).rejects.toThrow("attachment");
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(1);
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.id, reason: "generation_spend" } })).toBe(0);
  });

  it("projects prepared-media capability without requiring paid image generation or a model request", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    await prisma.character.update({ where: { id: f.character.id }, data: { advancedDetails: { imageToolEnabled: false } } });
    const pin = { characterId: snapshot.characterId, contentVersionId: snapshot.characterContentVersionId,
      releaseId: snapshot.characterReleaseId, visualProfileId: snapshot.characterVisualProfileId,
      visualProfileVersion: snapshot.characterVisualProfileVersion };
    expect((await loadChatAuthoritySnapshot(f.id, pin)).character).toMatchObject({ imageToolEnabled: false, mediaLibraryKinds: ["image"] });
    expect(mediaModels.embedMediaText).not.toHaveBeenCalled();
    const token = (await search(snapshot)).matches[0]!.candidateToken;
    const changedVisual = { ...f.visual, identityPrompt: "A different visual identity" };
    await prisma.characterVisualProfile.update({ where: { id: f.visual.id }, data: { identityPrompt: changedVisual.identityPrompt,
      immutableHash: characterVisualProfileSnapshotHash(changedVisual) } });
    expect((await loadChatAuthoritySnapshot(f.id, pin)).character?.mediaLibraryKinds).toEqual([]);
    expect(await search(snapshot)).toMatchObject({ status: "no_match" });
    await expect(send(snapshot, token)).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not let a paid generation attachment take the free direct-completion edge", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    await expect(prisma.$transaction(async tx => {
      const scope = await lockChatScope(tx, { userId: f.id, at: { turn: snapshot.turnId } });
      const created = await createToolEffectAttachment(tx, { id: `${f.id}-paid-bypass`, turn: scope.turn!, attempt: 1,
        kind: "generated_image", metadata: { costDreamcoins: 5 } });
      await transitionToolEffectAttachment(tx, created, { to: "completed", generationJobId: null, mediaAssetId: f.source.id });
    })).rejects.toMatchObject({ code: "conflict" });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(0);
  });

  it("uses the reviewed delivery description for image handoff after library withdrawal", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    const delivered = await send(snapshot, (await search(snapshot)).matches[0]!.candidateToken);
    await complete(snapshot);
    await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { status: "withdrawn" } });
    const response = await api("GET", "generation/context", { userId: f.id, ageGate: true,
      query: { kind: "chat", sessionId: snapshot.sessionId, turnId: snapshot.turnId, attempt: snapshot.attempt, mediaAssetId: delivered.mediaAssetId },
      headers: { "x-idream-viewer-scope": `user:${f.id}` } });
    expectOk(response);
    const context = parseGenerationContextResponse(response.json);
    expect(context).toMatchObject({ prompt: f.entry.description, sourceMedia: { id: delivered.mediaAssetId }, characterId: f.character.id });
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
  });

  it.each(["image", "video"] as const)("delivers %s bytes once, replays after regenerate, and leaves no generation or ledger spend", async kind => {
    const f = await fixture(kind);
    const snapshot = await f.begin();
    const balance = await dreamcoinBalance(f.id);
    const found = await search(snapshot, kind);
    expect(found.status).toBe("matches");
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(0);
    const token = found.matches[0]!.candidateToken;
    expect(token.split(".")).toHaveLength(6);
    expect(token.startsWith("2.")).toBe(true);
    expect(token.length).toBeLessThan(180);
    const [first, concurrent] = await Promise.all([send(snapshot, token), send(snapshot, token)]);
    expect(first.mediaAssetId).toBe(concurrent.mediaAssetId);
    expect([first.duplicate, concurrent.duplicate].sort()).toEqual([false, true]);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: first.mediaAssetId } });
    expect(asset).toMatchObject({ ownerId: f.id, characterId: f.character.id, sourceJobId: null, storageKey: null, prompt: null });
    expect(resolveMediaAssetBlobLocator(asset)).toMatchObject({ kind: "shared_immutable", key: f.libraryKey });
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.id, reason: "generation_spend" } })).toBe(0);
    expect(await dreamcoinBalance(f.id)).toBe(balance);
    await complete(snapshot);
    const history = await getChatSession(f.id, f.session.id);
    expect(history.messages.find(item => item.id === snapshot.assistantMessageId)?.attachments).toEqual([
      expect.objectContaining({ mediaAssetId: asset.id, status: "completed", costDreamcoins: 0, source: "library", mediaUrl: asset.url }),
    ]);
    const regenerated = (await regenerateChatTurn(f.id, snapshot.assistantMessageId)).snapshot;
    expect(await send(regenerated, token)).toMatchObject({ duplicate: true, attachmentId: first.attachmentId, mediaAssetId: asset.id });
    await expect(applyChatToolEffect(effect(regenerated, "generate_image_async", { subject: "companion", prompt: "Another picture", outputCount: 1, orientation: "4:5" }))).rejects.toMatchObject({ code: "conflict" });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(1);
    await complete(regenerated);
    const next = await f.begin("Send that same one again.");
    expect(next.recentMedia).toEqual([{ mediaAssetId: asset.id, kind, turnId: snapshot.turnId, description: f.entry.description }]);
    if (kind === "video") expect(next.hasRecentImageContext).toBe(false);
    expect(await search(next, kind)).toMatchObject({ status: "no_match", matches: [] });
  });

  it.each(["image", "video"] as const)("resends a delivered scene %s from the same conversation without changing its identity or charging", async kind => {
    const f = await deliveredScene(kind);
    const balance = await dreamcoinBalance(f.id);
    const next = await f.begin("Resend the exact scene you just sent.");
    expect(next.recentMedia).toEqual([{ mediaAssetId: f.asset.id, kind, turnId: f.snapshot.turnId, description: null }]);
    expect(next.hasRecentImageContext).toBe(kind === "image");
    const receipt = sendCharacterMediaResultSchema.parse(await applyChatToolEffect(effect(next, "send_character_media", { previousMediaAssetId: f.asset.id })));
    expect(receipt).toMatchObject({ accepted: true, source: "previous_media", mediaAssetId: f.asset.id, costDreamcoins: 0 });
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: receipt.attachmentId } })).toMatchObject({
      metadata: expect.objectContaining({ request: expect.objectContaining({ subject: "scene" }) }),
    });
    await complete(next, receipt.attachmentId);
    expect((await getChatSession(f.id, f.session.id)).messages.find(item => item.id === next.assistantMessageId)?.attachments).toEqual([
      expect.objectContaining({ mediaAssetId: f.asset.id, status: "completed", ...(kind === "image" ? { imageSubject: "scene" } : {}) }),
    ]);
    const regenerated = (await regenerateChatTurn(f.id, next.assistantMessageId)).snapshot;
    expect(regenerated.recoveredMediaAction).toMatchObject({ name: "send_character_media", attachmentId: receipt.attachmentId,
      mediaAssetId: f.asset.id, generationJobId: null, status: "completed", costDreamcoins: 0 });
    expect(await applyChatToolEffect(effect(regenerated, "send_character_media", { previousMediaAssetId: f.asset.id })))
      .toMatchObject({ duplicate: true, attachmentId: receipt.attachmentId, mediaAssetId: f.asset.id });
    await complete(regenerated, receipt.attachmentId);
    expect((await getChatSession(f.id, f.session.id)).messages.find(item => item.id === next.assistantMessageId)?.attachments)
      .toEqual([expect.objectContaining({ id: receipt.attachmentId, mediaAssetId: f.asset.id, status: "completed" })]);
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
    expect(await dreamcoinBalance(f.id)).toBe(balance);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.id, reason: "generation_spend" } })).toBe(0);
  });

  it.each(["unchanged", "deleted", "locator", "digest"] as const)("keeps resend I/O outside locks and rechecks %s media before committing", async change => {
    const f = await deliveredScene("video");
    const next = await f.begin("Resend that exact video.");
    const replacementKey = `${f.id}/replacement.mp4`;
    if (change === "locator") {
      keys.push(replacementKey);
      await providers.blob.putPrivate({ key: replacementKey, body: f.bytes, contentType: "video/mp4" });
    }
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const get = providers.blob.getPrivate!.bind(providers.blob);
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => {
      if (input.key === f.asset.storageKey) {
        entered.resolve();
        await resume.promise;
      }
      return get(input);
    });
    const result = resend(next, f.asset.id).then(receipt => ({ receipt }), (error: unknown) => ({ error }));
    try {
      await Promise.race([entered.promise, result.then(() => { throw new Error("Resend settled before reading the delivered object"); })]);
      await prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
        await lockChatScope(tx, { userId: f.id, at: { turn: next.turnId }, expect: { attempt: next.attempt } });
        await lockCharacterGenerationAndMediaAssetAuthorities(tx, f.character.id, [f.asset.id]);
        if (change === "deleted") await tx.mediaAsset.update({ where: { id: f.asset.id }, data: { deletedAt: new Date() } });
        if (change === "locator") await tx.mediaAsset.update({ where: { id: f.asset.id }, data: { storageKey: replacementKey } });
        if (change === "digest") await tx.mediaAsset.update({ where: { id: f.asset.id }, data: { metadata: { synthetic: false, sha256: "f".repeat(64) } } });
      });
    } finally {
      resume.resolve();
    }
    const outcome = await result;
    if (change === "unchanged") {
      expect(outcome).toMatchObject({ receipt: { accepted: true, source: "previous_media", mediaAssetId: f.asset.id, costDreamcoins: 0 } });
    } else {
      expect(outcome).toMatchObject({ error: { code: change === "deleted" ? "not_found" : "conflict" } });
    }
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: next.turnId } })).toBe(change === "unchanged" ? 1 : 0);
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
  });

  it("rejects a resend whose destination attempt changed while the bytes were read", async () => {
    const f = await deliveredScene();
    const next = await f.begin("Resend that exact scene.");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const get = providers.blob.getPrivate!.bind(providers.blob);
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => {
      if (input.key === f.asset.storageKey) {
        entered.resolve();
        await resume.promise;
      }
      return get(input);
    });
    const delayed = resend(next, f.asset.id).then(receipt => ({ receipt }), (error: unknown) => ({ error }));
    let regenerated: ChatExecutionSnapshot;
    try {
      await Promise.race([entered.promise, delayed.then(() => { throw new Error("Resend settled before reading the delivered object"); })]);
      await complete(next);
      regenerated = (await regenerateChatTurn(f.id, next.assistantMessageId)).snapshot;
    } finally {
      resume.resolve();
    }
    expect(await delayed).toMatchObject({ error: { code: "conflict" } });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: next.turnId } })).toBe(0);
    expect(await resend(regenerated, f.asset.id)).toMatchObject({ accepted: true, mediaAssetId: f.asset.id, source: "previous_media" });
  });

  it("replays the completed resend winner after a competing byte check fails", async () => {
    const f = await deliveredScene("video");
    const next = await f.begin("Resend that exact video.");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const get = providers.blob.getPrivate!.bind(providers.blob);
    let first = true;
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => {
      if (input.key === f.asset.storageKey && first) {
        first = false;
        entered.resolve();
        await resume.promise;
        return { ok: false, error: { code: "get_failed", message: "Fixture storage read failed", retryable: true } };
      }
      return get(input);
    });
    const delayed = resend(next, f.asset.id).then(receipt => ({ receipt }), (error: unknown) => ({ error }));
    let winner: Awaited<ReturnType<typeof resend>>;
    try {
      await Promise.race([entered.promise, delayed.then(() => { throw new Error("Resend settled before reading the delivered object"); })]);
      winner = await resend(next, f.asset.id);
      await complete(next, winner.attachmentId);
    } finally {
      resume.resolve();
    }
    expect(await delayed).toEqual({ receipt: { ...winner, duplicate: true } });
    expect(winner).toMatchObject({ source: "previous_media", mediaAssetId: f.asset.id, costDreamcoins: 0 });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: next.turnId } })).toBe(1);
  });

  it("keeps completed edit provenance through later resends without calling the delivery request an observed description", async () => {
    const f = await deliveredEdit();
    // Mutable Job controls and asset quality are not execution authority.
    await prisma.generationJob.update({ where: { id: f.jobId }, data: { controls: { localizedEdit: { operation: { kind: "recolor", color: "#ff0000" } } } } });
    await prisma.mediaAsset.update({ where: { id: f.asset.id }, data: { metadata: { index: 0, synthetic: false } } });
    const next = await f.begin("Resend the blue-mug edit.");
    expect(next.recentMedia).toContainEqual({ mediaAssetId: f.asset.id, kind: "image", turnId: f.snapshot.turnId,
      description: null, editProvenance: f.editProvenance });
    const receipt = sendCharacterMediaResultSchema.parse(await applyChatToolEffect(effect(next, "send_character_media", { previousMediaAssetId: f.asset.id })));
    await complete(next, receipt.attachmentId);
    const later = await f.begin("Which image did you just send?");
    expect(later.recentMedia).toContainEqual({ mediaAssetId: f.asset.id, kind: "image", turnId: next.turnId,
      description: null, editProvenance: f.editProvenance });
  });

  it("does not attribute a requested edit to the unedited asset accidentally sent for that request", async () => {
    const f = await deliveredEdit();
    const next = await f.begin("Resend the blue-mug edit.");
    const wrong = sendCharacterMediaResultSchema.parse(await applyChatToolEffect(effect(next, "send_character_media", { previousMediaAssetId: f.source.id })));
    await complete(next, wrong.attachmentId);
    const later = await f.begin("Which image did you send?");
    expect(later.recentMedia?.[0]).toEqual({ mediaAssetId: f.source.id, kind: "image", turnId: next.turnId, description: null });
    expect(later.recentMedia).toContainEqual(expect.objectContaining({ mediaAssetId: f.asset.id, editProvenance: f.editProvenance }));
  });

  it("does not promote a preservation claim accepted for an ordinary generation without a confirmed edit dispatch", async () => {
    const f = await deliveredEdit(false);
    expect((f.asset.metadata as { quality: { preservation: unknown } }).quality.preservation).toBeDefined();
    const next = await f.begin("What did you change?");
    expect(next.recentMedia?.find(media => media.mediaAssetId === f.asset.id)).toEqual({ mediaAssetId: f.asset.id,
      kind: "image", turnId: f.snapshot.turnId, description: null });
  });

  it.each(["output-key", "other-attempt", "changed-operation"] as const)("withholds provenance when %s no longer matches accepted execution", async mismatch => {
    const f = await deliveredEdit();
    if (mismatch === "output-key") {
      const otherKey = `gen/${f.jobId}/attempts/${f.attemptId}/unbound-image.png`;
      keys.push(otherKey);
      await providers.blob.putPrivate({ key: otherKey, body: f.bytes, contentType: "image/png" });
      await prisma.mediaAsset.update({ where: { id: f.asset.id }, data: { storageKey: otherKey } });
    }
    if (mismatch === "other-attempt") {
      const other = await prisma.generationAttempt.create({ data: { requestId: f.jobId, attemptNo: 2, provider: "local-image", status: "succeeded" } });
      await prisma.generationArtifact.updateMany({ where: { assetId: f.asset.id }, data: { attemptId: other.id } });
    }
    if (mismatch === "changed-operation") await prisma.mainOutboxEvent.update({ where: { id: f.dispatchId }, data: {
      payload: { ...f.dispatch, queueInput: { ...f.dispatch.queueInput, payload: { ...f.dispatch.queueInput.payload,
        controls: { ...f.dispatch.queueInput.payload.controls, localizedEdit: { ...f.dispatch.queueInput.payload.controls.localizedEdit!, operation: { kind: "recolor", color: "#ff0000" } } },
      } } },
    } });
    const next = await f.begin("Resend the blue-mug edit.");
    expect(next.recentMedia?.find(media => media.mediaAssetId === f.asset.id)).not.toHaveProperty("editProvenance");
  });

  it.each(["deleted", "other-owner", "stale-attempt"])("does not expose a scene delivery after %s", async condition => {
    const f = await deliveredScene();
    if (condition === "deleted") await prisma.mediaAsset.update({ where: { id: f.asset.id }, data: { deletedAt: new Date() } });
    if (condition === "other-owner") await prisma.mediaAsset.update({ where: { id: f.asset.id }, data: { ownerId: f.sourceOwnerId } });
    if (condition === "stale-attempt") await prisma.chatTurnAttachment.update({ where: { id: f.attachment.id }, data: { metadata: { attempt: 2 } } });
    const next = await f.begin("Resend that scene.");
    expect(next.recentMedia).toEqual([]);
    await expect(applyChatToolEffect(effect(next, "send_character_media", { previousMediaAssetId: f.asset.id }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a scene ID copied into another session's frozen snapshot", async () => {
    const f = await deliveredScene();
    const originalSession = await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.session.id } });
    const otherSessionId = `${f.id}-other-scene-session`;
    await prisma.recentChat.create({ data: { sessionId: otherSessionId, userId: f.id, characterId: f.character.id,
      characterContentVersionId: originalSession.characterContentVersionId, characterVisualProfileId: f.visual.id,
      characterVisualProfileVersion: f.visual.version, memoryEnabled: false } });
    const next = (await beginChatTurn({ userId: f.id, sessionId: otherSessionId, content: "Resend that scene.", idempotencyKey: randomUUID() })).snapshot;
    if (!next) throw new Error("No next snapshot");
    expect(next.recentMedia).toEqual([]);
    await prisma.chatTurn.update({ where: { id: next.turnId }, data: { executionSnapshot: JSON.parse(JSON.stringify({ ...next,
      recentMedia: [{ mediaAssetId: f.asset.id, turnId: f.snapshot.turnId, kind: "image", description: null }],
    })) } });
    await expect(applyChatToolEffect(effect(next, "send_character_media", { previousMediaAssetId: f.asset.id }))).rejects.toMatchObject({ code: "not_found" });
  });

  it.each(["image", "video"] as const)("preserves owned %s history and explicit resend after withdrawal and original source deletion", async kind => {
    const f = await fixture(kind);
    const snapshot = await f.begin();
    const original = await send(snapshot, (await search(snapshot, kind)).matches[0]!.candidateToken);
    await complete(snapshot);
    await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { status: "withdrawn", revision: { increment: 1 } } });
    await prisma.user.delete({ where: { id: f.sourceOwnerId } });
    await providers.blob.delete({ key: f.sourceKey });
    const next = await f.begin(`Send the previous ${kind} again.`);
    const repeated = sendCharacterMediaResultSchema.parse(await applyChatToolEffect(effect(next, "send_character_media", { previousMediaAssetId: original.mediaAssetId })));
    expect(repeated).toMatchObject({ source: "previous_media", mediaAssetId: original.mediaAssetId, costDreamcoins: 0 });
    const bytes = await api("GET", `media/${original.mediaAssetId}/content`, { userId: f.id, ageGate: true });
    expectOk(bytes);
    expect(Buffer.from(bytes.bytes!)).toEqual(f.bytes);
    const outsider = `${prefix}${randomUUID()}`;
    await createUser({ id: outsider });
    const denied = await api("GET", `media/${original.mediaAssetId}/content`, { userId: outsider, ageGate: true });
    expect(denied.status).toBe(404);
    if (kind === "video") {
      const token = Buffer.from(original.mediaAssetId, "utf8").toString("base64url");
      const filename = "poster.jpg";
      const path = `/user-content/${token}/${filename}`;
      const view = await getChatSession(f.id, f.session.id);
      expect(view.messages.find(message => message.id === snapshot.assistantMessageId)?.attachments).toEqual([
        expect.objectContaining({ mediaAssetId: original.mediaAssetId, thumbnailUrl: path }),
      ]);
      const readPoster = (userId: string) => userContentRoute(new Request(`http://localhost${path}`, {
        headers: { "x-idream-user-id": userId, cookie: "idream_age_gate=accepted" },
      }), { params: Promise.resolve({ id: token, filename }) });
      const poster = await readPoster(f.id);
      expect(poster.status).toBe(200);
      expect(poster.headers.get("content-type")).toBe("image/jpeg");
      expect(Buffer.from(await poster.arrayBuffer())).toEqual(f.posterBytes);
      expect((await readPoster(outsider)).status).toBe(404);
      await providers.blob.delete({ key: f.entry.thumbnailKey! });
      expect((await readPoster(f.id)).status).toBe(404);
      expectOk(await api("GET", `media/${original.mediaAssetId}/content`, { userId: f.id, ageGate: true }));
    }
  });

  it.each(["none", "full"] as const)("keeps signed %s search intent when the send tool has its default intent", async requestedNudity => {
    const f = await fixture();
    await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: {
      nudity: requestedNudity, revision: { increment: 1 },
      embeddingHash: libraryDescriptorHash({ ...f.entry, nudity: requestedNudity }),
    } });
    const snapshot = await f.begin();
    const token = (await search(snapshot, "image", { requestedNudity })).matches[0]!.candidateToken;
    expect(token.split(".")[4]).toBe(requestedNudity === "none" ? "n" : "f");
    const delivered = await send(snapshot, token);
    expect(delivered).toMatchObject({ accepted: true, costDreamcoins: 0, source: "library" });
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: delivered.attachmentId } })).toMatchObject({
      metadata: expect.objectContaining({ request: expect.objectContaining({ requestedNudity }),
        effect: expect.objectContaining({ intent: { requestedNudity: "unspecified" } }) }),
    });
    await complete(snapshot);
    const differentSharedDefault = requestedNudity === "none" ? "full" : "none";
    const replay = effect(snapshot, "send_character_media", { candidateToken: token });
    replay.intent.requestedNudity = differentSharedDefault;
    expect(await applyChatToolEffect(replay)).toMatchObject({ duplicate: true, mediaAssetId: delivered.mediaAssetId });
    const next = await f.begin("Resend that same photo.");
    const resend = effect(next, "send_character_media", { previousMediaAssetId: delivered.mediaAssetId });
    resend.intent.requestedNudity = differentSharedDefault;
    expect(await applyChatToolEffect(resend)).toMatchObject({ accepted: true, source: "previous_media", mediaAssetId: delivered.mediaAssetId });
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.id, reason: "generation_spend" } })).toBe(0);
  });

  it.each(["unseen", "nudity", "contentHash"])("rejects a changed signed %s fact without creating delivery", async changed => {
    const f = await fixture();
    const snapshot = await f.begin();
    const parts = (await search(snapshot)).matches[0]!.candidateToken.split(".");
    if (changed === "unseen") parts[3] = "0";
    if (changed === "nudity") parts[4] = "n";
    if (changed === "contentHash") await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { contentHash: "f".repeat(64) } });
    await expect(send(snapshot, parts.join("."))).rejects.toMatchObject({ code: "forbidden" });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(0);
  });

  it("binds a short candidate to its original Turn even for the same account, Character and attempt number", async () => {
    const f = await fixture();
    const first = await f.begin();
    const token = (await search(first)).matches[0]!.candidateToken;
    await complete(first);
    const second = await f.begin();
    expect(second.attempt).toBe(first.attempt);
    await expect(send(second, token)).rejects.toMatchObject({ code: "forbidden" });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: second.turnId } })).toBe(0);
  });

  it.each(["withdrawn", "revision", "missing bytes", "changed bytes", "account", "signature"])("rejects a candidate after %s changed without creating delivery", async change => {
    const f = await fixture();
    const snapshot = await f.begin();
    const signed = (await search(snapshot)).matches[0]!.candidateToken;
    const parts = signed.split(".");
    if (change === "signature") parts[5] = `${parts[5]!.startsWith("A") ? "B" : "A"}${parts[5]!.slice(1)}`;
    const token = parts.join(".");
    if (change === "withdrawn") await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { status: "withdrawn" } });
    if (change === "revision") await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { revision: { increment: 1 } } });
    if (change === "missing bytes") await providers.blob.delete({ key: f.libraryKey });
    if (change === "changed bytes") {
      await providers.blob.putPrivate({ key: f.libraryKey, body: Buffer.alloc(f.bytes.byteLength), contentType: "image/png" });
    }
    const target = change === "account" ? await (await fixture()).begin() : snapshot;
    await expect(send(target, token)).rejects.toMatchObject({ code: expect.stringMatching(/conflict|gone|forbidden|bad_request/) });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: target.turnId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
  });

  it("does not hold Character authority during the library read, then rejects a concurrent withdrawal", async () => {
    const f = await fixture("video");
    const snapshot = await f.begin();
    const token = (await search(snapshot, "video")).matches[0]!.candidateToken;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const get = providers.blob.getPrivate!.bind(providers.blob);
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => {
      if (input.key === f.libraryKey) {
        entered.resolve();
        await resume.promise;
      }
      return get(input);
    });
    const result = send(snapshot, token).then(receipt => ({ receipt }), (error: unknown) => ({ error }));
    try {
      await Promise.race([entered.promise, result.then(() => { throw new Error("Delivery settled before reading the library object"); })]);
      await prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
        await lockCharacterGenerationAndMediaAssetAuthorities(tx, f.character.id, [f.source.id]);
        await tx.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { status: "withdrawn", revision: { increment: 1 } } });
      });
    } finally {
      resume.resolve();
    }
    expect(await result).toMatchObject({ error: { code: "conflict" } });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(0);
  });

  it("returns the winning receipt after a concurrent send commits and finishes during a failed library read", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    const token = (await search(snapshot)).matches[0]!.candidateToken;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const get = providers.blob.getPrivate!.bind(providers.blob);
    let first = true;
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => {
      if (input.key === f.libraryKey && first) {
        first = false;
        entered.resolve();
        await resume.promise;
        return { ok: false, error: { code: "get_failed", message: "Fixture storage read failed", retryable: true } };
      }
      return get(input);
    });
    const delayed = send(snapshot, token).then(receipt => ({ receipt }), (error: unknown) => ({ error }));
    let winner: Awaited<ReturnType<typeof send>>;
    try {
      await Promise.race([entered.promise, delayed.then(() => { throw new Error("Delivery settled before reading the library object"); })]);
      winner = await send(snapshot, token);
      await complete(snapshot, winner.attachmentId);
    } finally {
      resume.resolve();
    }
    expect(await delayed).toEqual({ receipt: { ...winner, duplicate: true } });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(1);
  });

  it("rejects stale attempts and guessed previous IDs, while a user edit creates a separate action", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    const token = (await search(snapshot)).matches[0]!.candidateToken;
    await complete(snapshot);
    const regenerated = (await regenerateChatTurn(f.id, snapshot.assistantMessageId)).snapshot;
    await expect(send(regenerated, token)).rejects.toMatchObject({ code: "forbidden" });
    await expect(applyChatToolEffect(effect(regenerated, "send_character_media", { previousMediaAssetId: f.source.id }))).rejects.toMatchObject({ code: "forbidden" });
    const delivered = await send(regenerated, (await search(regenerated)).matches[0]!.candidateToken);
    await complete(regenerated);
    // This suite drives Main directly; acknowledge the independent memory worker
    // before editing, as the existing Turn authorization fixtures do.
    await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: `${f.id}:${f.character.id}` }, data: { status: "delivered", deliveredAt: new Date() } });
    const edited = (await editChatTurn(f.id, snapshot.userMessageId, "Actually send the same red dress image again.")).snapshot;
    if (!edited) throw new Error("No frozen edited Turn");
    const newToken = (await search(edited, "image", { unseenOnly: false })).matches[0]!.candidateToken;
    const replacement = await send(edited, newToken);
    expect(replacement.attachmentId).not.toBe(delivered.attachmentId);
    expect(replacement.mediaAssetId).not.toBe(delivered.mediaAssetId);
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
  });

  it("never rebinds an invalidated delivery after the user edits back to the original words", async () => {
    const f = await fixture();
    const original = await f.begin();
    const delivery = await send(original, (await search(original)).matches[0]!.candidateToken);
    await complete(original, delivery.attachmentId);
    const changed = (await editChatTurn(f.id, original.userMessageId, "Actually just say hello.")).snapshot!;
    await complete(changed);
    const acknowledgeMemoryRebuild = () => prisma.mainOutboxEvent.updateMany({
      where: { aggregateId: `${f.id}:${f.character.id}` }, data: { status: "delivered", deliveredAt: new Date() },
    });
    await acknowledgeMemoryRebuild();
    const restored = (await editChatTurn(f.id, original.userMessageId, original.userContent)).snapshot!;
    const token = (await search(restored)).matches[0]!.candidateToken;
    const newDelivery = await send(restored, token);
    expect(newDelivery.attachmentId).not.toBe(delivery.attachmentId);
    expect(newDelivery.mediaAssetId).not.toBe(delivery.mediaAssetId);
    await complete(restored, newDelivery.attachmentId);

    await acknowledgeMemoryRebuild();
    const regenerated = (await regenerateChatTurn(f.id, original.assistantMessageId)).snapshot;
    expect(regenerated.recoveredMediaAction?.attachmentId).toBe(newDelivery.attachmentId);
    expect(await send(regenerated, token)).toMatchObject({ duplicate: true, attachmentId: newDelivery.attachmentId });
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
  });

  it.each(["edited", "deleted", "cross-character"])("does not expose %s media as recent delivery", async condition => {
    const f = await fixture();
    const snapshot = await f.begin();
    const original = await send(snapshot, (await search(snapshot)).matches[0]!.candidateToken);
    await complete(snapshot);
    if (condition === "edited") {
      const edited = (await editChatTurn(f.id, snapshot.userMessageId, "Actually just say hello.")).snapshot;
      if (!edited) throw new Error("Missing edited turn");
      await complete(edited);
    } else if (condition === "deleted") {
      await prisma.mediaAsset.update({ where: { id: original.mediaAssetId }, data: { deletedAt: new Date() } });
    } else {
      const another = await createCharacter({ id: `${f.id}-another-character`, creatorId: f.id, source: "user", visibility: "private" });
      await prisma.mediaAsset.update({ where: { id: original.mediaAssetId }, data: { characterId: another.id } });
    }
    const next = await f.begin("Send the previous one.");
    expect(next.recentMedia).toEqual([]);
    await expect(applyChatToolEffect(effect(next, "send_character_media", { previousMediaAssetId: original.mediaAssetId }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a copied recent-media pointer when the delivery belongs to a different session", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    const original = await send(snapshot, (await search(snapshot)).matches[0]!.candidateToken);
    await complete(snapshot);
    const originalSession = await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.session.id } });
    const otherSessionId = `${f.id}-second-session`;
    await prisma.recentChat.create({ data: { sessionId: otherSessionId, userId: f.id, characterId: f.character.id,
      characterContentVersionId: originalSession.characterContentVersionId, characterVisualProfileId: f.visual.id,
      characterVisualProfileVersion: f.visual.version, memoryEnabled: false } });
    const next = (await beginChatTurn({ userId: f.id, sessionId: otherSessionId, content: "Send that photo again.", idempotencyKey: randomUUID() })).snapshot;
    if (!next) throw new Error("No next snapshot");
    expect(next.recentMedia).toEqual([]);
    // Even a poisoned context pointer is not authority to cross a session.
    await prisma.chatTurn.update({ where: { id: next.turnId }, data: { executionSnapshot: JSON.parse(JSON.stringify({ ...next,
      recentMedia: [{ mediaAssetId: original.mediaAssetId, turnId: snapshot.turnId, kind: "image", description: f.entry.description }],
    })) } });
    await expect(applyChatToolEffect(effect(next, "send_character_media", { previousMediaAssetId: original.mediaAssetId }))).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not reattach a user-deleted media asset when regenerating the same Turn", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    const token = (await search(snapshot)).matches[0]!.candidateToken;
    const original = await send(snapshot, token);
    await complete(snapshot);
    expectOk(await api("DELETE", `media/${original.mediaAssetId}`, { userId: f.id, ageGate: true }));
    const regenerated = (await regenerateChatTurn(f.id, snapshot.assistantMessageId)).snapshot;
    await expect(send(regenerated, token)).rejects.toMatchObject({ code: "gone" });
    expect((await getChatSession(f.id, f.session.id)).messages.find(item => item.id === snapshot.assistantMessageId)?.attachments).toEqual([]);
  });

  it("retains an actual delivered photo when the accompanying text reply fails", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    const original = await send(snapshot, (await search(snapshot)).matches[0]!.candidateToken);
    await commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
      attempt: snapshot.attempt, status: "failed", content: "", model: null, promptTokens: null, completionTokens: null,
      sceneVersion: snapshot.sceneVersion, scene: snapshot.scene,
      terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 5,
        systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
    const next = await f.begin("Please resend that photo.");
    expect(next.recentMedia).toEqual([expect.objectContaining({ mediaAssetId: original.mediaAssetId })]);
    expect(next.hasRecentImageContext).toBe(true);
    expect(await applyChatToolEffect(effect(next, "send_character_media", { previousMediaAssetId: original.mediaAssetId })))
      .toMatchObject({ accepted: true, source: "previous_media", mediaAssetId: original.mediaAssetId });
  });
});
