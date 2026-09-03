import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { MAIN_QUEUES } from "@idream/shared/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { jobQueue } from "@/server/jobs/queue";
import { drainLocalAiPipeline } from "@/server/ai/local-pipeline";
import { api, createCharacter, createUser, dreamcoinBalance, expectError, expectOk, generationTestProviders, grantCoins, purgeTestData, runQueuedGenerationJobs } from "@/server/test/helpers";
import * as generation from "../ourdream/service";
import { quoteAuthorityFor } from "../ourdream/generation-quote";
import { parseGenerationRetryQuoteResponse } from "@/lib/public-api-contracts";
import { applyChatToolEffect } from "./tool-effect";
import { beginChatTurn, commitChatTerminal, createChatSession, getChatSession, regenerateChatTurn } from "./turn-ledger";

const P = `zt-chat-image-retry-${randomUUID()}-`;
const profileKey = `${P}profile`;
const sourceKeys: string[] = [];
beforeAll(async () => {
  await prisma.generationModelProfile.create({ data: {
    id: profileKey, profileKey, label: "Pinned Chat retry fixture", mode: "image", runner: "comfyui", pipelineModel: "qwen-image-edit", workflowKey: "qwen-image-edit-img2img", version: 1,
    runnerConfig: { capabilities: { textToImage: true, stableSeed: true, referenceImages: true, initImage: true, lora: false } }, allowedOrientations: ["4:5"], maxCount: 1, enabled: true, status: "active", rolloutPercent: 100,
  } });
  if (!await prisma.pricingRule.findFirst({ where: { mode: "image", status: "active" } })) await prisma.pricingRule.create({ data: { id: `${P}price`, ruleKey: `${P}price`, label: "Retry price", mode: "image", baseCost: 5, status: "active" } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await purgeTestData(P); await prisma.pricingRule.deleteMany({ where: { id: { startsWith: P } } }); for (const key of sourceKeys) await providers.blob.delete({ key }); });

async function fixture() {
  const userId = `${P}${randomUUID()}`;
  await createUser({ id: userId }); await grantCoins(userId, 30);
  const character = await createCharacter({ id: `${userId}-character`, creatorId: userId, source: "user", visibility: "private", advancedDetails: { imageToolEnabled: true } });
  const soul = compileCharacterSoul({ name: "Avery", age: 28, gender: "female", characterPromise: "A warm photographer", detailsMarkdown: "Warm and curious." });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const content = await prisma.characterContentVersion.create({ data: { characterId: character.id, version: 1, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint, personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {} } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  const sourceKey = `${userId}-source.png`;
  sourceKeys.push(sourceKey);
  await providers.blob.putPrivate({ key: sourceKey, body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlZlE0AAAAASUVORK5CYII=", "base64"), contentType: "image/png" });
  const source = await prisma.mediaAsset.create({ data: { id: `${userId}-source`, ownerId: userId, characterId: character.id, type: "image", url: `/api/media/${userId}-source/content.png`, storageKey: sourceKey, contentType: "image/png", visibility: "private", safetyStatus: "passed", width: 1, height: 1, metadata: {} } });
  const visual = await prisma.characterVisualProfile.create({ data: { characterId: character.id, identityPrompt: "Avery", faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [source.id], adapterRefs: {}, createdFrom: "test" } });
  const session = await createChatSession(userId, { characterId: character.id });
  await prisma.recentChat.update({ where: { sessionId: session.id }, data: { memoryEnabled: false } });
  const { snapshot } = await beginChatTurn({ userId, sessionId: session.id, content: "Send me a portrait beside the rainy window.", idempotencyKey: randomUUID() });
  if (!snapshot) throw new Error("Missing accepted Turn");
  // Start at an already failed provider request. Retry itself uses the real
  // quote, reservation, queue, Gen test adapter and Main delivery transaction.
  vi.spyOn(generation, "createChatImageGenerationJob").mockImplementationOnce(async payload => {
    const job = await prisma.generationJob.create({ data: {
    id: `${userId}-failed`, userId, characterId: character.id, mode: "image", prompt: payload.promptHint, status: "failed", errorCode: "provider_error", controls: { width: 512, height: 640, workflowKey: "qwen-image-edit-img2img", workflowVersion: 2 }, presetIds: [],
    sourceType: "chat_image", sourceId: payload.attachmentId, sourceMeta: { sessionId: session.id, exchangeId: snapshot.turnId, messageId: snapshot.assistantMessageId, promptHint: payload.promptHint },
    visualProfileId: visual.id, visualProfileVersion: visual.version, referenceAssetIds: [source.id], referenceManifest: [{ mediaAssetId: source.id, role: "identity_anchor" }], model: "qwen-image-edit-img2img", profileId: profileKey, profileVersion: 1, provider: "comfyui", orientation: "4:5", outputCount: 1, costDreamcoins: 5,
    } });
    const attachment = await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: payload.attachmentId } });
    await prisma.chatTurnAttachment.update({ where: { id: attachment.id }, data: {
      status: "accepted", generationJobId: job.id,
      metadata: { ...JSON.parse(JSON.stringify(attachment.metadata)), costDreamcoins: job.costDreamcoins },
    } });
    return job;
  });
  const effect = { version: 2 as const, turnId: snapshot.turnId, attempt: 1, callId: randomUUID(), name: "generate_image_async" as const, effectScope: "turn_action" as const, intent: { requestedNudity: "unspecified" as const }, arguments: { prompt: "Avery beside the rainy window.", orientation: "4:5", outputCount: 1 } };
  const accepted = await applyChatToolEffect(effect);
  if (!accepted.accepted || !accepted.generationJobId) throw new Error("Missing original image action");
  await prisma.chatTurnAttachment.update({ where: { id: accepted.attachmentId }, data: { status: "failed", errorCode: "provider_error" } });
  await commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId, attempt: 1, status: "sent", content: "The image request failed.", model: "test", promptTokens: 1, completionTokens: 1, sceneVersion: 0, scene: null, terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
  const quoteResponse = await api("POST", `generation/jobs/${accepted.generationJobId}/retry/quote`, { userId, ageGate: true });
  expectOk(quoteResponse);
  const { quote } = parseGenerationRetryQuoteResponse(quoteResponse.json);
  const quoteAuthority = quoteAuthorityFor(quote, 1)!;
  const retry = (key: string, actorId = userId) => api("POST", `generation/jobs/${accepted.generationJobId}/retry`, { userId: actorId, ageGate: true, headers: { "Idempotency-Key": key }, body: { quoteAuthority } });
  return { userId, session, snapshot, effect, accepted, quoteAuthority, retry };
}

describe("Chat image retry delivery authority", () => {
  it("rebinds once before dispatch, delivers in the same Chat, and reuses that delivery on regenerate", async () => {
    const f = await fixture();
    await grantCoins(f.userId, f.quoteAuthority.costDreamcoins - await dreamcoinBalance(f.userId), "exact_retry_balance");
    const before = await dreamcoinBalance(f.userId);
    const [first, repeated] = await Promise.all([f.retry(`${f.userId}:retry`), f.retry(`${f.userId}:retry`)]);
    expectOk(first, 202); expectOk(repeated, 202);
    expect(repeated.data.job.id).toBe(first.data.job.id);
    const jobId = first.data.job.id;
    const original = await prisma.generationJob.findUniqueOrThrow({ where: { id: f.accepted.generationJobId! } });
    const retry = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(retry).toMatchObject({ sourceType: "chat_image", sourceId: null, sourceMeta: original.sourceMeta, derivedFromJobId: original.id, visualProfileId: original.visualProfileId, visualProfileVersion: original.visualProfileVersion, referenceManifest: original.referenceManifest });
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: f.accepted.attachmentId } })).toMatchObject({ generationJobId: jobId, status: "accepted", errorCode: null, metadata: { attempt: 1, effect: { turnId: f.snapshot.turnId, callId: f.effect.callId } } });
    expect(await dreamcoinBalance(f.userId)).toBe(before - f.quoteAuthority.costDreamcoins);
    expectError(await f.retry(`${f.userId}:second-intent`), 409);
    await runQueuedGenerationJobs();
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "completed" });
    const attachment = await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: f.accepted.attachmentId } });
    expect(attachment).toMatchObject({ status: "completed", generationJobId: jobId, mediaAssetId: expect.any(String) });
    expect((await getChatSession(f.userId, f.session.id)).messages.find(message => message.id === f.snapshot.assistantMessageId)?.attachments).toEqual([expect.objectContaining({ generationJobId: jobId, mediaAssetId: attachment.mediaAssetId, status: "completed" })]);
    const regenerated = await regenerateChatTurn(f.userId, f.snapshot.assistantMessageId);
    expect(regenerated.snapshot?.attempt).toBe(2);
    expect(await applyChatToolEffect({ ...f.effect, attempt: 2, callId: randomUUID() })).toMatchObject({ accepted: true, duplicate: true, generationJobId: jobId, mediaAssetId: attachment.mediaAssetId });
    expectOk(await f.retry(`${f.userId}:retry`), 202);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(1);
    expect(await prisma.generationJob.count({ where: { derivedFromJobId: original.id } })).toBe(1);
  });

  it("rejects a stranger, a stale Turn attempt and a deleted attachment before any retry charge", async () => {
    const f = await fixture();
    const other = `${P}other-${randomUUID()}`; await createUser({ id: other });
    expectError(await f.retry(`${f.userId}:foreign`, other), 404);
    await prisma.chatTurn.update({ where: { id: f.snapshot.turnId }, data: { attempt: 2 } });
    expectError(await f.retry(`${f.userId}:stale`), 409);
    await prisma.chatTurnAttachment.delete({ where: { id: f.accepted.attachmentId } });
    expectError(await f.retry(`${f.userId}:deleted`), 409);
    await prisma.chatTurn.delete({ where: { id: f.snapshot.turnId } });
    expectError(await f.retry(`${f.userId}:deleted-turn`), 409);
    expect(await prisma.generationJob.count({ where: { derivedFromJobId: f.accepted.generationJobId! } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(0);
  });

  it("projects a replacement's failure and refund, then permits retrying that exact replacement", async () => {
    const f = await fixture();
    const before = await dreamcoinBalance(f.userId);
    const first = await f.retry(`${f.userId}:first`); expectOk(first, 202);
    const jobId = first.data.job.id;
    const gen = await generationTestProviders();
    const failure = vi.spyOn(gen.image, "generate").mockResolvedValue({ ok: false, error: { code: "provider_error", message: "The provider returned a definite failure", retryable: false } });
    try { await runQueuedGenerationJobs(); } finally { failure.mockRestore(); }
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: f.accepted.attachmentId } })).toMatchObject({ generationJobId: jobId, status: "failed", errorCode: "provider_error" });
    expect(await dreamcoinBalance(f.userId)).toBe(before);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: jobId, reason: "refund" } })).toBe(1);
    const oldAttempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: jobId } });
    const oldTerminal = await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: `generation_terminal_record_${oldAttempt.id}` } });
    const quote = await api("POST", `generation/jobs/${jobId}/retry/quote`, { userId: f.userId, ageGate: true }); expectOk(quote);
    const next = await api("POST", `generation/jobs/${jobId}/retry`, { userId: f.userId, ageGate: true, headers: { "Idempotency-Key": `${f.userId}:replacement` }, body: { quoteAuthority: quoteAuthorityFor(parseGenerationRetryQuoteResponse(quote.json).quote, 1) } }); expectOk(next, 202);
    await runQueuedGenerationJobs();
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: f.accepted.attachmentId } })).toMatchObject({ generationJobId: next.data.job.id, status: "completed", mediaAssetId: expect.any(String) });
    // Re-deliver the old durable failure after the new image is visible. Its
    // ACK must neither replace the attachment nor refund the retry's charge.
    if (oldTerminal.payload === null) throw new Error("Missing durable terminal payload");
    await jobQueue.enqueue({ queue: MAIN_QUEUES.aiFinalize, dedupeKey: `${f.userId}:late-old-terminal`, payload: oldTerminal.payload });
    try { await drainLocalAiPipeline(); }
    finally { await jobQueue.removeByDedupeKey(MAIN_QUEUES.aiFinalize, `${f.userId}:late-old-terminal`); }
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: f.accepted.attachmentId } })).toMatchObject({ generationJobId: next.data.job.id, status: "completed", mediaAssetId: expect.any(String), errorCode: null });
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: jobId, reason: "refund" } })).toBe(1);
    expect(await dreamcoinBalance(f.userId)).toBe(before - f.quoteAuthority.costDreamcoins);
  });
});
