import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2Api } from "@/server/test/admin-v2-api";
import {
  createUser,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";

describe("content operations media authority", () => {
  const prefix = `legacy-media-authority-${randomUUID()}-`;
  const adminId = `${prefix}admin`;

  beforeAll(async () => {
    await createUser({
      id: adminId,
      role: "admin",
      dataClass: "internal",
    });
  });

  afterAll(async () => {
    const attempts = await prisma.generationAttempt.findMany({
      where: { requestId: { startsWith: prefix } },
      select: { id: true },
    });
    await prisma.generationAttemptEvent.deleteMany({
      where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
    });
    await prisma.generationAttempt.deleteMany({
      where: { requestId: { startsWith: prefix } },
    });
    await prisma.creativeReviewDecision.deleteMany({
      where: { runItemId: { startsWith: prefix } },
    });
    await purgeTestData(prefix);
    await prisma.$disconnect();
  });

  async function createProductionFixture(input: {
    label: string;
    metadata: Prisma.InputJsonValue;
    jobProvider: string;
    attemptProvider: string;
    status?: "generated" | "approved";
    canonicalDecision?: boolean;
  }) {
    const jobId = `${prefix}${input.label}-job`;
    const assetId = `${prefix}${input.label}-asset`;
    const batchId = `${prefix}${input.label}-batch`;
    const itemId = `${prefix}${input.label}-item`;
    const status = input.status ?? "generated";
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId: adminId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        provider: input.jobProvider,
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: `${prefix}${input.label}-attempt`,
        requestId: jobId,
        attemptNo: 1,
        provider: input.attemptProvider,
        status: "succeeded",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerId: adminId,
        sourceJobId: jobId,
        type: "image",
        url: `https://example.test/${assetId}.webp`,
        thumbnailUrl: `https://example.test/${assetId}-thumb.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: input.metadata,
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: batchId,
        title: `${prefix}${input.label}`,
        purpose: "feed",
        targetType: "none",
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: status === "approved" ? 1 : 0,
        status: "reviewing",
        createdById: adminId,
        items: {
          create: {
            id: itemId,
            itemIndex: 0,
            jobId,
            mediaAssetId: assetId,
            status,
            tags: [],
          },
        },
      },
    });
    if (input.canonicalDecision) {
      await prisma.creativeReviewDecision.create({
        data: {
          runItemId: itemId,
          artifactId: assetId,
          decision: "approved",
          identityConsistency: "unscored",
          score: 90,
          reason: "Canonical approval fixture",
          reviewerId: adminId,
        },
      });
    }
    return { assetId, batchId, itemId };
  }

  it("retains demo assets in private admin projections and marks them synthetic", async () => {
    const fixtures = await Promise.all([
      createProductionFixture({
        label: "malformed-marker",
        metadata: { synthetic: "false" },
        jobProvider: "backend",
        attemptProvider: "comfyui",
      }).then((fixture) => ({
        ...fixture,
        expected: {
          isSynthetic: true,
          customerPublishable: false,
          publishabilityReasons: expect.arrayContaining([
            "metadata_synthetic_marker_invalid",
          ]),
        },
      })),
      createProductionFixture({
        label: "mock-job",
        metadata: {},
        jobProvider: "mock-image",
        attemptProvider: "comfyui",
      }).then((fixture) => ({
        ...fixture,
        expected: {
          isSynthetic: false,
          customerPublishable: false,
          publishabilityReasons: expect.arrayContaining(["job_provider_mock"]),
        },
      })),
      createProductionFixture({
        label: "mock-attempt",
        metadata: {},
        jobProvider: "backend",
        attemptProvider: "mock-image",
      }).then((fixture) => ({
        ...fixture,
        expected: {
          isSynthetic: false,
          customerPublishable: false,
          publishabilityReasons: expect.arrayContaining([
            "latest_attempt_provider_mock",
          ]),
        },
      })),
      createProductionFixture({
        label: "archived-real",
        metadata: { platformAsset: { status: "archived" } },
        jobProvider: "backend",
        attemptProvider: "comfyui",
        status: "approved",
        canonicalDecision: true,
      }).then((fixture) => ({
        ...fixture,
        expected: {
          isSynthetic: false,
          customerPublishable: false,
          publishabilityReasons: expect.arrayContaining([
            "platform_asset_archived",
          ]),
        },
      })),
    ]);
    for (const fixture of fixtures) {
      const detail = await adminV2Api(
        "GET",
        `/api/v2/admin/assets/${fixture.assetId}`,
        { userId: adminId, role: "admin" },
      );
      expectOk(detail);
      expect(detail.data.asset).toMatchObject({
        id: fixture.assetId,
        ...fixture.expected,
      });
    }
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: fixtures[1].assetId },
      }),
    ).resolves.toMatchObject({ visibility: "private" });

    const archivedPlacement = await adminV2Api("POST", "/api/v2/admin/content/placements", {
      userId: adminId,
      role: "admin",
      body: {
        mediaAssetId: fixtures[3].assetId,
        slot: "feed_card",
        targetType: "route_page",
        targetId: `${prefix}archived-homepage`,
        status: "draft",
        reason: "attempt to stage an archived real asset",
      },
    });
    expectError(archivedPlacement, 400, "bad_request");
    await expect(
      prisma.mediaAssetPlacement.count({
        where: { mediaAssetId: fixtures[3].assetId },
      }),
    ).resolves.toBe(0);
  });

  it("rejects a canonically approved mock asset at the remaining draft Placement boundary", async () => {
    const fixture = await createProductionFixture({
      label: "already-approved-mock",
      metadata: {
        platformAsset: {
          status: "approved",
        },
      },
      jobProvider: "backend",
      attemptProvider: "mock-image",
      status: "approved",
      canonicalDecision: true,
    });

    const response = await adminV2Api("POST", "/api/v2/admin/content/placements", {
      userId: adminId,
      role: "admin",
      body: {
        mediaAssetId: fixture.assetId,
        slot: "feed_card",
        targetType: "route_page",
        targetId: `${prefix}homepage`,
        status: "draft",
        reason: "attempt to stage an old approved demo asset",
      },
    });
    expectError(response, 400, "bad_request");
    expect(response.error?.details).toMatchObject({
      code: "media_asset_not_customer_publishable",
      assetId: fixture.assetId,
      reasons: expect.arrayContaining(["latest_attempt_provider_mock"]),
    });
    await expect(
      prisma.mediaAssetPlacement.count({
        where: { mediaAssetId: fixture.assetId },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.contentProductionItem.findUniqueOrThrow({
        where: { id: fixture.itemId },
      }),
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("keeps the latest successful provider authoritative when a later retry fails", async () => {
    const fixture = await createProductionFixture({
      label: "failed-retry-after-success",
      metadata: {},
      jobProvider: "comfyui",
      attemptProvider: "comfyui",
    });
    await prisma.generationAttempt.create({
      data: {
        id: `${prefix}failed-retry-after-success-attempt-2`,
        requestId: `${prefix}failed-retry-after-success-job`,
        attemptNo: 2,
        provider: "mock-image",
        status: "failed",
        finishedAt: new Date(),
      },
    });

    const response = await adminV2Api(
      "GET",
      `/api/v2/admin/assets/${fixture.assetId}`,
      { userId: adminId, role: "admin" },
    );
    expectOk(response);
    expect(response.data.asset).toMatchObject({
      id: fixture.assetId,
      customerPublishable: true,
      publishabilityReasons: [],
    });
  });
});
