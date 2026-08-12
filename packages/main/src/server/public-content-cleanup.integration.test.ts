import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  applyPublicContentCleanup,
  planPublicContentCleanup,
} from "./public-content-cleanup";

describe("public content cleanup", () => {
  const suffix = randomUUID();
  const userId = `cleanup-fixture-${suffix}`;
  const characterId = `cleanup-character-${suffix}`;
  const officialCharacterId = `cleanup-official-character-${suffix}`;
  const collectionId = `cleanup-collection-${suffix}`;
  const officialCollectionId = `cleanup-official-collection-${suffix}`;
  const feedbackId = `cleanup-feedback-${suffix}`;
  const sourcedFeedbackId = `cleanup-sourced-feedback-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        dataClass: "fixture",
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: userId,
        name: "Cleanup character",
        age: 24,
        description: "Public fixture content.",
        visibility: "public",
        status: "approved",
        source: "user",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.character.create({
      data: {
        id: officialCharacterId,
        creatorId: userId,
        name: "Unqualified official character",
        age: 24,
        description: "Public official row without release authority.",
        visibility: "public",
        status: "approved",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.mediaCollection.create({
      data: {
        id: collectionId,
        ownerId: userId,
        name: "Cleanup collection",
        visibility: "public",
        source: "user",
      },
    });
    await prisma.mediaCollection.create({
      data: {
        id: officialCollectionId,
        ownerId: userId,
        name: "Empty official collection",
        visibility: "public",
        source: "official",
      },
    });
    await prisma.productFeedbackItem.create({
      data: {
        id: feedbackId,
        createdById: userId,
        title: "Cleanup feedback",
        description: "Public fixture feedback.",
      },
    });
    await prisma.productFeedbackItem.create({
      data: {
        id: sourcedFeedbackId,
        sourceKey: sourcedFeedbackId,
        source: "user",
        createdById: userId,
        title: "Sourced fixture feedback",
        description: "Public fixture feedback with a source key.",
      },
    });
  });

  afterAll(async () => {
    await prisma.productFeedbackItem.deleteMany({
      where: { id: { in: [feedbackId, sourcedFeedbackId] } },
    });
    await prisma.mediaCollection.deleteMany({
      where: { id: { in: [collectionId, officialCollectionId] } },
    });
    await prisma.character.deleteMany({
      where: { id: { in: [characterId, officialCharacterId] } },
    });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("plans a dry run without mutation and applies an unlisted transition without deleting content", async () => {
    const plan = await planPublicContentCleanup(prisma);

    expect(plan.characters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: characterId, toVisibility: "unlisted" }),
        expect.objectContaining({ id: officialCharacterId, toVisibility: "unlisted" }),
      ]),
    );
    expect(plan.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: collectionId, toVisibility: "unlisted" }),
        expect.objectContaining({ id: officialCollectionId, toVisibility: "unlisted" }),
      ]),
    );
    expect(plan.feedbackItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: feedbackId, toVisibility: "unlisted" }),
        expect.objectContaining({ id: sourcedFeedbackId, toVisibility: "unlisted" }),
      ]),
    );
    await expect(prisma.character.findUniqueOrThrow({ where: { id: characterId } }))
      .resolves.toMatchObject({ visibility: "public" });

    const applied = await applyPublicContentCleanup(prisma, plan);
    expect(applied).toMatchObject({
      charactersUpdated: 2,
      collectionsUpdated: 2,
      feedbackItemsUpdated: 2,
    });
    await expect(prisma.character.findUniqueOrThrow({ where: { id: characterId } }))
      .resolves.toMatchObject({ visibility: "unlisted", status: "approved" });
    await expect(prisma.mediaCollection.findUniqueOrThrow({ where: { id: collectionId } }))
      .resolves.toMatchObject({ visibility: "unlisted" });
    await expect(prisma.productFeedbackItem.findUniqueOrThrow({ where: { id: feedbackId } }))
      .resolves.toMatchObject({ visibility: "unlisted" });
    await expect(prisma.character.findUniqueOrThrow({ where: { id: officialCharacterId } }))
      .resolves.toMatchObject({ visibility: "unlisted", status: "approved" });
    await expect(prisma.mediaCollection.findUniqueOrThrow({ where: { id: officialCollectionId } }))
      .resolves.toMatchObject({ visibility: "unlisted" });
    await expect(prisma.productFeedbackItem.findUniqueOrThrow({ where: { id: sourcedFeedbackId } }))
      .resolves.toMatchObject({ visibility: "unlisted" });
  });
});
