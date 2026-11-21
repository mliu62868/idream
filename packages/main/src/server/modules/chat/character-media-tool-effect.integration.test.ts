import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { compileCharacterSoul } from "@idream/shared";
import { resendSessionMediaResultSchema } from "@idream/shared/chat/media-library";
import { CONFIRMED_IMAGE_EDIT_VERSION } from "@idream/shared/chat/image-action";
import { generationTerminalRecordChecksum } from "@idream/shared/contracts/durable-server";
import { recolorRgba } from "@idream/shared/media/image-recolor";
import { CHAT_SEND_PROTOCOL_VERSION, type ChatExecutionSnapshot, type ChatToolEffect } from "@idream/shared/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { dispatchPendingGenerationTerminalRecords, ingestGenerationTerminalRecord } from "@/server/ai/generation-terminal-record-ingest";
import { drainGenerationFinalization } from "@/server/ai/generation-finalize-drain";
import { createCharacter, createUser, dreamcoinBalance, purgeTestData } from "@/server/test/helpers";
import { characterContentHash } from "@/server/modules/admin-v2/shared/character-content-identity";
import { applyChatToolEffect } from "./tool-effect";
import { createToolEffectAttachment, transitionToolEffectAttachment } from "./tool-effect-attachment";
import { lockChatScope } from "./turn-scope";
import { beginChatTurn, commitChatTerminal, createChatSession, getChatSession, regenerateChatTurn } from "./turn-ledger";

const prefix = `zt-chat-library-${randomUUID()}-`;
const keys: string[] = [];
afterAll(async () => {
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
  const contentType = kind === "image" ? "image/png" : "video/mp4";
  const session = await createChatSession(id, { characterId: character.id });
  await prisma.recentChat.update({ where: { sessionId: session.id }, data: { memoryEnabled: false } });
  const begin = async (text = "Send me one in a red dress beside a rainy window.", allowPaidImage = false) => {
    const result = await beginChatTurn({ sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION, userId: id, sessionId: session.id, content: text, idempotencyKey: randomUUID(), allowPaidImage });
    if (!result.snapshot) throw new Error("No frozen turn");
    return result.snapshot;
  };
  return { id, character, session, sourceOwnerId, contentType, bytes, begin };
}

async function deliveredScene(kind: "image" | "video" = "image") {
  const f = await fixture(kind);
  const snapshot = await f.begin("Send the scene.");
  const sceneKey = `${f.id}/scene.${kind === "image" ? "png" : "mp4"}`;
  keys.push(sceneKey);
  await providers.blob.putPrivate({ key: sceneKey, body: f.bytes, contentType: f.contentType });
  const asset = await prisma.mediaAsset.create({ data: {
    id: `${f.id}-scene`, ownerId: f.id, characterId: null, type: kind,
    url: `/api/media/${f.id}-scene/content`, storageKey: sceneKey, contentType: f.contentType,
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

async function resend(snapshot: ChatExecutionSnapshot, previousMediaAssetId: string) {
  const effect: ChatToolEffect = {
    version: 2, turnId: snapshot.turnId, attempt: snapshot.attempt, callId: randomUUID(),
    name: "resend_session_media", effectScope: "turn_action",
    intent: { requestedNudity: "unspecified" }, arguments: { previousMediaAssetId },
  };
  return resendSessionMediaResultSchema.parse(await applyChatToolEffect(effect));
}

const unknownFacts = { facts: [], absentFacts: [], nudity: "unknown", durationSeconds: null, hasAudio: null };
async function complete(snapshot: ChatExecutionSnapshot, attachmentId?: string) {
  return commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content: attachmentId ? "" : "Here is one by the rainy window.", model: "fixture", promptTokens: 1, completionTokens: 1,
    sceneVersion: snapshot.sceneVersion + 1, scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: "rainy window", time: null,
      participants: [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "test", ...(attachmentId ? { mediaResponse: { version: 1, attachmentId } } : {}), prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 5,
      systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
}

describe("Main session media delivery authority", () => {
  it("does not let a paid generation attachment take the free direct-completion edge", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    await expect(prisma.$transaction(async tx => {
      const scope = await lockChatScope(tx, { userId: f.id, at: { turn: snapshot.turnId } });
      const created = await createToolEffectAttachment(tx, { id: `${f.id}-paid-bypass`, turn: scope.turn!, attempt: 1,
        kind: "generated_image", metadata: { costDreamcoins: 5 } });
      await transitionToolEffectAttachment(tx, created, { to: "completed", generationJobId: null, mediaAssetId: f.id + "-unowned-media" });
    })).rejects.toMatchObject({ code: "conflict" });
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(0);
  });

  it.each(["image", "video"] as const)("resends a delivered scene %s from the same conversation without changing its identity or charging", async kind => {
    const f = await deliveredScene(kind);
    const balance = await dreamcoinBalance(f.id);
    const next = await f.begin("Resend the exact scene you just sent.");
    expect(next.recentMedia).toEqual([{ mediaAssetId: f.asset.id, kind, turnId: f.snapshot.turnId, description: null, ...unknownFacts }]);
    expect(next.hasRecentImageContext).toBe(kind === "image");
    const receipt = await resend(next, f.asset.id);
    expect(receipt).toMatchObject({ accepted: true, source: "previous_media", mediaAssetId: f.asset.id, costDreamcoins: 0 });
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: receipt.attachmentId } })).toMatchObject({
      metadata: expect.objectContaining({ request: expect.objectContaining({ subject: "scene" }) }),
    });
    await complete(next, receipt.attachmentId);
    expect((await getChatSession(f.id, f.session.id)).messages.find(item => item.id === next.assistantMessageId)?.attachments).toEqual([
      expect.objectContaining({ mediaAssetId: f.asset.id, status: "completed", ...(kind === "image" ? { imageSubject: "scene" } : {}) }),
    ]);
    const regenerated = (await regenerateChatTurn(f.id, next.assistantMessageId)).snapshot;
    expect(regenerated.recoveredMediaAction).toMatchObject({ name: "resend_session_media", attachmentId: receipt.attachmentId,
      mediaAssetId: f.asset.id, generationJobId: null, status: "completed", costDreamcoins: 0 });
    expect(await resend(regenerated, f.asset.id))
      .toMatchObject({ duplicate: true, attachmentId: receipt.attachmentId, mediaAssetId: f.asset.id });
    await complete(regenerated, receipt.attachmentId);
    expect((await getChatSession(f.id, f.session.id)).messages.find(item => item.id === next.assistantMessageId)?.attachments)
      .toEqual([expect.objectContaining({ id: receipt.attachmentId, mediaAssetId: f.asset.id, status: "completed" })]);
    expect(await prisma.generationJob.count({ where: { userId: f.id } })).toBe(0);
    expect(await dreamcoinBalance(f.id)).toBe(balance);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.id, reason: "generation_spend" } })).toBe(0);
  });

  it("keeps completed edit provenance through later resends without calling the delivery request an observed description", async () => {
    const f = await deliveredEdit();
    // Mutable Job controls and asset quality are not execution authority.
    await prisma.generationJob.update({ where: { id: f.jobId }, data: { controls: { localizedEdit: { operation: { kind: "recolor", color: "#ff0000" } } } } });
    await prisma.mediaAsset.update({ where: { id: f.asset.id }, data: { metadata: { index: 0, synthetic: false } } });
    const next = await f.begin("Resend the blue-mug edit.");
    expect(next.recentMedia).toContainEqual({ mediaAssetId: f.asset.id, kind: "image", turnId: f.snapshot.turnId,
      description: null, ...unknownFacts, editProvenance: f.editProvenance });
    const receipt = await resend(next, f.asset.id);
    await complete(next, receipt.attachmentId);
    const later = await f.begin("Which image did you just send?");
    expect(later.recentMedia).toContainEqual({ mediaAssetId: f.asset.id, kind: "image", turnId: next.turnId,
      description: null, ...unknownFacts, editProvenance: f.editProvenance });
  });

  it("does not attribute a requested edit to the unedited asset accidentally sent for that request", async () => {
    const f = await deliveredEdit();
    const next = await f.begin("Resend the blue-mug edit.");
    const wrong = await resend(next, f.source.id);
    await complete(next, wrong.attachmentId);
    const later = await f.begin("Which image did you send?");
    expect(later.recentMedia?.[0]).toEqual({ mediaAssetId: f.source.id, kind: "image", turnId: next.turnId, description: null, ...unknownFacts });
    expect(later.recentMedia).toContainEqual(expect.objectContaining({ mediaAssetId: f.asset.id, editProvenance: f.editProvenance }));
  });

  it("does not promote a preservation claim accepted for an ordinary generation without a confirmed edit dispatch", async () => {
    const f = await deliveredEdit(false);
    expect((f.asset.metadata as { quality: { preservation: unknown } }).quality.preservation).toBeDefined();
    const next = await f.begin("What did you change?");
    expect(next.recentMedia?.find(media => media.mediaAssetId === f.asset.id)).toEqual({ mediaAssetId: f.asset.id,
      kind: "image", turnId: f.snapshot.turnId, description: null, ...unknownFacts });
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
    await expect(resend(next, f.asset.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a scene ID copied into another session's frozen snapshot", async () => {
    const f = await deliveredScene();
    const originalSession = await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.session.id } });
    const otherSessionId = `${f.id}-other-scene-session`;
    await prisma.recentChat.create({ data: { sessionId: otherSessionId, userId: f.id, characterId: f.character.id,
      characterContentVersionId: originalSession.characterContentVersionId, memoryEnabled: false } });
    const next = (await beginChatTurn({ sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION, userId: f.id, sessionId: otherSessionId, content: "Resend that scene.", idempotencyKey: randomUUID() })).snapshot;
    if (!next) throw new Error("No next snapshot");
    expect(next.recentMedia).toEqual([]);
    await prisma.chatTurn.update({ where: { id: next.turnId }, data: { executionSnapshot: JSON.parse(JSON.stringify({ ...next,
      recentMedia: [{ mediaAssetId: f.asset.id, turnId: f.snapshot.turnId, kind: "image", description: null }],
    })) } });
    await expect(resend(next, f.asset.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("preserves an already delivered asset after the accompanying text reply fails", async () => {
    const f = await deliveredScene();
    const next = await f.begin("Resend the scene and describe the weather.");
    const receipt = await resend(next, f.asset.id);
    await commitChatTerminal({ version: 1, turnId: next.turnId, sessionId: next.sessionId,
      assistantMessageId: next.assistantMessageId, attempt: next.attempt, status: "failed", content: "",
      model: null, promptTokens: null, completionTokens: null, sceneVersion: next.sceneVersion, scene: next.scene,
      terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1",
        preparedTurnVersion: 5, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
    const later = await f.begin("Please resend that photo.");
    expect(later.recentMedia).toEqual([expect.objectContaining({ mediaAssetId: receipt.mediaAssetId, turnId: next.turnId })]);
    expect(later.hasRecentImageContext).toBe(true);
    expect(await resend(later, receipt.mediaAssetId)).toMatchObject({ status: "completed", costDreamcoins: 0 });
  });
});
