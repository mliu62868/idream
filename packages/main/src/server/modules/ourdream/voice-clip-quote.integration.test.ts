import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import type { AuthCtx } from "@/server/lib/auth";
import { dispatchV1 } from "./service";
import { api, createCharacter, createUser, dreamcoinBalance, expectError, expectOk, grantCoins, purgeTestData, voiceReplyBody } from "@/server/test/helpers";
import { entitlementMap } from "./subscription-lifecycle";
import { readableCharacter } from "./generation-character-authority";
import { createVoiceClip, quoteVoiceClip, reclaimExpiredVoiceClip } from "./voice-clip";

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
  const deps = { entitlementMap, readableCharacter };
  const auth: AuthCtx = { userId, ageGateAccepted: true, ageVerificationStatus: "not_required" };

  it.each([
    { name: "anonymous", actor: { ...auth, userId: undefined }, status: 401 },
    { name: "age gate missing", actor: { ...auth, ageGateAccepted: false }, status: 403 },
    { name: "verification required", actor: { ...auth, ageVerificationStatus: "required" as const }, status: 403 },
  ].flatMap(testCase => [
    { ...testCase, operation: "quote" as const }, { ...testCase, operation: "play" as const },
  ]))("rejects $name through the common $operation entry before input or provider work", async ({ actor, status, operation }) => {
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize");
    const before = await prisma.voiceClipRequest.count({ where: { userId } });
    try {
      await expect(operation === "quote" ? quoteVoiceClip(actor, null, deps) : createVoiceClip(actor, null, deps))
        .rejects.toMatchObject({ status });
      expect(synthesize).not.toHaveBeenCalled();
      expect(await prisma.voiceClipRequest.count({ where: { userId } })).toBe(before);
    } finally { synthesize.mockRestore(); }
  });

  it.each(["anonymous", "age-gate", "verification"].flatMap(gate =>
    ["generation/voice/quote", "generation/voice"].map(path => ({ gate, path })),
  ))("keeps $gate rejection ahead of malformed HTTP JSON at $path", async ({ gate, path }) => {
    const actor = `${P}${gate}-${path.endsWith("quote") ? "quote" : "play"}`;
    if (gate !== "anonymous") await createUser({ id: actor });
    if (gate === "verification") {
      await prisma.ageGateAcceptance.create({ data: { userId: actor } });
      await prisma.ageVerification.create({ data: { userId: actor, provider: "mock", status: "required", metadata: {} } });
    }
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      const response = await dispatchV1(new Request(`http://localhost/api/v1/${path}`, {
        method: "POST", headers: { "content-type": "application/json", ...(gate !== "anonymous" ? { "x-idream-user-id": actor } : {}) }, body: "{",
      }), path.split("/"));
      expect(response.status).toBe(gate === "anonymous" ? 401 : 403);
      const failure = await response.json();
      if (gate !== "anonymous") expect(failure.error.details.reason).toBe(gate === "age-gate" ? "age_gate_required" : "age_verification_required");
      expect(synthesize).not.toHaveBeenCalled();
      expect(await prisma.voiceClipRequest.count({ where: { userId: actor } })).toBe(0);
    } finally { synthesize.mockRestore(); }
  });

  it("reads the authoritative reply at the common entry and shares its delivery with HTTP playback", async () => {
    const body = await voiceReplyBody(userId, { characterId, messageId: `${P}domain`, text: "Only the saved reply may be spoken.", intent: "play" });
    const quote = await quoteVoiceClip(auth, body, deps);
    const balance = await dreamcoinBalance(userId);
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      const result = await createVoiceClip(auth, { ...body, text: "Caller supplied text must never be spoken.", quoteToken: quote.quoteToken }, deps);
      expect(result.kind).toBe("created");
      expect(result.value).toMatchObject({ assetId: expect.any(String), messageId: body.messageId, durationMs: expect.any(Number) });
      expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: body.text }));
      const replay = await api("POST", "generation/voice", { userId, ageGate: true, autoGenerationQuote: false, body });
      expectOk(replay, 200);
      expect(replay.data).toEqual(result.value);
      expect(synthesize).toHaveBeenCalledTimes(1);
      expect(balance - await dreamcoinBalance(userId)).toBe(quote.maxCostDreamcoins);
      expect(await prisma.voiceClipRequest.count({ where: { userId, messageId: body.messageId } })).toBe(1);
      expect(await prisma.voiceUsageFact.count({ where: { userId, request: { messageId: body.messageId } } })).toBe(1);
    } finally { synthesize.mockRestore(); }
  });

  it("does not accept client-supplied Call execution or billing authority instead of a quote", async () => {
    const body = await voiceReplyBody(userId, { characterId, messageId: `${P}forged-call`, text: "A normal Play still needs its quote.", intent: "play" });
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      const result = await api("POST", "generation/voice", { userId, ageGate: true, autoGenerationQuote: false, body: {
        ...body, callUtteranceId: "forged", providerPayload: { providerKey: "mock" }, billingAuthority: { maxCostDreamcoins: 0 },
      } });
      expectError(result, 409);
      expect(result.error?.details.reason).toBe("voice_quote_required");
      expect(synthesize).not.toHaveBeenCalled();
      expect(await prisma.voiceClipRequest.count({ where: { userId, messageId: body.messageId } })).toBe(0);
    } finally { synthesize.mockRestore(); }
  });

  it("does not let a different authenticated actor quote or speak the selected owner's reply", async () => {
    const otherUserId = `${P}foreign-actor`;
    await createUser({ id: otherUserId });
    const body = await voiceReplyBody(userId, { characterId, messageId: `${P}owner-reply`, text: "Private reply.", intent: "play" });
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      for (const operation of [quoteVoiceClip, createVoiceClip]) {
        await expect(operation({ ...auth, userId: otherUserId }, body, deps)).rejects.toMatchObject({ status: 404 });
      }
      expect(synthesize).not.toHaveBeenCalled();
      expect(await prisma.voiceClipRequest.count({ where: { messageId: body.messageId } })).toBe(0);
    } finally { synthesize.mockRestore(); }
  });

  it("rejects an unquoted paid Play before invoking the provider or reserving a request", async () => {
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      const result = await api("POST", "generation/voice", {
        userId, ageGate: true, autoGenerationQuote: false,
        body: await voiceReplyBody(userId, { characterId, messageId: `${P}missing`, text: "Only after accepting the cost", intent: "play" }),
      });
      expectError(result, 409);
      expect(synthesize).not.toHaveBeenCalled();
      expect(await prisma.voiceClipRequest.count({ where: { userId, messageId: `${P}missing` } })).toBe(0);
    } finally { synthesize.mockRestore(); }
  });

  it("refuses to voice text that is not a sent reply in one of the caller's sessions", async () => {
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      const noSession = { characterId, messageId: `${P}free-text`, text: "Say anything I type", intent: "play" };
      expectError(await api("POST", "generation/voice/quote", { userId, ageGate: true, body: noSession }), 400);
      expectError(await api("POST", "generation/voice", { userId, ageGate: true, autoGenerationQuote: false, body: noSession }), 400);
      const unknownMessage = { ...noSession, sessionId: `${P}no-such-session` };
      expectError(await api("POST", "generation/voice/quote", { userId, ageGate: true, body: unknownMessage }), 404);
      expect(synthesize).not.toHaveBeenCalled();
      expect(await prisma.voiceClipRequest.count({ where: { userId, messageId: `${P}free-text` } })).toBe(0);
    } finally { synthesize.mockRestore(); }
  });

  it("binds a quote to the exact selected reply before any synthesis", async () => {
    const body = await voiceReplyBody(userId, { characterId, messageId: `${P}bound`, text: "The selected reply", intent: "play" });
    const quoted = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
    expectOk(quoted);
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      const result = await api("POST", "generation/voice", {
        userId, ageGate: true, autoGenerationQuote: false,
        body: { ...await voiceReplyBody(userId, { ...body, text: "A different regenerated reply" }), quoteToken: quoted.data.quote.quoteToken },
      });
      expectError(result, 409);
      expect(synthesize).not.toHaveBeenCalled();
    } finally { synthesize.mockRestore(); }
  });

  it("settles at the accepted rate after pricing changes and preserves free replay after entitlement expiry", async () => {
    const body = await voiceReplyBody(userId, { characterId, messageId: `${P}rate`, text: "An explicitly accepted price", intent: "play" });
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
      const request = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { userId_messageId_replyAttempt: { userId, messageId: body.messageId, replyAttempt: 1 } } });
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
    const body = await voiceReplyBody(userId, { characterId, messageId: `${P}retry`, text: "One commercial commitment across attempts", intent: "play" });
    const quoted = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
    const price = await prisma.pricingRule.findFirstOrThrow({ where: { mode: "voice", status: "active" } });
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize").mockResolvedValueOnce({ ok: false, error: { code: "voice_rate_limited", message: "Retry safely", retryable: true } });
    const before = await dreamcoinBalance(userId);
    try {
      expectError(await api("POST", "generation/voice", { userId, ageGate: true, autoGenerationQuote: false, body: { ...body, quoteToken: quoted.data.quote.quoteToken } }), 500);
      const original = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { userId_messageId_replyAttempt: { userId, messageId: body.messageId, replyAttempt: 1 } } });
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
    const body = await voiceReplyBody(userId, { characterId, messageId: `${P}reclaim`, text: "Recover the accepted original request", intent: "play" });
    const quoted = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
    const price = await prisma.pricingRule.findFirstOrThrow({ where: { mode: "voice", status: "active" } });
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize").mockRejectedValueOnce(new Error("Controlled durable provider transport interruption"));
    const before = await dreamcoinBalance(userId);
    try {
      expectError(await api("POST", "generation/voice", { userId, ageGate: true, autoGenerationQuote: false, body: { ...body, quoteToken: quoted.data.quote.quoteToken } }), 500);
      const original = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { userId_messageId_replyAttempt: { userId, messageId: body.messageId, replyAttempt: 1 } } });
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
