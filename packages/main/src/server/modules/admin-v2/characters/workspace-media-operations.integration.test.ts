import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_FISH_AUDIO_DELIVERY,
  characterMediaOperationsProjectionSchema,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { getCharacterWorkspace } from "./workspace";

describe("Character media operations projection", () => {
  const suffix = randomUUID();
  const userId = `media-ops-user-${suffix}`;
  const characterId = `media-ops-character-${suffix}`;
  const projectId = `media-ops-project-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        dataClass: "internal",
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Media Ops Character",
        age: 28,
        description: "Character media operations projection fixture.",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        audience: {},
        successCriteria: [],
        draftAssetPack: {},
      },
    });
  });

  afterAll(async () => {
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("returns explicit unavailable rows when the Character has no media requests", async () => {
    const workspace = await getCharacterWorkspace(characterId) as unknown as {
      mediaOperations?: unknown;
    };
    const projection = characterMediaOperationsProjectionSchema.parse(
      workspace.mediaOperations,
    );

    expect(projection.operations.map((row) => ({
      modality: row.modality,
      requestId: row.requestId,
      status: row.status,
      recoverability: row.recoverability.state,
    }))).toEqual([
      { modality: "image", requestId: null, status: null, recoverability: "unavailable" },
      { modality: "video", requestId: null, status: null, recoverability: "unavailable" },
      { modality: "voice", requestId: null, status: null, recoverability: "unavailable" },
    ]);
  });

  it("projects the latest image/video Attempt evidence and actionable recovery state", async () => {
    const imageJobId = `media-ops-image-${suffix}`;
    const imageAttemptId = `media-ops-image-attempt-${suffix}`;
    const videoJobId = `media-ops-video-${suffix}`;
    const videoAttemptId = `media-ops-video-attempt-${suffix}`;
    const videoAssetId = `media-ops-video-asset-${suffix}`;
    const transportIds = [
      `media-ops-image-transport-1-${suffix}`,
      `media-ops-image-transport-2-${suffix}`,
      `media-ops-video-transport-${suffix}`,
    ];
    const ledgerIds = [
      `media-ops-video-spend-${suffix}`,
      `media-ops-video-refund-${suffix}`,
    ];
    try {
      await prisma.generationJob.createMany({
        data: [
          {
            id: imageJobId,
            userId,
            characterId,
            mode: "image",
            controls: {},
            presetIds: [],
            status: "failed",
            costDreamcoins: 12,
            provider: "request-provider",
            sourceType: "content_production_item",
            sourceId: `media-ops-production-item-${suffix}`,
            createdAt: new Date("2026-08-02T01:00:00.000Z"),
            finishedAt: new Date("2026-08-02T01:00:09.000Z"),
          },
          {
            id: videoJobId,
            userId,
            characterId,
            mode: "video",
            controls: {},
            presetIds: [],
            status: "blocked",
            costDreamcoins: 100,
            createdAt: new Date("2026-08-02T02:00:00.000Z"),
            finishedAt: new Date("2026-08-02T02:00:21.000Z"),
          },
        ],
      });
      await prisma.generationAttempt.createMany({
        data: [
          {
            id: imageAttemptId,
            requestId: imageJobId,
            attemptNo: 2,
            provider: "attempt-provider",
            status: "failed",
            errorCode: "provider_timeout",
            retryability: "retryable",
            operatorGuidance: "Replay the pinned image attempt.",
            startedAt: new Date("2026-08-02T01:00:01.000Z"),
            finishedAt: new Date("2026-08-02T01:00:09.000Z"),
          },
          {
            id: videoAttemptId,
            requestId: videoJobId,
            attemptNo: 1,
            provider: "ltx",
            status: "blocked",
            errorCode: "runtime_capacity",
            retryability: "operator_retry",
            operatorGuidance: "Inspect capacity before an operator retry.",
            startedAt: new Date("2026-08-02T02:00:01.000Z"),
            finishedAt: new Date("2026-08-02T02:00:21.000Z"),
          },
        ],
      });
      await prisma.generationTransportExecution.createMany({
        data: [
          {
            id: transportIds[0],
            attemptId: imageAttemptId,
            transportAttemptNo: 1,
            providerRequestId: `image-provider-request-old-${suffix}`,
            status: "failed",
          },
          {
            id: transportIds[1],
            attemptId: imageAttemptId,
            transportAttemptNo: 2,
            providerRequestId: `image-provider-request-latest-${suffix}`,
            status: "failed",
          },
          {
            id: transportIds[2],
            attemptId: videoAttemptId,
            transportAttemptNo: 1,
            providerRequestId: `video-provider-request-${suffix}`,
            status: "failed",
          },
        ],
      });
      await prisma.dreamcoinLedger.createMany({
        data: [
          {
            id: ledgerIds[0],
            userId,
            delta: -100,
            balanceAfter: 100,
            reason: "generation_spend",
            sourceId: videoJobId,
          },
          {
            id: ledgerIds[1],
            userId,
            delta: 40,
            balanceAfter: 140,
            reason: "refund",
            sourceId: videoJobId,
          },
        ],
      });
      await prisma.mediaAsset.create({
        data: {
          id: videoAssetId,
          ownerId: userId,
          characterId,
          sourceJobId: videoJobId,
          type: "video",
          url: `/api/v1/media/${videoAssetId}/content`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: { durationMs: 4_000 },
          createdAt: new Date("2026-08-02T02:00:20.000Z"),
        },
      });

      const projection = characterMediaOperationsProjectionSchema.parse(
        (await getCharacterWorkspace(characterId)).mediaOperations,
      );
      expect(projection.operations[0]).toMatchObject({
        modality: "image",
        requestId: imageJobId,
        status: "failed",
        attempt: {
          id: imageAttemptId,
          number: 2,
          status: "failed",
          errorCode: "provider_timeout",
          retryability: "retryable",
          operatorGuidance: "Replay the pinned image attempt.",
        },
        provider: {
          key: "attempt-provider",
          requestId: `image-provider-request-latest-${suffix}`,
        },
        timing: { latencyMs: 8_000 },
        costDreamcoins: 0,
        output: null,
        recoverability: {
          state: "retryable",
          reason: "Replay the pinned image attempt.",
        },
      });
      expect(projection.operations[1]).toMatchObject({
        modality: "video",
        requestId: videoJobId,
        status: "blocked",
        attempt: {
          id: videoAttemptId,
          number: 1,
          status: "blocked",
          retryability: "operator_retry",
        },
        provider: {
          key: "ltx",
          requestId: `video-provider-request-${suffix}`,
        },
        timing: { latencyMs: 20_000 },
        costDreamcoins: 60,
        output: {
          mediaAssetId: videoAssetId,
          availability: "available",
          url: `/api/v1/media/${videoAssetId}/content`,
          durationMs: 4_000,
        },
        recoverability: {
          state: "operator_action",
          reason: "Inspect capacity before an operator retry.",
        },
      });
      expect(projection.operations[0].operationsHref).toContain("view=dead-letter");
      expect(projection.operations[1].operationsHref).toContain("view=dead-letter");
    } finally {
      await prisma.mediaAsset.deleteMany({ where: { id: videoAssetId } });
      await prisma.dreamcoinLedger.deleteMany({ where: { id: { in: ledgerIds } } });
      await prisma.generationTransportExecution.deleteMany({
        where: { id: { in: transportIds } },
      });
      await prisma.generationAttempt.deleteMany({
        where: { id: { in: [imageAttemptId, videoAttemptId] } },
      });
      await prisma.generationJob.deleteMany({
        where: { id: { in: [imageJobId, videoJobId] } },
      });
    }
  });

  it("requires operator reconciliation when the latest Attempt outcome is unknown", async () => {
    const jobId = `media-ops-unknown-outcome-${suffix}`;
    const attemptId = `media-ops-unknown-outcome-attempt-${suffix}`;
    const transportId = `media-ops-unknown-outcome-transport-${suffix}`;
    try {
      await prisma.generationJob.create({
        data: {
          id: jobId,
          userId,
          characterId,
          mode: "video",
          controls: {},
          presetIds: [],
          status: "running",
          costDreamcoins: 100,
          createdAt: new Date("2026-08-02T04:00:00.000Z"),
        },
      });
      await prisma.generationAttempt.create({
        data: {
          id: attemptId,
          requestId: jobId,
          attemptNo: 1,
          provider: "backend",
          status: "unknown",
          errorCode: "terminal_record_persist_failed",
          startedAt: new Date("2026-08-02T04:00:01.000Z"),
          finishedAt: new Date("2026-08-02T04:00:15.000Z"),
        },
      });
      await prisma.generationTransportExecution.create({
        data: {
          id: transportId,
          attemptId,
          transportAttemptNo: 1,
          providerRequestId: `unknown-provider-request-${suffix}`,
          status: "unknown",
        },
      });

      const projection = characterMediaOperationsProjectionSchema.parse(
        (await getCharacterWorkspace(characterId)).mediaOperations,
      );
      expect(projection.operations[1]).toMatchObject({
        requestId: jobId,
        status: "running",
        provider: {
          key: "backend",
          requestId: `unknown-provider-request-${suffix}`,
        },
        costDreamcoins: 0,
        recoverability: {
          state: "operator_action",
          reason:
            "The latest Attempt outcome is unknown; reconcile provider and terminal evidence before retrying.",
        },
      });
    } finally {
      await prisma.generationTransportExecution.deleteMany({ where: { id: transportId } });
      await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
    }
  });

  it("projects an operator-confirmed unknown failure as retryable", async () => {
    const jobId = `media-ops-confirmed-failure-${suffix}`;
    const attemptId = `media-ops-confirmed-failure-attempt-${suffix}`;
    const eventId = `media-ops-confirmed-failure-event-${suffix}`;
    try {
      await prisma.generationJob.create({
        data: {
          id: jobId,
          userId,
          characterId,
          mode: "video",
          controls: {},
          presetIds: [],
          status: "failed",
          errorCode: "operator_confirmed_provider_failure",
          costDreamcoins: 100,
          createdAt: new Date("2026-08-02T04:30:00.000Z"),
        },
      });
      await prisma.generationAttempt.create({
        data: {
          id: attemptId,
          requestId: jobId,
          attemptNo: 1,
          provider: "backend",
          status: "unknown",
          errorCode: "terminal_record_persist_failed",
          startedAt: new Date("2026-08-02T04:30:01.000Z"),
          finishedAt: new Date("2026-08-02T04:30:15.000Z"),
        },
      });
      await prisma.generationJobEvent.create({
        data: {
          id: eventId,
          jobId,
          type: "unknown_reconciliation_confirm_failed",
          message: "Provider confirmed the request failed without output.",
          metadata: {
            attemptId,
            actorId: userId,
            resolution: "confirm_failed",
          },
        },
      });

      const projection = characterMediaOperationsProjectionSchema.parse(
        (await getCharacterWorkspace(characterId)).mediaOperations,
      );
      expect(projection.operations[1]).toMatchObject({
        requestId: jobId,
        status: "failed",
        attempt: { id: attemptId, status: "unknown" },
        recoverability: {
          state: "retryable",
          reason:
            "The provider failure was confirmed by an operator; create a new pinned Attempt.",
        },
      });
    } finally {
      await prisma.generationJobEvent.deleteMany({ where: { id: eventId } });
      await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
    }
  });

  it("fails closed when a failed Attempt has no recognized retryability evidence", async () => {
    const jobId = `media-ops-unknown-retry-${suffix}`;
    const attemptId = `media-ops-unknown-retry-attempt-${suffix}`;
    try {
      await prisma.generationJob.create({
        data: {
          id: jobId,
          userId,
          characterId,
          mode: "image",
          controls: {},
          presetIds: [],
          status: "failed",
          createdAt: new Date("2026-08-02T02:30:00.000Z"),
        },
      });
      await prisma.generationAttempt.create({
        data: {
          id: attemptId,
          requestId: jobId,
          attemptNo: 1,
          status: "failed",
          retryability: "legacy_unknown",
        },
      });

      const projection = characterMediaOperationsProjectionSchema.parse(
        (await getCharacterWorkspace(characterId)).mediaOperations,
      );
      expect(projection.operations[0]).toMatchObject({
        requestId: jobId,
        attempt: { retryability: null },
        recoverability: {
          state: "unavailable",
          reason: "No retryability evidence is recorded for the latest Attempt.",
        },
      });
    } finally {
      await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
    }
  });

  it("requires recovery when a running Voice request lease has expired", async () => {
    const requestId = `media-ops-expired-voice-request-${suffix}`;
    try {
      await prisma.voiceClipRequest.create({
        data: {
          id: requestId,
          userId,
          characterId,
          messageId: `media-ops-expired-voice-message-${suffix}`,
          requestFingerprint: `media-ops-expired-voice-fingerprint-${suffix}`,
          synthesisPayload: {
            version: 1,
            text: "Recover the pinned Voice operation",
            sessionId: null,
            intent: "play",
          },
          providerPayload: {
            providerKey: "fish_audio",
            voiceId: "fish-female-default",
            voiceAuthority: "system_default",
            systemVoiceSettingVersion: 0,
            tone: "Warm operator fixture",
            delivery: DEFAULT_FISH_AUDIO_DELIVERY,
          },
          status: "running",
          attemptNo: 3,
          leaseOwner: `expired-voice-worker-${suffix}`,
          leaseExpiresAt: new Date(Date.now() - 60_000),
          provider: "fish_audio",
          startedAt: new Date(Date.now() - 120_000),
          createdAt: new Date(Date.now() + 60_000),
        },
      });

      const projection = characterMediaOperationsProjectionSchema.parse(
        (await getCharacterWorkspace(characterId)).mediaOperations,
      );
      expect(projection.operations[2]).toMatchObject({
        modality: "voice",
        requestId,
        status: "running",
        attempt: {
          number: 3,
          status: "running",
        },
        recoverability: {
          state: "operator_action",
          reason:
            "The Voice synthesis lease expired; reclaim the durable request before retrying provider execution.",
          actionHref:
            `/api/v2/admin/characters/${characterId}/voice-clips/${requestId}/commands/reclaim`,
          actionConfirmation: `RECLAIM VOICE ${requestId}`,
        },
      });
    } finally {
      await prisma.voiceClipRequest.deleteMany({ where: { id: requestId } });
    }
  });

  it("projects an older expired Voice lease before a newer succeeded request", async () => {
    const expiredId = `media-ops-drain-expired-${suffix}`;
    const succeededId = `media-ops-drain-succeeded-${suffix}`;
    const durableProviderPayload = {
      providerKey: "fish_audio",
      voiceId: "fish-female-default",
      voiceAuthority: "system_default",
      systemVoiceSettingVersion: 0,
      tone: "Warm operator fixture",
      delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    };
    try {
      await prisma.voiceClipRequest.createMany({
        data: [
          {
            id: expiredId,
            userId,
            characterId,
            messageId: `${expiredId}-message`,
            requestFingerprint: `${expiredId}-fingerprint`,
            synthesisPayload: {
              version: 1,
              text: "Drain this older expired request first",
              sessionId: null,
              intent: "play",
            },
            providerPayload: durableProviderPayload,
            provider: "fish_audio",
            status: "running",
            leaseOwner: "crashed-voice-worker",
            leaseExpiresAt: new Date(Date.now() - 60_000),
            createdAt: new Date("2026-08-02T03:00:00.000Z"),
          },
          {
            id: succeededId,
            userId,
            characterId,
            messageId: `${succeededId}-message`,
            requestFingerprint: `${succeededId}-fingerprint`,
            synthesisPayload: {
              version: 1,
              text: "A newer completed request",
              sessionId: null,
              intent: "play",
            },
            providerPayload: durableProviderPayload,
            provider: "fish_audio",
            status: "succeeded",
            completedAt: new Date("2026-08-02T04:00:05.000Z"),
            createdAt: new Date("2026-08-02T04:00:00.000Z"),
          },
        ],
      });

      const projection = characterMediaOperationsProjectionSchema.parse(
        (await getCharacterWorkspace(characterId)).mediaOperations,
      );
      expect(projection.operations[2]).toMatchObject({
        requestId: expiredId,
        status: "running",
        recoverability: {
          state: "operator_action",
          actionConfirmation: `RECLAIM VOICE ${expiredId}`,
        },
      });
    } finally {
      await prisma.voiceClipRequest.deleteMany({
        where: { id: { in: [expiredId, succeededId] } },
      });
    }
  });

  it("does not expose a reclaim action for a non-replayable Voice provider", async () => {
    const requestId = `media-ops-non-replayable-${suffix}`;
    try {
      await prisma.voiceClipRequest.create({
        data: {
          id: requestId,
          userId,
          characterId,
          messageId: `${requestId}-message`,
          requestFingerprint: `${requestId}-fingerprint`,
          synthesisPayload: {
            version: 1,
            text: "Do not replay this provider invocation",
            sessionId: null,
            intent: "play",
          },
          providerPayload: {
            providerKey: "pipeline",
            voiceId: "pipeline-default",
            voiceAuthority: "system_default",
            systemVoiceSettingVersion: 0,
            tone: "Warm operator fixture",
            delivery: DEFAULT_FISH_AUDIO_DELIVERY,
          },
          provider: "pipeline",
          providerRequestId: `voice:${requestId}:provider`,
          status: "running",
          leaseOwner: "crashed-pipeline-worker",
          leaseExpiresAt: new Date(Date.now() - 60_000),
          createdAt: new Date(Date.now() + 120_000),
        },
      });

      const projection = characterMediaOperationsProjectionSchema.parse(
        (await getCharacterWorkspace(characterId)).mediaOperations,
      );
      expect(projection.operations[2]).toMatchObject({
        requestId,
        recoverability: {
          state: "unavailable",
          actionHref: null,
          actionConfirmation: null,
        },
      });
    } finally {
      await prisma.voiceClipRequest.deleteMany({ where: { id: requestId } });
    }
  });

  it("retains voice usage cost and duration after the generated clip is deleted", async () => {
    const requestId = `media-ops-voice-request-${suffix}`;
    const assetId = `media-ops-voice-asset-${suffix}`;
    const usageId = `media-ops-voice-usage-${suffix}`;
    try {
      await prisma.mediaAsset.create({
        data: {
          id: assetId,
          ownerId: userId,
          characterId,
          type: "voice",
          url: `/api/v1/media/${assetId}/content`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
          createdAt: new Date("2026-08-02T03:00:10.000Z"),
        },
      });
      await prisma.voiceClipRequest.create({
        data: {
          id: requestId,
          userId,
          characterId,
          messageId: `media-ops-message-${suffix}`,
          requestFingerprint: `media-ops-fingerprint-${suffix}`,
          providerPayload: { providerKey: "fish_audio" },
          status: "succeeded",
          attemptNo: 2,
          mediaAssetId: assetId,
          provider: "fish_audio",
          providerRequestId: `fish-request-${suffix}`,
          startedAt: new Date("2026-08-02T03:00:00.000Z"),
          completedAt: new Date("2026-08-02T03:00:11.000Z"),
          createdAt: new Date("2026-08-02T03:00:00.000Z"),
        },
      });
      await prisma.voiceUsageFact.create({
        data: {
          id: usageId,
          requestId,
          attemptNo: 2,
          userId,
          characterId,
          mediaAssetId: assetId,
          durationMs: 3_456,
          costDreamcoins: 7,
          intent: "play",
          occurredAt: new Date("2026-08-02T03:00:11.000Z"),
        },
      });
      await prisma.mediaAsset.update({
        where: { id: assetId },
        data: { deletedAt: new Date("2026-08-02T03:05:00.000Z") },
      });

      const projection = characterMediaOperationsProjectionSchema.parse(
        (await getCharacterWorkspace(characterId)).mediaOperations,
      );
      expect(projection.operations[2]).toMatchObject({
        modality: "voice",
        requestId,
        status: "succeeded",
        attempt: {
          id: null,
          number: 2,
          status: "succeeded",
          errorCode: null,
          retryability: null,
          operatorGuidance: null,
        },
        provider: {
          key: "fish_audio",
          requestId: `fish-request-${suffix}`,
        },
        timing: { latencyMs: 11_000 },
        costDreamcoins: 7,
        output: {
          mediaAssetId: assetId,
          availability: "deleted",
          url: null,
          durationMs: 3_456,
        },
        recoverability: { state: "not_needed", reason: null },
      });
    } finally {
      await prisma.voiceUsageFact.deleteMany({ where: { id: usageId } });
      await prisma.voiceClipRequest.deleteMany({ where: { id: requestId } });
      await prisma.mediaAsset.deleteMany({ where: { id: assetId } });
    }
  });
});
