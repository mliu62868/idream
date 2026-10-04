import { createHash, randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import type { ChatToolEffect } from "@idream/shared/contracts";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_QUEUES } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { jobQueue } from "@/server/jobs/queue";
import { drainLocalAiPipeline } from "@/server/ai/local-pipeline";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import { transitionGenerationRequest } from "@/server/ai/generation-request-transition";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
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
  return { version: 2, turnId: snapshot.turnId, attempt: snapshot.attempt, callId: randomUUID(), name: "generate_image_async", effectScope: "turn_action", intent: { requestedNudity: "unspecified" }, arguments: { subject: "companion", prompt: "One person seated by a rain-streaked cafe window.", outputCount: 1, orientation: "4:5" } };
}

async function complete(snapshot: NonNullable<Awaited<ReturnType<typeof beginChatTurn>>["snapshot"]>, content = "Here you go.") {
  return commitChatTerminal({ version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId, attempt: snapshot.attempt, status: "sent", content, model: "test", promptTokens: 1, completionTokens: 1,
    sceneVersion: snapshot.sceneVersion + 1,
    scene: { schemaVersion: 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [], ...snapshot.scene, version: snapshot.sceneVersion + 1 },
    terminalEvidence: evidence });
}

// Pause only after PostgreSQL really acquired the Chat mutation's user lock.
// Every query and terminal settlement still runs against the real database.
function pauseNextUserLock() {
  let resume = () => {};
  const held = new Promise<void>(resolve => { resume = resolve; });
  let signalLocked = (_pid: number) => {};
  const locked = new Promise<number>(resolve => { signalLocked = resolve; });
  let paused = false;
  const transaction = prisma.$transaction.bind(prisma);
  vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: unknown[]) => {
    const [callback, options] = args;
    if (typeof callback !== "function") return Reflect.apply(transaction, prisma, args);
    return transaction(async tx => callback(new Proxy(tx, {
      get(target, property, receiver) {
        if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
        return async (...queryArgs: unknown[]) => {
          const result = await Reflect.apply(target.$queryRaw, target, queryArgs);
          const sql = Array.isArray(queryArgs[0]) ? queryArgs[0].join("") : String(queryArgs[0]);
          if (!paused && sql.includes('"users"') && sql.includes("FOR UPDATE")) {
            paused = true;
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            signalLocked(pid);
            await held;
          }
          return result;
        };
      },
    })), options as Parameters<typeof prisma.$transaction>[1]);
  }) as typeof prisma.$transaction);
  return { locked, resume };
}

async function waitForBlockedTransaction(blockerPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
    `;
    if (rows.length > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Generation settlement never reached the held Chat user lock");
}

async function editFixture(text: string) {
  const fixtureData = await fixture();
  const first = await fixtureData.begin("Let's sit beside the window.");
  if (!first.snapshot) throw new Error("Missing source Turn");
  const asset = await prisma.mediaAsset.create({ data: {
    id: `${fixtureData.userId}-source`, ownerId: fixtureData.userId, characterId: fixtureData.characterId,
    type: "image", url: "/test-source.png", safetyStatus: "passed", metadata: {},
  } });
  await prisma.chatTurnAttachment.create({ data: {
    id: `${fixtureData.userId}-source-attachment`, turnId: first.snapshot.turnId,
    kind: "generated_image", status: "completed", mediaAssetId: asset.id,
  } });
  await complete(first.snapshot);
  const next = await fixtureData.begin(text);
  if (!next.snapshot) throw new Error("Missing edit Turn");
  expect(next.snapshot.hasRecentImageContext).toBe(true);
  const call: ChatToolEffect = { ...effect(next.snapshot), name: "edit_last_image", arguments: {
    instruction: "Change blue to green. Preserve her curly updo, grey cardigan, kitchen background and standing pose.",
  } };
  return { ...fixtureData, snapshot: next.snapshot, call, asset };
}

describe("Main image action authorization", () => {
  it("rejects a new model image without subject before creating an attachment or spending", async () => {
    const { begin, generated, userId } = await fixture();
    const { snapshot } = await begin("Generate one image of the balcony plants. No people.");
    if (!snapshot) throw new Error("Missing snapshot");
    const call = effect(snapshot);
    call.arguments = { prompt: "The balcony plants in their terracotta pots. No people." };
    await expect(applyChatToolEffect(call)).rejects.toMatchObject({ code: "bad_request" });
    expect(generated).not.toHaveBeenCalled();
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(40);
  });

  it("rejects an oversized new-image direction before attachments, jobs or debit instead of discarding its final relation", async () => {
    const { begin, generated, userId } = await fixture();
    const { snapshot } = await begin("Send a picture of our current scene.");
    if (!snapshot) throw new Error("Missing snapshot");
    const call = effect(snapshot);
    call.arguments = { subject: "companion", prompt: "Soft light over the wooden windowsill. ".repeat(25) + "The blue notebook must remain to the left of the white cup." };
    await expect(applyChatToolEffect(call)).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("Shorten the request") });
    expect(generated).not.toHaveBeenCalled();
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(40);
  });

  it.each([
    "Edit the picture you just sent: change only the notebook from blue to green. Preserve the same face, hairstyle, clothes, pose, background and camera framing. Make the edited picture now.",
    "Edit this image: move the notebook to the left and turn its cover green; make the curtains yellow and brighten the window. Preserve the face, clothing and text on every page.",
    "Edit this image: replace the sweater with a green jacket, turn her body toward the window, and move the scene to a kitchen. Keep the same face and the text on the notebook.",
    "编辑这张图片：把笔记本改为绿色、窗帘改为黄色，保留脸、衣服、姿势和最后一页的文字。",
  ])("freezes the complete user's edit instead of invented source details: %s", async text => {
    const { snapshot, call, generated, asset } = await editFixture(text);
    expect(await applyChatToolEffect(call)).toMatchObject({ accepted: true });
    expect(generated).toHaveBeenCalledTimes(1);
    expect(generated.mock.calls[0]?.[0]).toMatchObject({ promptHint: text, controls: { sourceImageAssetId: asset.id } });
    expect(await prisma.chatTurnAttachment.findFirstOrThrow({ where: { turnId: snapshot.turnId } })).toMatchObject({ promptHint: text });
    await complete(snapshot);
    expect(await applyChatToolEffect({ ...call, callId: randomUUID(), arguments: { instruction: "Replace the room again" } })).toMatchObject({ accepted: true, duplicate: true });
    expect(generated).toHaveBeenCalledTimes(1);
  });

  it.each(["companion", "scene"] as const)("edits the last %s image after its newer video delivery", async subject => {
    const text = "Edit this image: change only the terracotta pot to blue. Keep everything else unchanged.";
    const { snapshot, call, generated, asset, userId, characterId } = await editFixture(text);
    if (subject === "scene") await prisma.mediaAsset.update({ where: { id: asset.id }, data: { characterId: null } });
    const imageAttachment = await prisma.chatTurnAttachment.findFirstOrThrow({ where: { mediaAssetId: asset.id } });
    const video = await prisma.mediaAsset.create({ data: {
      id: `${userId}-video`, ownerId: userId, characterId: subject === "scene" ? null : characterId,
      type: "video", url: "/test-source.mp4", safetyStatus: "passed", metadata: {},
    } });
    await prisma.chatTurnAttachment.create({ data: {
      id: `${userId}-video-attachment`, turnId: imageAttachment.turnId,
      kind: "generated_video", status: "completed", mediaAssetId: video.id,
      createdAt: new Date(imageAttachment.createdAt.getTime() + 1),
    } });
    expect(await applyChatToolEffect(call)).toMatchObject({ accepted: true });
    expect(generated).toHaveBeenCalledTimes(1);
    expect(generated.mock.calls[0]?.[0]).toMatchObject({ subject, promptHint: text, controls: { sourceImageAssetId: asset.id } });
    expect(await prisma.chatTurnAttachment.findFirstOrThrow({ where: { turnId: snapshot.turnId } })).toMatchObject({ promptHint: text });
  });

  it.each([
    [950, "unspecified"], [1_250, "unspecified"], [850, "none"], [850, "full"],
  ] as const)("rejects oversized frozen edits before attachments or billing (%s, %s)", async (length, nudity) => {
    const prefix = nudity === "none" ? "Edit this image with no nudity: " : nudity === "full" ? "Edit this image fully nude: " : "Edit this image: ";
    const text = `${prefix}${"retain detail; ".repeat(100)}`.slice(0, length) + " Preserve the last page.";
    const { snapshot, call, generated, userId } = await editFixture(text);
    call.intent = { requestedNudity: nudity };
    await expect(applyChatToolEffect(call)).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("Shorten the request") });
    expect(generated).not.toHaveBeenCalled();
    expect(await prisma.chatTurnAttachment.count({ where: { turnId: snapshot.turnId } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(40);
  });

  it.each(["requesting", "accepted"] as const)("preserves the frozen historical %s edit even when the user text exceeds the new budget", async status => {
    const text = `Edit this image: ${"retain detail; ".repeat(100)} Preserve the last page.`;
    const { snapshot, call, generated } = await editFixture(text);
    const attachmentId = `chatfx_${createHash("sha256").update(`${call.turnId}:${call.name}`).digest("hex").slice(0, 48)}`;
    const historicalHint = "Change only the notebook to green.";
    await prisma.chatTurnAttachment.create({ data: {
      id: attachmentId, turnId: snapshot.turnId, kind: "generated_image", status, promptHint: historicalHint,
      metadata: { attempt: call.attempt, effect: { effectScope: "turn_action", intent: call.intent }, request: { name: "edit_last_image" } },
    } });
    expect(await applyChatToolEffect(call)).toMatchObject({ accepted: true, duplicate: status === "accepted" });
    expect(generated).toHaveBeenCalledTimes(status === "accepted" ? 0 : 1);
    if (status === "requesting") expect(generated.mock.calls[0]?.[0].promptHint).toBe(historicalHint);
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachmentId } })).toMatchObject({ promptHint: historicalHint });
  });

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
    call.arguments = { subject: "companion", prompt: "One person seated by a rainy cafe window wearing a blue raincoat, portrait in soft light.", orientation: "4:5", outputCount: 1 };
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

  // Main runs the same intent authority Chat does, so a language the matchers
  // cannot read is still decided here and not accepted on Chat's word. The judge
  // below is a stand-in for the model; its accuracy is measured elsewhere.
  describe("with an intent judge configured", () => {
    let verdict = "NONE";
    let asked: string[] = [];
    let server: Server;
    beforeAll(async () => {
      server = createServer((request, response) => {
        let body = "";
        request.on("data", chunk => { body += chunk; });
        request.on("end", () => {
          asked.push(body);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ choices: [{ message: { content: verdict } }] }));
        });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      process.env.CHAT_MODEL_BASE_URL = `http://127.0.0.1:${port}/v1`;
      process.env.CHAT_INTENT_MODEL_NAME = "test-judge";
    });
    afterAll(async () => {
      delete process.env.CHAT_INTENT_MODEL_NAME;
      delete process.env.CHAT_MODEL_BASE_URL;
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    beforeEach(() => { verdict = "NONE"; asked = []; });

    it("spends on a request in a language the matchers cannot read", async () => {
      verdict = "PHOTO";
      const { userId, begin, generated } = await fixture();
      const { snapshot } = await begin("kirim foto kamu di pantai pas matahari terbenam");
      if (!snapshot) throw new Error("Missing snapshot");
      expect(await applyChatToolEffect(effect(snapshot))).toMatchObject({ accepted: true });
      expect(generated).toHaveBeenCalledTimes(1);
      expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
      // The judge sees this Turn's user message and nothing that surrounds it.
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("kirim foto kamu di pantai");
      expect(asked[0]).not.toContain("Mira");
    });

    it("refuses the same request the moment the judge declines it", async () => {
      const { userId, begin, generated } = await fixture();
      const { snapshot } = await begin("kirim foto kamu di pantai pas matahari terbenam");
      if (!snapshot) throw new Error("Missing snapshot");
      await expect(applyChatToolEffect(effect(snapshot))).rejects.toMatchObject({ code: "forbidden" });
      expect(generated).not.toHaveBeenCalled();
      expect(await dreamcoinBalance(userId)).toBe(40);
    });

    it.each([
      ["a message that names no image", "ceritain dong gimana harimu tadi"],
      ["a cancelled request", "不要给我发照片，我们聊天就好"],
    ])("never even asks the judge about %s", async (_case, content) => {
      verdict = "PHOTO";
      const { userId, begin, generated } = await fixture();
      const { snapshot } = await begin(content);
      if (!snapshot) throw new Error("Missing snapshot");
      await expect(applyChatToolEffect(effect(snapshot))).rejects.toMatchObject({ code: "forbidden" });
      expect(asked).toEqual([]);
      expect(generated).not.toHaveBeenCalled();
      expect(await dreamcoinBalance(userId)).toBe(40);
    });

    it("refuses a wardrobe guarantee the judge never made", async () => {
      verdict = "PHOTO";
      const { userId, begin, generated } = await fixture();
      const { snapshot } = await begin("kirim foto kamu di pantai pas matahari terbenam");
      if (!snapshot) throw new Error("Missing snapshot");
      await expect(applyChatToolEffect({ ...effect(snapshot), intent: { requestedNudity: "full" } }))
        .rejects.toMatchObject({ code: "forbidden" });
      expect(generated).not.toHaveBeenCalled();
      expect(await dreamcoinBalance(userId)).toBe(40);
    });

    it("refuses a classified edit until an image has been delivered", async () => {
      verdict = "EDIT";
      const { userId, begin, generated } = await fixture();
      const { snapshot } = await begin("na foto que voce mandou, consegue trocar o fundo?");
      if (!snapshot) throw new Error("Missing snapshot");
      const edit = { ...effect(snapshot), name: "edit_last_image" as const, arguments: { instruction: "Change the background" } };
      await expect(applyChatToolEffect(edit)).rejects.toMatchObject({ code: "forbidden" });
      expect(generated).not.toHaveBeenCalled();
      expect(await dreamcoinBalance(userId)).toBe(40);
    });
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

  it("makes a new picture when the latest request is edited into a different picture, and reuses it again on regenerate", async () => {
    const { userId, begin, generated } = await fixture();
    const { snapshot } = await begin("Send me a photo by the cafe window.");
    if (!snapshot) throw new Error("Missing snapshot");
    const call = effect(snapshot);
    const window = await applyChatToolEffect(call);
    expect(window).toMatchObject({ accepted: true, duplicate: false });
    await complete(snapshot);
    await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: `${userId}:${snapshot.characterId}` }, data: { status: "delivered", deliveredAt: new Date() } });

    const edited = await editChatTurn(userId, snapshot.userMessageId, "Send me a photo on the beach at sunset.");
    if (!edited.snapshot) throw new Error("Missing edited snapshot");
    const beachCall = { ...call, attempt: edited.attempt, callId: randomUUID(), arguments: { subject: "companion", prompt: "One person on a beach at sunset.", orientation: "4:5" as const, outputCount: 1 } };
    const beach = await applyChatToolEffect(beachCall);
    expect(beach).toMatchObject({ accepted: true, duplicate: false });
    expect(beach.attachmentId).not.toBe(window.attachmentId);
    expect(generated).toHaveBeenCalledTimes(2);
    expect(generated.mock.calls[1]?.[0].promptHint).toContain("beach at sunset");
    const view = await getChatSession(userId, snapshot.sessionId);
    const reply = view.messages.find((message) => message.id === snapshot.assistantMessageId) as { attachments: Array<{ id: string }> } | undefined;
    expect(reply?.attachments.map((attachment) => attachment.id)).toEqual([beach.attachmentId]);

    await complete(edited.snapshot);
    await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: `${userId}:${snapshot.characterId}` }, data: { status: "delivered", deliveredAt: new Date() } });
    const regenerated = await regenerateChatTurn(userId, snapshot.assistantMessageId);
    expect(await applyChatToolEffect({ ...beachCall, attempt: regenerated.attempt, callId: randomUUID() })).toMatchObject({
      accepted: true, duplicate: true, attachmentId: beach.attachmentId,
    });
    expect(generated).toHaveBeenCalledTimes(2);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(2);
  });

  it.each(["accepted", "completed"] as const)("replays an unedited legacy %s image but buys a new action after its Turn is edited", async status => {
    const { userId, characterId, begin, generated } = await fixture();
    const { snapshot } = await begin("Send me a photo by the cafe window.");
    if (!snapshot) throw new Error("Missing snapshot");
    const call = effect(snapshot);
    const attachmentId = `chatfx_${createHash("sha256").update(`${snapshot.turnId}:${call.name}`).digest("hex").slice(0, 48)}`;
    const job = await prisma.generationJob.create({ data: {
      userId, characterId, mode: "image", prompt: "By the cafe window.", controls: {}, presetIds: [],
      sourceType: "chat_image", sourceId: attachmentId, costDreamcoins: 8,
      status: status === "completed" ? "completed" : "queued",
      sourceMeta: { sessionId: snapshot.sessionId, exchangeId: snapshot.turnId, messageId: snapshot.assistantMessageId },
    } });
    const asset = status === "completed" ? await prisma.mediaAsset.create({ data: {
      id: `${userId}-legacy-window`, ownerId: userId, characterId, sourceJobId: job.id,
      type: "image", url: "/legacy-window.png", safetyStatus: "passed", metadata: {},
    } }) : null;
    await prisma.chatTurnAttachment.create({ data: {
      id: attachmentId, turnId: snapshot.turnId, kind: "generated_image", status,
      generationJobId: job.id, mediaAssetId: asset?.id, promptHint: "By the cafe window.",
      metadata: { attempt: 1, costDreamcoins: 8, effect: { effectScope: "turn_action", intent: call.intent } },
    } });
    await complete(snapshot);

    const regenerated = await regenerateChatTurn(userId, snapshot.assistantMessageId);
    expect(await applyChatToolEffect({ ...call, attempt: regenerated.attempt, callId: randomUUID() }))
      .toMatchObject({ accepted: true, duplicate: true, attachmentId, generationJobId: job.id });
    expect(generated).not.toHaveBeenCalled();
    await complete(regenerated.snapshot);
    await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: `${userId}:${characterId}` }, data: { status: "delivered", deliveredAt: new Date() } });

    const edited = await editChatTurn(userId, snapshot.userMessageId, "Send me a photo on the beach at sunset.");
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).sourceMeta)
      .toMatchObject({ privacyRedaction: { reason: "logical_turn_edited" } });
    // Historical edits predate attachment markers; their Job still records why
    // its source was redacted, and must not become reusable after an upgrade.
    const legacyMetadata = JSON.parse(JSON.stringify((await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachmentId } })).metadata));
    delete legacyMetadata.turnActionInvalidatedByEdit;
    await prisma.chatTurnAttachment.update({ where: { id: attachmentId }, data: { metadata: legacyMetadata } });
    const beach = await applyChatToolEffect({ ...call, attempt: edited.attempt, callId: randomUUID(),
      arguments: { subject: "companion", prompt: "One person on a beach at sunset.", orientation: "4:5", outputCount: 1 } });
    expect(beach).toMatchObject({ accepted: true, duplicate: false });
    expect(beach.attachmentId).not.toBe(attachmentId);
    expect(generated).toHaveBeenCalledTimes(1);
    expect(generated.mock.calls[0]?.[0].promptHint).toContain("beach at sunset");
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(2);
    const view = await getChatSession(userId, snapshot.sessionId);
    const reply = view.messages.find(message => message.id === snapshot.assistantMessageId) as { attachments: Array<{ id: string }> } | undefined;
    expect(reply?.attachments.map(attachment => attachment.id)).toEqual([beach.attachmentId]);
  });

  it.each(["accepted", "completed", "failed", "requesting"] as const)("starts a new picture after editing a legacy %s action without a Job", async status => {
    const { userId, characterId, begin, generated } = await fixture();
    const { snapshot } = await begin("Send me a photo by the cafe window.");
    if (!snapshot) throw new Error("Missing snapshot");
    const call = effect(snapshot);
    const attachmentId = `chatfx_${createHash("sha256").update(`${snapshot.turnId}:${call.name}`).digest("hex").slice(0, 48)}`;
    const asset = ["accepted", "completed"].includes(status) ? await prisma.mediaAsset.create({ data: {
      id: `${userId}-legacy-curated`, ownerId: userId, characterId,
      type: "image", url: "/legacy-curated.png", safetyStatus: "passed", metadata: {},
    } }) : null;
    await prisma.chatTurnAttachment.create({ data: {
      id: attachmentId, turnId: snapshot.turnId, kind: "generated_image", status,
      mediaAssetId: asset?.id, promptHint: "By the cafe window.",
      metadata: { attempt: 1, costDreamcoins: 0, effect: { effectScope: "turn_action", intent: call.intent } },
    } });
    await complete(snapshot);
    if (asset) {
      const regenerated = await regenerateChatTurn(userId, snapshot.assistantMessageId);
      expect(await applyChatToolEffect({ ...call, attempt: regenerated.attempt, callId: randomUUID() }))
        .toMatchObject({ accepted: true, duplicate: true, attachmentId, generationJobId: null, mediaAssetId: asset.id });
      expect(generated).not.toHaveBeenCalled();
      await complete(regenerated.snapshot);
    }
    await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: `${userId}:${characterId}` }, data: { status: "delivered", deliveredAt: new Date() } });
    const edited = await editChatTurn(userId, snapshot.userMessageId, "Send me a photo on the beach at sunset.");
    expect((await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachmentId } })).metadata)
      .toMatchObject({ turnActionInvalidatedByEdit: true });
    const beach = await applyChatToolEffect({ ...call, attempt: edited.attempt, callId: randomUUID(),
      arguments: { subject: "companion", prompt: "One person on a beach at sunset.", orientation: "4:5", outputCount: 1 } });
    expect(beach).toMatchObject({ accepted: true, duplicate: false });
    expect(beach.attachmentId).not.toBe(attachmentId);
    expect(generated).toHaveBeenCalledTimes(1);
    expect(generated.mock.calls[0]?.[0].promptHint).toContain("beach at sunset");
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
  });

  it.each(["rebind", "edit"] as const)("settles one real debit while a Chat %s holds the user lock", async mutation => {
    const { userId, begin } = await fixture();
    const { snapshot } = await begin("Send me a photo by the cafe window.");
    if (!snapshot) throw new Error("Missing snapshot");
    const call = effect(snapshot);
    const accepted = await applyChatToolEffect(call);
    if (!accepted.accepted || !accepted.generationJobId) throw new Error("Missing image reservation");
    const jobId = accepted.generationJobId;
    await prisma.generationJob.update({ where: { id: jobId }, data: {
      sourceMeta: { sessionId: snapshot.sessionId, exchangeId: snapshot.turnId, messageId: snapshot.assistantMessageId },
    } });
    await prisma.$transaction(tx => postDreamcoinEntry(tx, {
      kind: "generation_spend", userId, amount: 8, sourceId: jobId, idempotencyKey: `generation:${jobId}:reserve`,
    }));
    expect(await dreamcoinBalance(userId)).toBe(32);
    await complete(snapshot);
    const attempt = mutation === "rebind"
      ? (await regenerateChatTurn(userId, snapshot.assistantMessageId)).attempt
      : snapshot.attempt;
    const attemptId = `${jobId}-attempt`;
    await prisma.generationAttempt.create({ data: { id: attemptId, requestId: jobId, attemptNo: 1, provider: "mock", status: "running" } });
    const payload = { version: 1 as const, kind: "generation.failed" as const, requestId: jobId, generationJobId: jobId,
      attemptId, attemptNo: 1, mode: "image" as const, terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`,
      terminalRecordChecksum: "a".repeat(64), error: { code: "backend_error", message: "Controlled provider failure", retryable: true, retryability: "retryable" as const } };
    await prisma.mainOutboxEvent.create({ data: { id: `generation_terminal_record_${attemptId}`,
      eventType: "generation.terminal_record.accepted.v1", aggregateType: "generation_attempt", aggregateId: attemptId, payload } });
    const dedupeKey = `${prefix}refund-lock:${attemptId}`;
    await jobQueue.enqueue({ queue: MAIN_QUEUES.aiFinalize, payload, dedupeKey, maxAttempts: 1 });

    const barrier = pauseNextUserLock();
    const revision = Promise.allSettled([mutation === "rebind"
      ? applyChatToolEffect({ ...call, attempt, callId: randomUUID() })
      : editChatTurn(userId, snapshot.userMessageId, "Send me a photo on the beach at sunset.")]);
    let finalized: ReturnType<typeof drainLocalAiPipeline> | undefined;
    try {
      const pid = await barrier.locked;
      finalized = drainLocalAiPipeline({ queues: [MAIN_QUEUES.aiFinalize], limit: 1, workerId: `${prefix}refund` });
      await waitForBlockedTransaction(pid);
    } finally {
      barrier.resume();
    }
    expect(await revision).toEqual([expect.objectContaining({ status: "fulfilled" })]);
    expect(await finalized).toMatchObject({ processed: 1, claimed: [expect.objectContaining({ status: "completed" })] });
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "failed" });
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: accepted.attachmentId } }))
      .toMatchObject({ status: "failed", generationJobId: jobId, metadata: expect.objectContaining({ attempt }) });
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: jobId, reason: "generation_spend" } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: jobId, reason: "refund" } })).toBe(1);
    expect(await dreamcoinBalance(userId)).toBe(40);
    await jobQueue.removeByDedupeKey(MAIN_QUEUES.aiFinalize, dedupeKey);
  });

  it("runs a picture again on regenerate when its first try failed before anything was reserved", async () => {
    const { userId, begin, generated } = await fixture();
    const { snapshot } = await begin("Send me a photo by the cafe window.");
    if (!snapshot) throw new Error("Missing snapshot");
    const call = effect(snapshot);
    generated.mockImplementationOnce(async () => { throw Errors.rateLimited("Too many active generation jobs"); });
    const refused = await applyChatToolEffect(call);
    expect(refused).toMatchObject({ accepted: false, duplicate: false, error: { code: "rate_limited" } });
    // The same attempt keeps its answer: nothing is retried behind the reader's back.
    expect(await applyChatToolEffect({ ...call, callId: randomUUID() })).toMatchObject({ accepted: false, duplicate: true });
    expect(generated).toHaveBeenCalledTimes(1);
    await complete(snapshot);

    const regenerated = await regenerateChatTurn(userId, snapshot.assistantMessageId);
    const retried = await applyChatToolEffect({ ...call, attempt: regenerated.attempt, callId: randomUUID() });
    expect(retried).toMatchObject({ accepted: true, duplicate: false, attachmentId: refused.attachmentId });
    expect(generated).toHaveBeenCalledTimes(2);
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: refused.attachmentId } })).toMatchObject({
      status: "accepted", errorCode: null, metadata: expect.objectContaining({ attempt: regenerated.attempt }),
    });
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
  });

  it("preserves a concurrent replacement Job's cost when rebinding the action to a new attempt", async () => {
    const { userId, begin, generated } = await fixture();
    const { snapshot } = await begin("Send me a photo by the cafe window.");
    if (!snapshot) throw new Error("Missing snapshot");
    const call = effect(snapshot);
    const accepted = await applyChatToolEffect(call);
    if (!accepted.accepted) throw new Error("Missing image reservation");
    await complete(snapshot);
    const regenerated = await regenerateChatTurn(userId, snapshot.assistantMessageId);
    const replacement = await prisma.generationJob.create({ data: {
      userId, characterId: snapshot.characterId, mode: "image", prompt: "Replacement image.",
      controls: {}, presetIds: [], sourceType: "chat_image", sourceId: null,
      derivedFromJobId: accepted.generationJobId, costDreamcoins: 13,
    } });
    const staleRead = prisma.chatTurnAttachment.findUnique({ where: { id: accepted.attachmentId } });
    const stale = await staleRead;
    if (!stale) throw new Error("Missing prior action");
    // Replay the unlocked lookup from just before a paid retry's binding. The
    // canonical scope reads below must observe the real, newer database row.
    await prisma.chatTurnAttachment.update({ where: { id: stale.id }, data: {
      generationJobId: replacement.id,
      metadata: { ...JSON.parse(JSON.stringify(stale.metadata)), costDreamcoins: 13 },
    } });
    vi.spyOn(prisma.chatTurnAttachment, "findUnique").mockReturnValueOnce(staleRead);
    const replay = await applyChatToolEffect({ ...call, attempt: regenerated.attempt, callId: randomUUID() });
    expect(replay).toMatchObject({ accepted: true, duplicate: true, generationJobId: replacement.id, costDreamcoins: 13 });
    expect(await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: accepted.attachmentId } }))
      .toMatchObject({ generationJobId: replacement.id, metadata: expect.objectContaining({ attempt: regenerated.attempt, costDreamcoins: 13 }) });
    expect(generated).toHaveBeenCalledTimes(1);
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
