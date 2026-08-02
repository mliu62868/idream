import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  ensureProducedGenerationArtifact,
  projectAttemptArtifactDisposition,
  projectGenerationDelivery,
  transitionGenerationArtifactEvidence,
} from "./generation-evidence-transition-authority";

describe("Generation Artifact and Delivery authority", () => {
  const suffix = randomUUID();
  const attemptId = `artifact-attempt-${suffix}`;
  const requestId = `artifact-request-${suffix}`;
  const dispositionAttemptId = `artifact-disposition-attempt-${suffix}`;
  const dispositionRequestId = `artifact-disposition-request-${suffix}`;
  const userId = `artifact-user-${suffix}`;
  const otherUserId = `artifact-other-user-${suffix}`;
  const mediaAssetId = `artifact-media-${suffix}`;
  const wrongRequestId = `artifact-wrong-request-${suffix}`;
  const wrongMediaAssetId = `artifact-wrong-media-${suffix}`;
  const wrongOwnerMediaAssetId = `artifact-wrong-owner-media-${suffix}`;
  const checksum = "a".repeat(64);

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [userId, otherUserId].map((id) => ({
        id,
        email: `${id}@idream.internal`,
        status: "active",
      })),
    });
    await prisma.generationJob.createMany({
      data: [requestId, wrongRequestId, dispositionRequestId].map((id) => ({
        id,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "running",
      })),
    });
    await prisma.generationAttempt.createMany({
      data: [
        { id: attemptId, requestId, attemptNo: 1, status: "running" },
        {
          id: dispositionAttemptId,
          requestId: dispositionRequestId,
          attemptNo: 1,
          status: "running",
        },
      ],
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaAssetId,
        ownerId: userId,
        sourceJobId: requestId,
        type: "image",
        url: `/test/${mediaAssetId}.webp`,
        storageKey: `test/${mediaAssetId}.webp`,
        providerAssetId: "provider-output-0",
        metadata: { index: 0 },
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: wrongOwnerMediaAssetId,
        ownerId: otherUserId,
        sourceJobId: requestId,
        type: "image",
        url: `/test/${wrongOwnerMediaAssetId}.webp`,
        storageKey: `test/${wrongOwnerMediaAssetId}.webp`,
        providerAssetId: "provider-output-0",
        metadata: { index: 0 },
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: wrongMediaAssetId,
        ownerId: userId,
        sourceJobId: wrongRequestId,
        type: "image",
        url: `/test/${wrongMediaAssetId}.webp`,
        storageKey: `test/${wrongMediaAssetId}.webp`,
        providerAssetId: "provider-output-0",
        metadata: { index: 0 },
      },
    });
  });

  afterAll(async () => {
    const artifacts = await prisma.generationArtifact.findMany({
      where: { attemptId: { in: [attemptId, dispositionAttemptId] } },
      select: { id: true },
    });
    await prisma.generationDelivery.deleteMany({
      where: { artifactId: { in: artifacts.map((artifact) => artifact.id) } },
    });
    await prisma.generationArtifact.deleteMany({
      where: { attemptId: { in: [attemptId, dispositionAttemptId] } },
    });
    await prisma.generationAttemptEvent.deleteMany({
      where: { attemptId: { in: [attemptId, dispositionAttemptId] } },
    });
    await prisma.generationAttempt.deleteMany({
      where: { id: { in: [attemptId, dispositionAttemptId] } },
    });
    await prisma.mediaAsset.deleteMany({
      where: {
        id: { in: [mediaAssetId, wrongMediaAssetId, wrongOwnerMediaAssetId] },
      },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: [requestId, wrongRequestId, dispositionRequestId] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it("serializes concurrent production and rejects provider identity rewrites", async () => {
    const input = {
      attemptId,
      ordinal: 0,
      providerRef: "provider-output-0",
      terminalRecordChecksum: checksum,
    } as const;
    const [first, second] = await Promise.all([
      prisma.$transaction((tx) => ensureProducedGenerationArtifact(tx, input)),
      prisma.$transaction((tx) => ensureProducedGenerationArtifact(tx, input)),
    ]);
    expect([first.disposition, second.disposition].sort()).toEqual([
      "created",
      "duplicate",
    ]);
    await expect(
      prisma.$transaction((tx) =>
        ensureProducedGenerationArtifact(tx, {
          ...input,
          providerRef: "different-provider-output",
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      prisma.$transaction((tx) =>
        ensureProducedGenerationArtifact(tx, {
          ...input,
          terminalRecordChecksum: "b".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("binds one MediaAsset and fails closed on terminal evidence rewrites", async () => {
    const artifact = await prisma.generationArtifact.findUniqueOrThrow({
      where: { attemptId_ordinal: { attemptId, ordinal: 0 } },
    });
    await expect(
      prisma.$transaction((tx) =>
        transitionGenerationArtifactEvidence(tx, {
          artifactId: artifact.id,
          validationState: "valid",
          assetId: `missing-asset-${suffix}`,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      prisma.$transaction((tx) =>
        transitionGenerationArtifactEvidence(tx, {
          artifactId: artifact.id,
          validationState: "valid",
          assetId: wrongOwnerMediaAssetId,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      prisma.$transaction((tx) =>
        transitionGenerationArtifactEvidence(tx, {
          artifactId: artifact.id,
          validationState: "valid",
          assetId: wrongMediaAssetId,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const transitioned = await prisma.$transaction((tx) =>
      transitionGenerationArtifactEvidence(tx, {
        artifactId: artifact.id,
        validationState: "valid",
        assetId: mediaAssetId,
      }),
    );
    expect(transitioned).toMatchObject({
      validationState: "valid",
      assetId: mediaAssetId,
      disposition: "updated",
    });
    await expect(
      prisma.$transaction((tx) =>
        transitionGenerationArtifactEvidence(tx, {
          artifactId: artifact.id,
          validationState: "valid",
          assetId: mediaAssetId,
        }),
      ),
    ).resolves.toMatchObject({ disposition: "duplicate" });
    await expect(
      prisma.$transaction((tx) =>
        transitionGenerationArtifactEvidence(tx, {
          artifactId: artifact.id,
          validationState: "valid",
          assetId: `other-asset-${suffix}`,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      prisma.$transaction((tx) =>
        transitionGenerationArtifactEvidence(tx, {
          artifactId: artifact.id,
          validationState: "invalid",
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("owns the Delivery terminal timestamp and preserves it on replay", async () => {
    const artifact = await prisma.generationArtifact.findUniqueOrThrow({
      where: { attemptId_ordinal: { attemptId, ordinal: 0 } },
    });
    const pendingAt = new Date("2026-08-01T10:00:00.000Z");
    const deliveredAt = new Date("2026-08-01T10:00:02.000Z");
    await expect(
      prisma.$transaction((tx) =>
        projectGenerationDelivery(tx, {
          requestId: `other-request-${suffix}`,
          artifactId: artifact.id,
          targetType: "user_library",
          targetId: userId,
          status: "pending",
          occurredAt: pendingAt,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const [ownerProjection, crossUserProjection] = await Promise.allSettled([
      prisma.$transaction((tx) =>
        projectGenerationDelivery(tx, {
          requestId,
          artifactId: artifact.id,
          targetType: "user_library",
          targetId: userId,
          status: "pending",
          occurredAt: pendingAt,
        }),
      ),
      prisma.$transaction((tx) =>
        projectGenerationDelivery(tx, {
          requestId,
          artifactId: artifact.id,
          targetType: "user_library",
          targetId: otherUserId,
          status: "pending",
          occurredAt: pendingAt,
        }),
      ),
    ]);
    expect(ownerProjection).toMatchObject({
      status: "fulfilled",
      value: expect.objectContaining({ status: "pending", deliveredAt: null }),
    });
    expect(crossUserProjection).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ status: 409 }),
    });
    await expect(
      prisma.generationDelivery.findMany({
        where: { artifactId: artifact.id, targetType: "user_library" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ targetId: userId, status: "pending" }),
    ]);
    const delivered = await prisma.$transaction((tx) =>
      projectGenerationDelivery(tx, {
        requestId,
        artifactId: artifact.id,
        targetType: "user_library",
        targetId: userId,
        status: "delivered",
        occurredAt: deliveredAt,
      }),
    );
    expect(delivered).toMatchObject({ status: "delivered", deliveredAt });
    await expect(
      prisma.$transaction((tx) =>
        projectGenerationDelivery(tx, {
          requestId,
          artifactId: artifact.id,
          targetType: "user_library",
          targetId: userId,
          status: "delivered",
          occurredAt: new Date("2026-08-01T10:00:09.000Z"),
        }),
      ),
    ).resolves.toMatchObject({ disposition: "duplicate", deliveredAt });
    await expect(
      prisma.$transaction((tx) =>
        projectGenerationDelivery(tx, {
          requestId,
          artifactId: artifact.id,
          targetType: "user_library",
          targetId: userId,
          status: "failed",
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("projects every produced Artifact through one terminal disposition", async () => {
    await prisma.$transaction(async (tx) => {
      for (const ordinal of [0, 1]) {
        await ensureProducedGenerationArtifact(tx, {
          attemptId: dispositionAttemptId,
          ordinal,
          providerRef: `disposition-provider-output-${ordinal}`,
          terminalRecordChecksum: checksum,
        });
      }
    });
    await expect(
      prisma.$transaction((tx) =>
        projectAttemptArtifactDisposition(tx, {
          requestId: dispositionRequestId,
          attemptId: dispositionAttemptId,
          targetId: userId,
          validationState: "late_after_failed",
          deliveryStatus: "suppressed",
          occurredAt: new Date(),
        }),
      ),
    ).resolves.toBe(2);
    await expect(
      prisma.generationArtifact.findMany({
        where: { attemptId: dispositionAttemptId },
        orderBy: { ordinal: "asc" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        ordinal: 0,
        validationState: "late_after_failed",
        archiveState: "archived",
      }),
      expect.objectContaining({
        ordinal: 1,
        validationState: "late_after_failed",
        archiveState: "archived",
      }),
    ]);
    await expect(
      prisma.generationDelivery.count({
        where: { requestId: dispositionRequestId, status: "suppressed" },
      }),
    ).resolves.toBe(2);
  });
});
