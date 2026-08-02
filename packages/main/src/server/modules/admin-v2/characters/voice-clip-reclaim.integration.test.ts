import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_FISH_AUDIO_DELIVERY } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { providers } from "@/server/providers";
import { canonicalRequestHash } from "@/server/modules/admin-v2/shared/control-plane-command";
import { updateControlPlaneCommandMetadata } from "@/server/modules/admin-v2/shared/control-plane-command-transition";
import { reclaimExpiredVoiceClip } from "@/server/modules/ourdream/voice-clip";
import {
  createCharacter,
  createUser,
  publishCharacterForPublicAudience,
  purgeTestData,
} from "@/server/test/helpers";
import { reclaimCharacterVoiceClip } from "./voice-clip-reclaim";

describe("Character Voice clip reclaim authority", () => {
  const prefix = `voice-reclaim-${randomUUID()}-`;
  const userId = `${prefix}user`;
  const actorId = `${prefix}actor`;
  const characterId = `${prefix}character`;
  const actor = { id: actorId, role: "admin" as const };
  const providerPayload = {
    providerKey: "mock",
    voiceId: "fish-female-default",
    voiceAuthority: "system_default",
    systemVoiceSettingVersion: 0,
    tone: "Warm test delivery",
    delivery: DEFAULT_FISH_AUDIO_DELIVERY,
  };
  const deps = {
    entitlementMap: async () => ({
      voice_enabled: true,
      voice_minutes: 10,
    }),
    readableCharacter: async () => ({
      id: characterId,
      age: 28,
      name: "Voice Reclaim Character",
      style: "warm",
      relationship: "companion",
      voiceId: null,
      gender: "female",
    }),
  };

  beforeAll(async () => {
    await purgeTestData(prefix);
    await createUser({ id: userId, dataClass: "customer" });
    await createUser({ id: actorId, role: "admin", dataClass: "internal" });
    await createCharacter({
      id: characterId,
      creatorId: actorId,
      visibility: "public",
      status: "approved",
    });
    await publishCharacterForPublicAudience({
      characterId,
      ownerId: actorId,
    });
    await prisma.entitlement.createMany({
      data: [
        {
          userId,
          key: "voice_enabled",
          value: true,
          source: "subscription",
        },
        {
          userId,
          key: "voice_minutes",
          value: 10,
          source: "subscription",
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.controlPlaneCommand.deleteMany({
      where: { OR: [{ actorId }, { targetId: { startsWith: prefix } }] },
    });
    await prisma.adminAuditLog.deleteMany({
      where: { OR: [{ actorId }, { targetId: { startsWith: prefix } }] },
    });
    await purgeTestData(prefix);
    await prisma.$disconnect();
  });

  it("single-flights a concurrent command and replays the successful receipt", async () => {
    const requestId = `${prefix}single-flight`;
    await createExpiredRequest(requestId);
    const original = providers.voice.clip.synthesize.bind(providers.voice.clip);
    let started!: () => void;
    let release!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const providerCall = vi
      .spyOn(providers.voice.clip, "synthesize")
      .mockImplementation(async (input) => {
        started();
        await providerRelease;
        return original(input);
      });
    const idempotencyKey = `${prefix}single-flight-key`;
    const command = () =>
      reclaimCharacterVoiceClip({
        characterId,
        requestId,
        actor,
        idempotencyKey,
        transportRequestId: randomUUID(),
        request: reclaimBody(requestId),
      });
    try {
      const owner = command();
      await providerStarted;
      await expect(command()).rejects.toMatchObject({ code: "conflict" });
      release();
      await expect(owner).resolves.toMatchObject({
        requestId,
        status: "succeeded",
        attemptNo: 2,
        replayed: false,
      });
      await expect(command()).resolves.toMatchObject({
        requestId,
        status: "succeeded",
        attemptNo: 2,
        replayed: true,
      });
      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(providerCall).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptNo: 2,
          idempotencyKey: `voice:${requestId}:provider`,
        }),
      );
      await expect(
        prisma.adminAuditLog.count({
          where: {
            actorId,
            targetId: requestId,
            action: "character.voice_clip.reclaimed",
          },
        }),
      ).resolves.toBe(1);
    } finally {
      release();
      providerCall.mockRestore();
    }
  });

  it("rejects a stale owner after the command lease authority changes", async () => {
    const requestId = `${prefix}stale-command-owner`;
    const idempotencyKey = `${prefix}stale-command-owner-key`;
    await createExpiredRequest(requestId);
    const original = providers.voice.clip.synthesize.bind(providers.voice.clip);
    let started!: () => void;
    let release!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const providerCall = vi
      .spyOn(providers.voice.clip, "synthesize")
      .mockImplementation(async (providerInput) => {
        started();
        await providerRelease;
        return original(providerInput);
      });
    try {
      const staleOwner = reclaimCharacterVoiceClip({
        characterId,
        requestId,
        actor,
        idempotencyKey,
        transportRequestId: randomUUID(),
        request: reclaimBody(requestId),
      });
      await providerStarted;
      const reserved = await prisma.controlPlaneCommand.findFirstOrThrow({
        where: { actorId, idempotencyKey },
      });
      const replacementLeaseOwner = `${prefix}replacement-owner`;
      await prisma.$transaction((tx) =>
        updateControlPlaneCommandMetadata(tx, {
          commandId: reserved.id,
          expected: {
            from: "running",
            leaseOwner: reserved.leaseOwner,
            leaseExpiresAt: reserved.leaseExpiresAt,
            attemptCount: reserved.attemptCount,
          },
          data: {
            leaseOwner: replacementLeaseOwner,
            leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
            attemptCount: { increment: 1 },
          },
        }),
      );
      release();

      await expect(staleOwner).rejects.toMatchObject({
        code: "conflict",
        message: "Voice reclaim command authority changed before commit",
      });
      await expect(
        prisma.controlPlaneCommand.findUniqueOrThrow({
          where: { id: reserved.id },
        }),
      ).resolves.toMatchObject({
        status: "running",
        leaseOwner: replacementLeaseOwner,
        attemptCount: reserved.attemptCount + 1,
        result: null,
        error: null,
      });
      await expect(
        prisma.adminAuditLog.count({
          where: { actorId, targetId: requestId },
        }),
      ).resolves.toBe(0);
      expect(providerCall).toHaveBeenCalledTimes(1);
    } finally {
      release();
      providerCall.mockRestore();
    }
  });

  it("fails closed for an active lease, a legacy payload, and the wrong Character", async () => {
    const activeId = `${prefix}active`;
    const legacyId = `${prefix}legacy`;
    await createExpiredRequest(activeId, {
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await createExpiredRequest(legacyId, { synthesisPayload: null });

    await expect(
      reclaimExpiredVoiceClip({ characterId, requestId: activeId, deps }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      reclaimExpiredVoiceClip({ characterId, requestId: legacyId, deps }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: expect.objectContaining({
        reason: "legacy_synthesis_payload_missing",
      }),
    });
    await expect(
      reclaimExpiredVoiceClip({
        characterId: `${prefix}wrong-character`,
        requestId: legacyId,
        deps,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await prisma.voiceClipRequest.deleteMany({
      where: { id: { in: [activeId, legacyId] } },
    });
  });

  it.each(["pipeline", "pocket_tts"] as const)(
    "does not mutate or call the %s provider during Admin reclaim",
    async (providerKey) => {
      const requestId = `${prefix}admin-non-replayable-${providerKey}`;
      const providerIdempotencyKey = `voice:${requestId}:attempt:1:provider`;
      await createExpiredRequest(requestId, {
        providerPayload: { ...providerPayload, providerKey },
        providerRequestId: providerIdempotencyKey,
      });
      const before = await prisma.voiceClipRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      const configuredVoice = providers.voice;
      const synthesize = vi.fn();
      providers.voice = {
        clip: {
          providerKey,
          providerReplay: "non_replayable",
          synthesize,
        },
        identity: null,
      };
      try {
        await expect(
          reclaimExpiredVoiceClip({ characterId, requestId, deps }),
        ).rejects.toMatchObject({
          code: "conflict",
          details: expect.objectContaining({
            provider: providerKey,
            reason: "provider_not_durably_replayable",
          }),
        });
        expect(synthesize).not.toHaveBeenCalled();
        const after = await prisma.voiceClipRequest.findUniqueOrThrow({
          where: { id: requestId },
        });
        expect(after).toEqual(before);
      } finally {
        providers.voice = configuredVoice;
      }
    },
  );

  it("checks the selected adapter capability before mutating an Admin reclaim", async () => {
    const requestId = `${prefix}adapter-capability-mismatch`;
    await createExpiredRequest(requestId);
    const before = await prisma.voiceClipRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const configuredVoice = providers.voice;
    const synthesize = vi.fn();
    providers.voice = {
      clip: {
        providerKey: "mock",
        providerReplay: "non_replayable",
        synthesize,
      },
      identity: null,
    };
    try {
      await expect(
        reclaimExpiredVoiceClip({ characterId, requestId, deps }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: expect.objectContaining({
          adapterProvider: "mock",
          adapterReplay: "non_replayable",
          reason: "provider_adapter_not_durably_replayable",
        }),
      });
      expect(synthesize).not.toHaveBeenCalled();
      const after = await prisma.voiceClipRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect(after).toEqual(before);
    } finally {
      providers.voice = configuredVoice;
    }
  });

  it("replays the original failed command receipt for the same idempotency key", async () => {
    const requestId = `${prefix}failed-receipt-replay`;
    const idempotencyKey = `${prefix}failed-receipt-replay-key`;
    await createExpiredRequest(requestId, {
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const before = await prisma.voiceClipRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const command = () =>
      reclaimCharacterVoiceClip({
        characterId,
        requestId,
        actor,
        idempotencyKey,
        transportRequestId: randomUUID(),
        request: reclaimBody(requestId),
      });

    const firstFailure = await command().catch((cause: unknown) => cause);
    const replayedFailure = await command().catch((cause: unknown) => cause);
    expect(firstFailure).toMatchObject({
      code: "conflict",
      message: "Voice clip request lease is still active",
    });
    expect(replayedFailure).toMatchObject({
      code: "conflict",
      message: "Voice clip request lease is still active",
      details: (firstFailure as { details?: unknown }).details,
    });
    await expect(
      prisma.controlPlaneCommand.count({
        where: { actorId, idempotencyKey },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.adminAuditLog.count({
        where: {
          actorId,
          targetId: requestId,
          action: "character.voice_clip.reclaim_failed",
        },
      }),
    ).resolves.toBe(1);
    const after = await prisma.voiceClipRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    expect(after).toEqual(before);
    await prisma.voiceClipRequest.delete({ where: { id: requestId } });
  });

  it("takes over an expired command but fails closed on an unattributed terminal row", async () => {
    const takeoverId = `${prefix}command-takeover`;
    const takeoverKey = `${prefix}command-takeover-key`;
    await createExpiredRequest(takeoverId);
    await createExpiredCommand(takeoverId, takeoverKey);
    await expect(
      reclaimCharacterVoiceClip({
        characterId,
        requestId: takeoverId,
        actor,
        idempotencyKey: takeoverKey,
        transportRequestId: randomUUID(),
        request: reclaimBody(takeoverId),
      }),
    ).resolves.toMatchObject({ status: "succeeded", replayed: false });
    await expect(
      prisma.controlPlaneCommand.findFirstOrThrow({
        where: { actorId, idempotencyKey: takeoverKey },
      }),
    ).resolves.toMatchObject({ status: "succeeded", attemptCount: 2 });

    const terminalId = `${prefix}terminal-window`;
    const terminalKey = `${prefix}terminal-window-key`;
    await createExpiredRequest(terminalId, {
      status: "succeeded",
      leaseExpiresAt: null,
    });
    await createExpiredCommand(terminalId, terminalKey);
    const replayUnattributedTerminal = () =>
      reclaimCharacterVoiceClip({
        characterId,
        requestId: terminalId,
        actor,
        idempotencyKey: terminalKey,
        transportRequestId: randomUUID(),
        request: reclaimBody(terminalId),
      });
    await expect(replayUnattributedTerminal()).rejects.toMatchObject({
      code: "conflict",
      details: expect.objectContaining({
        requestId: terminalId,
        reason: "voice_terminal_without_command_receipt",
      }),
    });
    await expect(replayUnattributedTerminal()).rejects.toMatchObject({
      code: "conflict",
      details: expect.objectContaining({
        requestId: terminalId,
        reason: "voice_terminal_without_command_receipt",
      }),
    });
    await expect(
      prisma.controlPlaneCommand.findFirstOrThrow({
        where: { actorId, idempotencyKey: terminalKey },
      }),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      prisma.adminAuditLog.count({
        where: {
          actorId,
          targetId: terminalId,
          action: "character.voice_clip.reclaimed",
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.adminAuditLog.count({
        where: {
          actorId,
          targetId: terminalId,
          action: "character.voice_clip.reclaim_failed",
        },
      }),
    ).resolves.toBe(1);
  });

  async function createExpiredRequest(
    requestId: string,
    overrides: {
      readonly leaseExpiresAt?: Date | null;
      readonly synthesisPayload?: object | null;
      readonly status?: string;
      readonly providerPayload?: object;
      readonly providerRequestId?: string;
    } = {},
  ) {
    return prisma.voiceClipRequest.create({
      data: {
        id: requestId,
        userId,
        characterId,
        messageId: `${requestId}-message`,
        requestFingerprint: `${requestId}-fingerprint`,
        synthesisPayload:
          overrides.synthesisPayload === null
            ? undefined
            : overrides.synthesisPayload ?? {
                version: 1,
                text: "Reclaim this exact Voice request",
                sessionId: null,
                intent: "play",
              },
        providerPayload: overrides.providerPayload ?? providerPayload,
        provider:
          (overrides.providerPayload as { providerKey?: string } | undefined)
            ?.providerKey ?? "mock",
        providerRequestId: overrides.providerRequestId,
        status: overrides.status ?? "running",
        leaseOwner: "expired-worker",
        leaseExpiresAt:
          overrides.leaseExpiresAt === undefined
            ? new Date(Date.now() - 1_000)
            : overrides.leaseExpiresAt,
      },
    });
  }

  function reclaimBody(requestId: string) {
    return {
      requestId,
      confirmation: `RECLAIM VOICE ${requestId}`,
      reason: "Recover an expired provider lease",
    };
  }

  async function createExpiredCommand(requestId: string, idempotencyKey: string) {
    const payload = { characterId, ...reclaimBody(requestId) };
    return prisma.controlPlaneCommand.create({
      data: {
        scope: `${env.APP_ENV}:${actorId}`,
        idempotencyKey,
        commandType: "character.voice_clip.reclaim",
        targetType: "voice_clip_request",
        targetId: requestId,
        actorId,
        requestId: randomUUID(),
        requestHash: canonicalRequestHash({
          commandType: "character.voice_clip.reclaim",
          target: { type: "voice_clip_request", id: requestId },
          payload,
          retryMode: "idempotent",
        }),
        requestPayload: payload,
        retryMode: "idempotent",
        status: "running",
        attemptCount: 1,
        maxAttempts: 3,
        leaseOwner: "crashed-admin-worker",
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });
  }
});
