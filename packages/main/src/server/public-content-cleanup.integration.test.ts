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
  const collectionId = `cleanup-collection-${suffix}`;
  const feedbackId = `cleanup-feedback-${suffix}`;

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
    await prisma.mediaCollection.create({
      data: {
        id: collectionId,
        ownerId: userId,
        name: "Cleanup collection",
        visibility: "public",
        source: "user",
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
  });

  afterAll(async () => {
    await prisma.productFeedbackItem.deleteMany({ where: { id: feedbackId } });
    await prisma.mediaCollection.deleteMany({ where: { id: collectionId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("plans a dry run without mutation and applies an unlisted transition without deleting content", async () => {
    const plan = await planPublicContentCleanup(prisma);

    expect(plan.characters).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: characterId, toVisibility: "unlisted" })]),
    );
    expect(plan.collections).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: collectionId, toVisibility: "unlisted" })]),
    );
    expect(plan.feedbackItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: feedbackId, toVisibility: "unlisted" })]),
    );
    await expect(prisma.character.findUniqueOrThrow({ where: { id: characterId } }))
      .resolves.toMatchObject({ visibility: "public" });

    const applied = await applyPublicContentCleanup(prisma, plan);
    expect(applied).toMatchObject({
      charactersUpdated: 1,
      collectionsUpdated: 1,
      feedbackItemsUpdated: 1,
    });
    await expect(prisma.character.findUniqueOrThrow({ where: { id: characterId } }))
      .resolves.toMatchObject({ visibility: "unlisted", status: "approved" });
    await expect(prisma.mediaCollection.findUniqueOrThrow({ where: { id: collectionId } }))
      .resolves.toMatchObject({ visibility: "unlisted" });
    await expect(prisma.productFeedbackItem.findUniqueOrThrow({ where: { id: feedbackId } }))
      .resolves.toMatchObject({ visibility: "unlisted" });
  });
});
