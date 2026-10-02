import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { dispatchV1 } from "@/server/modules/ourdream/service";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { canonicalJsonHash } from "@/server/modules/admin-v2/shared/idempotency";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { providers } from "@/server/providers";
import { beginChatTurn, commitChatTerminal, createChatSession, editChatTurn, regenerateChatTurn } from "@/server/modules/chat/turn-ledger";
import { AGE_GATE_COOKIE_HEADER, api, createCharacter, createUser, dreamcoinBalance, expectOk, grantCoins, purgeTestData, voiceReplyBody } from "@/server/test/helpers";

const P = "zt-voice-replay-";
let createdVoiceFlag = false;

async function grantVoice(userId: string, minutes: number) {
  await prisma.entitlement.create({ data: { userId, key: "voice_enabled", value: true, source: "subscription" } });
  if (minutes > 0) await prisma.entitlement.create({ data: { userId, key: "voice_minutes", value: minutes, source: "subscription" } });
}

beforeAll(async () => {
  await purgeTestData(P);
  if (!(await prisma.featureFlag.findUnique({ where: { key: "voice_gen" } }))) {
    await prisma.featureFlag.create({ data: {
      key: "voice_gen", label: "Voice replay test", enabled: true, rolloutPercent: 100, targetRoles: [], targetPlans: [],
    } });
    createdVoiceFlag = true;
  }
  if (!(await prisma.pricingRule.count({ where: { mode: "voice", status: "active" } }))) {
    await prisma.pricingRule.create({ data: {
      id: `${P}pricing`, ruleKey: `${P}pricing`, label: "Voice replay test", version: 1, mode: "voice", baseCost: 2, status: "active",
    } });
  }
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.pricingRule.deleteMany({ where: { id: `${P}pricing` } });
  if (createdVoiceFlag) await prisma.featureFlag.delete({ where: { key: "voice_gen" } });
  await prisma.$disconnect();
});

describe("voice clip replay settlement", () => {
  it("replays a migrated legacy request without changing its accepted fingerprint or charging again", async () => {
    const userId = `${P}legacy-version`;
    const characterId = `${userId}-character`;
    const messageId = `${P}legacy-message`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
    await grantVoice(userId, 0);
    await grantCoins(userId, 4, "seed");
    const body = await voiceReplyBody(userId, { characterId, messageId, text: "An existing reply." });
    const delivered = await api("POST", "generation/voice", { userId, ageGate: true, body });
    expectOk(delivered, 201);
    const current = await prisma.voiceClipRequest.findFirstOrThrow({ where: { userId, messageId } });
    const usage = await prisma.voiceUsageFact.findFirstOrThrow({ where: { requestId: current.id } });
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: delivered.data.assetId } });
    const legacyId = `voice_clip_request_${createHash("sha256").update(`${userId}\u0000${messageId}`).digest("hex")}`;
    const legacyFingerprint = canonicalJsonHash({
      schemaVersion: "voice-clip-request-v1", userId, characterId, messageId,
      sessionId: body.sessionId, text: body.text, sceneVersion: 0, scene: null,
    });
    // Build the exact pre-migration authority shape from a real delivered clip.
    // Recreate fixtures rather than weakening the immutable production triggers.
    await prisma.voiceClipRequest.delete({ where: { id: current.id } });
    const legacy = await prisma.voiceClipRequest.create({ data: {
      ...current, id: legacyId, requestFingerprint: legacyFingerprint,
      synthesisPayload: toInputJson(current.synthesisPayload), providerPayload: toInputJson(current.providerPayload), error: Prisma.DbNull,
      providerRequestId: `voice:${legacyId}:provider`,
      billingAuthority: { ...(current.billingAuthority as object), requestFingerprint: legacyFingerprint },
    } });
    const legacyUsage = await prisma.voiceUsageFact.create({ data: { ...usage, requestId: legacyId } });
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: {
      metadata: { ...(asset.metadata as object), requestId: legacyId },
    } });
    const provider = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      const quote = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
      expectOk(quote);
      expect(quote.data.quote).toMatchObject({ alreadyDelivered: true, maxCostDreamcoins: 0 });
      const replay = await api("POST", "generation/voice", { userId, ageGate: true, body });
      expectOk(replay);
      expect(replay.data.assetId).toBe(delivered.data.assetId);
      expect(provider).not.toHaveBeenCalled();
      expect(await dreamcoinBalance(userId)).toBe(2);
      expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: legacyId } })).toEqual(legacy);
      expect(await prisma.voiceUsageFact.findUniqueOrThrow({ where: { id: legacyUsage.id } })).toEqual(legacyUsage);
      expectOk(await api("DELETE", `media/${asset.id}`, { userId, ageGate: true }));
      const restored = await api("POST", "generation/voice", { userId, ageGate: true, body });
      expectOk(restored, 201);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(await dreamcoinBalance(userId)).toBe(2);
      expect(await prisma.voiceUsageFact.findUniqueOrThrow({ where: { id: legacyUsage.id } })).toEqual(legacyUsage);
      expect(await prisma.voiceClipRequest.count({ where: { userId, messageId } })).toBe(1);
    } finally {
      provider.mockRestore();
    }
  });

  it.each(["regenerate", "edit"] as const)("delivers and settles each reply version after %s while preserving earlier audio", async (revision) => {
    const userId = `${P}revision-${revision}`;
    const characterId = `${userId}-character`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
    await grantVoice(userId, 0);
    await grantCoins(userId, 10, "seed");
    const soul = compileCharacterSoul({
      name: "Nova", age: 31, gender: "female",
      characterPromise: "A ceramicist who works late.", detailsMarkdown: "Unhurried and specific.",
    });
    if (!soul.ok) throw new Error("Invalid fixture Soul");
    const content = await prisma.characterContentVersion.create({ data: {
      characterId, version: 1, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint,
      personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: {}, appearanceSnapshot: {},
    } });
    await prisma.character.update({ where: { id: characterId }, data: { currentContentVersionId: content.id } });
    const session = await createChatSession(userId, { characterId });
    const firstTurn = await beginChatTurn({ userId, sessionId: session.id, content: "Hello.", idempotencyKey: `${P}${revision}` });
    const commitReply = async (snapshot: NonNullable<typeof firstTurn.snapshot>, text: string) => {
      await commitChatTerminal({
        version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId,
        assistantMessageId: snapshot.assistantMessageId, attempt: snapshot.attempt, status: "sent", content: text,
        model: "fixture", promptTokens: 2, completionTokens: 2,
        sceneVersion: snapshot.sceneVersion + 1,
        scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
        terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } },
      });
    };
    if (!firstTurn.snapshot) throw new Error("Missing initial Turn snapshot");
    await commitReply(firstTurn.snapshot, "The first reply.");
    const body = { characterId, sessionId: session.id, messageId: firstTurn.assistant.id };
    const provider = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      const originalQuote = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
      expectOk(originalQuote);
      const first = await api("POST", "generation/voice", {
        userId, ageGate: true, body: { ...body, quoteToken: originalQuote.data.quote.quoteToken },
      });
      expectOk(first, 201);
      const initialRequest = await prisma.voiceClipRequest.findFirstOrThrow({ where: { userId, messageId: body.messageId } });
      const initialUsage = await prisma.voiceUsageFact.findMany({ where: { requestId: initialRequest.id } });
      const quoteBeforeRevision = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
      expectOk(quoteBeforeRevision);
      expect(quoteBeforeRevision.data.quote).toMatchObject({ alreadyDelivered: true, maxCostDreamcoins: 0 });
      const revised = revision === "regenerate"
        ? await regenerateChatTurn(userId, body.messageId)
        : await editChatTurn(userId, firstTurn.userMessage.id, "Hello again.");
      if (!revised.snapshot) throw new Error("Missing revised Turn snapshot");
      expect(revised.assistantMessageId).toBe(body.messageId);
      expect(revised.attempt).toBe(2);
      // Regeneration can return identical words and scene; version identity still changes.
      await commitReply(revised.snapshot, revision === "regenerate" ? "The first reply." : "The edited reply.");
      const quote = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
      expectOk(quote);
      expect(quote.data.quote).toMatchObject({ alreadyDelivered: false, maxCostDreamcoins: 2 });
      const staleQuote = await api("POST", "generation/voice", {
        userId, ageGate: true, autoGenerationQuote: false,
        body: { ...body, quoteToken: originalQuote.data.quote.quoteToken },
      });
      expect(staleQuote.status).toBe(409);
      expect(provider).toHaveBeenCalledTimes(1);
      const second = await api("POST", "generation/voice", { userId, ageGate: true, body });
      expectOk(second, 201);
      expect(second.data.assetId).not.toBe(first.data.assetId);
      expect(await dreamcoinBalance(userId)).toBe(6);
      expect(await prisma.voiceClipRequest.count({ where: { userId, messageId: body.messageId } })).toBe(2);
      expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(2);
      expect(await prisma.voiceUsageFact.findMany({ where: { requestId: initialRequest.id } })).toEqual(initialUsage);
      expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: initialRequest.id } })).toEqual(initialRequest);
      expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: first.data.assetId } })).toMatchObject({ deletedAt: null });
      const oldAudio = await dispatchV1(new Request(`http://localhost/api/v1/media/${first.data.assetId}/content`, {
        headers: { "x-idream-user-id": userId, cookie: AGE_GATE_COOKIE_HEADER },
      }), ["media", first.data.assetId, "content"]);
      expect(oldAudio.status).toBe(200);
      expect((await oldAudio.arrayBuffer()).byteLength).toBeGreaterThan(0);
      const replay = await api("POST", "generation/voice", { userId, ageGate: true, body });
      expectOk(replay);
      expect(replay.data.assetId).toBe(second.data.assetId);
      expect(await dreamcoinBalance(userId)).toBe(6);
      expect(provider).toHaveBeenCalledTimes(2);
    } finally {
      provider.mockRestore();
    }
  });

  it.each([
    { name: "paid", coins: 4, minutes: 0, expectedBalance: 2 },
    { name: "last-paid-coins", coins: 2, minutes: 0, expectedBalance: 0 },
    { name: "included-minutes", coins: 0, minutes: 0.01, expectedBalance: 0 },
  ])("restores a deleted $name voice without charging the same message or counting its minutes twice", async ({ name, coins, minutes, expectedBalance }) => {
    const userId = `${P}restore-once-${name}`;
    const messageId = `${P}restore-message-${name}`;
    await createUser({ id: userId });
    await createCharacter({ id: `${userId}-character`, creatorId: userId, source: "user", visibility: "private" });
    await grantVoice(userId, minutes);
    if (coins > 0) await grantCoins(userId, coins, "seed");
    const body = await voiceReplyBody(userId, { characterId: `${userId}-character`, messageId, text: "short" });
    const first = await api("POST", "generation/voice", { userId, ageGate: true, body });
    expectOk(first, 201);
    const originalRequest = await prisma.voiceClipRequest.findUniqueOrThrow({
      where: { userId_messageId_replyAttempt: { userId, messageId, replyAttempt: 1 } },
    });
    const usageBefore = await prisma.voiceUsageFact.findMany({ where: { requestId: originalRequest.id } });
    const spendsBefore = await prisma.dreamcoinLedger.findMany({ where: { userId, reason: "generation_spend" } });
    expect(usageBefore).toHaveLength(1);
    expect(spendsBefore).toHaveLength(minutes > 0 ? 0 : 1);
    expect(await dreamcoinBalance(userId)).toBe(expectedBalance);
    expectOk(await api("DELETE", `media/${first.data.assetId}`, { userId, ageGate: true }));

    const restored = await api("POST", "generation/voice", { userId, ageGate: true, body });
    expectOk(restored, 201);
    expect(await dreamcoinBalance(userId)).toBe(expectedBalance);
    expect(await prisma.dreamcoinLedger.findMany({ where: { userId, reason: "generation_spend" } })).toEqual(spendsBefore);
    expect(await prisma.voiceUsageFact.findMany({ where: { requestId: originalRequest.id } })).toEqual(usageBefore);
    expect(await prisma.voiceClipRequest.count({ where: { userId, messageId } })).toBe(1);
    expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: originalRequest.id } })).toMatchObject({
      status: "succeeded", attemptNo: 2, providerRequestId: originalRequest.providerRequestId, mediaAssetId: restored.data.assetId,
    });
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: restored.data.assetId } })).toMatchObject({
      ownerId: userId, characterId: `${userId}-character`, type: "voice", deletedAt: null,
    });
    const content = await dispatchV1(new Request(`http://localhost/api/v1/media/${restored.data.assetId}/content`, {
      headers: { "x-idream-user-id": userId, cookie: AGE_GATE_COOKIE_HEADER },
    }), ["media", restored.data.assetId, "content"]);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toMatch(/^audio\//);
    expect((await content.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("accounts for one provider execution when a wallet race delays the first delivery", async () => {
    const userId = `${P}wallet-retry`;
    const characterId = `${userId}-character`;
    const messageId = `${P}wallet-retry-message`;
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
    await grantVoice(userId, 0);
    await grantCoins(userId, 2, "seed");
    const body = await voiceReplyBody(userId, { characterId, messageId, text: "short" });
    const original = providers.voice.clip.synthesize.bind(providers.voice.clip);
    const providerKeys: string[] = [];
    let started!: () => void;
    let release!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    const providerReleased = new Promise<void>((resolve) => { release = resolve; });
    const providerCall = vi.spyOn(providers.voice.clip, "synthesize").mockImplementation(async (input) => {
      providerKeys.push(input.idempotencyKey);
      started();
      await providerReleased;
      return original(input);
    });
    try {
      const first = api("POST", "generation/voice", { userId, ageGate: true, body });
      await providerStarted;
      await prisma.$transaction((tx) => postDreamcoinEntry(tx, {
        kind: "generation_spend", userId, amount: 2, sourceId: `${P}other-purchase`, idempotencyKey: `${P}other-purchase`,
      }));
      release();
      expect((await first).status).toBe(402);
      const before = await prisma.voiceUsageFact.findFirstOrThrow({ where: { userId } });
      expect(before).toMatchObject({ durationMs: 500, costDreamcoins: 0, mediaAssetId: null });
      await grantCoins(userId, 2, "retry-wallet");

      const retried = await api("POST", "generation/voice", { userId, ageGate: true, body });
      expectOk(retried, 201);
      expect(providerKeys).toHaveLength(2);
      expect(providerKeys[0]).toBe(providerKeys[1]);
      expect(await dreamcoinBalance(userId)).toBe(0);
      const usage = await prisma.voiceUsageFact.findMany({ where: { requestId: before.requestId }, orderBy: { attemptNo: "asc" } });
      expect(usage[0]).toEqual(before);
      expect(usage.reduce((sum, fact) => sum + fact.durationMs, 0)).toBe(500);
      expect(usage.reduce((sum, fact) => sum + fact.costDreamcoins, 0)).toBe(2);
      expect(usage.at(-1)).toMatchObject({ mediaAssetId: retried.data.assetId, attemptNo: 2 });
      expect(await prisma.dreamcoinLedger.count({ where: { userId, sourceId: retried.data.assetId, reason: "generation_spend" } })).toBe(1);
    } finally {
      release();
      providerCall.mockRestore();
    }
  });

});
