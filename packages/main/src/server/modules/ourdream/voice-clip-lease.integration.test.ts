import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { dispatchV1 } from "@/server/modules/ourdream/service";
import { providers } from "@/server/providers";
import type { VoiceClipPort } from "@/server/providers/types";
import { AGE_GATE_COOKIE_HEADER, api, createCharacter, createUser, dreamcoinBalance, expectOk, grantCoins, purgeTestData, voiceReplyBody } from "@/server/test/helpers";
import { recoverExpiredVoiceClips } from "./voice-clip-recovery";

const P = "zt-voice-lease-";
const LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
let createdVoiceFlag = false;

beforeAll(async () => {
  await purgeTestData(P);
  if (!(await prisma.featureFlag.findUnique({ where: { key: "voice_gen" } }))) {
    await prisma.featureFlag.create({ data: { key: "voice_gen", label: "Voice lease test", enabled: true, rolloutPercent: 100, targetRoles: [], targetPlans: [] } });
    createdVoiceFlag = true;
  }
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(async () => {
  await purgeTestData(P);
  if (createdVoiceFlag) await prisma.featureFlag.delete({ where: { key: "voice_gen" } });
  await prisma.$disconnect();
});

async function fixture(name: string) {
  const userId = `${P}${name}`, characterId = `${userId}-character`;
  await createUser({ id: userId });
  await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
  await prisma.entitlement.create({ data: { userId, key: "voice_enabled", value: true, source: "subscription" } });
  await grantCoins(userId, 4, "seed");
  return { userId, characterId };
}

// A provider that holds the render open until released or until the signal aborts,
// which is what closing the gateway connection does to a real adapter.
function heldProvider() {
  const original = providers.voice.clip.synthesize.bind(providers.voice.clip);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const signals: AbortSignal[] = [];
  const provider = vi.spyOn(providers.voice.clip, "synthesize").mockImplementationOnce(async (input: Parameters<VoiceClipPort["synthesize"]>[0]) => {
    if (input.signal) signals.push(input.signal);
    entered();
    await Promise.race([released, new Promise<void>(resolve => input.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
    if (input.signal?.aborted) return { ok: false as const, error: { code: "voice_cancelled", message: "Closed", retryable: true } };
    return original(input);
  });
  return { provider, started, release, signals };
}

async function eventually(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

describe("voice clip lease", () => {
  it("claims a lease far shorter than the provider timeout and renews it for as long as the owner lives", async () => {
    const { userId, characterId } = await fixture("heartbeat");
    const body = await voiceReplyBody(userId, { characterId, messageId: `${P}heartbeat-message`, text: "A reply." });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const held = heldProvider();
    const pending = api("POST", "generation/voice", { userId, ageGate: true, body });
    try {
      await held.started;
      const claimed = await prisma.voiceClipRequest.findFirstOrThrow({ where: { userId } });
      const remaining = claimed.leaseExpiresAt!.getTime() - Date.now();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(LEASE_MS);

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await eventually(async () => {
        const row = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: claimed.id } });
        return row.leaseExpiresAt!.getTime() > claimed.leaseExpiresAt!.getTime();
      }, "the heartbeat did not renew a live owner's lease");

      held.release();
      expectOk(await pending, 201);
    } finally { held.release(); await pending; }
  });

  it("does not let a dead owner hold the user's next Play for the whole provider timeout", async () => {
    const { userId, characterId } = await fixture("dead-owner");
    const first = await voiceReplyBody(userId, { characterId, messageId: `${P}dead-first`, text: "First reply." });
    const second = await voiceReplyBody(userId, { characterId, messageId: `${P}dead-second`, text: "Second reply." });
    await prisma.voiceClipRequest.create({ data: {
      id: `${P}dead-owner-request`, userId, characterId, messageId: first.messageId, requestFingerprint: "dead-owner",
      providerPayload: { providerKey: "mock" }, status: "running", leaseOwner: "crashed-process", leaseExpiresAt: new Date(Date.now() + 750),
    } });
    const startedAt = Date.now();
    expectOk(await api("POST", "generation/voice", { userId, ageGate: true, body: second }), 201);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  });

  it("stops work and charges nothing when the caller hangs up during synthesis, and a retry still delivers", async () => {
    const { userId, characterId } = await fixture("hangup");
    const body = await voiceReplyBody(userId, { characterId, messageId: `${P}hangup-message`, text: "A reply." });
    const quote = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
    expectOk(quote);
    const held = heldProvider();
    const connection = new AbortController();
    const pending = dispatchV1(new Request("http://localhost/api/v1/generation/voice", {
      method: "POST", signal: connection.signal,
      headers: { "content-type": "application/json", "x-idream-user-id": userId, cookie: AGE_GATE_COOKIE_HEADER },
      body: JSON.stringify({ ...body, quoteToken: quote.data.quote.quoteToken }),
    }), ["generation", "voice"]);
    await held.started;
    connection.abort();
    const stopped = await pending;
    expect(stopped.status).toBe(410);
    expect(held.signals[0]?.aborted).toBe(true);
    const request = await prisma.voiceClipRequest.findFirstOrThrow({ where: { userId } });
    expect(request).toMatchObject({ status: "failed", errorCode: "voice_client_disconnected", leaseOwner: null, mediaAssetId: null });
    expect(await prisma.voiceUsageFact.count({ where: { requestId: request.id } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(4);

    const retried = await api("POST", "generation/voice", { userId, ageGate: true, body });
    expectOk(retried, 201);
    expect(await dreamcoinBalance(userId)).toBe(2);
  });

  it("never reaches the provider for a caller that already hung up", async () => {
    const { userId, characterId } = await fixture("gone");
    const body = await voiceReplyBody(userId, { characterId, messageId: `${P}gone-message`, text: "A reply." });
    const quote = await api("POST", "generation/voice/quote", { userId, ageGate: true, body });
    expectOk(quote);
    const provider = vi.spyOn(providers.voice.clip, "synthesize");
    const connection = new AbortController();
    connection.abort();
    const stopped = await dispatchV1(new Request("http://localhost/api/v1/generation/voice", {
      method: "POST", signal: connection.signal,
      headers: { "content-type": "application/json", "x-idream-user-id": userId, cookie: AGE_GATE_COOKIE_HEADER },
      body: JSON.stringify({ ...body, quoteToken: quote.data.quote.quoteToken }),
    }), ["generation", "voice"]);
    expect(stopped.status).toBe(410);
    expect(provider).not.toHaveBeenCalled();
    expect(await dreamcoinBalance(userId)).toBe(4);
  });

  it("resolves a cancelled turn whose owner died instead of leaving it running", async () => {
    const { userId, characterId } = await fixture("cancelled-dead");
    await prisma.voiceClipRequest.create({ data: {
      id: `${P}cancelled-dead-request`, userId, characterId, messageId: `${P}cancelled-dead-message`, requestFingerprint: "cancelled-dead",
      providerPayload: { providerKey: "mock" }, status: "running", leaseOwner: "crashed-process", leaseExpiresAt: new Date(0), cancelRequestedAt: new Date(),
    } });
    const reclaim = vi.spyOn(providers.voice.clip, "synthesize");
    let cursorId: string | null = null, visited = 0;
    // Other fixtures may sort first; walk to this row the way the finalizer does.
    while (visited++ < 50) {
      const swept: { examined: number; nextCursorId: string | null } = await recoverExpiredVoiceClips({ cursorId, deps: {
        entitlementMap: async () => ({ voice_enabled: true }), readableCharacter: async () => { throw new Error("Not recovered"); },
      } });
      if (!swept.nextCursorId || swept.nextCursorId === `${P}cancelled-dead-request`) break;
      cursorId = swept.nextCursorId;
    }
    expect(reclaim).not.toHaveBeenCalled();
    expect(await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: `${P}cancelled-dead-request` } })).toMatchObject({
      status: "failed", errorCode: "voice_call_delivery_revoked", leaseOwner: null, leaseExpiresAt: null,
    });
  });
});
