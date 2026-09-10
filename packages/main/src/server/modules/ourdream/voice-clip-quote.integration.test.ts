import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { api, createCharacter, createUser, dreamcoinBalance, expectError, expectOk, grantCoins, purgeTestData } from "@/server/test/helpers";
import { entitlementMap } from "./subscription-lifecycle";
import { readableCharacter } from "./generation-character-authority";
import { reclaimExpiredVoiceClip } from "./voice-clip";

const P = "zt-voice-quote-";
const userId = `${P}user`;
const characterId = `${P}character`;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: userId });
  await createCharacter({ id: characterId, creatorId: userId, visibility: "private", status: "approved" });
  await grantCoins(userId, 100, "seed");
  await prisma.entitlement.create({ data: { userId, key: "voice_enabled", value: true, source: "test" } });
});
afterAll(async () => { await purgeTestData(P); await prisma.$disconnect(); });

describe("Voice Clip accepted price", () => {
  it("rejects an unquoted paid Play before invoking the provider or reserving a request", async () => {
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      const result = await api("POST", "generation/voice", {
        userId, ageGate: true, autoGenerationQuote: false,
        body: { characterId, messageId: `${P}missing`, text: "Only after accepting the cost", intent: "play" },
      });
      expectError(result, 409);
      expect(synthesize).not.toHaveBeenCalled();
      expect(await prisma.voiceClipRequest.count({ where: { userId, messageId: `${P}missing` } })).toBe(0);
    } finally { synthesize.mockRestore(); }
  });

  it("binds a quote to the exact selected reply before any synthesis", async () => {
    const body = { characterId, messageId: `${P}bound`, text: "The selected reply", intent: "play" };
    const quoted = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
    expectOk(quoted);
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      const result = await api("POST", "generation/voice", {
        userId, ageGate: true, autoGenerationQuote: false,
        body: { ...body, text: "A different regenerated reply", quoteToken: quoted.data.quote.quoteToken },
      });
      expectError(result, 409);
      expect(synthesize).not.toHaveBeenCalled();
    } finally { synthesize.mockRestore(); }
  });

  it("settles at the accepted rate after pricing changes and preserves free replay after entitlement expiry", async () => {
    const body = { characterId, messageId: `${P}rate`, text: "An explicitly accepted price", intent: "play" };
    const quoted = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
    expectOk(quoted);
    const price = await prisma.pricingRule.findFirstOrThrow({ where: { mode: "voice", status: "active" } });
    const before = await dreamcoinBalance(userId);
    try {
      await prisma.pricingRule.update({ where: { id: price.id }, data: { baseCost: price.baseCost + 37 } });
      const played = await api("POST", "generation/voice", {
        userId, ageGate: true, autoGenerationQuote: false, body: { ...body, quoteToken: quoted.data.quote.quoteToken },
      });
      expectOk(played, 201);
      expect(before - await dreamcoinBalance(userId)).toBe(quoted.data.quote.maxCostDreamcoins);
      const request = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { userId_messageId: { userId, messageId: body.messageId } } });
      expect(request.billingAuthority).toMatchObject({ intent: "play", maxCostDreamcoins: quoted.data.quote.maxCostDreamcoins, allowanceMinutes: 0 });
      await expect(prisma.voiceClipRequest.update({ where: { id: request.id }, data: {
        billingAuthority: { ...request.billingAuthority as Record<string, unknown>, maxCostDreamcoins: 0 },
      } })).rejects.toThrow(/immutable/);
      await prisma.entitlement.update({ where: { userId_key: { userId, key: "voice_enabled" } }, data: { expiresAt: new Date(0) } });
      expectOk(await api("POST", "generation/voice", { userId, ageGate: true, autoGenerationQuote: false, body }), 200);
      expect(await prisma.voiceUsageFact.count({ where: { requestId: request.id } })).toBe(1);
    } finally {
      await prisma.pricingRule.update({ where: { id: price.id }, data: { baseCost: price.baseCost } });
      await prisma.entitlement.update({ where: { userId_key: { userId, key: "voice_enabled" } }, data: { expiresAt: null } });
    }
  });

  it("keeps accepted terms across failed Play retries without allowing automatic prewarm to spend", async () => {
    const body = { characterId, messageId: `${P}retry`, text: "One commercial commitment across attempts", intent: "play" };
    const quoted = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
    const price = await prisma.pricingRule.findFirstOrThrow({ where: { mode: "voice", status: "active" } });
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize").mockResolvedValueOnce({ ok: false, error: { code: "voice_rate_limited", message: "Retry safely", retryable: true } });
    const before = await dreamcoinBalance(userId);
    try {
      expectError(await api("POST", "generation/voice", { userId, ageGate: true, autoGenerationQuote: false, body: { ...body, quoteToken: quoted.data.quote.quoteToken } }), 500);
      const original = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { userId_messageId: { userId, messageId: body.messageId } } });
      await prisma.pricingRule.update({ where: { id: price.id }, data: { baseCost: price.baseCost + 41 } });
      const skipped = await api("POST", "generation/voice", { userId, ageGate: true, body: { ...body, intent: "prewarm" } });
      expectOk(skipped);
      expect(skipped.data).toMatchObject({ prewarmed: false, reason: "play_required" });
      expect(synthesize).toHaveBeenCalledTimes(1);
      expectOk(await api("POST", "generation/voice", { userId, ageGate: true, autoGenerationQuote: false, body }), 201);
      const restored = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } });
      expect(restored.billingAuthority).toEqual(original.billingAuthority);
      expect(restored.attemptNo).toBe(2);
      expect(before - await dreamcoinBalance(userId)).toBe(quoted.data.quote.maxCostDreamcoins);
    } finally {
      synthesize.mockRestore();
      await prisma.pricingRule.update({ where: { id: price.id }, data: { baseCost: price.baseCost } });
    }
  });

  it("operator reclaim uses the original accepted price even after its quote expires", async () => {
    const body = { characterId, messageId: `${P}reclaim`, text: "Recover the accepted original request", intent: "play" };
    const quoted = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
    const price = await prisma.pricingRule.findFirstOrThrow({ where: { mode: "voice", status: "active" } });
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize").mockRejectedValueOnce(new Error("Controlled durable provider transport interruption"));
    const before = await dreamcoinBalance(userId);
    try {
      expectError(await api("POST", "generation/voice", { userId, ageGate: true, autoGenerationQuote: false, body: { ...body, quoteToken: quoted.data.quote.quoteToken } }), 500);
      const original = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { userId_messageId: { userId, messageId: body.messageId } } });
      expect(original.status).toBe("running");
      await prisma.voiceClipRequest.update({ where: { id: original.id }, data: { leaseExpiresAt: new Date(0) } });
      await prisma.pricingRule.update({ where: { id: price.id }, data: { baseCost: price.baseCost + 43 } });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 6 * 60_000);
      const recovered = await reclaimExpiredVoiceClip({ characterId, requestId: original.id, deps: { entitlementMap, readableCharacter } });
      expect(recovered).toMatchObject({ status: "succeeded", attemptNo: 2 });
      expect((await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: original.id } })).billingAuthority).toEqual(original.billingAuthority);
      expect(before - await dreamcoinBalance(userId)).toBe(quoted.data.quote.maxCostDreamcoins);
    } finally {
      vi.useRealTimers();
      synthesize.mockRestore();
      await prisma.pricingRule.update({ where: { id: price.id }, data: { baseCost: price.baseCost } });
    }
  });
});
