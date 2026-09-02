import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { dispatchV1 } from "@/server/modules/ourdream/service";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { providers } from "@/server/providers";
import { AGE_GATE_COOKIE_HEADER, api, createCharacter, createUser, dreamcoinBalance, expectOk, grantCoins, purgeTestData } from "@/server/test/helpers";

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
    const body = { characterId: `${userId}-character`, messageId, text: "short" };
    const first = await api("POST", "generation/voice", { userId, ageGate: true, body });
    expectOk(first, 201);
    const originalRequest = await prisma.voiceClipRequest.findUniqueOrThrow({
      where: { userId_messageId: { userId, messageId } },
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
    const body = { characterId, messageId, text: "short" };
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
