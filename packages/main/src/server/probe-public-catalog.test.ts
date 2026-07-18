import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { runPublicCatalogProbe } from "./public-catalog-probe";

describe("public catalog probe audience audit", () => {
  const suffix = randomUUID();
  const userId = `catalog-pollution-user-${suffix}`;
  const characterId = `catalog-pollution-character-${suffix}`;
  const collectionId = `catalog-pollution-collection-${suffix}`;
  const feedbackId = `catalog-pollution-feedback-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        displayName: "Hidden automation account",
        dataClass: "fixture",
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: userId,
        name: "Hidden automated character",
        age: 24,
        description: "Synthetic content that must not enter the customer audience.",
        visibility: "public",
        status: "approved",
        source: "user",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.mediaCollection.create({
      data: {
        id: collectionId,
        ownerId: userId,
        name: "Hidden automated collection",
        visibility: "public",
        source: "user",
      },
    });
    await prisma.productFeedbackItem.create({
      data: {
        id: feedbackId,
        createdById: userId,
        title: "Hidden automated feedback",
        description: "Synthetic feedback that must not enter the customer audience.",
      },
    });
  });

  afterAll(async () => {
    await prisma.productFeedbackItem.deleteMany({ where: { id: feedbackId } });
    await prisma.mediaCollection.deleteMany({ where: { id: collectionId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("counts only the true public audience while launch-blocking raw fixture pollution", async () => {
    const report = await runPublicCatalogProbe(prisma, {
      report: null,
      maxDuplicateImageRatio: 0.4,
      maxPublicMetric: 10_000_000,
      maxIssues: 100,
    });

    expect(report.ok).toBe(false);
    expect(report.counts).toMatchObject({
      publicCharacters: 16,
      rawPublicCharacters: 17,
      excludedPublicCharacters: 1,
      publicCollections: 3,
      rawPublicCollections: 4,
      excludedPublicCollections: 1,
      publicFeedbackItems: 3,
      rawPublicFeedbackItems: 4,
      excludedPublicFeedbackItems: 1,
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "fail",
          entity: "character",
          id: characterId,
          field: "imageAsset",
        }),
        expect.objectContaining({
          severity: "fail",
          entity: "collection",
          id: collectionId,
          field: "items",
        }),
        expect.objectContaining({
          severity: "fail",
          entity: "feedback",
          id: feedbackId,
          field: "audience",
        }),
      ]),
    );
  });

  it("reports legacy synthetic image authorities separately from owner provenance", async () => {
    const customerId = `catalog-synthetic-customer-${suffix}`;
    const assetId = `catalog-synthetic-asset-${suffix}`;
    const syntheticCharacterId = `catalog-synthetic-character-${suffix}`;
    const syntheticCollectionId = `catalog-synthetic-collection-${suffix}`;
    await prisma.user.create({
      data: {
        id: customerId,
        email: `${customerId}@example.test`,
        displayName: "Real customer",
        dataClass: "customer",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerId: customerId,
        type: "image",
        url: `/user-content/${assetId}/content.webp`,
        safetyStatus: "passed",
        metadata: { synthetic: "true", source: "mock" },
      },
    });
    await prisma.character.create({
      data: {
        id: syntheticCharacterId,
        creatorId: customerId,
        imageAssetId: assetId,
        name: "Legacy synthetic character",
        age: 24,
        description: "A legacy row that must be quarantined.",
        visibility: "public",
        status: "approved",
        source: "user",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.mediaCollection.create({
      data: {
        id: syntheticCollectionId,
        ownerId: customerId,
        name: "Legacy synthetic collection",
        visibility: "public",
        source: "user",
        items: {
          create: {
            mediaAssetId: assetId,
          },
        },
      },
    });

    try {
      const report = await runPublicCatalogProbe(prisma, {
        report: null,
        maxDuplicateImageRatio: 0.4,
        maxPublicMetric: 10_000_000,
        maxIssues: 100,
      });

      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "fail",
            entity: "character",
            id: syntheticCharacterId,
            field: "imageAsset",
            value: assetId,
          }),
          expect.objectContaining({
            severity: "fail",
            entity: "collection",
            id: syntheticCollectionId,
            field: "items",
            value: assetId,
          }),
        ]),
      );
    } finally {
      await prisma.mediaCollection.deleteMany({ where: { id: syntheticCollectionId } });
      await prisma.character.deleteMany({ where: { id: syntheticCharacterId } });
      await prisma.mediaAsset.deleteMany({ where: { id: assetId } });
      await prisma.user.deleteMany({ where: { id: customerId } });
    }
  });
});
