import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { compileCharacterSoul } from "@idream/shared";
import { searchCharacterMediaResultSchema, sendCharacterMediaResultSchema, type SearchCharacterMediaArgs } from "@idream/shared/chat/media-library";
import type { ChatExecutionSnapshot, ChatToolEffect } from "@idream/shared/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { OPERATOR_UPLOAD_AUTHORITY_SCHEMA, resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import { api, createCharacter, createUser, dreamcoinBalance, expectOk, purgeTestData } from "@/server/test/helpers";
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
    status: "published", ...descriptor, width: 8, height: 8, contentType, storageKey: libraryKey, contentHash,
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
  return { id, character, session, visual, entry, source, sourceOwnerId, sourceKey, libraryKey, bytes, begin };
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
async function complete(snapshot: ChatExecutionSnapshot) {
  await commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content: "Here is one by the rainy window.", model: "fixture", promptTokens: 1, completionTokens: 1,
    sceneVersion: snapshot.sceneVersion + 1, scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: "rainy window", time: null,
      participants: [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 5,
      systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
}

describe("Main Character media delivery authority", () => {
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

  it("preserves owned history and explicit resend after withdrawal and original source deletion", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    const original = await send(snapshot, (await search(snapshot)).matches[0]!.candidateToken);
    await complete(snapshot);
    await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { status: "withdrawn", revision: { increment: 1 } } });
    await prisma.user.delete({ where: { id: f.sourceOwnerId } });
    await providers.blob.delete({ key: f.sourceKey });
    const next = await f.begin("Send the previous picture again.");
    const repeated = sendCharacterMediaResultSchema.parse(await applyChatToolEffect(effect(next, "send_character_media", { previousMediaAssetId: original.mediaAssetId })));
    expect(repeated).toMatchObject({ source: "previous_media", mediaAssetId: original.mediaAssetId, costDreamcoins: 0 });
    const bytes = await api("GET", `media/${original.mediaAssetId}/content`, { userId: f.id, ageGate: true });
    expectOk(bytes);
    expect(Buffer.from(bytes.bytes!)).toEqual(f.bytes);
    const outsider = `${prefix}${randomUUID()}`;
    await createUser({ id: outsider });
    const denied = await api("GET", `media/${original.mediaAssetId}/content`, { userId: outsider, ageGate: true });
    expect(denied.status).toBe(404);
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

  it.each(["withdrawn", "revision", "bytes", "account", "signature"])("rejects a candidate after %s changed without creating delivery", async change => {
    const f = await fixture();
    const snapshot = await f.begin();
    const signed = (await search(snapshot)).matches[0]!.candidateToken;
    const parts = signed.split(".");
    if (change === "signature") parts[5] = `${parts[5]!.startsWith("A") ? "B" : "A"}${parts[5]!.slice(1)}`;
    const token = parts.join(".");
    if (change === "withdrawn") await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { status: "withdrawn" } });
    if (change === "revision") await prisma.characterMediaLibraryEntry.update({ where: { id: f.entry.id }, data: { revision: { increment: 1 } } });
    if (change === "bytes") await providers.blob.delete({ key: f.libraryKey });
    const target = change === "account" ? await (await fixture()).begin() : snapshot;
    await expect(send(target, token)).rejects.toMatchObject({ code: expect.stringMatching(/conflict|gone|forbidden|bad_request/) });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: target.turnId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
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

  it.each(["discarded", "deleted", "cross-character"])("does not expose %s media as recent delivery", async condition => {
    const f = await fixture();
    const snapshot = await f.begin();
    const original = await send(snapshot, (await search(snapshot)).matches[0]!.candidateToken);
    await complete(snapshot);
    if (condition === "discarded") {
      const regenerated = (await regenerateChatTurn(f.id, snapshot.assistantMessageId)).snapshot;
      await complete(regenerated);
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
