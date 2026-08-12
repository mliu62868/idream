import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

const curatedCharacterIds = [
  "melissa-burke",
  "summoned-world",
  "sarah-mercer",
  "alexa-reeves",
  "tamsin-jacobs",
  "truth-confessional",
  "truth-stepmother",
  "stephanie",
  "kennedy-graham",
  "eleanor-dawn",
  "bailey-price",
  "sophie",
  "raya-reyes",
  "emily-coming-home",
  "diana-weird-girl",
  "lola-moonstruck",
] as const;
const execFileAsync = promisify(execFile);

async function seedFunctionSource(name: string) {
  const source = await readFile(fileURLToPath(new URL("./seed.ts", import.meta.url)), "utf8");
  const start = source.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

async function writeLegacyVideoBetaProfile(costMultiplier = 1) {
  return prisma.generationModelProfile.update({
    where: { id: "seed-profile-video-beta-v1" },
    data: {
      profileKey: "profile_video_beta_v1",
      label: "Video beta",
      mode: "video",
      runner: "external",
      pipelineModel: "mock-video",
      workflowKey: null,
      sourceModelPath: null,
      convertedModelPath: null,
      modelFormat: "external",
      runnerConfig: { disabledUntilFlag: "video_gen" },
      defaultWidth: 768,
      defaultHeight: 1024,
      allowedOrientations: ["9:16", "16:9"],
      steps: 24,
      sampler: "video_default",
      scheduler: "model_default",
      cfgScale: 5,
      costMultiplier,
      requiredEntitlement: "video_generation",
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 0,
      version: 1,
      status: "active",
      dryRunSummary: {
        status: "not_run",
        source: "seed_configuration_state",
        disabledByFlag: "video_gen",
      },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
      archivedAt: null,
    },
  });
}

describe("seed data provenance", () => {
  it("separates the dedicated audit probe from internal operator users", async () => {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { id: { in: [
            "seed-system-creator",
            "seed-admin-user",
            "seed-dev-user",
            "seed-chat-probe-user",
            "seed-support-user",
            "seed-ops-user",
            "seed-analyst-user",
          ] } },
        ],
      },
      select: { id: true, dataClass: true },
    });

    expect(users).toHaveLength(7);
    expect(
      users.find((user) => user.id === "seed-chat-probe-user"),
    ).toEqual({
      id: "seed-chat-probe-user",
      dataClass: "audit",
    });
    expect(
      users
        .filter((user) => user.id !== "seed-chat-probe-user")
        .every((user) => user.dataClass === "internal"),
    ).toBe(true);
    await expect(
      prisma.user.count({ where: { id: { startsWith: "seed-creator-" } } }),
    ).resolves.toBe(0);
  });

  it("keeps curated cold-start content official without invented engagement", async () => {
    const characters = await prisma.character.findMany({
      where: { id: { in: [...curatedCharacterIds] } },
      select: {
        id: true,
        source: true,
        creatorId: true,
        relationship: true,
        advancedDetails: true,
        imageAssetId: true,
        imageAsset: {
          select: {
            id: true,
            characterId: true,
          },
        },
        serving: {
          select: {
            state: true,
            currentRelease: {
              select: {
                legacy: true,
                readiness: true,
                status: true,
                publishedAt: true,
                generationProvenance: true,
                releasePlacementManifest: true,
                publicCatalogQualification: {
                  select: {
                    kind: true,
                    validationRunId: true,
                    revokedAt: true,
                  },
                },
              },
            },
          },
        },
        stats: {
          select: {
            likesCount: true,
            chatsCount: true,
          },
        },
      },
    });
    const collections = await prisma.mediaCollection.findMany({
      where: { id: { startsWith: "seed-collection-" } },
      select: { id: true, source: true, _count: { select: { items: true } } },
    });
    const feedbackItems = await prisma.productFeedbackItem.findMany({
      where: { id: { startsWith: "seed-feedback-" } },
      select: { sourceKey: true, source: true, voteCount: true },
      orderBy: { sourceKey: "asc" },
    });

    expect(characters).toHaveLength(16);
    expect(characters.every((character) => character.source === "official")).toBe(true);
    expect(
      characters.every(
        (character) =>
          character.creatorId === "seed-system-creator" &&
          Boolean(character.relationship?.trim()) &&
          Boolean(
            (character.advancedDetails as {
              personality?: string;
              tone?: string;
              backstory?: string;
              firstMessage?: string;
              exampleDialogue?: string[];
            }).personality?.trim(),
          ) &&
          Boolean(
            (character.advancedDetails as {
              tone?: string;
            }).tone?.trim(),
          ) &&
          Boolean(
            (character.advancedDetails as {
              backstory?: string;
            }).backstory?.trim(),
          ) &&
          Boolean(
            (character.advancedDetails as {
              firstMessage?: string;
            }).firstMessage?.trim(),
          ) &&
          Boolean(
            (character.advancedDetails as {
              exampleDialogue?: string[];
            }).exampleDialogue?.length,
          ) &&
          (character.advancedDetails as {
            provenance?: { ownership?: string; originalCreator?: string };
          }).provenance?.ownership === "platform_official" &&
          Boolean(
            (character.advancedDetails as {
              provenance?: { originalCreator?: string };
            }).provenance?.originalCreator,
          ),
      ),
    ).toBe(true);
    expect(
      characters.every(
        (character) =>
          character.stats?.likesCount === 0 && character.stats.chatsCount === 0,
      ),
    ).toBe(true);
    expect(
      characters.every((character) => {
        const release = character.serving?.currentRelease;
        const provenance =
          release?.generationProvenance as Record<string, unknown> | undefined;
        const manifest =
          release?.releasePlacementManifest as {
            placements?: Array<Record<string, unknown>>;
          } | undefined;
        return character.imageAssetId === `seed-image-${character.id}` &&
          character.imageAsset?.id === character.imageAssetId &&
          character.imageAsset.characterId === character.id &&
          character.serving?.state === "live" &&
          release?.legacy === true &&
          release.readiness === "ready" &&
          release.status === "published" &&
          release.publishedAt !== null &&
          provenance?.schemaVersion === "character-release-editorial-import-v1" &&
          manifest?.placements?.length === 1 &&
          manifest.placements[0]?.slotKey === "character_avatar" &&
          manifest.placements[0]?.assetId === character.imageAssetId &&
          !("generationJobId" in manifest.placements[0]) &&
          release.publicCatalogQualification?.kind === "editorial_import" &&
          release.publicCatalogQualification.validationRunId === null &&
          release.publicCatalogQualification.revokedAt === null;
      }),
    ).toBe(true);
    expect(collections).toHaveLength(3);
    expect(collections.every((collection) => collection.source === "official")).toBe(true);
    expect(collections.every((collection) => collection._count.items > 0)).toBe(true);
    expect(feedbackItems).toEqual([
      { sourceKey: "chat-memory-review", source: "official", voteCount: 0 },
      { sourceKey: "creator-collections", source: "official", voteCount: 0 },
      { sourceKey: "generator-recipes", source: "official", voteCount: 0 },
    ]);
  });

  it("keeps Qwen Edit profile controls aligned with the executable ComfyUI graphs", async () => {
    const profiles = await prisma.generationModelProfile.findMany({
      where: {
        profileKey: {
          in: [
            "chat-image-edit",
            "character-image-variation",
            "character-image-multi-identity",
          ],
        },
      },
      select: {
        profileKey: true,
        workflowKey: true,
        steps: true,
        sampler: true,
        scheduler: true,
        cfgScale: true,
        enabled: true,
        rolloutPercent: true,
        status: true,
      },
      orderBy: { profileKey: "asc" },
    });

    expect(profiles).toEqual([
      {
        profileKey: "character-image-multi-identity",
        workflowKey: "qwen-image-edit-multi-identity",
        steps: 4,
        sampler: "sa_solver",
        scheduler: "beta",
        cfgScale: 1,
        enabled: true,
        rolloutPercent: 100,
        status: "active",
      },
      {
        profileKey: "character-image-variation",
        workflowKey: "qwen-image-edit-multi-reference",
        steps: 4,
        sampler: "sa_solver",
        scheduler: "beta",
        cfgScale: 1,
        enabled: true,
        rolloutPercent: 100,
        status: "active",
      },
      {
        profileKey: "chat-image-edit",
        workflowKey: "qwen-image-edit-img2img",
        steps: 4,
        sampler: "sa_solver",
        scheduler: "beta",
        cfgScale: 1,
        enabled: true,
        rolloutPercent: 100,
        status: "active",
      },
    ]);
  });

  it("keeps Dark Beast Klein as a disabled workflow-backed comparison candidate", async () => {
    const profile = await prisma.generationModelProfile.findFirst({
      where: { profileKey: "darkbeast-flux2-klein-bfs-comparison" },
      select: {
        profileKey: true,
        pipelineModel: true,
        workflowKey: true,
        runner: true,
        steps: true,
        sampler: true,
        scheduler: true,
        cfgScale: true,
        enabled: true,
        rolloutPercent: true,
        status: true,
        runnerConfig: true,
      },
    });

    expect(profile).toMatchObject({
      profileKey: "darkbeast-flux2-klein-bfs-comparison",
      pipelineModel: "darkbeast-flux2-klein-9b-bfs",
      workflowKey: "darkbeast-flux2-klein-9b-multi-reference",
      runner: "comfyui",
      steps: 5,
      sampler: "euler",
      scheduler: "flux2",
      cfgScale: 1,
      enabled: false,
      rolloutPercent: 0,
      status: "draft",
      runnerConfig: {
        baseModel: "Flux.2 Klein 9B",
        civitaiVersionId: 2740209,
        comparisonBaseline: {
          modelId: "qwen-image-edit-multi-reference",
          workflowKey: "qwen-image-edit-multi-reference",
        },
        componentStatus: {
          diffusionModel: {
            status: "configured",
            path: expect.stringMatching(
              /models\/diffusion_models\/darkBeastINT8Convrot2_dbkleinv2BFS\.safetensors$/,
            ),
          },
          qwenTextEncoder: {
            status: "configured",
            path: expect.stringMatching(
              /models\/text_encoders\/qwen_3_8b_fp8mixed\.safetensors$/,
            ),
          },
          flux2Vae: {
            status: "configured",
            path: expect.stringMatching(/models\/vae\/flux2-vae\.safetensors$/),
          },
          comfyWorkflow: {
            status: "registered",
            path: expect.stringMatching(
              /packages\/gen\/workflows\/darkbeast-flux2-klein-9b-multi-reference\.json$/,
            ),
          },
        },
        capabilities: {
          textToImage: false,
          stableSeed: true,
          referenceImages: true,
          initImage: true,
          lora: false,
        },
      },
    });
  });

  it("publishes the verified Dark Beast identity-edit route for explicit user selection", async () => {
    const profile = await prisma.generationModelProfile.findUnique({
      where: { id: "seed-profile-darkbeast-user-image-edit-v1" },
      select: {
        profileKey: true,
        label: true,
        pipelineModel: true,
        workflowKey: true,
        enabled: true,
        rolloutPercent: true,
        status: true,
        runnerConfig: true,
        dryRunSummary: true,
      },
    });

    expect(profile).toMatchObject({
      profileKey: "character-image-variation-darkbeast",
      label: "Dark Beast · Identity Focus",
      pipelineModel: "darkbeast-flux2-klein-9b-bfs",
      workflowKey: "darkbeast-flux2-klein-9b-multi-reference",
      enabled: true,
      rolloutPercent: 100,
      status: "active",
      runnerConfig: {
        publicSelection: {
          surface: "generator_image_edit",
          referenceMode: "identity_source",
          explicitOnly: true,
        },
      },
      dryRunSummary: {
        sampleCount: 1,
        successRate: 1,
        smokeOutputSha256:
          "be3f9252c37b9d203d4e4eb98b51d5a1e57e6c5de183a6944e54063b12f59f5a",
      },
    });
  });

  it("keeps RedMix3 as a disabled exact-version scaled-fp8 comparison candidate", async () => {
    const profile = await prisma.generationModelProfile.findFirst({
      where: { profileKey: "redcraft-krea2-redmix3-comparison" },
      select: {
        profileKey: true,
        pipelineModel: true,
        workflowKey: true,
        runner: true,
        sourceModelPath: true,
        convertedModelPath: true,
        steps: true,
        sampler: true,
        scheduler: true,
        cfgScale: true,
        enabled: true,
        rolloutPercent: true,
        status: true,
        runnerConfig: true,
      },
    });

    expect(profile).toMatchObject({
      profileKey: "redcraft-krea2-redmix3-comparison",
      pipelineModel: "redcraft-krea2-redmix3-fp8",
      workflowKey: "redcraft-krea2-redmix3-txt2img",
      runner: "comfyui",
      sourceModelPath: expect.stringMatching(
        /models\/diffusion_models\/Krea2RedMix3\.0-fp8-scaled-ComfyUI\.safetensors$/,
      ),
      // The Civitai release file runs as-is on MPS now; there is no conversion product.
      convertedModelPath: null,
      steps: 12,
      sampler: "euler",
      scheduler: "simple",
      cfgScale: 1,
      enabled: false,
      rolloutPercent: 0,
      status: "draft",
      runnerConfig: {
        templateIntent: "redmix3_text_to_image_comparison",
        baseModel: "Krea 2",
        civitaiModelId: 958009,
        civitaiVersionId: 3139241,
        civitaiFileId: 3019490,
        civitaiFileName: "redcraft23INT8INT4FP8_30Krea2.safetensors",
        civitaiSha256:
          "F6088960C0FEBD27CBD372FC758BB07D012F2D8AE3CD10C45C903D48B94409EA",
        comparisonBaseline: {
          modelId: "redcraft-krea2-redmix3-fp8",
          workflowKey: "redcraft-krea2-redmix3-txt2img",
        },
        capabilities: {
          textToImage: true,
          stableSeed: true,
          referenceImages: false,
          initImage: false,
          lora: false,
        },
      },
    });
  });

  it("seeds both public image routes on the registered RedMix3 descriptor", async () => {
    const profiles = await prisma.generationModelProfile.findMany({
      where: {
        profileKey: {
          in: ["profile_image_default_v1", "profile_image_premium_v1"],
        },
        status: "active",
      },
      select: {
        profileKey: true,
        pipelineModel: true,
        workflowKey: true,
        runner: true,
        enabled: true,
        rolloutPercent: true,
      },
      orderBy: { profileKey: "asc" },
    });

    expect(profiles).toEqual([
      {
        profileKey: "profile_image_default_v1",
        pipelineModel: "redcraft-krea2-redmix3-fp8",
        workflowKey: "redcraft-krea2-redmix3-txt2img",
        runner: "comfyui",
        enabled: true,
        rolloutPercent: 100,
      },
      {
        profileKey: "profile_image_premium_v1",
        pipelineModel: "redcraft-krea2-redmix3-fp8",
        workflowKey: "redcraft-krea2-redmix3-txt2img",
        runner: "comfyui",
        enabled: true,
        rolloutPercent: 100,
      },
    ]);
  });

  it("migrates the legacy Dark Beast row in place using a configurable ComfyUI model root", async () => {
    const profileId = "seed-profile-sdcpp-darkbeast-krea2-img2img-v1";
    await prisma.generationModelProfile.update({
      where: { id: profileId },
      data: {
        profileKey: "profile_sdcpp_darkbeast_krea2_img2img_v1",
        pipelineModel: "darkbeast-reference-candidate",
        workflowKey: null,
        runnerConfig: {
          templateIntent: "image_to_image_identity_reference",
        },
        status: "active",
        enabled: true,
        rolloutPercent: 100,
      },
    });

    const modelRoot = "/tmp/idream-darkbeast-model-root";
    await execFileAsync("bun", ["run", "db:seed"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        COMFYUI_MODEL_ROOT: modelRoot,
      },
    });

    const migrated = await prisma.generationModelProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: {
        id: true,
        profileKey: true,
        pipelineModel: true,
        workflowKey: true,
        runnerConfig: true,
        status: true,
        enabled: true,
        rolloutPercent: true,
      },
    });
    expect(migrated).toMatchObject({
      id: profileId,
      profileKey: "darkbeast-flux2-klein-bfs-comparison",
      pipelineModel: "darkbeast-flux2-klein-9b-bfs",
      workflowKey: "darkbeast-flux2-klein-9b-multi-reference",
      status: "draft",
      enabled: false,
      rolloutPercent: 0,
      runnerConfig: {
        diffusionModelPath: `${modelRoot}/diffusion_models/darkBeastINT8Convrot2_dbkleinv2BFS.safetensors`,
        textEncoderPath: `${modelRoot}/text_encoders/qwen_3_8b_fp8mixed.safetensors`,
        vaePath: `${modelRoot}/vae/flux2-vae.safetensors`,
        civitaiVersionId: 2740209,
        civitaiSha256:
          "B20B6F2744E152FD3EFA2638E88A5FEAB478C778EE25C81B183FD80E03A099C3",
      },
    });
    await expect(
      prisma.generationModelProfile.count({
        where: { profileKey: "profile_sdcpp_darkbeast_krea2_img2img_v1" },
      }),
    ).resolves.toBe(0);
  }, 15_000);

  it("migrates the untouched legacy video beta route to the exact LTX workflow", async () => {
    const profileId = "seed-profile-video-beta-v1";
    await writeLegacyVideoBetaProfile();

    await execFileAsync("bun", ["run", "db:seed"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: process.env,
    });

    const migrated = await prisma.generationModelProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: {
        runner: true,
        pipelineModel: true,
        workflowKey: true,
        sourceModelPath: true,
        modelFormat: true,
        runnerConfig: true,
        defaultWidth: true,
        defaultHeight: true,
        allowedOrientations: true,
        rolloutPercent: true,
      },
    });
    expect(migrated).toMatchObject({
      runner: "comfyui",
      pipelineModel: "ltx23-gtanimation-int4-convrot",
      workflowKey: "ltx23-gtanimation-i2v",
      sourceModelPath:
        "diffusion_models/ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors",
      modelFormat: "safetensors",
      runnerConfig: {
        workflowVersion: 1,
        capabilities: {
          imageToVideo: true,
          audio: true,
          fps: 25,
          maxDurationSeconds: 4,
        },
      },
      defaultWidth: 768,
      defaultHeight: 1152,
      allowedOrientations: ["2:3"],
      rolloutPercent: 100,
    });
  }, 15_000);

  it("preserves an operator-edited legacy video beta route", async () => {
    const profileId = "seed-profile-video-beta-v1";
    await writeLegacyVideoBetaProfile(1.25);

    try {
      await execFileAsync("bun", ["run", "db:seed"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: process.env,
      });

      await expect(
        prisma.generationModelProfile.findUniqueOrThrow({
          where: { id: profileId },
          select: {
            runner: true,
            pipelineModel: true,
            workflowKey: true,
            costMultiplier: true,
            rolloutPercent: true,
          },
        }),
      ).resolves.toEqual({
        runner: "external",
        pipelineModel: "mock-video",
        workflowKey: null,
        costMultiplier: 1.25,
        rolloutPercent: 0,
      });
    } finally {
      await writeLegacyVideoBetaProfile();
      await execFileAsync("bun", ["run", "db:seed"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: process.env,
      });
    }
  }, 30_000);

  it("only creates missing cold-start rows and preserves operator edits on repeat seed runs", async () => {
    const users = await seedFunctionSource("seedUsers");
    const characters = await seedFunctionSource("seedCharacters");
    const collections = await seedFunctionSource("seedCommunityCollections");
    const feedback = await seedFunctionSource("seedOfficialFeedbackItems");
    const plans = await seedFunctionSource("seedPlans");
    const presets = await seedFunctionSource("seedPresets");

    expect(users).not.toContain("seed-creator-");
    expect(characters).toContain('ownerId: SYSTEM_USER_ID');
    expect(characters).toContain('ownership: "platform_official"');
    expect(characters).toContain("existingProvenance.legacyCreatorId");
    expect(characters).toContain("originalOwnerId");
    expect(characters).toContain("hasExistingStructuredPersona");
    expect(characters).toContain("existingCharacter?.relationship?.trim()");
    expect(characters).toMatch(
      /officialAdvancedDetails:[\s\S]*?\.\.\.personaDetails,[\s\S]*?\.\.\.existingAdvancedDetails,/,
    );
    expect(characters).toMatch(
      /characterStats\.upsert\(\{[\s\S]*?update: \{\},/,
    );
    expect(collections).not.toContain("mediaCollectionItem.deleteMany");
    expect(collections).toMatch(
      /mediaCollection\.upsert\(\{[\s\S]*?ownerId: SYSTEM_USER_ID,[\s\S]*?mediaCollectionItem\.createMany/,
    );
    expect(feedback).toMatch(
      /productFeedbackItem\.upsert\(\{[\s\S]*?update: \{\},/,
    );
    expect(plans).toMatch(/plan\.upsert\(\{[\s\S]*?update: \{\},/);
    expect(presets).toMatch(
      /generationPreset\.upsert\(\{[\s\S]*?update: \{\},/,
    );
  });
});
