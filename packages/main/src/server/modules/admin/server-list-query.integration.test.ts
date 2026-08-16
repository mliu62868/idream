import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 as adminV2Api } from "@/server/test/admin-v2-http";

describe("server-backed compatibility lists", () => {
  const suffix = randomUUID();
  const actorId = `list-admin-${suffix}`;
  const token = `list-token-${suffix}`;
  const batchId = `list-batch-${suffix}`;
  const assetIds = [0, 1, 2].map((index) => `list-asset-${index}-${suffix}`);
  const placementIds = [0, 1, 2].map((index) => `list-placement-${index}-${suffix}`);
  const templateIds = [0, 1, 2].map((index) => `list-template-${index}-${suffix}`);
  const recipeIds = [0, 1, 2].map((index) => `list-recipe-${index}-${suffix}`);
  const presetIds = [0, 1, 2].map((index) => `list-preset-${index}-${suffix}`);

  type ListBody = {
    data?: {
      items: Array<{ id?: string; submissionId?: string }>;
      pageInfo: { endCursor: string | null; hasNextPage: boolean };
    };
    error?: unknown;
  };

  async function call(testCase: ListCase, query: string) {
    const result = await adminV2Api("GET", `${testCase.v2Path}?${query}`, {
      userId: actorId,
      role: "admin",
    });
    return { status: result.status, body: result.json as ListBody };
  }

  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" } });
    await prisma.mediaAsset.createMany({ data: assetIds.map((id, index) => ({
      id,
      ownerId: actorId,
      type: "image",
      url: `memory://${id}`,
      safetyStatus: "passed",
      metadata: { platform: { description: `${token} asset ${index}` } },
      createdAt: new Date(Date.UTC(2026, 6, 11, 12, index)),
    })) });
    await prisma.contentProductionBatch.create({ data: {
      id: batchId,
      title: `${token} batch`,
      purpose: "feed",
      targetType: "none",
      presetIds: [],
      count: 3,
      totalItems: 3,
      completedItems: 3,
      createdById: actorId,
      items: { create: assetIds.map((assetId, index) => ({
        id: `list-item-${index}-${suffix}`,
        itemIndex: index,
        mediaAssetId: assetId,
        status: "generated",
        tags: [token],
      })) },
    } });
    await prisma.mediaAssetPlacement.createMany({ data: placementIds.map((id, index) => ({
      id,
      mediaAssetId: assetIds[index],
      slot: "feed_card",
      targetType: "campaign",
      targetId: `${token}-${index}`,
      status: "draft",
      createdById: actorId,
      metadata: {},
      createdAt: new Date(Date.UTC(2026, 6, 11, 13, index)),
    })) });
    await prisma.generationRecipe.createMany({ data: recipeIds.map((id, index) => ({
      id,
      recipeKey: `${token}-${index}`,
      label: `${token} recipe ${index}`,
      mode: "image",
      useCase: "character",
      body: "prompt",
      presetOrder: [],
      safetyHints: {},
      sampleMatrix: [],
      status: "draft",
    })) });
    await prisma.generationPreset.createMany({ data: presetIds.map((id, index) => ({
      id,
      scope: "built_in",
      type: "background",
      label: `${token} preset ${index}`,
      controls: {},
      visibility: "public",
      status: "active",
    })) });
    await prisma.characterTemplate.createMany({ data: templateIds.map((id, index) => ({
      id,
      scope: "built_in",
      name: `${token} starter ${index}`,
      appearance: {},
      advancedDetails: {},
      tags: [],
      isActive: true,
      createdById: actorId,
    })) });
  });

  afterAll(async () => {
    await prisma.mediaAssetPlacement.deleteMany({ where: { id: { in: placementIds } } });
    await prisma.contentProductionItem.deleteMany({ where: { batchId } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: batchId } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
    await prisma.characterTemplate.deleteMany({ where: { id: { in: templateIds } } });
    await prisma.generationRecipe.deleteMany({ where: { id: { in: recipeIds } } });
    await prisma.generationPreset.deleteMany({ where: { id: { in: presetIds } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  type ListCase = {
    readonly label: string;
    readonly query: string;
    readonly v2Path: string;
  };

  const cases: readonly ListCase[] = [
    { label: "content/assets", query: `search=${token}&status=generated`, v2Path: "/api/v2/admin/assets" },
    { label: "content/placements", query: `search=${token}&status=draft`, v2Path: "/api/v2/admin/content/placements" },
    { label: "generation/recipes", query: `search=${token}&status=draft`, v2Path: "/api/v2/admin/generation/recipes" },
    { label: "generation/presets", query: `search=${token}&type=background`, v2Path: "/api/v2/admin/generation/presets" },
    { label: "content/templates", query: `search=${token}&scope=built_in`, v2Path: "/api/v2/admin/content/templates" },
  ];

  for (const testCase of cases) {
    it(`paginates ${testCase.label} on the server with a query-bound cursor`, async () => {
      const first = await call(testCase, `${testCase.query}&limit=1`);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.data?.items).toHaveLength(1);
      expect(first.body.data?.pageInfo).toMatchObject({ hasNextPage: true, endCursor: expect.any(String) });
      const cursor = first.body.data?.pageInfo.endCursor ?? "";
      const second = await call(testCase, `${testCase.query}&limit=1&cursor=${encodeURIComponent(cursor)}`);
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body.data?.items).toHaveLength(1);
      expect(second.body.data?.items[0]?.id).not.toBe(first.body.data?.items[0]?.id);
      const mismatchQuery = testCase.query.replace(/search=[^&]+/, "search=different");
      const mismatch = await call(testCase, `${mismatchQuery}&limit=1&cursor=${encodeURIComponent(cursor)}`);
      expect(mismatch.status).toBe(400);
    });
  }
});
