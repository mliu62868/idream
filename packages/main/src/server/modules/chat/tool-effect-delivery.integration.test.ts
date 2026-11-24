import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { compileCharacterSoul } from "@idream/shared";
import { CHAT_SEND_PROTOCOL_VERSION, MAIN_TO_CHAT_EVENTS, type ChatExecutionSnapshot } from "@idream/shared/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { api, createCharacter, createUser, dreamcoinBalance, expectOk, generationTestProviders, grantCoins, purgeTestData, runQueuedGenerationJobs } from "@/server/test/helpers";
import { parseGenerationRetryQuoteResponse } from "@/lib/public-api-contracts";
import * as generation from "../ourdream/service";
import { acceptGenerationJobForUser } from "../ourdream/generation-job-authority";
import { createReferenceSetRevision } from "../ourdream/generation-reference-set";
import { quoteAuthorityFor } from "../ourdream/generation-quote";
import { applyChatToolEffect } from "./tool-effect";
import { confirmChatMediaQuote } from "./media-fulfillment-router";
import { beginChatTurn, commitChatTerminal, createChatSession, executionSnapshot, getChatSession } from "./turn-ledger";

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
  it("rejects a four-output Chat reservation at the final debit authority", async () => {
    const userId = `${prefix}${randomUUID()}`;
    await createUser({ id: userId });
    await grantCoins(userId, 40);
    await expect(acceptGenerationJobForUser({ userId, identity: {}, prepare: async () => ({
      data: { mode: "image", prompt: "A seaside photo", presetIds: [], controls: {},
        sourceType: "chat_image", outputCount: 4, costDreamcoins: 20 },
      entitlements: {},
    }) })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("one photo") });
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(40);
  });

  it.each((["companion", "scene"] as const).flatMap(subject =>
    (["failed", "completed", "retry-completed"] as const).flatMap(scenario =>
      (subject === "scene" ? (["direct", "quote"] as const) : (["direct"] as const))
        .map(authorization => ({ subject, scenario, authorization }))
    )
  ))("preserves $subject $scenario image delivery and reservation identity with $authorization authorization", async ({ subject, scenario, authorization }) => {
    const outcome = scenario;
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
    await providers.blob.putPrivate({ key: sourceKey, body: await sharp({ create: { width: 1, height: 1, channels: 3, background: "#7296b0" } }).png().toBuffer(), contentType: "image/png" });
    const source = await prisma.mediaAsset.create({ data: { id: `${userId}-source`, ownerId: userId, characterId: character.id, type: "image", url: `/api/media/${userId}-source/content.png`, storageKey: sourceKey, contentType: "image/png", visibility: "private", safetyStatus: "passed", width: 1, height: 1, metadata: {} } });
    const visual = await prisma.characterVisualProfile.create({ data: { characterId: character.id, status: "active", identityPrompt: "Avery", faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [source.id], adapterRefs: {}, createdFrom: "test" } });
    await prisma.$transaction(tx => createReferenceSetRevision(tx, visual, "test", [{ mediaAssetId: source.id, position: 0, role: "primary_face", weight: 1, selectionReason: "primary_identity_anchor" }]));
    const session = await createChatSession(userId, { characterId: character.id });
    await prisma.recentChat.update({ where: { sessionId: session.id }, data: { memoryEnabled: false } });
    const direction = subject === "scene" ? "A basil plant in a terracotta pot on a sunny balcony. No people visible." : "Avery beside the rainy window.";
    const { snapshot } = await beginChatTurn({ sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION, userId, sessionId: session.id, content: subject === "scene" ? `Generate one picture of ${direction}` : "Send me a portrait beside the rainy window.", idempotencyKey: randomUUID(), allowPaidImage: authorization === "direct" });
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
        const receipt = await create(...args);
        const { job } = receipt;
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
        return receipt;
      } catch (error) {
        creationFailure = error;
        throw error;
      }
    });
    const effect = { version: 2 as const, turnId: snapshot.turnId, attempt: snapshot.attempt, callId: randomUUID(),
      name: "request_character_media" as const, effectScope: "turn_action" as const, intent: { requestedNudity: "unspecified" as const },
      arguments: { kind: "image", direction, subject, mode: "force_new", orientation: "portrait" } };
    if (subject === "scene" && scenario === "completed") {
      await expect(applyChatToolEffect({ ...effect, arguments: { ...effect.arguments, outputCount: 4 } }))
        .rejects.toMatchObject({ code: "bad_request" });
      expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(0);
      expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
      expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
      expect(await dreamcoinBalance(userId)).toBe(40);
    }
    const requested = await applyChatToolEffect(effect);
    if (authorization === "quote") expect(requested).toMatchObject({ status: "awaiting_confirmation", costDreamcoins: 5 });
    const accepted = authorization === "quote" ? await confirmChatMediaQuote(userId, requested.attachmentId!) : requested;
    if (creationFailure) throw creationFailure;
    if (authorization === "quote") {
      expect(accepted).toMatchObject({
        status: outcome === "failed" ? "failed" : "completed",
        duplicate: false,
        generationJobId: replacementJobId ?? originalJobId,
        costDreamcoins: 5,
      });
      await expect(confirmChatMediaQuote(userId, requested.attachmentId!)).resolves.toMatchObject({
        status: outcome === "failed" ? "failed" : "completed",
        duplicate: true,
        generationJobId: replacementJobId ?? originalJobId,
      });
    } else if (outcome === "failed") {
      // A first receipt reflects a terminal failure already committed by Main.
      expect(accepted).toMatchObject({ accepted: false, duplicate: false, error: { code: "backend_error", retryable: true } });
    } else {
      expect(accepted, JSON.stringify(accepted)).toMatchObject({ accepted: true, duplicate: false, status: "completed", generationJobId: replacementJobId ?? originalJobId });
    }
    const finalJobId = replacementJobId ?? originalJobId;
    const stored = await prisma.generationJob.findUniqueOrThrow({ where: { id: finalJobId } });
    expect(stored.outputCount).toBe(1);
    expect(stored.sourceMeta).toMatchObject({ chatCharacterId: character.id, imageSubject: subject, exchangeId: snapshot.turnId });
    if (subject === "scene") {
      expect(stored).toMatchObject({ characterId: null, visualProfileId: null, referenceSetRevisionId: null, referenceAssetIds: null });
      expect(stored.prompt).toContain(direction);
      expect(stored.prompt).not.toMatch(/portrait|Locked identity|same face|visible face|Avery/iu);
      expect(stored.controls).not.toHaveProperty("visualIdentity");
      for (const [request] of generate.mock.calls) expect(request.referenceImages ?? []).toHaveLength(0);
    } else {
      expect(stored).toMatchObject({ characterId: character.id, visualProfileId: visual.id, consistencyMode: "strict" });
    }
    const delivery = outcome === "failed"
      ? { generationJobId: finalJobId, status: "failed", errorCode: "backend_error", mediaAssetId: null }
      : { generationJobId: finalJobId, status: "completed", errorCode: null, mediaAssetId: expect.any(String) };
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: accepted.attachmentId } })).toMatchObject(delivery);
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: accepted.attachmentId } })).toMatchObject({ metadata: expect.objectContaining({ attempt: snapshot.attempt }) });
    await commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId, attempt: snapshot.attempt, status: "sent", content: "The image request failed.", model: "test", promptTokens: 1, completionTokens: 1,
      sceneVersion: snapshot.sceneVersion + 1,
      scene: { schemaVersion: 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [], ...snapshot.scene, version: snapshot.sceneVersion + 1 },
      terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
    expect((await getChatSession(userId, session.id)).messages.find(message => message.id === snapshot.assistantMessageId)?.attachments).toEqual([expect.objectContaining({ ...delivery, imageSubject: subject })]);
    await expect(applyChatToolEffect({ ...effect, arguments: { ...effect.arguments, subject: subject === "scene" ? "companion" : "scene" } })).rejects.toMatchObject({ code: "conflict" });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(outcome === "retry-completed" ? 2 : 1);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(outcome === "retry-completed" ? 2 : 1);
    expect(await dreamcoinBalance(userId)).toBe(outcome === "failed" ? 40 : 40 - finalCost);
  });

  it("replays a recorded legacy edit without permitting versionless writes or another debit", async () => {
    const userId = `${prefix}${randomUUID()}`;
    await createUser({ id: userId });
    await grantCoins(userId, 40);
    const character = await createCharacter({ id: `${userId}-character`, creatorId: userId, source: "user", visibility: "private", advancedDetails: { imageToolEnabled: true } });
    const soul = compileCharacterSoul({ name: "Avery", age: 28, gender: "female", characterPromise: "A warm photographer", detailsMarkdown: "Warm and curious." });
    if (!soul.ok) throw new Error("Invalid fixture Soul");
    const content = await prisma.characterContentVersion.create({ data: {
      characterId: character.id, version: 1, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint,
      personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {},
    } });
    await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
    const session = await createChatSession(userId, { characterId: character.id });
    const { snapshot } = await beginChatTurn({ sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION, userId, sessionId: session.id, content: "Say ready.", idempotencyKey: randomUUID() });
    if (!snapshot) throw new Error("Missing accepted Turn");

    const admit = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/internal/agent-runs");
      const { turnId, attempt } = JSON.parse(String(init?.body)) as { turnId: string; attempt: number };
      return Response.json({ ok: true, turnId, attempt, duplicate: false, terminal: false, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    });
    const complete = async (turn: ChatExecutionSnapshot) => {
      const sceneVersion = turn.sceneVersion + 1;
      await commitChatTerminal({
        version: 1, turnId: turn.turnId, sessionId: turn.sessionId, assistantMessageId: turn.assistantMessageId,
        attempt: turn.attempt, status: "sent", content: "Done.", model: "test", promptTokens: 1, completionTokens: 1,
        sceneVersion, scene: { schemaVersion: 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [], ...turn.scene, version: sceneVersion },
        terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 5, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } },
      });
      // This test controls Chat admission, so ACK the independent rebuild worker.
      await prisma.mainOutboxEvent.updateMany({
        where: { eventType: MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1, aggregateId: `${userId}:${character.id}`, status: "pending" },
        data: { status: "delivered", deliveredAt: new Date() },
      });
    };
    const patch = (body: object, key?: string) => api("PATCH", `messages/${snapshot.userMessageId}`, {
      userId, ageGate: true, ...(key ? { headers: { "idempotency-key": key } } : {}), body,
    });
    const load = () => executionSnapshot(snapshot.turnId);
    const wallet = async () => ({
      balance: await dreamcoinBalance(userId),
      jobs: await prisma.generationJob.count({ where: { userId } }),
      spends: await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } }),
    });

    await complete(snapshot);
    const paid = { content: "Generate a new seaside landscape without people.", allowPaidImage: true };
    const paidKey = randomUUID();
    expect((await patch({ ...paid, attempt: snapshot.attempt }, paidKey)).status).toBe(202);
    const revised = await load();
    const generated = await applyChatToolEffect({
      version: 2, turnId: revised.turnId, attempt: revised.attempt, callId: randomUUID(), name: "request_character_media",
      effectScope: "turn_action", intent: { requestedNudity: "unspecified" },
      arguments: { subject: "scene", kind: "image", direction: "An empty shore beneath a blue sky.", orientation: "portrait" },
    });
    if (!generated.accepted || !generated.generationJobId) throw new Error(`No paid generation: ${JSON.stringify(generated)}`);
    await runQueuedGenerationJobs();
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: generated.generationJobId } });
    expect(job).toMatchObject({ status: "completed", costDreamcoins: expect.any(Number) });
    expect(job.costDreamcoins).toBeGreaterThan(0);
    await complete(revised);

    // The previous API could accept an edit without an observed attempt and
    // persisted this exact fingerprint for its idempotency key.
    await prisma.chatTurnEditReceipt.update({
      where: { turnId_idempotencyKey: { turnId: snapshot.turnId, idempotencyKey: paidKey } },
      data: { requestHash: createHash("sha256").update(JSON.stringify({ content: paid.content, expectedAttempt: null, allowPaidImage: true })).digest("hex") },
    });
    admit.mockClear();
    const legacyReplay = await patch(paid, paidKey);
    expect(legacyReplay.status).toBe(202);
    expect(legacyReplay.json).toMatchObject({ attempt: revised.attempt, status: "sent", streamUrl: null });
    expect(admit).not.toHaveBeenCalled();

    const replacement = { content: "Only say hello.", attempt: revised.attempt };
    expect((await patch(replacement)).status).toBe(202);
    const newer = await load();
    expect(newer).toMatchObject({ attempt: 3, userContent: replacement.content, imageActionMode: "chat" });
    await complete(newer);
    const expectedWallet = { balance: 40 - job.costDreamcoins, jobs: 1, spends: 1 };
    expect(await wallet()).toEqual(expectedWallet);
    admit.mockClear();
    const late = await patch(paid, paidKey);
    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({ details: { reason: "edit_attempt_changed", attempt: newer.attempt } });
    for (const [body, key] of [
      [paid, undefined],
      [paid, randomUUID()],
      [{ content: paid.content }, undefined],
      [{ content: replacement.content }, undefined],
    ] as const) {
      const refused = await patch(body, key);
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({ details: { reason: "edit_attempt_required", attempt: newer.attempt } });
    }
    expect(admit).not.toHaveBeenCalled();
    expect(await load()).toEqual(newer);
    expect(await wallet()).toEqual(expectedWallet);

    expect((await patch({ ...replacement, attempt: newer.attempt, allowPaidImage: true }, randomUUID())).status).toBe(202);
    const retried = await load();
    expect(retried).toMatchObject({ attempt: 4, imageActionMode: "chat", userMessageRevision: newer.userMessageRevision });
    await complete(retried);
    expect((await patch({ ...paid, attempt: retried.attempt }, randomUUID())).status).toBe(202);
    const restored = await load();
    expect(restored).toMatchObject({ attempt: 5, imageActionMode: "paid", userMessageRevision: 5, userContent: paid.content });
    expect(restored.recoveredMediaAction).toBeUndefined();
    expect(await wallet()).toEqual(expectedWallet);
  });
});
