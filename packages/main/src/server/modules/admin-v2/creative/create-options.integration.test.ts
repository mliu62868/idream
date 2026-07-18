import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getCreativeRunOptions } from "@/app/api/v2/admin/creative/run-options/route";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { prisma } from "@/server/lib/db";
import { createUser } from "@/server/test/helpers";

describe("Creative Run create options projection", () => {
  const suffix = randomUUID();
  const operatorId = `creative-options-operator-${suffix}`;
  const profilePrefix = `creative-options-${suffix}`;
  const recipeKey = `creative-options-recipe-${suffix}`;

  beforeAll(async () => {
    await createUser({ id: operatorId, role: "support", dataClass: "internal" });
    await prisma.adminUserGrantBundle.create({
      data: {
        userId: operatorId,
        bundleKey: "creative_operator",
        reason: "Exercise the Creative operator projection without generation config access",
        createdById: operatorId,
      },
    });
    await prisma.generationRecipe.create({
      data: {
        id: `${recipeKey}-v1`,
        recipeKey,
        label: "Creative options freeplay",
        mode: "image",
        useCase: "freeplay",
        body: "Create a production-ready generic image.",
        presetOrder: [],
        safetyHints: {},
        sampleMatrix: [],
        version: 1,
        status: "active",
        publishedAt: new Date(),
      },
    });
    await prisma.generationModelProfile.createMany({
      data: [
        {
          id: `${profilePrefix}-compatible-v1`,
          profileKey: `${profilePrefix}-compatible`,
          label: "Compatible text to image",
          mode: "image",
          runner: "pipeline",
          pipelineModel: "redcraft-krea2-txt2img",
          workflowKey: "redcraft-krea2-txt2img",
          runnerConfig: {
            workflowVersion: 1,
            capabilities: { textToImage: true },
          },
          allowedOrientations: ["1:1", "16:9"],
          version: 1,
          status: "active",
          enabled: true,
          rolloutPercent: 100,
          publishedAt: new Date(),
        },
        {
          id: `${profilePrefix}-rollout-zero-v1`,
          profileKey: `${profilePrefix}-rollout-zero`,
          label: "Rollout zero",
          mode: "image",
          runner: "pipeline",
          pipelineModel: "redcraft-krea2-txt2img",
          workflowKey: "redcraft-krea2-txt2img",
          runnerConfig: {
            workflowVersion: 1,
            capabilities: { textToImage: true },
          },
          allowedOrientations: ["1:1"],
          version: 1,
          status: "active",
          enabled: true,
          rolloutPercent: 0,
          publishedAt: new Date(),
        },
        {
          id: `${profilePrefix}-reference-only-v1`,
          profileKey: `${profilePrefix}-reference-only`,
          label: "Reference only",
          mode: "image",
          runner: "pipeline",
          pipelineModel: "qwen-image-edit",
          workflowKey: "qwen-image-edit-img2img",
          runnerConfig: {
            workflowVersion: 1,
            capabilities: { textToImage: false, referenceImages: true, initImage: true },
          },
          allowedOrientations: ["4:5"],
          version: 1,
          status: "active",
          enabled: true,
          rolloutPercent: 100,
          publishedAt: new Date(),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.generationModelProfile.deleteMany({
      where: { profileKey: { startsWith: profilePrefix } },
    });
    await prisma.generationRecipe.deleteMany({ where: { recipeKey } });
    await prisma.adminUserGrantBundle.deleteMany({ where: { userId: operatorId } });
    await prisma.user.deleteMany({ where: { id: operatorId } });
    await prisma.$disconnect();
  });

  it("serves friendly compatible options without generation.config.read", async () => {
    const permissions = await effectivePermissions(operatorId, "support");
    expect(permissions).toContain("creative.run.read");
    expect(permissions).toContain("creative.placement.publish");
    expect(permissions).not.toContain("generation.config.read");

    const response = await getCreativeRunOptions(new Request(
      "http://localhost/api/v2/admin/creative/run-options",
      {
        headers: {
          "x-idream-user-id": operatorId,
          "x-idream-role": "support",
        },
      },
    ));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.readiness).toEqual({ ready: true, blocker: null });
    expect(payload.data.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profileKey: `${profilePrefix}-compatible`,
        recommended: expect.any(Boolean),
      }),
    ]));
    expect(payload.data.profiles).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ profileKey: `${profilePrefix}-rollout-zero` }),
      expect.objectContaining({ profileKey: `${profilePrefix}-reference-only` }),
    ]));
    expect(payload.data.purposes.map((purpose: { value: string }) => purpose.value)).toEqual([
      "campaign",
      "homepage",
      "feed",
      "seo",
      "template_cover",
    ]);
  });
});
