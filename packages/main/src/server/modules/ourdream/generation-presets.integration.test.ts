import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createUser, dreamcoinBalance, expectError, expectOk, grantCoins, purgeTestData, type ApiResult } from "@/server/test/helpers";

const P = "zt-preset-query-";
const owner = `${P}owner`;
const viewer = `${P}viewer`;
const id = (scope: string, visibility: string, category = "outdoor") => `${P}${scope}-${visibility}-${category}`;
const ids = (response: ApiResult) => response.data.items.map((item: { id: string }) => item.id).sort();

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: owner });
  await createUser({ id: viewer });
  for (const scope of ["built_in", "community", "user"]) {
    for (const visibility of ["public", "private", "unlisted"]) {
      for (const category of ["outdoor", "indoor"]) {
        await prisma.generationPreset.create({ data: {
          id: id(scope, visibility, category), ownerId: owner, scope, visibility, category,
          type: "background", label: `Query preset ${scope} ${visibility} ${category}`,
          controls: { background: `${scope}-${visibility}-${category}-scene` },
        } });
      }
    }
  }
  await prisma.generationPreset.createMany({ data: [
    { id: `${P}pose`, ownerId: owner, scope: "community", type: "pose", category: "outdoor", label: "Query preset pose", controls: { pose: "standing" }, visibility: "public" },
    { id: `${P}archived`, ownerId: owner, scope: "community", type: "background", category: "outdoor", label: "Query preset archived", controls: { background: "archived-scene" }, visibility: "public", status: "archived" },
    { id: `${P}own-private`, ownerId: viewer, scope: "user", type: "outfit", category: "outdoor", label: "Own wardrobe", controls: { outfit: "own-private-wardrobe" }, visibility: "private" },
  ] });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.generationRecipe.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.pricingRule.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.generationModelProfile.deleteMany({ where: { id: { startsWith: P } } });
});

describe("generation preset catalog authority", () => {
  it("lists only public catalog entries for anonymous visitors, including Community", async () => {
    const result = await api("GET", "generation/presets", { ageGate: true, query: { q: "Query preset" } });
    expectOk(result);
    expect(ids(result)).toEqual([
      id("built_in", "public", "indoor"), id("built_in", "public"),
      id("community", "public", "indoor"), id("community", "public"), `${P}pose`,
    ].sort());
  });

  it("keeps private and unlisted catalog entries private to their owner", async () => {
    const other = await api("GET", "generation/presets", { userId: viewer, ageGate: true, query: { q: "Query preset" } });
    expectOk(other);
    expect(ids(other)).toEqual([
      id("built_in", "public", "indoor"), id("built_in", "public"),
      id("community", "public", "indoor"), id("community", "public"), `${P}pose`,
    ].sort());
    const own = await api("GET", "generation/presets", { userId: owner, ageGate: true, query: { q: "Query preset" } });
    expectOk(own);
    expect(ids(own)).toHaveLength(19);
    expect(ids(own)).toContain(id("community", "private"));
    expect(ids(own)).toContain(id("built_in", "unlisted"));
    expect(ids(own)).toContain(id("user", "private"));
    expect(ids(own)).not.toContain(`${P}archived`);
  });

  it.each([
    { scope: "built_in", category: "outdoor", q: "public", expected: [id("built_in", "public")] },
    { scope: "community", category: "indoor", q: "PUBLIC", expected: [id("community", "public", "indoor")] },
    { scope: "community", category: "outdoor", q: "private", expected: [] },
    { scope: "user", category: "outdoor", q: "public", expected: [] },
    { scope: "built_in", category: "missing", q: "public", expected: [] },
  ])("combines type/scope/category/query without widening visibility: $scope/$category/$q", async ({ scope, category, q, expected }) => {
    const result = await api("GET", "generation/presets", {
      userId: viewer, ageGate: true, query: { type: "background", scope, category, q },
    });
    expectOk(result);
    expect(ids(result)).toEqual(expected);
  });

  it("keeps the owner's private preset available under combined category filters", async () => {
    const result = await api("GET", "generation/presets", {
      userId: owner, ageGate: true,
      query: { type: "background", scope: "user", category: "indoor", q: "private" },
    });
    expectOk(result);
    expect(ids(result)).toEqual([id("user", "private", "indoor")]);
  });

  it("uses the same owner/public catalog boundary when reserving a real generation Job", async () => {
    await grantCoins(viewer, 50);
    // Only supply authority absent from a schema-only isolated database. In the
    // normal seeded suite this uses the existing production catalog and pricing.
    if (!await prisma.pricingRule.findFirst({ where: { mode: "image", status: "active" } })) {
      await prisma.pricingRule.create({ data: {
        id: `${P}pricing`, ruleKey: `${P}image`, label: "Preset image pricing", mode: "image", baseCost: 1,
        status: "active", publishedAt: new Date("2026-01-01"), effectiveFrom: new Date("2026-01-01"),
      } });
    }
    if (!await prisma.generationRecipe.findFirst({ where: { mode: "image", useCase: "freeplay", status: "active" } })) {
      await prisma.generationRecipe.create({ data: {
        id: `${P}recipe`, recipeKey: `${P}freeplay`, label: "Preset Freeplay", mode: "image", useCase: "freeplay",
        body: "Freeplay scene", presetOrder: [], safetyHints: {}, sampleMatrix: [], status: "active",
      } });
    }
    if (!await prisma.generationModelProfile.findFirst({ where: { mode: "image", status: "active", enabled: true } })) {
      await prisma.generationModelProfile.create({ data: {
        id: `${P}profile`, profileKey: `${P}text-to-image`, label: "Preset image route", mode: "image", runner: "comfyui",
        pipelineModel: "redcraft-krea2-redmix3-fp8", workflowKey: "redcraft-krea2-redmix3-txt2img",
        runnerConfig: { workflowVersion: 2, capabilities: { textToImage: true, stableSeed: true, referenceImages: false, initImage: false, lora: false } },
        version: 2, defaultWidth: 512, defaultHeight: 512, allowedOrientations: ["1:1"], maxCount: 1,
        status: "active", enabled: true, costMultiplier: 1,
      } });
    }
    const response = await api("POST", "generation/jobs", { userId: viewer, ageGate: true, body: {
      mode: "image", freeplay: true, outputCount: 1,
      controls: {
        modePresetId: id("built_in", "private"),
        backgroundPresetId: id("community", "public"),
        posePresetId: id("community", "private"),
        outfitPresetId: `${P}own-private`,
      },
    } });
    expectOk(response, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: response.data.job.id } });
    expect(job.status).toBe("queued");
    expect(job.prompt).toContain("community-public-outdoor-scene");
    expect(job.prompt).toContain("own-private-wardrobe");
    expect(job.prompt).not.toContain("built_in-private-outdoor-scene");
    expect(job.prompt).not.toContain("community-private-outdoor-scene");
    const attempts = await prisma.generationAttempt.findMany({ where: { requestId: job.id } });
    expect(attempts).toHaveLength(1);
    expect(await dreamcoinBalance(viewer)).toBe(50 - job.costDreamcoins);
    expect(await prisma.generationArtifact.count({ where: { attemptId: { in: attempts.map((attempt) => attempt.id) } } })).toBe(0);

    await grantCoins(owner, 50);
    const ownResponse = await api("POST", "generation/jobs", { userId: owner, ageGate: true, body: {
      mode: "image", freeplay: true, outputCount: 1,
      controls: {
        modePresetId: id("built_in", "unlisted"),
        backgroundPresetId: id("community", "unlisted"),
        posePresetId: id("user", "private"),
        outfitPresetId: `${P}archived`,
      },
    } });
    expectOk(ownResponse, 202);
    const ownJob = await prisma.generationJob.findUniqueOrThrow({ where: { id: ownResponse.data.job.id } });
    expect(ownJob.prompt).toContain("built_in-unlisted-outdoor-scene");
    expect(ownJob.prompt).toContain("community-unlisted-outdoor-scene");
    expect(ownJob.prompt).toContain("user-private-outdoor-scene");
    expect(ownJob.prompt).not.toContain("archived-scene");

    const crossAccountCreate = await api("POST", "generation/presets", { userId: viewer, ageGate: true,
      headers: { "x-idream-viewer-scope": `user:${owner}` }, body: { type: "background", label: `${P}Wrong account copy`, controls: { background: "Private old-account draft" } },
    });
    expectError(crossAccountCreate, 409, "conflict");
    expect(await prisma.generationPreset.count({ where: { label: `${P}Wrong account copy` } })).toBe(0);
    const created = await api("POST", "generation/presets", { userId: owner, ageGate: true, headers: { "x-idream-viewer-scope": `user:${owner}` }, body: {
      type: "background", label: `${P}Editable scene`, category: "Indoor", controls: { background: "Original window scene" },
    } });
    expectOk(created);
    const presetId = created.data.preset.id as string;
    const edited = await api("PATCH", `generation/presets/${presetId}`, { userId: owner, ageGate: true, body: {
      label: `${P}Evening window`, category: "Quiet scenes", controls: { background: "Amber lamps reflected in rainy glass" }, visibility: "private",
    } });
    expectOk(edited);
    expect(edited.data.preset).toMatchObject({ id: presetId, ownerId: owner, scope: "user", category: "Quiet scenes", visibility: "private" });
    for (const method of ["PATCH", "DELETE"]) {
      const changedAccount = await api(method, `generation/presets/${presetId}`, { userId: owner, ageGate: true,
        headers: { "x-idream-viewer-scope": `user:${viewer}` }, body: { label: "Wrong account edit" },
      });
      expectError(changedAccount, 409, "conflict");
    }
    expect(await prisma.generationPreset.findUnique({ where: { id: presetId } })).toMatchObject({ label: `${P}Evening window`, status: "active" });
    const filtered = await api("GET", "generation/presets", { userId: owner, ageGate: true, query: { scope: "user", category: "Quiet scenes", q: "Evening window" } });
    expect(ids(filtered)).toEqual([presetId]);
    const forbidden = await api("PATCH", `generation/presets/${presetId}`, { userId: viewer, ageGate: true, body: { label: "Changed by another viewer" } });
    expectError(forbidden, 404, "not_found");
    const generated = await api("POST", "generation/jobs", { userId: owner, ageGate: true, body: {
      mode: "image", freeplay: true, outputCount: 1, controls: { backgroundPresetId: presetId },
    } });
    expectOk(generated, 202);
    const savedJob = await prisma.generationJob.findUniqueOrThrow({ where: { id: generated.data.job.id } });
    expect(savedJob.prompt).toContain("Amber lamps reflected in rainy glass");
    expect(savedJob.prompt).not.toContain("Original window scene");
    const removed = await api("DELETE", `generation/presets/${presetId}`, { userId: owner, ageGate: true });
    expectOk(removed);
    const afterDelete = await api("GET", "generation/presets", { userId: owner, ageGate: true, query: { scope: "user", q: "Evening window" } });
    expect(ids(afterDelete)).toEqual([]);
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: savedJob.id } })).prompt).toBe(savedJob.prompt);
  });
});
