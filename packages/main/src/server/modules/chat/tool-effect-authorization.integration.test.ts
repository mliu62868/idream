import { createHash, randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import type { ChatToolEffect } from "@idream/shared/contracts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import { transitionGenerationRequest } from "@/server/ai/generation-request-transition";
import { reserveInitialGenerationAttempt, reserveRetryGenerationAttempt } from "@/server/modules/generation/generation-attempt-authority";
import { createUser, createCharacter, dreamcoinBalance, purgeTestData } from "@/server/test/helpers";
import * as generation from "../ourdream/service";
import { applyChatToolEffect } from "./tool-effect";
import { beginChatTurn, commitChatTerminal, createChatSession, editChatTurn, getChatSession, regenerateChatTurn } from "./turn-ledger";

const prefix = `zt-image-consent-${randomUUID()}-`;
const evidence = { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } };
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

async function fixture() {
  const userId = `${prefix}${randomUUID()}`;
  await createUser({ id: userId });
  const character = await createCharacter({ id: `${userId}-character`, creatorId: userId, source: "user", visibility: "private", advancedDetails: { imageToolEnabled: true } });
  const soul = compileCharacterSoul({ name: "Mira", age: 28, gender: "female", characterPromise: "A warm photographer", detailsMarkdown: "Warm and curious." });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const content = await prisma.characterContentVersion.create({ data: {
    characterId: character.id, version: 1, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint,
    personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {},
  } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  await prisma.dreamcoinLedger.create({ data: { userId, delta: 40, balanceAfter: 40, reason: "test" } });
  const session = await createChatSession(userId, { characterId: character.id });
  const begin = (text: string) => beginChatTurn({ userId, sessionId: session.id, content: text, idempotencyKey: randomUUID() });
  const generated = vi.spyOn(generation, "createChatImageGenerationJob").mockImplementation(async payload =>
    bindFixtureJob(payload.attachmentId, await prisma.generationJob.create({ data: {
      userId, characterId: character.id, mode: "image", prompt: payload.promptHint, controls: {}, presetIds: [],
      sourceType: "chat_image", sourceId: payload.attachmentId, costDreamcoins: 8,
    } })));
  return { userId, characterId: character.id, contentVersionId: content.id, begin, generated };
}

// This authorization fixture replaces Generation's reservation, including its
// atomic delivery binding. The separate delivery suite runs the real owner.
async function bindFixtureJob(attachmentId: string, job: Awaited<ReturnType<typeof prisma.generationJob.create>>) {
  const attachment = await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
  await prisma.chatTurnAttachment.update({ where: { id: attachmentId }, data: {
    status: "accepted", generationJobId: job.id,
    metadata: { ...JSON.parse(JSON.stringify(attachment.metadata)), costDreamcoins: job.costDreamcoins },
  } });
  return job;
}

function effect(snapshot: NonNullable<Awaited<ReturnType<typeof beginChatTurn>>["snapshot"]>): ChatToolEffect {
  return { version: 2, turnId: snapshot.turnId, attempt: snapshot.attempt, callId: randomUUID(), name: "generate_image_async", effectScope: "turn_action", intent: { requestedNudity: "unspecified" }, arguments: { prompt: "One person seated by a rain-streaked cafe window.", outputCount: 1, orientation: "4:5" } };
}

async function complete(snapshot: NonNullable<Awaited<ReturnType<typeof beginChatTurn>>["snapshot"]>, content = "Here you go.") {
  return commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId, attempt: snapshot.attempt, status: "sent", content, model: "test", promptTokens: 1, completionTokens: 1, sceneVersion: 0, scene: null, terminalEvidence: evidence });
}

describe("Main image action authorization", () => {
  it("projects an unknown image result in the real session without retaining it after operator settlement or retry", async () => {
    const { userId, characterId, begin, generated } = await fixture();
    const visualProfile = await prisma.characterVisualProfile.create({ data: {
      characterId, identityPrompt: "Mira, the cafe photographer", faceTraits: {}, hairTraits: {}, bodyTraits: {},
      signatureTraits: {}, styleTraits: {}, anchorAssetIds: [], adapterRefs: {}, createdFrom: "test",
    } });
    generated.mockImplementationOnce(async payload => bindFixtureJob(payload.attachmentId, await prisma.generationJob.create({ data: {
      userId, characterId, mode: "image", prompt: payload.promptHint, controls: {}, presetIds: [],
      sourceType: "chat_image", sourceId: payload.attachmentId, costDreamcoins: 8,
      provider: "mock", model: "mock-image",
      visualProfileId: visualProfile.id, visualProfileVersion: visualProfile.version,
    } })));
    const { snapshot } = await begin("Send me a portrait by the rainy cafe window.");
    if (!snapshot) throw new Error("Missing snapshot");
    const accepted = await applyChatToolEffect(effect(snapshot));
    if (!accepted.accepted || !accepted.generationJobId) throw new Error("Missing accepted image request");
    await complete(snapshot);
    const requestId = accepted.generationJobId;
    const { attempt } = await prisma.$transaction(tx => reserveInitialGenerationAttempt(tx, {
      requestId, dispatch: { eventType: "generation.retry.dispatch.v2" },
    }));
    await prisma.$transaction(tx => recordGenerationAttemptEvent(tx, {
      eventId: `${attempt.id}:unknown`, attemptId: attempt.id,
      eventType: "generation.attempt.unknown.v1", outcome: "unknown",
      occurredAt: new Date(), payload: { requestId }, retryability: "operator_retry",
    }));
    const readAttachment = async () => {
      const session = await getChatSession(userId, snapshot.sessionId);
      const message = session.messages.find(item => item.id === snapshot.assistantMessageId);
      if (!Array.isArray(message?.attachments)) throw new Error("Missing session attachments");
      return message.attachments.find(item => item.id === accepted.attachmentId);
    };
    expect(await readAttachment()).toMatchObject({
      id: accepted.attachmentId, generationJobId: requestId, status: "accepted",
      errorCode: "provider_outcome_unknown",
    });
    // The warning is a read projection, not a rewrite of attachment or billing facts.
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: accepted.attachmentId } })).toMatchObject({ status: "accepted", errorCode: null });
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: requestId, reason: "refund" } })).toBe(0);
    await expect(getChatSession(`${userId}-other`, snapshot.sessionId)).rejects.toMatchObject({ code: "not_found" });

    // Match the existing append-only operator decision. The unknown Attempt
    // stays immutable while the business Request is settled and then retried.
    await prisma.$transaction(async tx => {
      await transitionGenerationRequest(tx, {
        requestId, to: "failed", expected: { from: "queued" },
        data: { errorCode: "operator_confirmed_provider_failure" },
      });
      await tx.generationJobEvent.create({ data: {
        jobId: requestId, type: "unknown_reconciliation_confirm_failed",
        metadata: { attemptId: attempt.id, resolution: "confirm_failed" },
      } });
    });
    expect(await readAttachment()).toMatchObject({ errorCode: null });
    const retry = await prisma.$transaction(tx => reserveRetryGenerationAttempt(tx, {
      requestId, requireLatestAttempt: true, dispatch: { eventType: "generation.retry.dispatch.v2" },
    }));
    expect(retry.attempt).toMatchObject({ attemptNo: 2, status: "queued" });
    expect(await readAttachment()).toMatchObject({ status: "accepted", errorCode: null });
    expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: "unknown" });
  });

  it("generates the requested moment even when a reviewed studio portrait has high vocabulary overlap", async () => {
    const { userId, characterId, contentVersionId, generated } = await fixture();
    const studioPrompt = "One person seated by a gray studio backdrop wearing a white shirt, portrait in soft light.";
    const sourceJob = await prisma.generationJob.create({ data: {
      userId, characterId, mode: "image", prompt: studioPrompt, controls: {}, presetIds: [], orientation: "4:5",
      provider: "comfyui", sourceType: "content_production_item", sourceId: `${userId}-studio-item`,
    } });
    const batch = await prisma.contentProductionBatch.create({ data: {
      id: `${userId}-studio-batch`, title: "Studio portrait", purpose: "character_chat", targetType: "character", targetId: characterId,
      brief: studioPrompt, presetIds: [], orientation: "4:5", status: "completed", createdById: userId,
    } });
    const assets = [];
    for (const slot of ["avatar", "hero", "chat"] as const) {
      assets.push(await prisma.mediaAsset.create({ data: {
        id: `${userId}-studio-${slot}`, ownerId: userId, characterId, type: "image", sourceJobId: sourceJob.id,
        url: `/user-content/${userId}-studio-${slot}.webp`, width: 400, height: 500, prompt: studioPrompt,
        safetyStatus: "passed", metadata: { synthetic: false, provider: "comfyui", platformAsset: { status: "approved", description: studioPrompt } },
      } }));
    }
    const studio = assets[2]!;
    const item = await prisma.contentProductionItem.create({ data: {
      id: `${userId}-studio-item`, batchId: batch.id, jobId: sourceJob.id, mediaAssetId: studio.id,
      status: "approved", tags: ["portrait", "person", "seated", "soft light"],
    } });
    const project = await prisma.characterProject.create({ data: { id: `${userId}-project`, characterId } });
    const release = await prisma.characterRelease.create({ data: {
      id: `${userId}-release`, projectId: project.id, revisionId: `${userId}-revision`, characterContentVersionId: contentVersionId,
      generationProvenance: {}, snapshotHash: `${userId}-snapshot`, status: "superseded",
      releasePlacementManifest: { schemaVersion: 2, placements: assets.map((asset, index) => ({
        slotKey: ["character_avatar", "character_hero", "character_chat"][index], assetId: asset.id, slotVersion: 1,
        ...(index === 2 ? { runId: batch.id, itemId: item.id, generationJobId: sourceJob.id, reviewDecisionId: `${userId}-review` } : {}),
      })) },
    } });
    // A historical pinned session keeps its Release assets after supersession.
    const session = await prisma.recentChat.create({ data: {
      sessionId: randomUUID(), userId, characterId, characterContentVersionId: contentVersionId, characterReleaseId: release.id,
    } });
    const { snapshot } = await beginChatTurn({ userId, sessionId: session.sessionId,
      content: "Send me a portrait by the rainy cafe window wearing a blue raincoat.", idempotencyKey: randomUUID() });
    if (!snapshot) throw new Error("Missing snapshot");
    const call = effect(snapshot);
    call.arguments = { prompt: "One person seated by a rainy cafe window wearing a blue raincoat, portrait in soft light.", orientation: "4:5", outputCount: 1 };
    const accepted = await applyChatToolEffect(call);
    expect(accepted).toMatchObject({ accepted: true, status: "accepted", mediaAssetId: null });
    expect(generated).toHaveBeenCalledTimes(1);
    expect(generated.mock.calls[0]?.[0].promptHint).toContain("rainy cafe window wearing a blue raincoat");
    await complete(snapshot);
    const regenerated = await regenerateChatTurn(userId, snapshot.assistantMessageId);
    expect(await applyChatToolEffect({ ...call, attempt: regenerated.attempt, callId: randomUUID() })).toMatchObject({
      accepted: true, duplicate: true, generationJobId: accepted.accepted ? accepted.generationJobId : null,
    });
    expect(generated).toHaveBeenCalledTimes(1);
  });

  it("preserves an exact accepted historical ACK without authorizing a new action", async () => {
    const { userId, begin, generated } = await fixture();
    const { snapshot } = await begin("What reflection would you photograph from our window?");
    if (!snapshot) throw new Error("Missing snapshot");
    const call = effect(snapshot);
    const attachmentId = `chatfx_${createHash("sha256").update(`${call.turnId}:${call.name}`).digest("hex").slice(0, 48)}`;
    await prisma.chatTurnAttachment.create({ data: {
      id: attachmentId, turnId: call.turnId, kind: "generated_image", status: "accepted",
      metadata: { attempt: call.attempt, effect: { effectScope: "turn_action", intent: call.intent } },
    } });
    await complete(snapshot);
    expect(await applyChatToolEffect(call)).toMatchObject({ accepted: true, duplicate: true, attachmentId });
    expect(generated).not.toHaveBeenCalled();
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(40);
  });

  it.each(["attempt", "turn_action"] as const)("rejects an unsolicited direct ToolEffect (%s) without creating media or spending", async effectScope => {
    const { userId, begin, generated } = await fixture();
    const { snapshot } = await begin("For this quiet cafe visit, let us enjoy the rain without saving new memories. What reflection would you photograph from our window?");
    if (!snapshot) throw new Error("Missing snapshot");
    await expect(applyChatToolEffect({ ...effect(snapshot), effectScope })).rejects.toMatchObject({ code: "forbidden" });
    expect(generated).not.toHaveBeenCalled();
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(40);
  });

  it("executes a requested image once, replays terminal/regenerate ACKs, and rejects a later text-only edit", async () => {
    const { userId, begin, generated } = await fixture();
    const { snapshot } = await begin("Send me a photo by the cafe window.");
    if (!snapshot) throw new Error("Missing snapshot");
    const call = effect(snapshot);
    for (const untrusted of [
      { ...call, effectScope: "attempt" },
      { ...call, name: "edit_last_image", arguments: { instruction: "Change the photo background" } },
      { ...call, intent: { requestedNudity: "full" } },
    ]) {
      await expect(applyChatToolEffect(untrusted)).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(generated).not.toHaveBeenCalled();
    const accepted = await applyChatToolEffect(call);
    expect(accepted).toMatchObject({ accepted: true, duplicate: false });
    await complete(snapshot);
    expect(await applyChatToolEffect(call)).toMatchObject({ accepted: true, duplicate: true });
    const regenerated = await regenerateChatTurn(userId, snapshot.assistantMessageId);
    expect(await applyChatToolEffect({ ...call, attempt: regenerated.attempt, callId: randomUUID() })).toMatchObject({ accepted: true, duplicate: true });
    expect(generated).toHaveBeenCalledTimes(1);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
    await complete(regenerated.snapshot);
    // This focused fixture ACKs the independent memory worker before another edit.
    await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: `${userId}:${snapshot.characterId}` }, data: { status: "delivered", deliveredAt: new Date() } });
    const edited = await editChatTurn(userId, snapshot.userMessageId, "Let's only talk about the rain.");
    await expect(applyChatToolEffect({ ...call, attempt: edited.attempt })).rejects.toMatchObject({ code: "forbidden" });
    expect(generated).toHaveBeenCalledTimes(1);
    const attachment = await prisma.chatTurnAttachment.findFirstOrThrow({ where: { turnId: snapshot.turnId } });
    expect(attachment.metadata).toMatchObject({ attempt: regenerated.attempt });
  });

  it.each(["Yes, please.", "No, let's talk about coffee."])("uses only the persisted previous offer for a short reply: %s", async reply => {
    const { begin, generated, userId } = await fixture();
    const first = await begin("Tell me about your evening.");
    if (!first.snapshot) throw new Error("Missing snapshot");
    await complete(first.snapshot, "Would you like me to send you a photo by the cafe window?");
    const second = await begin(reply);
    if (!second.snapshot) throw new Error("Missing snapshot");
    if (reply.startsWith("Yes")) {
      expect(await applyChatToolEffect(effect(second.snapshot))).toMatchObject({ accepted: true });
      expect(generated).toHaveBeenCalledTimes(1);
    } else {
      await expect(applyChatToolEffect(effect(second.snapshot))).rejects.toMatchObject({ code: "forbidden" });
      expect(generated).not.toHaveBeenCalled();
      expect(await dreamcoinBalance(userId)).toBe(40);
    }
  });
});
