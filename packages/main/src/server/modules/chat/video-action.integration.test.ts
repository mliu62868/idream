import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import { MAIN_QUEUES } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { api, createCharacter, createMedia, createUser, dreamcoinBalance, expectError, expectOk, generationTestProviders, grantCoins, purgeTestData, runQueuedGenerationJobs } from "@/server/test/helpers";
import { characterContentHash } from "@/server/modules/admin-v2/shared/character-content-identity";
import { characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { parseGenerationContextResponse } from "@/lib/public-api-contracts";
import { quoteAuthorityFor } from "../ourdream/generation-quote";
import * as attempts from "../generation/generation-attempt-authority";
import { editChatTurn, getChatSession } from "./turn-ledger";

const prefix = "zt-chat-video-";
const sourceKeys: string[] = [];
let originalFlag = false;
const videoQueues = ["ai.video.generate", MAIN_QUEUES.generationTerminalIngest, MAIN_QUEUES.aiFinalize];
beforeAll(async () => {
  await purgeTestData(prefix);
  originalFlag = (await prisma.featureFlag.findUnique({ where: { key: "chat_video" } }))?.enabled ?? false;
  await prisma.featureFlag.upsert({ where: { key: "chat_video" }, create: { key: "chat_video", label: "Chat video", enabled: true, targetRoles: [], targetPlans: [] }, update: { enabled: true } });
});
afterEach(async () => { vi.restoreAllMocks(); await prisma.featureFlag.update({ where: { key: "chat_video" }, data: { enabled: true } }); });
afterAll(async () => {
  await purgeTestData(prefix);
  await prisma.featureFlag.update({ where: { key: "chat_video" }, data: { enabled: originalFlag } });
  for (const key of sourceKeys) await providers.blob.delete({ key });
});

async function fixture() {
  const id = `${prefix}${randomUUID()}`;
  const userId = `${id}-user`;
  await createUser({ id: userId });
  await grantCoins(userId, 500);
  await prisma.entitlement.createMany({ data: ["premium_controls", "premium_models", "video_generation"].map(key => ({ userId, key, value: true, source: "test" })) });
  const character = await createCharacter({ id: `${id}-character`, creatorId: userId, source: "user", visibility: "private", name: "Original Mira" });
  const soul = compileCharacterSoul({ name: character.name, age: 25, gender: "female", characterPromise: "A curious companion", detailsMarkdown: "Calm and thoughtful." });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const values = { personaSnapshot: soul.snapshot, openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: { style: "realistic", identityAnchor: "short auburn hair" } };
  const content = await prisma.characterContentVersion.create({ data: { id: `${id}-content`, characterId: character.id, version: 1, sourceType: "test", contentHash: characterContentHash(values), ...JSON.parse(JSON.stringify(values)) } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  const anchor = await prisma.mediaAsset.create({ data: { id: `${id}-anchor`, ownerId: userId, characterId: character.id, type: "image", url: `/user-content/${id}/anchor.webp`, storageKey: `${id}/anchor.webp`, contentType: "image/webp", safetyStatus: "passed", metadata: { synthetic: false } } });
  const profileValues = { characterId: character.id, version: 1, status: "active", style: "realistic", identityPrompt: "Adult with short auburn hair", negativeIdentityPrompt: null, faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [anchor.id], adapterRefs: {}, createdFrom: "test", evidenceState: "qualified" };
  const visual = await prisma.characterVisualProfile.create({ data: { id: `${id}-visual`, ...profileValues, immutableHash: characterVisualProfileSnapshotHash(profileValues) } });
  const references = [{ mediaAssetId: anchor.id, position: 0, role: "identity_anchor", weight: 1 }];
  const referenceSet = await prisma.referenceSetRevision.create({ data: { id: `${id}-references`, visualProfileId: visual.id, revision: 1, status: "active", createdFrom: "test", snapshotHash: referenceSetSnapshotHash({ visualProfileId: visual.id, revision: 1, selectorVersion: "v1", references }), references: { create: references.map(value => ({ ...value, selectionReason: "original identity" })) } } });
  const project = await prisma.characterProject.create({ data: { id: `${id}-project`, characterId: character.id } });
  const release = await prisma.characterRelease.create({ data: { id: `${id}-release`, projectId: project.id, revisionId: `${id}-revision`, characterContentVersionId: content.id, visualProfileId: visual.id, visualProfileVersion: visual.version, referenceSetRevisionId: referenceSet.id, generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: `${id}-release-hash`, legacy: false, status: "published", publishedAt: new Date() } });
  const sessionId = `${id}-session`;
  await prisma.recentChat.create({ data: { sessionId, userId, characterId: character.id, characterContentVersionId: content.id, characterReleaseId: release.id, characterVisualProfileId: visual.id, characterVisualProfileVersion: visual.version } });
  const turnId = `${id}-turn`;
  const userMessageId = `${id}-user-message`;
  const scene = { schemaVersion: 1, version: 1, location: "the blue kitchen window", time: "morning", participants: ["Mira"], emotionalBeat: "a quiet conversation", unresolvedThreads: [] };
  await prisma.chatTurn.create({ data: { id: turnId, sessionId, attempt: 1, idempotencyKey: `${id}-chat`, requestHash: `${id}-chat-hash`, userMessageId, assistantMessageId: `${id}-reply`, userContent: "Stay beside the blue kitchen window.", assistantContent: "I stay beside the window.", assistantStatus: "sent", memoryEnabled: true, characterContentVersionId: content.id, characterReleaseId: release.id, characterVisualProfileId: visual.id, characterVisualProfileVersion: visual.version, scene, sceneVersion: 1, terminalAt: new Date(),
    executionSnapshot: { version: 1, turnId, sessionId, userId, characterId: character.id, userMessageId, assistantMessageId: `${id}-reply`, attempt: 1, characterContentVersionId: content.id, characterReleaseId: release.id, characterVisualProfileId: visual.id, characterVisualProfileVersion: visual.version, memoryEnabled: true, contextRevision: 0, userContent: "Stay beside the blue kitchen window.", recentTurns: [], sceneVersion: 0, scene: null } } });
  const sourceJob = await prisma.generationJob.create({ data: { id: `${id}-source-job`, userId, characterId: character.id, mode: "image", status: "completed", visualProfileId: visual.id, visualProfileVersion: visual.version, referenceSetRevisionId: referenceSet.id, controls: {}, presetIds: [], sourceType: "chat_image", sourceId: `${id}-attachment`, sourceMeta: { sessionId, exchangeId: turnId }, momentSpec: { rawInput: "Mira by the blue window holding a green cup." } } });
  const source = await createMedia({ id: `${id}-source-image`, ownerId: userId, sourceJobId: sourceJob.id });
  await prisma.chatTurnAttachment.create({ data: { id: `${id}-attachment`, turnId, kind: "generated_image", status: "completed", mediaAssetId: source.id, generationJobId: sourceJob.id, promptHint: "Earlier wording", metadata: { attempt: 1 } } });
  const sourceKey = `${id}-source.png`;
  sourceKeys.push(sourceKey);
  await providers.blob.putPrivate({ key: sourceKey, body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlZlE0AAAAASUVORK5CYII=", "base64"), contentType: "image/png" });
  await prisma.mediaAsset.update({ where: { id: source.id }, data: { storageKey: sourceKey, contentType: "image/png", characterId: character.id } });
  const query = { kind: "chat", sessionId, turnId, attempt: "1" };
  return { id, userId, characterId: character.id, userMessageId, turnId, sessionId, visual, referenceSet, release, source, query };
}

async function context(f: Awaited<ReturnType<typeof fixture>>, image = false) {
  const response = await api("GET", "generation/context", { userId: f.userId, ageGate: true, query: { ...f.query, ...(image ? { mediaAssetId: f.source.id } : {}) }, headers: { "x-idream-viewer-scope": `user:${f.userId}` } });
  expectOk(response);
  return parseGenerationContextResponse(response.json);
}

async function videoBody(f: Awaited<ReturnType<typeof fixture>>, image = true) {
  const source = await context(f, image);
  const body = { generationContextToken: source.token, prompt: "Turn slightly toward the window, preserving the green cup and original setting." };
  const response = await api("POST", `chat/${f.sessionId}/video/quote`, { userId: f.userId, ageGate: true, body });
  expectOk(response);
  expect(response.data.quote.video.durationSeconds).toBeGreaterThan(0);
  expect(response.data.quote.costs[0].costDreamcoins).toBeGreaterThan(0);
  return { ...body, quoteAuthority: quoteAuthorityFor(response.data.quote, 1)! };
}
function submit(f: Awaited<ReturnType<typeof fixture>>, body: unknown, key = `${f.id}-video`) {
  return api("POST", `chat/${f.sessionId}/video`, { userId: f.userId, ageGate: true, body, headers: { "Idempotency-Key": key, "x-idream-viewer-scope": `user:${f.userId}` } });
}

describe("explicit Chat video admission and delivery", () => {
  it("keeps the frozen source and original Turn, charges once on concurrent confirmation, and preserves playable history while disabled", async () => {
    const f = await fixture();
    const originalTurn = await prisma.chatTurn.findUniqueOrThrow({ where: { id: f.turnId } });
    const body = await videoBody(f);
    expect(await dreamcoinBalance(f.userId)).toBe(500);
    expect(await prisma.generationJob.count({ where: { userId: f.userId, sourceType: "chat_video" } })).toBe(0);
    await prisma.character.update({ where: { id: f.characterId }, data: { name: "Current changed character", imageAssetId: `${f.id}-anchor` } });
    const generated = vi.spyOn((await generationTestProviders()).video, "generate");
    const [created, replay] = await Promise.all([submit(f, body), submit(f, body)]);
    expectOk(created, 202); expectOk(replay, 202);
    expect(replay.data.job.id).toBe(created.data.job.id);
    const jobId = created.data.job.id as string;
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    // Origin identity pins belong to provenance; the I2V execution consumes only its source image.
    expect(job).toMatchObject({ sourceType: "chat_video", mode: "video", referenceSetRevisionId: null });
    expect(job.sourceMeta).toMatchObject({ visualProfileId: f.visual.id, visualProfileVersion: f.visual.version, referenceSetRevisionId: f.referenceSet.id });
    expect(job.controls).toMatchObject({ sourceImageAssetId: f.source.id });
    expect(job.sourceMeta).toMatchObject({ sessionId: f.sessionId, exchangeId: f.turnId, attempt: 1, sourceMediaId: f.source.id, characterReleaseId: f.release.id });
    expect(job.prompt).toContain("preserving the green cup");
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: f.turnId } })).toEqual(originalTurn);
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: f.turnId, kind: "generated_video" } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: jobId, reason: "generation_spend" } })).toBe(1);
    expect(await dreamcoinBalance(f.userId)).toBe(500 - body.quoteAuthority.costDreamcoins);
    const tooLate = await api("POST", `generation/jobs/${jobId}/cancel`, { userId: f.userId, ageGate: true });
    expectError(tooLate, 409);
    await runQueuedGenerationJobs(8, videoQueues);
    expect(generated).toHaveBeenCalledOnce();
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "completed", deliveredOutputCount: 1 });
    const attachment = await prisma.chatTurnAttachment.findFirstOrThrow({ where: { generationJobId: jobId } });
    expect(attachment).toMatchObject({ kind: "generated_video", status: "completed", mediaAssetId: expect.any(String) });
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: attachment.mediaAssetId! } })).toMatchObject({ type: "video", ownerId: f.userId, sourceJobId: jobId, storageKey: expect.any(String) });
    await prisma.featureFlag.update({ where: { key: "chat_video" }, data: { enabled: false } });
    const history = await getChatSession(f.userId, f.sessionId);
    expect(JSON.stringify(history)).toContain(attachment.mediaAssetId!);
    expect(JSON.stringify(history)).toContain('"mediaUrl":');
    const acceptedReplay = await submit(f, body); expectOk(acceptedReplay, 202);
    expect(acceptedReplay.data.job.id).toBe(jobId);
    expectError(await submit(f, body, `${f.id}-disabled`), 403);
    expect(await dreamcoinBalance(f.userId)).toBe(500 - body.quoteAuthority.costDreamcoins);
  }, 20_000);

  it("rejects missing source, missing quote, other accounts and edited source without spending", async () => {
    const f = await fixture();
    const withoutImage = await context(f);
    expectError(await api("POST", `chat/${f.sessionId}/video/quote`, { userId: f.userId, ageGate: true, body: { generationContextToken: withoutImage.token, prompt: "Wave." } }), 400);
    const body = await videoBody(f);
    const { quoteAuthority: _quote, ...unquoted } = body;
    expectError(await submit(f, unquoted), 409);
    const other = `${f.id}-other`; await createUser({ id: other });
    // Fully entitled, so the rejection below proves Session ownership, not access.
    await prisma.entitlement.createMany({ data: ["premium_controls", "video_generation"].map(key => ({ userId: other, key, value: true, source: "test" })) });
    expectError(await api("POST", `chat/${f.sessionId}/video/quote`, { userId: other, ageGate: true, body }), 403);
    await editChatTurn(f.userId, f.userMessageId, "Move to a different scene.");
    expectError(await submit(f, body, `${f.id}-changed`), 409);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(0);
  });

  it("reports the full admission entitlement set before a user writes motion to quote", async () => {
    const f = await fixture();
    const source = await context(f, true);
    // A lone video grant cannot quote user motion text, so capability must not offer it.
    await prisma.entitlement.deleteMany({ where: { userId: f.userId, key: "premium_controls" } });
    const capability = await api("GET", `chat/${f.sessionId}/video`, { userId: f.userId, ageGate: true, headers: { "x-idream-viewer-scope": `user:${f.userId}` } });
    expectOk(capability);
    expect(capability.data.capability).toMatchObject({ enabled: true, entitled: false });
    const quote = await api("POST", `chat/${f.sessionId}/video/quote`, { userId: f.userId, ageGate: true, body: { generationContextToken: source.token, prompt: "Turn toward the window." } });
    expectError(quote, 402);
    expect(quote.error?.message).toBe("Chat video requires Deluxe video access");
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(0);
  });

  it("removes private prompt text from the Turn's image and video attachments when the Turn is edited", async () => {
    const f = await fixture();
    // A delivered Chat video keeps the user's motion request on its attachment.
    const videoJob = await prisma.generationJob.create({ data: { id: `${f.id}-video-job`, userId: f.userId, characterId: f.characterId, mode: "video", status: "completed", controls: {}, presetIds: [], sourceType: "chat_video", sourceId: `${f.id}-video-attachment`, sourceMeta: { sessionId: f.sessionId, exchangeId: f.turnId }, momentSpec: { rawInput: "Turn slowly toward the blue window." } } });
    await prisma.chatTurnAttachment.create({ data: { id: `${f.id}-video-attachment`, turnId: f.turnId, kind: "generated_video", status: "completed", generationJobId: videoJob.id, promptHint: "Turn slowly toward the blue window.", metadata: { attempt: 1 } } });
    await editChatTurn(f.userId, f.userMessageId, "Move to a different scene.");
    expect(await prisma.chatTurnAttachment.findMany({ where: { turnId: f.turnId }, orderBy: { id: "asc" }, select: { kind: true, promptHint: true } })).toEqual([
      { kind: "generated_image", promptHint: null },
      { kind: "generated_video", promptHint: null },
    ]);
  });

  it("refunds a definitive failure and binds a single explicit retry to the same Chat attachment", async () => {
    const f = await fixture(); const body = await videoBody(f);
    const generate = vi.spyOn((await generationTestProviders()).video, "generate").mockResolvedValueOnce({ ok: false, error: { code: "backend_error", message: "Controlled pre-submit refusal", retryable: false, outcome: "definitive" } });
    const created = await submit(f, body); expectOk(created, 202);
    const jobId = created.data.job.id as string;
    await runQueuedGenerationJobs(8, videoQueues);
    const attachment = await prisma.chatTurnAttachment.findFirstOrThrow({ where: { generationJobId: jobId } });
    expect(attachment.status).toBe("failed");
    expect(await dreamcoinBalance(f.userId)).toBe(500);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: jobId, reason: "refund" } })).toBe(1);
    const quote = await api("POST", `generation/jobs/${jobId}/retry/quote`, { userId: f.userId, ageGate: true }); expectOk(quote);
    expect(await dreamcoinBalance(f.userId)).toBe(500);
    const retryBody = { quoteAuthority: quoteAuthorityFor(quote.data.quote, 1)! };
    const retryRequest = { userId: f.userId, ageGate: true, body: retryBody, headers: { "Idempotency-Key": `${f.id}-retry` } };
    const [retry, repeat] = await Promise.all([api("POST", `generation/jobs/${jobId}/retry`, retryRequest), api("POST", `generation/jobs/${jobId}/retry`, retryRequest)]);
    expectOk(retry, 202); expectOk(repeat, 202); expect(repeat.data.job.id).toBe(retry.data.job.id);
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachment.id } })).toMatchObject({ generationJobId: retry.data.job.id, status: "accepted", mediaAssetId: null });
    expectError(await api("POST", `generation/jobs/${jobId}/retry/quote`, { userId: f.userId, ageGate: true }), 409);
    await runQueuedGenerationJobs(8, videoQueues);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachment.id } })).toMatchObject({ generationJobId: retry.data.job.id, status: "completed", mediaAssetId: expect.any(String) });
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: retry.data.job.id } })).toMatchObject({ status: "completed", sourceType: "chat_video", derivedFromJobId: jobId });
    expect(await dreamcoinBalance(f.userId)).toBe(500 - retryBody.quoteAuthority.costDreamcoins);
  }, 20_000);

  it("atomically cancels only untouched dispatches and refunds once without later provider submission", async () => {
    const f = await fixture(); const body = await videoBody(f);
    const dispatch = attempts.dispatchGenerationAttemptOutbox;
    const held = vi.spyOn(attempts, "dispatchGenerationAttemptOutbox").mockImplementation((db) => dispatch(db, { outboxIds: [] }));
    const generate = vi.spyOn((await generationTestProviders()).video, "generate");
    const created = await submit(f, body); expectOk(created, 202);
    const jobId = created.data.job.id as string;
    expect(await prisma.mainOutboxEvent.findFirstOrThrow({ where: { aggregateId: jobId } })).toMatchObject({ status: "pending", attempts: 0 });
    const cancel = () => api("POST", `generation/jobs/${jobId}/cancel`, { userId: f.userId, ageGate: true });
    const first = await cancel(); expectOk(first); expect(first.data.refundAmount).toBe(body.quoteAuthority.costDreamcoins);
    const repeat = await cancel(); expectOk(repeat); expect(repeat.data.refundAmount).toBe(0);
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "cancelled" });
    expect(await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: jobId } })).toMatchObject({ status: "cancelled" });
    expect(await prisma.chatTurnAttachment.findFirstOrThrow({ where: { generationJobId: jobId } })).toMatchObject({ status: "cancelled" });
    expect(await dreamcoinBalance(f.userId)).toBe(500);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: jobId, reason: "refund" } })).toBe(1);
    held.mockRestore();
    await dispatch(prisma, { outboxIds: [`generation_initial_${jobId}`] });
    await runQueuedGenerationJobs(4, videoQueues);
    expect(generate).not.toHaveBeenCalled();
  });
});
