import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  publicCharacterAudienceWhere,
  publicCollectionAudienceWhere,
  publicFeedbackAudienceWhere,
} from "./public-content-audience";

describe("public content audience", () => {
  const suffix = randomUUID();
  const userIds = {
    customer: `audience-customer-${suffix}`,
    internal: `audience-internal-${suffix}`,
    fixture: `audience-fixture-${suffix}`,
  };
  const characterIds = {
    official: `audience-official-character-${suffix}`,
    customer: `audience-customer-character-${suffix}`,
    internal: `audience-internal-character-${suffix}`,
    fixture: `audience-fixture-character-${suffix}`,
    orphan: `audience-orphan-character-${suffix}`,
  };
  const collectionIds = {
    official: `audience-official-collection-${suffix}`,
    customer: `audience-customer-collection-${suffix}`,
    internal: `audience-internal-collection-${suffix}`,
    fixture: `audience-fixture-collection-${suffix}`,
  };
  const feedbackIds = {
    official: `audience-official-feedback-${suffix}`,
    customer: `audience-customer-feedback-${suffix}`,
    internal: `audience-internal-feedback-${suffix}`,
    fixture: `audience-fixture-feedback-${suffix}`,
  };

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: userIds.customer,
          email: `${userIds.customer}@customer.invalid`,
          dataClass: "customer",
        },
        {
          id: userIds.internal,
          email: `${userIds.internal}@idream.internal`,
          dataClass: "internal",
        },
        {
          id: userIds.fixture,
          email: `${userIds.fixture}@example.test`,
          dataClass: "fixture",
        },
      ],
    });
    await prisma.character.createMany({
      data: [
        {
          id: characterIds.official,
          creatorId: userIds.internal,
          name: "Official cold-start character",
          age: 24,
          description: "Official content remains visible.",
          visibility: "public",
          status: "approved",
          source: "official",
          appearance: {},
          advancedDetails: {},
        },
        {
          id: characterIds.customer,
          creatorId: userIds.customer,
          name: "Customer character",
          age: 24,
          description: "Customer content is public.",
          visibility: "public",
          status: "approved",
          source: "user",
          appearance: {},
          advancedDetails: {},
        },
        ...[
          [characterIds.internal, userIds.internal],
          [characterIds.fixture, userIds.fixture],
          [characterIds.orphan, null],
        ].map(([id, creatorId]) => ({
          id: id as string,
          creatorId,
          name: "Non-customer character",
          age: 24,
          description: "Must not enter the public audience.",
          visibility: "public",
          status: "approved",
          source: "user",
          appearance: {},
          advancedDetails: {},
        })),
      ],
    });
    await prisma.mediaCollection.createMany({
      data: [
        {
          id: collectionIds.official,
          ownerId: userIds.internal,
          name: "Official collection",
          visibility: "public",
          source: "official",
        },
        {
          id: collectionIds.customer,
          ownerId: userIds.customer,
          name: "Customer collection",
          visibility: "public",
          source: "user",
        },
        {
          id: collectionIds.internal,
          ownerId: userIds.internal,
          name: "Internal collection",
          visibility: "public",
          source: "user",
        },
        {
          id: collectionIds.fixture,
          ownerId: userIds.fixture,
          name: "Fixture collection",
          visibility: "public",
          source: "user",
        },
      ],
    });
    await prisma.productFeedbackItem.createMany({
      data: [
        {
          id: feedbackIds.official,
          sourceKey: `official-${suffix}`,
          createdById: userIds.internal,
          title: "Official roadmap item",
          description: "Editorial cold-start content.",
        },
        {
          id: feedbackIds.customer,
          createdById: userIds.customer,
          title: "Customer feedback",
          description: "Real customer feedback.",
        },
        {
          id: feedbackIds.internal,
          createdById: userIds.internal,
          title: "Internal feedback",
          description: "Not public user feedback.",
        },
        {
          id: feedbackIds.fixture,
          createdById: userIds.fixture,
          title: "Fixture feedback",
          description: "Not public user feedback.",
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.productFeedbackItem.deleteMany({ where: { id: { in: Object.values(feedbackIds) } } });
    await prisma.mediaCollection.deleteMany({ where: { id: { in: Object.values(collectionIds) } } });
    await prisma.character.deleteMany({ where: { id: { in: Object.values(characterIds) } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(userIds) } } });
  });

  it("includes official and customer-created characters only", async () => {
    const rows = await prisma.character.findMany({
      where: {
        AND: [
          publicCharacterAudienceWhere,
          { id: { in: Object.values(characterIds) } },
        ],
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });

    expect(rows.map((row) => row.id).sort()).toEqual(
      [characterIds.official, characterIds.customer].sort(),
    );
  });

  it("includes official and customer-owned collections only", async () => {
    const rows = await prisma.mediaCollection.findMany({
      where: {
        AND: [
          publicCollectionAudienceWhere,
          { id: { in: Object.values(collectionIds) } },
        ],
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });

    expect(rows.map((row) => row.id).sort()).toEqual(
      [collectionIds.official, collectionIds.customer].sort(),
    );
  });

  it("treats source-keyed roadmap items as official and otherwise requires a customer creator", async () => {
    const rows = await prisma.productFeedbackItem.findMany({
      where: {
        AND: [
          publicFeedbackAudienceWhere,
          { id: { in: Object.values(feedbackIds) } },
        ],
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });

    expect(rows.map((row) => row.id).sort()).toEqual(
      [feedbackIds.official, feedbackIds.customer].sort(),
    );
  });
});
