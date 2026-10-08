import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { officialCharacterSeeds } from "@/lib/official-cold-start-content";

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
  const data = {
    profileKey: "profile_video_beta_v1",
    label: "Video beta",
    mode: "video",
    runner: "comfyui",
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
  };
  return prisma.generationModelProfile.upsert({
    where: { id: "seed-profile-video-beta-v1" },
    update: data,
    create: { id: "seed-profile-video-beta-v1", ...data },
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
        style: true,
        appearance: true,
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
    const expectedVisualIdentity = new Map(
      officialCharacterSeeds.map((character) => [character.id, character]),
    );
    for (const character of characters) {
      const expected = expectedVisualIdentity.get(character.id);
      expect(expected, character.id).toBeDefined();
      expect(character.style, character.id).toBe(expected?.style);
      expect(character.appearance, character.id).toMatchObject({
        identityAnchor: expected?.identityAnchor,
        stableTraits: expected?.stableTraits,
      });
    }
    expect(
      characters.every(
        (character) =>
          character.creatorId === "seed-system-creator" &&
          Boolean(
            (character.advancedDetails as {
              detailsMarkdown?: string;
              firstMessage?: string;
            }).detailsMarkdown?.trim(),
          ) &&
          Boolean(
            (character.advancedDetails as {
              firstMessage?: string;
            }).firstMessage?.trim(),
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
        version: true,
        runnerConfig: true,
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
        steps: 6,
        sampler: "euler",
        scheduler: "viggle_turbo",
        cfgScale: 1,
        version: 6,
        runnerConfig: expect.objectContaining({
          workflowVersion: 6,
          vaeTemporalPadding: "torch_cat",
          textEncoderPrecision: "int8_convrot",
          textEncoderDevice: "mps",
          conditioningPasses: 1,
          turboLora: expect.objectContaining({ rank: 128, alpha: 128, strength: 1, unmerged: true }),
          capabilities: expect.objectContaining({ referenceImages: true, lora: true }),
          textEncoderSha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
        }),
        enabled: true,
        rolloutPercent: 100,
        status: "active",
      },
      {
        profileKey: "character-image-variation",
        workflowKey: "qwen-image-edit-multi-reference",
        steps: 6,
        sampler: "euler",
        scheduler: "viggle_turbo",
        cfgScale: 1,
        version: 7,
        runnerConfig: expect.objectContaining({
          workflowVersion: 7,
          vaeTemporalPadding: "torch_cat",
          textEncoderPrecision: "int8_convrot",
          textEncoderDevice: "mps",
          conditioningPasses: 1,
          turboLora: expect.objectContaining({ rank: 128, alpha: 128, strength: 1, unmerged: true }),
          capabilities: expect.objectContaining({ referenceImages: true, lora: true }),
          textEncoderSha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
          publicSelection: { surface: "generator_image_edit" },
        }),
        enabled: true,
        rolloutPercent: 100,
        status: "active",
      },
      {
        profileKey: "chat-image-edit",
        workflowKey: "qwen-image-edit-img2img",
        steps: 6,
        sampler: "euler",
        scheduler: "viggle_turbo",
        cfgScale: 1,
        version: 5,
        runnerConfig: expect.objectContaining({
          workflowVersion: 5,
          vaeTemporalPadding: "torch_cat",
          textEncoderPrecision: "int8_convrot",
          textEncoderDevice: "mps",
          conditioningPasses: 1,
          turboLora: expect.objectContaining({ rank: 128, alpha: 128, strength: 1, unmerged: true }),
          textEncoderSha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
          publicSelection: { surface: "generator_image_edit" },
        }),
        enabled: true,
        rolloutPercent: 100,
        status: "active",
      },
    ]);
  });

  it("does not leave the retired Dark Beast Klein route executable", async () => {
    const profiles = await prisma.generationModelProfile.findMany({
      where: {
        OR: [
          { pipelineModel: "darkbeast-flux2-klein-9b-bfs" },
          { workflowKey: "darkbeast-flux2-klein-9b-multi-reference" },
        ],
      },
      select: {
        enabled: true,
        rolloutPercent: true,
        status: true,
      },
    });

    expect(
      profiles.every(
        (profile) =>
          profile.status === "archived" &&
          profile.enabled === false &&
          profile.rolloutPercent === 0,
      ),
    ).toBe(true);
  });

  it("retires executable Krea routes and preserves the single-identity profile contract on REDQW21 V2", async () => {
    const retiredActive = await prisma.generationModelProfile.count({
      where: {
        status: "active",
        OR: [
          { pipelineModel: { contains: "krea", mode: "insensitive" } },
          { workflowKey: { contains: "krea", mode: "insensitive" } },
          { sourceModelPath: { contains: "Krea", mode: "insensitive" } },
          { convertedModelPath: { contains: "RedMix3", mode: "insensitive" } },
        ],
      },
    });
    expect(retiredActive).toBe(0);

    const profile = await prisma.generationModelProfile.findFirstOrThrow({
      where: { profileKey: "character-image-single-identity-redcraft", status: "active" },
    });
    expect(profile).toMatchObject({
      pipelineModel: "redqw21-image-edit",
      workflowKey: "qwen-image-edit-img2img",
      sourceModelPath: expect.stringMatching(/redqw21_unlocked_v2_fp8\.safetensors$/),
      convertedModelPath: expect.stringMatching(/redqw21_unlocked_v2_bf16\.safetensors$/),
      steps: 6,
      scheduler: "viggle_turbo",
      version: 6,
      costMultiplier: 1.3,
      requiredEntitlement: null,
      enabled: true,
      rolloutPercent: 100,
      runnerConfig: {
        apiModelId: "redqw21-image-edit",
        workflowVersion: 5,
        precisionPolicy: "bf16_resident_mps",
        textEncoderPrecision: "int8_convrot",
        textEncoderDevice: "mps",
        publicSelection: { explicitOnly: true },
        turboLora: { unmerged: true, strength: 1 },
        capabilities: {
          textToImage: false,
          stableSeed: true,
          referenceImages: true,
          initImage: true,
          lora: true,
        },
      },
      dryRunSummary: { status: "not_run", source: "seed_configuration_state" },
    });
    expect(JSON.stringify(profile.runnerConfig)).not.toMatch(/krea|redmix3/i);
  });

  it("seeds REDQW21 for default and Premium while preserving Premium pricing and access", async () => {
    const profiles = await prisma.generationModelProfile.findMany({
      where: {
        profileKey: { in: ["profile_image_default_v1", "profile_image_premium_v1"] },
        status: "active",
      },
      orderBy: { profileKey: "asc" },
    });

    expect(profiles).toHaveLength(2);
    for (const profile of profiles) {
      expect(profile).toMatchObject({
        pipelineModel: "redqw21",
        workflowKey: "redqw21",
        runner: "comfyui",
        sourceModelPath: expect.stringMatching(/redqw21_bf16\.safetensors$/),
        convertedModelPath: null,
        defaultWidth: 512,
        defaultHeight: 512,
        steps: 10,
        scheduler: "simple",
        version: 4,
        runnerConfig: {
          workflowVersion: 3,
          vaeTemporalPadding: "torch_cat",
          textEncoderPrecision: "int8_convrot",
          textEncoderDevice: "cpu",
          textEncoderSha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
          capabilities: { textToImage: true, referenceImages: true, initImage: false },
        },
        enabled: true,
        rolloutPercent: 100,
      });
    }
    expect(profiles[0]).toMatchObject({
      profileKey: "profile_image_default_v1", costMultiplier: 1, requiredEntitlement: null, maxCount: 1,
    });
    expect(profiles[1]).toMatchObject({
      profileKey: "profile_image_premium_v1", costMultiplier: 1.5, requiredEntitlement: "premium_models", maxCount: 4,
      dryRunSummary: { status: "not_run", source: "seed_configuration_state" },
    });
    expect(profiles[1].runnerConfig).toEqual(profiles[0].runnerConfig);
  });

  it("archives the legacy LTX route and seeds RedGraft as the replacement", async () => {
    const profileId = "seed-profile-video-beta-v1";
    await writeLegacyVideoBetaProfile();

    await execFileAsync("bun", ["run", "db:seed"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: process.env,
    });

    const retired = await prisma.generationModelProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: {
        enabled: true,
        rolloutPercent: true,
        status: true,
        archivedAt: true,
      },
    });
    expect(retired).toMatchObject({
      enabled: false,
      rolloutPercent: 0,
      status: "archived",
    });
    expect(retired.archivedAt).not.toBeNull();

    await expect(
      prisma.generationModelProfile.findUniqueOrThrow({
        where: { id: "seed-profile-video-redgraft-ltx25-v1" },
        select: {
          profileKey: true,
          runner: true,
          pipelineModel: true,
          workflowKey: true,
          defaultWidth: true,
          defaultHeight: true,
          allowedOrientations: true,
          enabled: true,
          rolloutPercent: true,
          status: true,
          version: true,
          runnerConfig: true,
          dryRunSummary: true,
        },
      }),
    ).resolves.toEqual({
      profileKey: "profile_video_redgraft_ltx25_v1",
      runner: "comfyui",
      pipelineModel: "redgraft-ltx25-fast2k-int8-convrot",
      workflowKey: "redgraft-ltx25-i2v",
      defaultWidth: 448,
      defaultHeight: 768,
      allowedOrientations: ["7:12"],
      enabled: true,
      rolloutPercent: 100,
      status: "active",
      version: 8,
      runnerConfig: {
        workflowVersion: 5,
        capabilities: {
          textToImage: false,
          stableSeed: true,
          referenceImages: false,
          initImage: true,
          imageToVideo: true,
          audio: true,
          fps: 24,
          maxDurationSeconds: 5,
        },
      },
      dryRunSummary: expect.objectContaining({ status: "not_run", source: "seed_configuration_state" }),
    });
  }, 15_000);

  it("seeds MiniMax H3 as an explicit-only production video profile", async () => {
    await execFileAsync("bun", ["run", "db:seed"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: process.env,
    });

    const profile = await prisma.generationModelProfile.findUniqueOrThrow({
      where: { id: "seed-profile-video-h3-v1" },
      select: {
        profileKey: true,
        runner: true,
        pipelineModel: true,
        workflowKey: true,
        sourceModelPath: true,
        runnerConfig: true,
        defaultWidth: true,
        defaultHeight: true,
        allowedOrientations: true,
        steps: true,
        rolloutPercent: true,
      },
    });
    expect(profile).toMatchObject({
      profileKey: "profile_video_h3_v1",
      runner: "comfyui",
      pipelineModel: "minimax-h3-redcraft-a2a-int8-convrot",
      workflowKey: "minimax-h3-redcraft-i2v",
      sourceModelPath:
        "diffusion_models/REDMix-MiniMaxH3-A2Ab1-pruned-int8-convrot-ComfyMCP.safetensors",
      runnerConfig: {
        workflowVersion: 4,
        capabilities: {
          imageToVideo: true,
          audio: true,
          fps: 24,
          maxDurationSeconds: 5,
        },
        publicSelection: { explicitOnly: true },
      },
      defaultWidth: 512,
      defaultHeight: 512,
      allowedOrientations: ["1:1"],
      steps: 8,
      rolloutPercent: 100,
    });
  }, 15_000);

  it("preserves a modern operator release while still seeding MiniMax H3", async () => {
    const character = await prisma.character.findUniqueOrThrow({
      where: { id: "alexa-reeves" },
      select: {
        imageAssetId: true,
        serving: { select: { currentReleaseId: true } },
      },
    });
    const releaseId = character.serving?.currentReleaseId;
    expect(releaseId).toBeTruthy();
    const release = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: releaseId! },
      select: { legacy: true },
    });

    await prisma.characterRelease.update({
      where: { id: releaseId! },
      data: { legacy: false },
    });
    await prisma.character.update({
      where: { id: "alexa-reeves" },
      data: { imageAssetId: "seed-image-sarah-mercer" },
    });
    await prisma.generationModelProfile.delete({
      where: { id: "seed-profile-video-h3-v1" },
    });

    try {
      await execFileAsync("bun", ["run", "db:seed"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: process.env,
      });

      await expect(
        prisma.generationModelProfile.findUniqueOrThrow({
          where: { id: "seed-profile-video-h3-v1" },
          select: { profileKey: true },
        }),
      ).resolves.toEqual({ profileKey: "profile_video_h3_v1" });
      await expect(
        prisma.character.findUniqueOrThrow({
          where: { id: "alexa-reeves" },
          select: { imageAssetId: true },
        }),
      ).resolves.toEqual({ imageAssetId: "seed-image-sarah-mercer" });
    } finally {
      await prisma.character.update({
        where: { id: "alexa-reeves" },
        data: { imageAssetId: character.imageAssetId },
      });
      await prisma.characterRelease.update({
        where: { id: releaseId! },
        data: { legacy: release.legacy },
      });
      await execFileAsync("bun", ["run", "db:seed"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: process.env,
      });
    }
  }, 30_000);

  it("archives an operator-edited legacy video route without rewriting its evidence", async () => {
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
            enabled: true,
            rolloutPercent: true,
            status: true,
            archivedAt: true,
          },
        }),
      ).resolves.toMatchObject({
        runner: "comfyui",
        pipelineModel: "mock-video",
        workflowKey: null,
        costMultiplier: 1.25,
        enabled: false,
        rolloutPercent: 0,
        status: "archived",
        archivedAt: expect.any(Date),
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
    expect(characters).not.toContain("relationshipArchetype");
    expect(characters).toContain("resolveOfficialColdStartPersonaWrite({");
    expect(characters).toContain("...personaWrite.advancedDetails");
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
