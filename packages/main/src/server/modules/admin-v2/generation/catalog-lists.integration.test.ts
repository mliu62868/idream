import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";

// SPEC: server-side paging and data provenance for the generation catalogue lists — model
//       profiles, prompt recipes, built-in presets, and the dead-letter queue.
// INTENT: ported from the v1 `remaining-canonical-lists` / `server-list-query` /
//         `inventory-provenance` suites when these resources moved to `/api/v2/admin/generation`.
// INVARIANT: a cursor is bound to the query that produced it — replaying it against different
//            filters is a 400, not a silently different page.
describe("generation catalogue lists (v2)", () => {
  const suffix = randomUUID();
  const token = `gen-lists-${suffix}`;
  const adminId = `${token}-admin`;
  const owners = {
    customer: `${token}-customer`,
    internal: `${token}-internal`,
    fixture: `${token}-fixture`,
    audit: `${token}-audit`,
  } as const;
  const jobIds = Object.fromEntries(
    Object.keys(owners).map((dataClass) => [dataClass, `${token}-job-${dataClass}`]),
  ) as Record<keyof typeof owners, string>;
  const pair = (kind: string) => [0, 1].map((index) => `${token}-${kind}-${index}`);
  const profileIds = pair("profile");
  const recipeIds = pair("recipe");
  const presetIds = pair("preset");

  const admin = { userId: adminId, role: "admin" };

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: adminId,
          email: `${adminId}@example.test`,
          role: "admin",
          status: "active",
          dataClass: "internal",
        },
        ...Object.entries(owners).map(([dataClass, id]) => ({
          id,
          email: `${id}@example.test`,
          role: "user",
          status: "active",
          dataClass,
        })),
      ],
    });
    await prisma.generationJob.createMany({
      data: Object.entries(owners).map(([dataClass, userId], index) => ({
        id: jobIds[dataClass as keyof typeof owners],
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        errorCode: token,
        sourceType: "generation_lists_test",
        sourceId: `${token}-source-${dataClass}`,
        updatedAt: new Date(Date.UTC(2026, 6, 11, 3, index)),
      })),
    });
    await prisma.generationModelProfile.createMany({
      data: profileIds.map((id, index) => ({
        id,
        profileKey: `${token}-profile-key-${index}`,
        label: `${token} profile ${index}`,
        mode: "image",
        pipelineModel: "test-model",
        allowedOrientations: ["1:1"],
        status: "draft",
      })),
    });
    await prisma.generationRecipe.createMany({
      data: recipeIds.map((id, index) => ({
        id,
        recipeKey: `${token}-recipe-key-${index}`,
        label: `${token} recipe ${index}`,
        mode: "image",
        useCase: "character",
        body: "prompt",
        presetOrder: [],
        safetyHints: {},
        sampleMatrix: [],
        status: "draft",
      })),
    });
    await prisma.generationPreset.createMany({
      data: presetIds.map((id, index) => ({
        id,
        scope: "built_in",
        type: "background",
        label: `${token} preset ${index}`,
        controls: {},
        visibility: "public",
        status: "active",
      })),
    });
  });

  afterAll(async () => {
    await prisma.generationPreset.deleteMany({ where: { id: { in: presetIds } } });
    await prisma.generationRecipe.deleteMany({ where: { id: { in: recipeIds } } });
    await prisma.generationModelProfile.deleteMany({ where: { id: { in: profileIds } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: Object.values(jobIds) } } });
    await prisma.user.deleteMany({
      where: { id: { in: [adminId, ...Object.values(owners)] } },
    });
    await prisma.$disconnect();
  });

  const pagedLists = [
    { name: "model profiles", path: "/api/v2/admin/generation/model-profiles", query: `search=${token}&mode=image` },
    { name: "recipes", path: "/api/v2/admin/generation/recipes", query: `search=${token}&status=draft` },
    { name: "presets", path: "/api/v2/admin/generation/presets", query: `search=${token}&type=background` },
    { name: "dead-letter", path: "/api/v2/admin/generation/dead-letter", query: `search=${token}&status=failed` },
  ] as const;

  for (const list of pagedLists) {
    it(`paginates ${list.name} with a query-bound cursor`, async () => {
      const first = await adminV2("GET", `${list.path}?${list.query}&limit=1`, admin);
      expect(first.status, JSON.stringify(first.error)).toBe(200);
      expect(first.data.items).toHaveLength(1);
      expect(first.data.pageInfo).toMatchObject({
        hasNextPage: true,
        endCursor: expect.any(String),
      });

      const cursor = encodeURIComponent(first.data.pageInfo.endCursor ?? "");
      const second = await adminV2("GET", `${list.path}?${list.query}&limit=1&cursor=${cursor}`, admin);
      expect(second.status, JSON.stringify(second.error)).toBe(200);
      expect(second.data.items).toHaveLength(1);
      expect(second.data.items[0].id).not.toBe(first.data.items[0].id);

      const mismatch = await adminV2(
        "GET",
        `${list.path}?${list.query.replace(token, "different")}&limit=1&cursor=${cursor}`,
        admin,
      );
      expect(mismatch.status).toBe(400);
    });
  }

  it("keeps the model-profile list unbounded when no limit is requested", async () => {
    const result = await adminV2(
      "GET",
      `/api/v2/admin/generation/model-profiles?search=${token}`,
      admin,
    );
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    expect(result.data.items).toHaveLength(2);
    expect(result.data.pageInfo).toEqual({ endCursor: null, hasNextPage: false });
  });

  it("rejects malformed catalogue queries at the boundary", async () => {
    for (const path of [
      "/api/v2/admin/generation/model-profiles?status=mystery",
      "/api/v2/admin/generation/model-profiles?limit=1junk",
      "/api/v2/admin/generation/recipes?unknown=value",
      "/api/v2/admin/generation/presets?type=mystery",
    ]) {
      const result = await adminV2("GET", path, admin);
      expect(result.status, path).toBe(400);
    }
  });

  it("limits the dead-letter queue to customer and internal owners", async () => {
    const result = await adminV2(
      "GET",
      `/api/v2/admin/generation/dead-letter?search=${token}&status=failed&limit=100`,
      admin,
    );
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    expect(new Set(
      (result.data.items as Array<{ id: string }>)
        .map((item) => item.id)
        .filter((id) => id.startsWith(`${token}-job-`)),
    )).toEqual(new Set([jobIds.customer, jobIds.internal]));
    expect(result.data.dataScope).toEqual({
      kind: "operational",
      includedDataClasses: ["customer", "internal"],
      excludedDataClasses: ["fixture", "audit"],
    });
  });

  it("reads a single recipe and preset through their detail routes", async () => {
    const recipe = await adminV2("GET", `/api/v2/admin/generation/recipes/${recipeIds[0]}`, admin);
    expect(recipe.status, JSON.stringify(recipe.error)).toBe(200);
    expect(recipe.data.recipe).toMatchObject({ id: recipeIds[0], status: "draft" });

    const preset = await adminV2("GET", `/api/v2/admin/generation/presets/${presetIds[0]}`, admin);
    expect(preset.status, JSON.stringify(preset.error)).toBe(200);
    expect(preset.data.preset).toMatchObject({ id: presetIds[0], scope: "built_in" });

    const missing = await adminV2("GET", "/api/v2/admin/generation/recipes/nope", admin);
    expect(missing.status).toBe(404);
  });
});
