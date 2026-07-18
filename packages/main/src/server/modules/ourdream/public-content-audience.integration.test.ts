import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, expectOk } from "@/server/test/helpers";
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
  const releaseAssetIds = {
    avatar: `audience-release-avatar-${suffix}`,
    hero: `audience-release-hero-${suffix}`,
    chat: `audience-release-chat-${suffix}`,
  };
  const officialAssetId = `audience-official-asset-${suffix}`;
  const releaseProjectId = `audience-release-project-${suffix}`;
  const releaseId = `audience-release-${suffix}`;
  const releaseValidationRunId = `${releaseId}:validation`;
  const releaseQualificationId = `${releaseId}:catalog-qualification`;
  const officialReleaseProjectId = `audience-official-release-project-${suffix}`;
  const officialReleaseId = `audience-official-release-${suffix}`;
  const officialReleaseQualificationId = `${officialReleaseId}:catalog-qualification`;
  const releasePlacement = (
    slotKey: "character_avatar" | "character_hero" | "character_chat",
    assetId: string,
  ) => ({
    slotKey,
    assetId,
    slotVersion: 1,
    runId: `${releaseId}:${slotKey}:run`,
    itemId: `${releaseId}:${slotKey}:item`,
    reviewDecisionId: `${releaseId}:${slotKey}:decision`,
    generationJobId: `${releaseId}:${slotKey}:job`,
  });
  const strictReleaseManifest = () => ({
    schemaVersion: 2 as const,
    placements: [
      releasePlacement("character_avatar", releaseAssetIds.avatar),
      releasePlacement("character_hero", releaseAssetIds.hero),
      releasePlacement("character_chat", releaseAssetIds.chat),
    ],
  });

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
    await prisma.mediaAsset.createMany({
      data: [
        ...Object.entries(releaseAssetIds).map(([slot, id]) => ({
          id,
          ownerId: userIds.customer,
          type: "image",
          url: `/user-content/${id}/content.webp`,
          thumbnailUrl: `/user-content/${id}/thumbnail.webp`,
          storageKey: `tests/${id}/content.webp`,
          visibility: "public_pack",
          safetyStatus: "passed",
          metadata: { slot, synthetic: false, provider: "pipeline" },
        })),
        {
          id: officialAssetId,
          ownerId: userIds.internal,
          type: "image",
          url: `/user-content/${officialAssetId}/content.webp`,
          thumbnailUrl: `/user-content/${officialAssetId}/thumbnail.webp`,
          visibility: "public_pack",
          safetyStatus: "passed",
          metadata: { source: "editorial_import", synthetic: false },
        },
      ],
    });
    await prisma.character.createMany({
      data: [
        {
          id: characterIds.official,
          creatorId: userIds.internal,
          name: `Audience Official ${suffix}`,
          age: 24,
          description: "Official content remains visible.",
          visibility: "public",
          status: "approved",
          source: "official",
          style: "hybrid",
          gender: "male",
          imageAssetId: officialAssetId,
          appearance: {},
          advancedDetails: {},
        },
        {
          id: characterIds.customer,
          creatorId: userIds.customer,
          name: `Audience Customer ${suffix}`,
          age: 24,
          description: "Customer content is public.",
          visibility: "public",
          status: "approved",
          source: "user",
          style: "hybrid",
          gender: "male",
          imageAssetId: releaseAssetIds.avatar,
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
          name: `Audience Hidden ${suffix}`,
          age: 24,
          description: "Must not enter the public audience.",
          visibility: "public",
          status: "approved",
          source: "user",
          style: "hybrid",
          gender: "male",
          appearance: {},
          advancedDetails: {},
        })),
      ],
    });
    await prisma.mediaAsset.updateMany({
      where: { id: { in: Object.values(releaseAssetIds) } },
      data: { characterId: characterIds.customer },
    });
    await prisma.characterProject.create({
      data: {
        id: releaseProjectId,
        characterId: characterIds.customer,
        phase: "live_management",
        audience: {},
        successCriteria: [],
      },
    });
    await prisma.characterProject.create({
      data: {
        id: officialReleaseProjectId,
        characterId: characterIds.official,
        phase: "live_management",
        audience: {},
        successCriteria: [],
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId: releaseProjectId,
        revisionId: `${releaseId}:revision`,
        characterContentVersionId: `${releaseId}:content`,
        generationProvenance: {
          schemaVersion: "character-release-generation-provenance-v2",
          policyVersion: "character-release-policy-v2",
          requiredReleaseRoute: {
            routeFingerprint: `${releaseId}:route`,
            matrixKey: "public-audience-test",
            generationProfileKey: "public-audience-profile",
            generationProfileVersion: 1,
            workflowKey: "public-audience-workflow",
            workflowVersion: 1,
          },
          placements: [
            {
              slotKey: "character_avatar",
              assetId: releaseAssetIds.avatar,
              provider: "pipeline",
            },
            {
              slotKey: "character_hero",
              assetId: releaseAssetIds.hero,
              provider: "pipeline",
            },
            {
              slotKey: "character_chat",
              assetId: releaseAssetIds.chat,
              provider: "pipeline",
            },
          ],
        },
        releasePlacementManifest: strictReleaseManifest(),
        snapshotHash: `${releaseId}:snapshot`,
        readiness: "ready",
        status: "published",
        publishedAt: new Date(),
      },
    });
    await prisma.releaseValidationRun.create({
      data: {
        id: releaseValidationRunId,
        releaseId,
        snapshotHash: `${releaseId}:snapshot`,
        policyVersion: "character-release-policy-v2",
        result: "passed",
        finishedAt: new Date(),
      },
    });
    await prisma.publicCatalogQualification.create({
      data: {
        id: releaseQualificationId,
        releaseId,
        releaseSnapshotHash: `${releaseId}:snapshot`,
        kind: "generated_release",
        validationRunId: releaseValidationRunId,
        evidence: {
          schemaVersion: "public-catalog-qualification-v1",
          policyVersion: "character-release-policy-v2",
        },
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: officialReleaseId,
        projectId: officialReleaseProjectId,
        revisionId: `${officialReleaseId}:revision`,
        characterContentVersionId: `${officialReleaseId}:content`,
        generationProvenance: {
          schemaVersion: "character-release-editorial-import-v1",
          sourceAssetId: officialAssetId,
        },
        releasePlacementManifest: {
          schemaVersion: 1,
          kind: "editorial_import",
          placements: [
            {
              slotKey: "character_avatar",
              assetId: officialAssetId,
              slotVersion: 1,
            },
          ],
        },
        snapshotHash: `${officialReleaseId}:snapshot`,
        readiness: "ready",
        legacy: true,
        status: "published",
        publishedAt: new Date(),
      },
    });
    await prisma.publicCatalogQualification.create({
      data: {
        id: officialReleaseQualificationId,
        releaseId: officialReleaseId,
        releaseSnapshotHash: `${officialReleaseId}:snapshot`,
        kind: "editorial_import",
        evidence: {
          schemaVersion: "public-catalog-qualification-v1",
          policyVersion: "public-catalog-editorial-import-v1",
          sourceAssetId: officialAssetId,
        },
      },
    });
    await prisma.characterServing.create({
      data: {
        id: `${releaseId}:serving`,
        characterId: characterIds.customer,
        currentReleaseId: releaseId,
        state: "live",
      },
    });
    await prisma.characterServing.create({
      data: {
        id: `${officialReleaseId}:serving`,
        characterId: characterIds.official,
        currentReleaseId: officialReleaseId,
        state: "live",
      },
    });
    await prisma.characterStats.createMany({
      data: [
        { characterId: characterIds.official, viewsCount: 5 },
        { characterId: characterIds.customer, viewsCount: 7 },
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
          source: "official",
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
    await prisma.mediaCollectionItem.createMany({
      data: [
        {
          collectionId: collectionIds.official,
          mediaAssetId: officialAssetId,
        },
        {
          collectionId: collectionIds.customer,
          mediaAssetId: releaseAssetIds.hero,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.characterServing.deleteMany({
      where: { characterId: { in: [characterIds.customer, characterIds.official] } },
    });
    await prisma.publicCatalogQualification.deleteMany({
      where: { id: { in: [releaseQualificationId, officialReleaseQualificationId] } },
    });
    await prisma.releaseValidationRun.deleteMany({ where: { id: releaseValidationRunId } });
    await prisma.characterRelease.deleteMany({
      where: { id: { in: [releaseId, officialReleaseId] } },
    });
    await prisma.characterProject.deleteMany({
      where: { id: { in: [releaseProjectId, officialReleaseProjectId] } },
    });
    await prisma.productFeedbackItem.deleteMany({ where: { id: { in: Object.values(feedbackIds) } } });
    await prisma.mediaCollection.deleteMany({ where: { id: { in: Object.values(collectionIds) } } });
    await prisma.character.deleteMany({ where: { id: { in: Object.values(characterIds) } } });
    await prisma.mediaAsset.deleteMany({
      where: { id: { in: [...Object.values(releaseAssetIds), officialAssetId] } },
    });
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

  it("fails closed for an official character without a qualified live Release", async () => {
    const characterId = `audience-unqualified-official-${suffix}`;
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: userIds.internal,
        name: `Audience Unqualified Official ${suffix}`,
        age: 24,
        description: "Editorial ownership alone is not publication evidence.",
        visibility: "public",
        status: "approved",
        source: "official",
        style: "hybrid",
        gender: "female",
        appearance: {},
        advancedDetails: {},
      },
    });

    try {
      await expect(
        prisma.character.count({
          where: { AND: [publicCharacterAudienceWhere, { id: characterId }] },
        }),
      ).resolves.toBe(0);
    } finally {
      await prisma.character.delete({ where: { id: characterId } });
    }
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

  it("does not publish an empty collection", async () => {
    const collectionId = `audience-empty-collection-${suffix}`;
    await prisma.mediaCollection.create({
      data: {
        id: collectionId,
        ownerId: userIds.customer,
        name: "Empty public collection",
        visibility: "public",
        source: "user",
      },
    });

    try {
      await expect(
        prisma.mediaCollection.count({
          where: { AND: [publicCollectionAudienceWhere, { id: collectionId }] },
        }),
      ).resolves.toBe(0);
    } finally {
      await prisma.mediaCollection.delete({ where: { id: collectionId } });
    }
  });

  it.each([
    ["boolean", true],
    ["string", "true"],
    ["numeric", 1],
    ["yes", "yes"],
  ] as const)(
    "excludes %s synthetic markers even when legacy rows are marked public",
    async (markerName, marker) => {
      const assetId = `audience-synthetic-${markerName}-asset-${suffix}`;
      const characterId = `audience-synthetic-${markerName}-character-${suffix}`;
      const collectionId = `audience-synthetic-${markerName}-collection-${suffix}`;
      await prisma.mediaAsset.create({
        data: {
          id: assetId,
          ownerId: userIds.customer,
          type: "image",
          url: `/user-content/${assetId}/content.webp`,
          visibility: "public_pack",
          safetyStatus: "passed",
          metadata: { synthetic: marker, source: "mock" },
        },
      });
      await prisma.character.create({
        data: {
          id: characterId,
          creatorId: userIds.customer,
          name: "Synthetic legacy character",
          age: 24,
          description: "Must not enter the public audience.",
          visibility: "public",
          status: "approved",
          source: "user",
          style: "hybrid",
          gender: "female",
          imageAssetId: assetId,
          appearance: {},
          advancedDetails: {},
        },
      });
      await prisma.mediaCollection.create({
        data: {
          id: collectionId,
          ownerId: userIds.customer,
          name: "Synthetic legacy collection",
          visibility: "public",
          source: "user",
          items: { create: { mediaAssetId: assetId } },
        },
      });

      try {
        await expect(
          prisma.character.count({
            where: { AND: [publicCharacterAudienceWhere, { id: characterId }] },
          }),
        ).resolves.toBe(0);
        await expect(
          prisma.mediaCollection.count({
            where: { AND: [publicCollectionAudienceWhere, { id: collectionId }] },
          }),
        ).resolves.toBe(0);
      } finally {
        await prisma.mediaCollection.deleteMany({ where: { id: collectionId } });
        await prisma.character.deleteMany({ where: { id: characterId } });
        await prisma.mediaAsset.deleteMany({ where: { id: assetId } });
      }
    },
  );

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

  it("does not treat an arbitrary sourceKey as official feedback provenance", async () => {
    const feedbackId = `audience-source-key-spoof-${suffix}`;
    await prisma.productFeedbackItem.create({
      data: {
        id: feedbackId,
        sourceKey: `spoofed-official-${suffix}`,
        createdById: userIds.internal,
        title: "Internal source-key spoof",
        description: "A source key is identity, not provenance.",
      },
    });

    try {
      await expect(
        prisma.productFeedbackItem.count({
          where: { AND: [publicFeedbackAudienceWhere, { id: feedbackId }] },
        }),
      ).resolves.toBe(0);
    } finally {
      await prisma.productFeedbackItem.delete({ where: { id: feedbackId } });
    }
  });

  it("applies the audience boundary across catalog, search, feed, community, and creator reads", async () => {
    const allowedIds = [characterIds.official, characterIds.customer].sort();
    const hiddenIds = [
      characterIds.internal,
      characterIds.fixture,
      characterIds.orphan,
    ];

    const catalog = await api("GET", "characters", {
      ageGate: true,
      query: { q: suffix, style: "hybrid", gender: "male", limit: 60 },
    });
    expectOk(catalog);
    expect(
      (catalog.data.items as Array<{ id: string }>).map((item) => item.id).sort(),
    ).toEqual(allowedIds);

    const search = await api("GET", "search/suggest", {
      ageGate: true,
      query: { q: suffix },
    });
    expectOk(search);
    expect(
      (search.data.characters as Array<{ id: string }>).map((item) => item.id).sort(),
    ).toEqual(allowedIds);

    for (const characterId of allowedIds) {
      const focused = await api("GET", "feed", {
        ageGate: true,
        query: { item: `character:${characterId}`, limit: 20 },
      });
      expectOk(focused);
      expect(focused.data.focusedItemId).toBe(`character:${characterId}`);
    }
    for (const characterId of hiddenIds) {
      const focused = await api("GET", "feed", {
        ageGate: true,
        query: { item: `character:${characterId}`, limit: 20 },
      });
      expectOk(focused);
      expect(focused.data.focusedItemId).not.toBe(`character:${characterId}`);
    }

    const community = await api("GET", "community/leaderboards", {
      ageGate: true,
      query: { style: "hybrid", gender: "male" },
    });
    expectOk(community);
    expect(
      (
        community.data.leaderboards.characters as Array<{ id: string }>
      ).map((item) => item.id).sort(),
    ).toEqual(allowedIds);

    const customerCreator = await api("GET", `creators/${userIds.customer}`, {
      ageGate: true,
    });
    expectOk(customerCreator);
    expect(
      (customerCreator.data.characters as Array<{ id: string }>).map((item) => item.id),
    ).toEqual([characterIds.customer]);

    const fixtureCreator = await api("GET", `creators/${userIds.fixture}`, {
      ageGate: true,
    });
    expect(fixtureCreator.status).toBe(404);
  });

  it("keeps official and customer collections while hiding internal fixtures", async () => {
    const response = await api("GET", "community/collections", { ageGate: true });
    expectOk(response);
    const ids = (response.data.collections as Array<{ id: string }>)
      .map((collection) => collection.id);

    expect(ids).toContain(collectionIds.official);
    expect(ids).toContain(collectionIds.customer);
    expect(ids).not.toContain(collectionIds.internal);
    expect(ids).not.toContain(collectionIds.fixture);
  });

  it("does not mutate public view totals merely by reading character detail", async () => {
    const before = await prisma.characterStats.findUniqueOrThrow({
      where: { characterId: characterIds.customer },
    });

    const response = await api("GET", `characters/${characterIds.customer}`, {
      ageGate: true,
    });
    expectOk(response);

    const after = await prisma.characterStats.findUniqueOrThrow({
      where: { characterId: characterIds.customer },
    });
    expect(after.viewsCount).toBe(before.viewsCount);
  });

  it("fails closed generated malformed manifests from the public list while preserving legacy", async () => {
    const strictManifest = strictReleaseManifest();
    const malformedManifest = {
      ...strictManifest,
      placements: strictManifest.placements.map((placement) =>
        placement.slotKey === "character_chat"
          ? {
              slotKey: placement.slotKey,
              assetId: placement.assetId,
              slotVersion: placement.slotVersion,
              runId: placement.runId,
              itemId: placement.itemId,
              reviewDecisionId: placement.reviewDecisionId,
            }
          : placement
      ),
    };
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { releasePlacementManifest: malformedManifest },
    });
    try {
      const catalog = await api("GET", "characters", {
        ageGate: true,
        query: { q: suffix, style: "hybrid", gender: "male", limit: 60 },
      });
      expectOk(catalog);
      expect(
        (catalog.data.items as Array<{ id: string }>).map((item) => item.id),
      ).toEqual([characterIds.official]);

      const malformedDetail = await api(
        "GET",
        `characters/${characterIds.customer}`,
        { ageGate: true },
      );
      expect(malformedDetail.status).toBe(404);
      expectOk(await api("GET", `characters/${characterIds.official}`, {
        ageGate: true,
      }));
    } finally {
      await prisma.characterRelease.update({
        where: { id: releaseId },
        data: { releasePlacementManifest: strictReleaseManifest() },
      });
    }
  });

  it.each([
    ["hero", "archived"],
    ["chat", "blocked"],
  ] as const)(
    "returns no public detail when the current Release %s is %s in asset authority",
    async (slot, status) => {
      const assetId = releaseAssetIds[slot];
      await prisma.mediaAsset.update({
        where: { id: assetId },
        data: {
          metadata: {
            slot,
            synthetic: false,
            provider: "pipeline",
            platformAsset: { status },
          },
        },
      });
      try {
        const response = await api("GET", `characters/${characterIds.customer}`, {
          ageGate: true,
        });
        expect(response.status).toBe(404);
      } finally {
        await prisma.mediaAsset.update({
          where: { id: assetId },
          data: {
            metadata: {
              slot,
              synthetic: false,
              provider: "pipeline",
            },
          },
        });
      }
    },
  );

  it("serves the current Release hero on the public character detail", async () => {
    const response = await api("GET", `characters/${characterIds.customer}`, {
      ageGate: true,
    });
    expectOk(response);
    expect(response.data.character).toMatchObject({
      imageAssetId: releaseAssetIds.avatar,
      currentReleaseId: releaseId,
      heroImageAssetId: releaseAssetIds.hero,
      heroImage:
        `/user-content/${Buffer.from(releaseAssetIds.hero, "utf8").toString("base64url")}/content.webp`,
      imageAuthority: {
        source: "release",
        releaseId,
      },
    });
  });

  it("excludes a generated Release after its public qualification is revoked", async () => {
    await prisma.publicCatalogQualification.update({
      where: { id: releaseQualificationId },
      data: { revokedAt: new Date() },
    });
    await expect(
      prisma.character.count({
        where: {
          AND: [
            publicCharacterAudienceWhere,
            { id: characterIds.customer },
          ],
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.publicCatalogQualification.findUniqueOrThrow({
        where: { id: releaseQualificationId },
      }),
    ).resolves.toMatchObject({
      releaseId,
      revokedAt: expect.any(Date),
    });
  });
});
