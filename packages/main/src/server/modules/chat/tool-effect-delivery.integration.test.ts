import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { api, createCharacter, createUser, dreamcoinBalance, expectOk, generationTestProviders, grantCoins, purgeTestData, runQueuedGenerationJobs } from "@/server/test/helpers";
import { parseGenerationRetryQuoteResponse } from "@/lib/public-api-contracts";
import * as generation from "../ourdream/service";
import { createReferenceSetRevision } from "../ourdream/generation-reference-set";
import { quoteAuthorityFor } from "../ourdream/generation-quote";
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
  it.each(["failed", "completed", "retry-completed"] as const)("keeps %s delivery visible when Gen finishes before the first ToolEffect ACK", async outcome => {
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
    const visual = await prisma.characterVisualProfile.create({ data: { characterId: character.id, status: "active", identityPrompt: "Avery", faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [source.id], adapterRefs: {}, createdFrom: "test" } });
    await prisma.$transaction(tx => createReferenceSetRevision(tx, visual, "test", [{ mediaAssetId: source.id, position: 0, role: "primary_face", weight: 1, selectionReason: "primary_identity_anchor" }]));
    const session = await createChatSession(userId, { characterId: character.id });
    await prisma.recentChat.update({ where: { sessionId: session.id }, data: { memoryEnabled: false } });
    const { snapshot } = await beginChatTurn({ userId, sessionId: session.id, content: "Send me a portrait beside the rainy window.", idempotencyKey: randomUUID() });
    if (!snapshot) throw new Error("Missing accepted Turn");
    const gen = await generationTestProviders();
    const generate = vi.spyOn(gen.image, "generate");
    if (outcome !== "completed") generate.mockResolvedValueOnce({ ok: false, error: { code: "backend_error", message: "Controlled pre-submit connection refusal", retryable: false, outcome: "definitive" } });
    const create = generation.createChatImageGenerationJob;
    let creationFailure: unknown;
    let originalJobId = "";
    let replacementJobId: string | null = null;
    let finalCost = 0;
    const createSpy = vi.spyOn(generation, "createChatImageGenerationJob").mockImplementationOnce(async (...args) => {
      try {
        const job = await create(...args);
        originalJobId = job.id;
        finalCost = job.costDreamcoins;
        // Force the real Gen terminal + Main refund to commit before the caller
        // receives its reservation ACK. No timing delay or fake Job status.
        await runQueuedGenerationJobs();
        expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject(outcome === "completed" ? { status: "completed" } : { status: "failed", errorCode: "backend_error" });
        expect(await prisma.dreamcoinLedger.count({ where: { sourceId: job.id, reason: "refund" } })).toBe(outcome === "completed" ? 0 : 1);
        if (outcome === "retry-completed") {
          // A faster second browser can observe the failure and retry while
          // the first invocation's ACK is still in flight. Only this new Job
          // may own the attachment when the original invocation returns.
          const quoteResponse = await api("POST", `generation/jobs/${job.id}/retry/quote`, { userId, ageGate: true });
          expectOk(quoteResponse);
          const { quote } = parseGenerationRetryQuoteResponse(quoteResponse.json);
          const retryOptions = { userId, ageGate: true, headers: { "Idempotency-Key": `${userId}:retry` }, body: { quoteAuthority: quoteAuthorityFor(quote, 1) } };
          const retried = await api("POST", `generation/jobs/${job.id}/retry`, retryOptions);
          expectOk(retried, 202);
          replacementJobId = retried.data.job.id;
          finalCost = retried.data.job.costDreamcoins;
          const repeated = await api("POST", `generation/jobs/${job.id}/retry`, retryOptions);
          expectOk(repeated, 202);
          expect(repeated.data.job.id).toBe(replacementJobId);
          await runQueuedGenerationJobs();
        }
        return job;
      } catch (error) {
        creationFailure = error;
        throw error;
      }
    });
    const effect = { version: 2 as const, turnId: snapshot.turnId, attempt: 1, callId: randomUUID(), name: "generate_image_async" as const, effectScope: "turn_action" as const, intent: { requestedNudity: "unspecified" as const }, arguments: { prompt: "Avery beside the rainy window.", orientation: "4:5", outputCount: 1 } };
    const accepted = await applyChatToolEffect(effect);
    if (creationFailure) throw creationFailure;
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ accepted: true, duplicate: false, generationJobId: expect.any(String) });
    if (!accepted.accepted || !accepted.generationJobId) throw new Error("Missing original image action");
    const finalJobId = replacementJobId ?? originalJobId;
    expect(accepted.generationJobId).toBe(finalJobId);
    const delivery = outcome === "failed"
      ? { generationJobId: finalJobId, status: "failed", errorCode: "backend_error", mediaAssetId: null }
      : { generationJobId: finalJobId, status: "completed", errorCode: null, mediaAssetId: expect.any(String) };
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: accepted.attachmentId } })).toMatchObject(delivery);
    await commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId, attempt: 1, status: "sent", content: "The image request failed.", model: "test", promptTokens: 1, completionTokens: 1,
      sceneVersion: snapshot.sceneVersion + 1,
      scene: { schemaVersion: 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [], ...snapshot.scene, version: snapshot.sceneVersion + 1 },
      terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
    expect((await getChatSession(userId, session.id)).messages.find(message => message.id === snapshot.assistantMessageId)?.attachments).toEqual([expect.objectContaining(delivery)]);
    await applyChatToolEffect(effect);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(outcome === "retry-completed" ? 2 : 1);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(outcome === "retry-completed" ? 2 : 1);
    expect(await dreamcoinBalance(userId)).toBe(outcome === "failed" ? 40 : 40 - finalCost);
  });
});
