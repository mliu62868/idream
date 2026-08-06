import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { dispatchV1 } from "@/server/modules/ourdream/service";
import { providers } from "@/server/providers";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { reclaimExpiredVoiceClip } from "./voice-clip";
import {
  AGE_GATE_COOKIE_HEADER,
  api,
  createCharacter,
  createPlan,
  createUser,
  dreamcoinBalance,
  expectError,
  expectOk,
  grantCoins,
  publishCharacterForPublicAudience,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-voicesvc-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;

async function grantVoice(userId: string, minutes = 0) {
  await prisma.entitlement.create({
    data: { userId, key: "voice_enabled", value: true, source: "subscription" },
  });
  if (minutes > 0) {
    await prisma.entitlement.create({
      data: { userId, key: "voice_minutes", value: minutes, source: "subscription" },
    });
  }
}

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: SYS });
  await createCharacter({ id: CHAR, creatorId: SYS, visibility: "public", status: "approved" });
  await publishCharacterForPublicAudience({
    characterId: CHAR,
    ownerId: SYS,
  });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("voice generation service contract", () => {
  it("single-flights concurrent requests for the same message", async () => {
    const userId = `${P}single-flight-user`;
    const messageId = `${P}single-flight-message`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId);

    const synthesize = providers.voice.clip.synthesize.bind(providers.voice.clip);
    const providerCall = vi
      .spyOn(providers.voice.clip, "synthesize")
      .mockImplementation(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return synthesize(input);
      });
    try {
      const requests = await Promise.all([
        api("POST", "generation/voice", {
          userId,
          ageGate: true,
          body: { characterId: CHAR, messageId, text: "One durable voice clip" },
        }),
        api("POST", "generation/voice", {
          userId,
          ageGate: true,
          body: { characterId: CHAR, messageId, text: "One durable voice clip" },
        }),
      ]);

      expect(requests.map((response) => response.status).sort()).toEqual([200, 201]);
      expect(requests[0]?.data.assetId).toBe(requests[1]?.data.assetId);
      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(
        await prisma.mediaAsset.count({
          where: { ownerId: userId, type: "voice", deletedAt: null },
        }),
      ).toBe(1);
      expect(
        await prisma.voiceClipRequest.findUnique({
          where: { userId_messageId: { userId, messageId } },
        }),
      ).toMatchObject({ status: "succeeded", attemptNo: 1 });
      expect(
        await prisma.voiceUsageFact.count({ where: { userId } }),
      ).toBe(1);
      expect(await dreamcoinBalance(userId)).toBe(98);
    } finally {
      providerCall.mockRestore();
    }
  });

  it("serializes different messages so an exhausted balance is rejected before provider execution", async () => {
    const userId = `${P}budget-race-user`;
    const messageIds = [`${P}budget-race-1`, `${P}budget-race-2`];
    await createUser({ id: userId });
    await grantCoins(userId, 2, "seed");
    await grantVoice(userId);

    const synthesize = providers.voice.clip.synthesize.bind(providers.voice.clip);
    const providerCall = vi
      .spyOn(providers.voice.clip, "synthesize")
      .mockImplementation(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return synthesize(input);
      });
    try {
      const responses = await Promise.all(
        messageIds.map((messageId) =>
          api("POST", "generation/voice", {
            userId,
            ageGate: true,
            body: { characterId: CHAR, messageId, text: "One paid clip" },
          }),
        ),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([201, 402]);
      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(await prisma.voiceUsageFact.count({ where: { userId } })).toBe(1);
      expect(
        await prisma.mediaAsset.count({
          where: { ownerId: userId, type: "voice", deletedAt: null },
        }),
      ).toBe(1);
      expect(await dreamcoinBalance(userId)).toBe(0);
    } finally {
      providerCall.mockRestore();
    }
  });

  it("records provider usage when another wallet writer consumes the balance in flight", async () => {
    const userId = `${P}cross-domain-wallet-race-user`;
    const messageId = `${P}cross-domain-wallet-race-message`;
    await createUser({ id: userId });
    await grantCoins(userId, 2, "seed");
    await grantVoice(userId);

    const synthesize = providers.voice.clip.synthesize.bind(providers.voice.clip);
    let providerStarted: (() => void) | undefined;
    let releaseProvider: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const providerCall = vi
      .spyOn(providers.voice.clip, "synthesize")
      .mockImplementation(async (input) => {
        providerStarted?.();
        await released;
        return synthesize(input);
      });
    try {
      const responsePromise = api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body: { characterId: CHAR, messageId, text: "One raced clip" },
      });
      await started;
      await prisma.$transaction((tx) =>
        postDreamcoinEntry(tx, {
          kind: "generation_spend",
          userId,
          amount: 2,
          sourceId: `${P}cross-domain-wallet-race-source`,
          idempotencyKey: `${P}cross-domain-wallet-race-spend`,
        }),
      );
      releaseProvider?.();
      const response = await responsePromise;

      expect(response.status).toBe(402);
      expect(providerCall).toHaveBeenCalledTimes(1);
      await expect(
        prisma.voiceUsageFact.findFirstOrThrow({ where: { userId } }),
      ).resolves.toMatchObject({
        mediaAssetId: null,
        costDreamcoins: 0,
        durationMs: expect.any(Number),
      });
      await expect(
        prisma.voiceClipRequest.findUniqueOrThrow({
          where: { userId_messageId: { userId, messageId } },
        }),
      ).resolves.toMatchObject({
        status: "failed",
        errorCode: "insufficient_dreamcoins_after_synthesis",
      });
      expect(
        await prisma.mediaAsset.count({
          where: { ownerId: userId, type: "voice", deletedAt: null },
        }),
      ).toBe(0);
    } finally {
      releaseProvider?.();
      providerCall.mockRestore();
    }
  });

  it("keeps one provider idempotency key when a failed request is retried", async () => {
    const userId = `${P}provider-retry-user`;
    const messageId = `${P}provider-retry-message`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId);

    const synthesize = providers.voice.clip.synthesize.bind(providers.voice.clip);
    const providerCalls: Array<{
      attemptNo: number;
      idempotencyKey: string;
      voiceId: string | undefined;
    }> = [];
    const providerCall = vi
      .spyOn(providers.voice.clip, "synthesize")
      .mockImplementation(async (input) => {
        providerCalls.push({
          attemptNo: input.attemptNo,
          idempotencyKey: input.idempotencyKey,
          voiceId: input.voiceId,
        });
        if (providerCalls.length === 1) {
          return {
            ok: false,
            error: {
              code: "transient_voice_failure",
              message: "retry me",
              retryable: true,
            },
          };
        }
        return synthesize(input);
      });
    try {
      const body = {
        characterId: CHAR,
        messageId,
        text: "One logical clip across retries",
      };
      const failed = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body,
      });
      await prisma.character.update({
        where: { id: CHAR },
        data: { voiceId: "voice-authority-changed-after-reservation" },
      });
      const succeeded = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body,
      });

      expect(failed.status).toBe(500);
      expectOk(succeeded, 201);
      expect(providerCalls.map((call) => call.attemptNo)).toEqual([1, 2]);
      expect(new Set(providerCalls.map((call) => call.idempotencyKey)).size).toBe(1);
      expect(new Set(providerCalls.map((call) => call.voiceId)).size).toBe(1);
    } finally {
      await prisma.character.update({
        where: { id: CHAR },
        data: { voiceId: null },
      });
      providerCall.mockRestore();
    }
  });

  it("pins the takeover payload per attempt from prewarm to play and reclaims with the original provider identity", async () => {
    const userId = `${P}prewarm-play-reclaim-user`;
    const messageId = `${P}prewarm-play-reclaim-message`;
    await createUser({ id: userId });
    await grantVoice(userId, 10);

    const synthesize = providers.voice.clip.synthesize.bind(providers.voice.clip);
    const calls: Array<{
      attemptNo: number;
      idempotencyKey: string;
      providerKey: string;
    }> = [];
    const providerCall = vi
      .spyOn(providers.voice.clip, "synthesize")
      .mockImplementation(async (input) => {
        calls.push({
          attemptNo: input.attemptNo,
          idempotencyKey: input.idempotencyKey,
          providerKey: providers.voice.clip.providerKey,
        });
        if (calls.length <= 2) throw new Error("simulated worker crash");
        return synthesize(input);
      });
    const deps = {
      entitlementMap: async () => ({
        voice_enabled: true,
        voice_minutes: 10,
      }),
      readableCharacter: async () => ({
        id: CHAR,
        age: 28,
        name: "Voice Reclaim Character",
        style: "warm",
        relationship: "companion",
        voiceId: null,
        gender: "female",
      }),
    };
    try {
      const prewarm = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body: {
          characterId: CHAR,
          messageId,
          text: "Persist the exact takeover payload",
          intent: "prewarm",
        },
      });
      expect(prewarm.status).toBe(500);
      const initial = await prisma.voiceClipRequest.findUniqueOrThrow({
        where: { userId_messageId: { userId, messageId } },
      });
      expect(initial).toMatchObject({
        status: "running",
        attemptNo: 1,
        synthesisPayload: { version: 1, intent: "prewarm" },
      });
      await prisma.voiceClipRequest.update({
        where: { id: initial.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });

      const play = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body: {
          characterId: CHAR,
          messageId,
          text: "Persist the exact takeover payload",
          intent: "play",
        },
      });
      expect(play.status).toBe(500);
      const playAttempt = await prisma.voiceClipRequest.findUniqueOrThrow({
        where: { id: initial.id },
      });
      expect(playAttempt).toMatchObject({
        status: "running",
        attemptNo: 2,
        synthesisPayload: { version: 1, intent: "play" },
      });
      await prisma.voiceClipRequest.update({
        where: { id: initial.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });

      const reclaimed = await reclaimExpiredVoiceClip({
        characterId: CHAR,
        requestId: initial.id,
        deps,
      });
      expect(reclaimed).toMatchObject({
        requestId: initial.id,
        status: "succeeded",
        attemptNo: 3,
        provider: calls[0]?.providerKey,
      });
      expect(calls.map((call) => call.attemptNo)).toEqual([1, 2, 3]);
      expect(new Set(calls.map((call) => call.idempotencyKey))).toEqual(
        new Set([`voice:${initial.id}:provider`]),
      );
      expect(new Set(calls.map((call) => call.providerKey)).size).toBe(1);
      const asset = await prisma.mediaAsset.findUniqueOrThrow({
        where: { id: reclaimed.mediaAssetId! },
      });
      expect(asset.metadata).toMatchObject({ generationIntent: "requested" });
      await expect(
        prisma.voiceUsageFact.findUniqueOrThrow({
          where: {
            requestId_attemptNo: { requestId: initial.id, attemptNo: 3 },
          },
        }),
      ).resolves.toMatchObject({ intent: "play" });
    } finally {
      providerCall.mockRestore();
    }
  });

  it("quarantines a non-replayable accepted timeout and never sends an expired ordinary retry twice", async () => {
    const userId = `${P}non-replayable-timeout-user`;
    const messageId = `${P}non-replayable-timeout-message`;
    await createUser({ id: userId });
    await grantVoice(userId, 10);
    const configuredVoice = providers.voice;
    const synthesize = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: "voice_timeout",
        message: "connection closed after provider acceptance",
        retryable: true,
      },
    }));
    providers.voice = {
      clip: {
        providerKey: "pipeline",
        providerReplay: "non_replayable",
        synthesize,
      },
      identity: null,
    };
    const body = {
      characterId: CHAR,
      messageId,
      text: "Do not duplicate this accepted provider call",
      intent: "play" as const,
    };
    try {
      const timedOut = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body,
      });
      expect(timedOut.status).toBe(500);
      const request = await prisma.voiceClipRequest.findUniqueOrThrow({
        where: { userId_messageId: { userId, messageId } },
      });
      expect(request).toMatchObject({
        status: "failed",
        attemptNo: 1,
        errorCode: "provider_outcome_unknown",
        provider: "pipeline",
        providerRequestId: `voice:${request.id}:attempt:1:provider`,
      });

      // Simulate a process that persisted provider invocation acceptance but
      // crashed before it could persist the terminal unknown state.
      await prisma.voiceClipRequest.update({
        where: { id: request.id },
        data: {
          status: "running",
          errorCode: null,
          error: Prisma.DbNull,
          completedAt: null,
          leaseOwner: "crashed-non-replayable-worker",
          leaseExpiresAt: new Date(Date.now() - 1_000),
        },
      });
      const expiredRetry = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body,
      });
      expect(expiredRetry.status).toBe(409);
      expect(synthesize).toHaveBeenCalledTimes(1);
      await expect(
        prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).resolves.toMatchObject({
        status: "failed",
        attemptNo: 2,
        errorCode: "provider_outcome_unknown",
      });
      const terminalReplay = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body,
      });
      expect(terminalReplay.status).toBe(409);
      expect(synthesize).toHaveBeenCalledTimes(1);
    } finally {
      providers.voice = configuredVoice;
    }
  });

  it("keeps the canonical provider reservation when a succeeded clip is regenerated", async () => {
    const userId = `${P}durable-success-replay-user`;
    const messageId = `${P}durable-success-replay-message`;
    await createUser({ id: userId });
    await grantVoice(userId, 10);
    const original = providers.voice.clip.synthesize.bind(providers.voice.clip);
    const keys: string[] = [];
    const providerCall = vi
      .spyOn(providers.voice.clip, "synthesize")
      .mockImplementation(async (input) => {
        keys.push(input.idempotencyKey);
        return original(input);
      });
    try {
      const body = {
        characterId: CHAR,
        messageId,
        text: "Replay one durable provider reservation",
      };
      const first = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body,
      });
      expectOk(first, 201);
      const request = await prisma.voiceClipRequest.findUniqueOrThrow({
        where: { userId_messageId: { userId, messageId } },
      });
      const canonicalProviderKey = `voice:${request.id}:provider`;
      expect(request.providerRequestId).toBe(canonicalProviderKey);
      await prisma.mediaAsset.update({
        where: { id: first.data.assetId },
        data: { deletedAt: new Date() },
      });

      const regenerated = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body,
      });
      expectOk(regenerated, 201);
      expect(keys).toEqual([canonicalProviderKey, canonicalProviderKey]);
      await expect(
        prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).resolves.toMatchObject({
        status: "succeeded",
        attemptNo: 2,
        providerRequestId: canonicalProviderKey,
      });
    } finally {
      providerCall.mockRestore();
    }
  });

  it("releases a definitive non-replayable rejection for a new attempt identity", async () => {
    const userId = `${P}non-replayable-definitive-user`;
    const messageId = `${P}non-replayable-definitive-message`;
    await createUser({ id: userId });
    await grantVoice(userId, 10);
    const configuredVoice = providers.voice;
    const keys: string[] = [];
    const synthesize = vi.fn(async (input: { idempotencyKey: string }) => {
      keys.push(input.idempotencyKey);
      if (keys.length === 1) {
        return {
          ok: false as const,
          error: {
            code: "voice_request_failed",
            message: "Pipeline voice request failed with HTTP 400",
            retryable: false,
          },
        };
      }
      return {
        ok: true as const,
        data: { key: `${P}definitive-retry.wav`, durationMs: 1_000 },
      };
    });
    providers.voice = {
      clip: {
        providerKey: "pipeline",
        providerReplay: "non_replayable",
        synthesize,
      },
      identity: null,
    };
    const body = {
      characterId: CHAR,
      messageId,
      text: "Retry only after a definitive rejection",
    };
    try {
      const rejected = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body,
      });
      expect(rejected.status).toBe(500);
      const first = await prisma.voiceClipRequest.findUniqueOrThrow({
        where: { userId_messageId: { userId, messageId } },
      });
      expect(first).toMatchObject({
        status: "failed",
        attemptNo: 1,
        errorCode: "voice_request_failed",
        providerRequestId: null,
      });

      const retried = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body,
      });
      expectOk(retried, 201);
      expect(keys).toEqual([
        `voice:${first.id}:attempt:1:provider`,
        `voice:${first.id}:attempt:2:provider`,
      ]);
      await expect(
        prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: first.id } }),
      ).resolves.toMatchObject({
        status: "succeeded",
        attemptNo: 2,
        providerRequestId: `voice:${first.id}:attempt:2:provider`,
      });
    } finally {
      providers.voice = configuredVoice;
    }
  });

  it("resumes an unfinished request with its pinned provider after configuration switches", async () => {
    const userId = `${P}pinned-provider-switch-user`;
    const messageId = `${P}pinned-provider-switch-message`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId);

    const configuredVoice = providers.voice;
    const firstProviderCall = vi
      .spyOn(configuredVoice.clip, "synthesize")
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "transient_voice_failure",
          message: "retry on the pinned adapter",
          retryable: true,
        },
      });
    const switchedProviderCall = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: "wrong_provider",
        message: "the newly configured provider must not execute the old request",
        retryable: false,
      },
    }));
    try {
      const body = {
        characterId: CHAR,
        messageId,
        text: "Keep the original provider authority across a cutover",
      };
      const failed = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body,
      });
      expect(failed.status).toBe(500);
      firstProviderCall.mockRestore();

      providers.voice = {
        clip: {
          providerKey: "pipeline",
          providerReplay: "non_replayable",
          synthesize: switchedProviderCall,
        },
        identity: null,
      };
      const resumed = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body,
      });

      expectOk(resumed, 201);
      expect(switchedProviderCall).not.toHaveBeenCalled();
      expect(
        await prisma.voiceClipRequest.findUniqueOrThrow({
          where: { userId_messageId: { userId, messageId } },
        }),
      ).toMatchObject({
        status: "succeeded",
        attemptNo: 2,
        provider: "mock",
        providerPayload: { providerKey: "mock" },
      });
    } finally {
      firstProviderCall.mockRestore();
      providers.voice = configuredVoice;
    }
  });

  it("synthesizes on demand, charges once, and caches replays by message", async () => {
    const userId = `${P}play-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId);

    const first = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-1`, sessionId: `${P}sess`, text: "Hello there" },
    });
    expectOk(first, 201);
    expect(typeof first.data.assetId).toBe("string");
    expect(first.data.contentUrl).toBe(`/api/v1/media/${first.data.assetId}/content`);
    expect(first.data.durationMs).toBeGreaterThan(0);
    expect(await dreamcoinBalance(userId)).toBe(98);

    // The clip is a real, fetchable artifact (mock persists a playable WAV) — not a
    // dangling key. This is the path that 404'd before the provider stored bytes.
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: first.data.assetId } });
    expect(asset.storageKey).toBeTruthy();
    expect(asset.metadata).toMatchObject({
      voiceId: "fish-female-default",
      voiceAuthority: "system_default",
      systemVoiceSettingVersion: 0,
    });
    const bytes = await readFile(resolveLocalBlobPath(asset.storageKey as string));
    expect(bytes.byteLength).toBeGreaterThan(44);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");

    const rangeResponse = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${first.data.assetId}/content`, {
        headers: {
          "x-idream-user-id": userId,
          cookie: AGE_GATE_COOKIE_HEADER,
          range: "bytes=0-3",
        },
      }),
      ["media", first.data.assetId as string, "content"],
    );
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("accept-ranges")).toBe("bytes");
    expect(rangeResponse.headers.get("content-length")).toBe("4");
    expect(rangeResponse.headers.get("content-range")).toBe(`bytes 0-3/${bytes.byteLength}`);
    expect(rangeResponse.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await rangeResponse.arrayBuffer()).toString("ascii")).toBe("RIFF");

    // Replay of the same message reuses the cached clip — no second charge.
    const second = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-1`, sessionId: `${P}sess`, text: "Hello there" },
    });
    expectOk(second, 200);
    expect(second.data.assetId).toBe(first.data.assetId);
    expect(await dreamcoinBalance(userId)).toBe(98);
    expect(await prisma.mediaAsset.count({ where: { ownerId: userId, type: "voice" } })).toBe(1);
  });

  it("regenerates stale cached voice clips without charging again", async () => {
    const userId = `${P}stale-cache-user`;
    const messageId = `${P}msg-stale-cache`;
    const staleId = `${P}stale-voice`;
    await createUser({ id: userId });
    await grantVoice(userId);
    await prisma.mediaAsset.create({
      data: {
        id: staleId,
        ownerId: userId,
        characterId: CHAR,
        type: "voice",
        url: `/api/v1/media/${staleId}/content`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: { messageId, durationMs: 1_234, costDreamcoins: 2 },
      },
    });

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId, text: "Replace the bad cached clip" },
    });

    expectOk(res, 201);
    expect(res.data.assetId).not.toBe(staleId);
    expect(await dreamcoinBalance(userId)).toBe(0);
    const stale = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: staleId } });
    expect(stale.deletedAt).toBeInstanceOf(Date);
    const replacement = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.data.assetId } });
    expect((replacement.metadata as { cacheVersion?: number }).cacheVersion).toBe(8);
    expect((replacement.metadata as { costDreamcoins?: number }).costDreamcoins).toBe(0);
    expect((replacement.metadata as { replacedAssetIds?: string[] }).replacedAssetIds).toEqual([
      staleId,
    ]);
  });

  it("spends the plan voice-minute allowance before charging coins", async () => {
    const userId = `${P}allowance-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId, 30); // 30 minutes of free voice

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-allow`, text: "Within the free allowance" },
    });
    expectOk(res, 201);
    // Covered by the minute allowance → no Dreamcoins spent.
    expect(await dreamcoinBalance(userId)).toBe(100);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.data.assetId } });
    expect((asset.metadata as { costDreamcoins?: number }).costDreamcoins).toBe(0);
  });

  it("does not restore consumed voice minutes when the clip asset is deleted", async () => {
    const userId = `${P}immutable-usage-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId, 0.01); // 600ms; each short mock clip is 500ms.

    const first = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}usage-1`, text: "short" },
    });
    expectOk(first, 201);
    expect(await dreamcoinBalance(userId)).toBe(100);

    expectOk(
      await api("DELETE", `media/${first.data.assetId}`, {
        userId,
        ageGate: true,
      }),
    );

    const second = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}usage-2`, text: "short" },
    });
    expectOk(second, 201);
    expect(await dreamcoinBalance(userId)).toBe(98);
    expect(await prisma.voiceUsageFact.count({ where: { userId } })).toBe(2);
  });

  it("prewarms an entitled assistant reply from included minutes without charging coins", async () => {
    const userId = `${P}prewarm-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId, 30);

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: {
        characterId: CHAR,
        messageId: `${P}msg-prewarm`,
        sessionId: `${P}session-prewarm`,
        text: "This completed assistant reply should already be voiced.",
        intent: "prewarm",
      },
    });

    expectOk(res, 201);
    expect(await dreamcoinBalance(userId)).toBe(100);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: res.data.assetId },
    });
    expect(asset.metadata).toMatchObject({
      costDreamcoins: 0,
      generationIntent: "automatic",
      messageId: `${P}msg-prewarm`,
      sessionId: `${P}session-prewarm`,
    });
  });

  it("replays a prewarmed clip when the user later requests play", async () => {
    const userId = `${P}prewarm-play-user`;
    const messageId = `${P}prewarm-play-message`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId, 30);
    const providerCall = vi.spyOn(providers.voice.clip, "synthesize");
    try {
      const prewarm = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body: {
          characterId: CHAR,
          messageId,
          sessionId: `${P}prewarm-play-session`,
          text: "Warm this once, then play the same artifact.",
          intent: "prewarm",
        },
      });
      expectOk(prewarm, 201);

      const play = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body: {
          characterId: CHAR,
          messageId,
          sessionId: `${P}prewarm-play-session`,
          text: "Warm this once, then play the same artifact.",
          intent: "play",
        },
      });

      expectOk(play, 200);
      expect(play.data.assetId).toBe(prewarm.data.assetId);
      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(await dreamcoinBalance(userId)).toBe(100);
    } finally {
      providerCall.mockRestore();
    }
  });

  it("skips automatic prewarm instead of spending overflow coins", async () => {
    const userId = `${P}prewarm-overflow-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId);

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: {
        characterId: CHAR,
        messageId: `${P}msg-prewarm-overflow`,
        text: "Do not charge for automatic voice generation.",
        intent: "prewarm",
      },
    });

    expectOk(res, 200);
    expect(res.data).toEqual({
      messageId: `${P}msg-prewarm-overflow`,
      prewarmed: false,
      reason: "allowance_exhausted",
    });
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(
      await prisma.mediaAsset.count({
        where: { ownerId: userId, type: "voice" },
      }),
    ).toBe(0);
  });

  it("records provider usage without delivering or charging when concurrent prewarms exhaust allowance", async () => {
    const userId = `${P}prewarm-concurrent-overflow-user`;
    const messageIds = [
      `${P}prewarm-concurrent-overflow-1`,
      `${P}prewarm-concurrent-overflow-2`,
    ];
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId, 0.01); // 600ms; each mock synthesis is 500ms.

    const synthesize = providers.voice.clip.synthesize.bind(providers.voice.clip);
    let activeProviderCalls = 0;
    let maxActiveProviderCalls = 0;
    const providerCall = vi
      .spyOn(providers.voice.clip, "synthesize")
      .mockImplementation(async (input) => {
        activeProviderCalls += 1;
        maxActiveProviderCalls = Math.max(
          maxActiveProviderCalls,
          activeProviderCalls,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        try {
          return await synthesize(input);
        } finally {
          activeProviderCalls -= 1;
        }
      });
    try {
      const responses = await Promise.all(
        messageIds.map((messageId) =>
          api("POST", "generation/voice", {
            userId,
            ageGate: true,
            body: {
              characterId: CHAR,
              messageId,
              text: "short",
              intent: "prewarm",
            },
          }),
        ),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
      expect(providerCall).toHaveBeenCalledTimes(2);
      expect(maxActiveProviderCalls).toBe(1);
      expect(await dreamcoinBalance(userId)).toBe(100);
      expect(
        await prisma.mediaAsset.count({
          where: { ownerId: userId, type: "voice", deletedAt: null },
        }),
      ).toBe(1);
      const usageFacts = await prisma.voiceUsageFact.findMany({
        where: { userId },
        orderBy: { requestId: "asc" },
      });
      expect(usageFacts).toHaveLength(2);
      expect(usageFacts.map((fact) => fact.costDreamcoins)).toEqual([0, 0]);
      expect(usageFacts.filter((fact) => fact.mediaAssetId === null)).toHaveLength(1);
      expect(
        (
          await prisma.voiceClipRequest.findMany({
            where: { userId, messageId: { in: messageIds } },
            orderBy: { messageId: "asc" },
          })
        ).map((request) => request.status).sort(),
      ).toEqual(["skipped", "succeeded"]);
    } finally {
      providerCall.mockRestore();
    }
  });

  it("honors active plan voice features when derived entitlement rows are missing", async () => {
    const userId = `${P}stale-sub-user`;
    const planId = `${P}stale-plan`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await createPlan({
      id: planId,
      slug: `${P}stale-premium`,
      billingPeriod: "monthly",
      includedDreamcoins: 1_000,
      features: {
        unlimitedMessages: true,
        voiceEnabled: true,
        voiceMinutes: 30,
      },
    });
    await prisma.subscription.create({
      data: {
        id: `${P}stale-sub`,
        userId,
        planId,
        provider: "mock",
        providerSubscriptionId: `${P}stale-invoice`,
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const me = await api("GET", "me", { userId });
    expectOk(me);
    expect(me.data.entitlements).toMatchObject({
      voice_enabled: true,
      voice_minutes: 30,
    });

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-stale-sub`, text: "Covered by plan" },
    });
    expectOk(res, 201);
    expect(await dreamcoinBalance(userId)).toBe(100);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.data.assetId } });
    expect((asset.metadata as { costDreamcoins?: number }).costDreamcoins).toBe(0);
  });

  it("charges overflow when the remaining allowance cannot cover the new clip", async () => {
    const userId = `${P}allowance-overflow-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId, 0.01); // 600ms
    const included = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}used-msg`, text: "Hello" },
    });
    expectOk(included, 201);
    expect(await dreamcoinBalance(userId)).toBe(100);

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-overflow`, text: "Hello" },
    });
    expectOk(res, 201);
    expect(await dreamcoinBalance(userId)).toBe(98);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.data.assetId } });
    expect((asset.metadata as { costDreamcoins?: number }).costDreamcoins).toBe(2);
  });

  it("is fully gated by the voice_gen feature flag (kill-switch)", async () => {
    const userId = `${P}flag-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId);

    await prisma.featureFlag.update({ where: { key: "voice_gen" }, data: { enabled: false } });
    try {
      const res = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body: { characterId: CHAR, messageId: `${P}msg-flag`, text: "Should be blocked" },
      });
      expectError(res, 403, "forbidden");
      expect(await prisma.mediaAsset.count({ where: { ownerId: userId, type: "voice" } })).toBe(0);
    } finally {
      await prisma.featureFlag.update({ where: { key: "voice_gen" }, data: { enabled: true } });
    }
  });

  it("requires the voice_enabled entitlement", async () => {
    const userId = `${P}nogate-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-2`, text: "No voice for you" },
    });
    expectError(res, 402, "payment_required");
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { ownerId: userId, type: "voice" } })).toBe(0);
  });

  it("rejects when the wallet cannot cover the clip", async () => {
    const userId = `${P}broke-user`;
    await createUser({ id: userId });
    await grantVoice(userId);

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-3`, text: "Too poor to talk" },
    });
    expectError(res, 402, "payment_required");
    expect(await prisma.mediaAsset.count({ where: { ownerId: userId, type: "voice" } })).toBe(0);
  });
});
