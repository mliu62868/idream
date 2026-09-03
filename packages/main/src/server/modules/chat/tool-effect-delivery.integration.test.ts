import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { createCharacter, createUser, dreamcoinBalance, generationTestProviders, grantCoins, purgeTestData, runQueuedGenerationJobs } from "@/server/test/helpers";
import * as generation from "../ourdream/service";
import { createReferenceSetRevision } from "../ourdream/generation-reference-set";
import { applyChatToolEffect } from "./tool-effect";
import { beginChatTurn, commitChatTerminal, createChatSession, getChatSession } from "./turn-ledger";

const prefix = `zt-chat-effect-delivery-${randomUUID()}-`;
const sourceKeys: string[] = [];
beforeAll(async () => {
  await prisma.generationModelProfile.create({ data: {
    id: `${prefix}profile`, profileKey: `${prefix}profile`, label: "Chat delivery fixture",
    mode: "image", runner: "comfyui", pipelineModel: "qwen-image-edit", workflowKey: "qwen-image-edit-img2img", version: 10000,
    runnerConfig: { capabilities: { textToImage: true, stableSeed: true, referenceImages: true, initImage: true, lora: false } },
    allowedOrientations: ["4:5"], maxCount: 1, enabled: true, status: "active", rolloutPercent: 100,
  } });
  if (!await prisma.pricingRule.findFirst({ where: { mode: "image", status: "active" } })) {
    await prisma.pricingRule.create({ data: { id: `${prefix}price`, ruleKey: `${prefix}price`, label: "Chat image price", mode: "image", baseCost: 5, status: "active" } });
  }
  if (!await prisma.generationRecipe.findFirst({ where: { mode: "image", useCase: "character", status: "active" } })) {
    await prisma.generationRecipe.create({ data: { id: `${prefix}recipe`, recipeKey: `${prefix}recipe`, label: "Chat image recipe", mode: "image", useCase: "character", body: "A portrait of the character.", presetOrder: [], safetyHints: {}, sampleMatrix: {}, status: "active" } });
  }
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await purgeTestData(prefix);
  await prisma.pricingRule.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.generationRecipe.deleteMany({ where: { id: { startsWith: prefix } } });
  for (const key of sourceKeys) await providers.blob.delete({ key });
});

describe("initial Chat image delivery", () => {
  it("keeps a definitive failure and refund visible when Gen finishes before the first ToolEffect ACK", async () => {
    const userId = `${prefix}${randomUUID()}`;
    await createUser({ id: userId });
    await grantCoins(userId, 40);
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
    await prisma.$transaction(tx => createReferenceSetRevision(tx, visual, "test", [{ mediaAssetId: source.id, position: 0, role: "primary_face", weight: 1, selectionReason: "primary_identity_anchor" }]));
    const session = await createChatSession(userId, { characterId: character.id });
    await prisma.recentChat.update({ where: { sessionId: session.id }, data: { memoryEnabled: false } });
    const { snapshot } = await beginChatTurn({ userId, sessionId: session.id, content: "Send me a portrait beside the rainy window.", idempotencyKey: randomUUID() });
    if (!snapshot) throw new Error("Missing accepted Turn");
    const gen = await generationTestProviders();
    vi.spyOn(gen.image, "generate").mockResolvedValue({ ok: false, error: { code: "backend_error", message: "Controlled pre-submit connection refusal", retryable: false, outcome: "definitive" } });
    const create = generation.createChatImageGenerationJob;
    const createSpy = vi.spyOn(generation, "createChatImageGenerationJob").mockImplementationOnce(async payload => {
      const job = await create(payload);
      // Force the real Gen terminal + Main refund to commit before the caller
      // receives its reservation ACK. No timing delay or fake Job status.
      await runQueuedGenerationJobs();
      expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "failed", errorCode: "backend_error" });
      expect(await prisma.dreamcoinLedger.count({ where: { sourceId: job.id, reason: "refund" } })).toBe(1);
      return job;
    });
    const effect = { version: 2 as const, turnId: snapshot.turnId, attempt: 1, callId: randomUUID(), name: "generate_image_async" as const, effectScope: "turn_action" as const, intent: { requestedNudity: "unspecified" as const }, arguments: { prompt: "Avery beside the rainy window.", orientation: "4:5", outputCount: 1 } };
    const accepted = await applyChatToolEffect(effect);
    expect(accepted).toMatchObject({ accepted: true, duplicate: false, generationJobId: expect.any(String) });
    if (!accepted.accepted || !accepted.generationJobId) throw new Error("Missing original image action");
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: accepted.attachmentId } })).toMatchObject({ generationJobId: accepted.generationJobId, status: "failed", errorCode: "backend_error", mediaAssetId: null });
    await commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId, attempt: 1, status: "sent", content: "The image request failed.", model: "test", promptTokens: 1, completionTokens: 1, sceneVersion: 0, scene: null, terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
    expect((await getChatSession(userId, session.id)).messages.find(message => message.id === snapshot.assistantMessageId)?.attachments).toEqual([expect.objectContaining({ generationJobId: accepted.generationJobId, status: "failed", errorCode: "backend_error" })]);
    await applyChatToolEffect(effect);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(1);
    expect(await dreamcoinBalance(userId)).toBe(40);
  });
});
