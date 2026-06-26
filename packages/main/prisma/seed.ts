import { PrismaClient } from "@prisma/client";
import {
  categoryFilters,
  characterCards,
  getOurdreamRoute,
  ourdreamRoutePaths,
} from "../src/lib/ourdream-data";
import { createPrismaClientOptions } from "../src/server/lib/prisma-adapter";
import { safetyDocuments } from "../src/lib/ourdream-safety-data";

process.env.DB_PROVIDER ??= "postgresql";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5433/idream";

const prisma = new PrismaClient(createPrismaClientOptions());

const SYSTEM_USER_ID = "seed-system-creator";
const ADMIN_USER_ID = "seed-admin-user";
const DEV_USER_ID = "seed-dev-user";
const SUPPORT_USER_ID = "seed-support-user";
const OPS_USER_ID = "seed-ops-user";
const ANALYST_USER_ID = "seed-analyst-user";
const Z_IMAGE_SOURCE_MODEL_PATH =
  "/Users/kk/Downloads/pornmasterZImage_turboV35Bf16.safetensors";
const Z_IMAGE_LLM_PATH =
  "/Users/kk/.localai/models/z-image-components/Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
const Z_IMAGE_VAE_PATH =
  "/Users/kk/.localai/models/z-image-components/split_files/vae/ae.safetensors";
const SDCPP_CLI_PATH = "/Users/kk/code/sdcpp/sd-cli";

const sensitiveTags = new Set(["teen", "bdsm", "virgin"]);

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseCount(value: string) {
  const normalized = value.trim().toLowerCase();
  const numeric = Number.parseFloat(normalized.replace(/[km]/g, ""));

  if (Number.isNaN(numeric)) return 0;
  if (normalized.endsWith("m")) return Math.round(numeric * 1_000_000);
  if (normalized.endsWith("k")) return Math.round(numeric * 1_000);
  return Math.round(numeric);
}

function parseAge(value: string) {
  const age = Number.parseInt(value, 10);
  return Number.isFinite(age) && age >= 18 ? age : 18;
}

function tagCategory(label: string) {
  const slug = slugify(label);

  if (["asian", "latina"].includes(slug)) return "ethnicity";
  if (["blonde", "redhead"].includes(slug)) return "hair";
  if (["busty", "athletic", "thick"].includes(slug)) return "body";
  if (["submissive", "dominant", "bdsm", "romantic", "slow-burn"].includes(slug)) {
    return "relationship";
  }
  if (["vampire", "cosplay", "elf", "demon"].includes(slug)) return "theme";
  return "theme";
}

function inferredTagSlugs(card: (typeof characterCards)[number]) {
  const haystack = `${card.title} ${card.description}`.toLowerCase();
  return categoryFilters
    .filter((label) => label !== "All")
    .map(slugify)
    .filter((slug) => haystack.includes(slug.replace(/-/g, " ")));
}

async function seedUsers() {
  await prisma.user.upsert({
    where: { id: SYSTEM_USER_ID },
    update: {},
    create: {
      id: SYSTEM_USER_ID,
      email: "system@idream.local",
      emailVerified: true,
      displayName: "System Creator",
      role: "admin",
    },
  });

  await prisma.user.upsert({
    where: { id: ADMIN_USER_ID },
    update: {},
    create: {
      id: ADMIN_USER_ID,
      email: "admin@idream.local",
      emailVerified: true,
      displayName: "Admin",
      role: "admin",
    },
  });

  await prisma.user.upsert({
    where: { id: DEV_USER_ID },
    update: {},
    create: {
      id: DEV_USER_ID,
      email: "user@idream.local",
      emailVerified: true,
      displayName: "Dev User",
      role: "user",
    },
  });

  await prisma.user.upsert({
    where: { id: SUPPORT_USER_ID },
    update: {},
    create: {
      id: SUPPORT_USER_ID,
      email: "support@idream.local",
      emailVerified: true,
      displayName: "Support",
      role: "support",
    },
  });

  await prisma.user.upsert({
    where: { id: OPS_USER_ID },
    update: {},
    create: {
      id: OPS_USER_ID,
      email: "ops@idream.local",
      emailVerified: true,
      displayName: "Ops",
      role: "ops",
    },
  });

  await prisma.user.upsert({
    where: { id: ANALYST_USER_ID },
    update: {},
    create: {
      id: ANALYST_USER_ID,
      email: "analyst@idream.local",
      emailVerified: true,
      displayName: "Analyst",
      role: "analyst",
    },
  });

  await prisma.dreamcoinLedger.upsert({
    where: { id: "seed-admin-signup-bonus" },
    update: {},
    create: {
      id: "seed-admin-signup-bonus",
      userId: ADMIN_USER_ID,
      delta: 1_000,
      balanceAfter: 1_000,
      reason: "signup_bonus",
      sourceId: "seed",
    },
  });

  await prisma.dreamcoinLedger.upsert({
    where: { id: "seed-user-signup-bonus" },
    update: {},
    create: {
      id: "seed-user-signup-bonus",
      userId: DEV_USER_ID,
      delta: 250,
      balanceAfter: 250,
      reason: "signup_bonus",
      sourceId: "seed",
    },
  });
}

async function seedTags() {
  for (const label of categoryFilters.filter((item) => item !== "All")) {
    const slug = slugify(label);

    await prisma.tag.upsert({
      where: { slug },
      update: {
        label,
        category: tagCategory(label),
        isSensitive: sensitiveTags.has(slug),
        isMutedByDefault: slug === "teen",
      },
      create: {
        slug,
        label,
        category: tagCategory(label),
        isSensitive: sensitiveTags.has(slug),
        isMutedByDefault: slug === "teen",
      },
    });
  }
}

async function seedCharacters() {
  for (const card of characterCards) {
    const mediaAssetId = `seed-image-${card.id}`;

    await prisma.mediaAsset.upsert({
      where: { id: mediaAssetId },
      update: {
        url: card.image,
        thumbnailUrl: card.image,
        prompt: card.description,
        visibility: "public_pack",
        safetyStatus: "passed",
      },
      create: {
        id: mediaAssetId,
        ownerId: SYSTEM_USER_ID,
        type: "image",
        url: card.image,
        thumbnailUrl: card.image,
        prompt: card.description,
        visibility: "public_pack",
        safetyStatus: "passed",
        metadata: {
          seedSource: "src/lib/ourdream-data.ts",
          originalCreator: card.creator,
        },
      },
    });

    await prisma.character.upsert({
      where: { id: card.id },
      update: {
        name: card.title,
        age: parseAge(card.age),
        description: card.description,
        visibility: "public",
        status: "approved",
        imageAssetId: mediaAssetId,
        vivid: card.vivid ?? false,
      },
      create: {
        id: card.id,
        creatorId: SYSTEM_USER_ID,
        name: card.title,
        age: parseAge(card.age),
        description: card.description,
        visibility: "public",
        status: "approved",
        style: card.title.toLowerCase().includes("anime") ? "anime" : "realistic",
        gender: "female",
        relationship: card.creator,
        imageAssetId: mediaAssetId,
        vivid: card.vivid ?? false,
        appearance: {
          sourceImage: card.image,
        },
        advancedDetails: {},
      },
    });

    await prisma.characterStats.upsert({
      where: { characterId: card.id },
      update: {
        likesCount: parseCount(card.likes),
        chatsCount: parseCount(card.chats),
      },
      create: {
        characterId: card.id,
        likesCount: parseCount(card.likes),
        chatsCount: parseCount(card.chats),
      },
    });

    for (const slug of inferredTagSlugs(card)) {
      const tag = await prisma.tag.findUnique({ where: { slug } });
      if (!tag) continue;

      await prisma.characterTag.upsert({
        where: {
          characterId_tagId: {
            characterId: card.id,
            tagId: tag.id,
          },
        },
        update: {},
        create: {
          characterId: card.id,
          tagId: tag.id,
        },
      });
    }
  }
}

async function seedPlans() {
  const plans = [
    {
      slug: "premium",
      name: "Premium",
      billingPeriod: "monthly",
      priceCents: 1_999,
      includedDreamcoins: 1_500,
      features: {
        unlimitedMessages: true,
        imageGeneration: true,
        videoGeneration: false,
        voiceMinutes: 30,
      },
    },
    {
      slug: "premium",
      name: "Premium",
      billingPeriod: "yearly",
      priceCents: 9_990,
      includedDreamcoins: 18_000,
      features: {
        unlimitedMessages: true,
        imageGeneration: true,
        videoGeneration: false,
        voiceMinutes: 360,
      },
    },
    {
      slug: "deluxe",
      name: "Deluxe",
      billingPeriod: "monthly",
      priceCents: 5_999,
      includedDreamcoins: 6_000,
      features: {
        unlimitedMessages: true,
        imageGeneration: true,
        videoGeneration: true,
        voiceMinutes: 120,
        premiumModels: true,
      },
    },
    {
      slug: "deluxe",
      name: "Deluxe",
      billingPeriod: "yearly",
      priceCents: 29_990,
      includedDreamcoins: 72_000,
      features: {
        unlimitedMessages: true,
        imageGeneration: true,
        videoGeneration: true,
        voiceMinutes: 1_440,
        premiumModels: true,
      },
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: {
        slug_billingPeriod: {
          slug: plan.slug,
          billingPeriod: plan.billingPeriod,
        },
      },
      update: plan,
      create: plan,
    });
  }
}

async function seedPresets() {
  const presets = [
    {
      id: "seed-preset-background-bedroom",
      type: "background",
      label: "Bedroom",
      controls: { background: "bedroom", lighting: "soft" },
    },
    {
      id: "seed-preset-background-studio",
      type: "background",
      label: "Studio",
      controls: { background: "studio", lighting: "cinematic" },
    },
    {
      id: "seed-preset-pose-portrait",
      type: "pose",
      label: "Portrait",
      controls: { crop: "portrait", pose: "standing" },
    },
    {
      id: "seed-preset-outfit-casual",
      type: "outfit",
      label: "Casual",
      controls: { outfit: "casual" },
    },
    {
      id: "seed-preset-mode-realistic",
      type: "mode",
      label: "Realistic",
      controls: { style: "realistic" },
    },
    {
      id: "seed-preset-mode-anime",
      type: "mode",
      label: "Anime",
      controls: { style: "anime" },
    },
  ];

  for (const preset of presets) {
    await prisma.generationPreset.upsert({
      where: { id: preset.id },
      update: {
        scope: "built_in",
        type: preset.type,
        label: preset.label,
        controls: preset.controls,
        visibility: "public",
        status: "active",
      },
      create: {
        id: preset.id,
        scope: "built_in",
        type: preset.type,
        label: preset.label,
        controls: preset.controls,
        visibility: "public",
        status: "active",
      },
    });
  }
}

async function seedAdminControlPlane() {
  await prisma.featureFlag.upsert({
    where: { key: "video_gen" },
    update: {
      label: "Video generation",
      description: "Single gate for all video generation traffic.",
      enabled: false,
      rolloutPercent: 0,
      targetRoles: [],
      targetPlans: ["deluxe"],
      hardPolicy: false,
    },
    create: {
      key: "video_gen",
      label: "Video generation",
      description: "Single gate for all video generation traffic.",
      enabled: false,
      rolloutPercent: 0,
      targetRoles: [],
      targetPlans: ["deluxe"],
      hardPolicy: false,
    },
  });

  await prisma.featureFlag.upsert({
    where: { key: "image_edit" },
    update: {
      label: "Image edit",
      description: "Unlocks the image edit surface when providers are ready.",
      enabled: false,
      rolloutPercent: 0,
      targetRoles: [],
      targetPlans: [],
      hardPolicy: false,
    },
    create: {
      key: "image_edit",
      label: "Image edit",
      description: "Unlocks the image edit surface when providers are ready.",
      enabled: false,
      rolloutPercent: 0,
      targetRoles: [],
      targetPlans: [],
      hardPolicy: false,
    },
  });

  await prisma.generationPromptTemplate.upsert({
    where: { id: "seed-template-image-character-v1" },
    update: {
      templateKey: "template_image_character_default",
      label: "Image character default",
      mode: "image",
      useCase: "character",
      body: "Character image generation template with appearance, pose, outfit, background, style, and quality blocks.",
      negativeBase: "low quality, distorted anatomy, extra fingers, watermark, text",
      presetOrder: ["background", "pose", "outfit", "mode"],
      safetyHints: { hardPolicies: ["age_under_18", "real_person_nonconsensual"] },
      sampleMatrix: [{ character: "seed", orientation: "4:5", presets: ["background", "pose"] }],
      dryRunSummary: { sampleCount: 6, successRate: 1, blockedRate: 0 },
      version: 1,
      status: "active",
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    create: {
      id: "seed-template-image-character-v1",
      templateKey: "template_image_character_default",
      label: "Image character default",
      mode: "image",
      useCase: "character",
      body: "Character image generation template with appearance, pose, outfit, background, style, and quality blocks.",
      negativeBase: "low quality, distorted anatomy, extra fingers, watermark, text",
      presetOrder: ["background", "pose", "outfit", "mode"],
      safetyHints: { hardPolicies: ["age_under_18", "real_person_nonconsensual"] },
      sampleMatrix: [{ character: "seed", orientation: "4:5", presets: ["background", "pose"] }],
      dryRunSummary: { sampleCount: 6, successRate: 1, blockedRate: 0 },
      version: 1,
      status: "active",
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
  });

  await prisma.generationPromptTemplate.upsert({
    where: { id: "seed-template-image-freeplay-v1" },
    update: {
      templateKey: "template_image_freeplay_default",
      label: "Image freeplay default",
      mode: "image",
      useCase: "freeplay",
      body: "Freeplay image generation template with user prompt, style, preset fragments, and quality blocks.",
      negativeBase: "low quality, distorted anatomy, watermark, text",
      presetOrder: ["background", "pose", "outfit", "mode"],
      safetyHints: { hardPolicies: ["age_under_18", "real_person_nonconsensual"] },
      sampleMatrix: [{ freeplay: true, orientation: "1:1" }],
      dryRunSummary: { sampleCount: 4, successRate: 1, blockedRate: 0 },
      version: 1,
      status: "active",
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    create: {
      id: "seed-template-image-freeplay-v1",
      templateKey: "template_image_freeplay_default",
      label: "Image freeplay default",
      mode: "image",
      useCase: "freeplay",
      body: "Freeplay image generation template with user prompt, style, preset fragments, and quality blocks.",
      negativeBase: "low quality, distorted anatomy, watermark, text",
      presetOrder: ["background", "pose", "outfit", "mode"],
      safetyHints: { hardPolicies: ["age_under_18", "real_person_nonconsensual"] },
      sampleMatrix: [{ freeplay: true, orientation: "1:1" }],
      dryRunSummary: { sampleCount: 4, successRate: 1, blockedRate: 0 },
      version: 1,
      status: "active",
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
  });

  await prisma.generationPromptTemplate.upsert({
    where: { id: "seed-template-video-character-v1" },
    update: {
      templateKey: "template_video_character_default",
      label: "Video character beta",
      mode: "video",
      useCase: "character",
      body: "Video generation beta template. Draftable while video_gen is disabled.",
      negativeBase: "low quality, flicker, watermark, text",
      presetOrder: ["pose", "mode"],
      safetyHints: { disabledUntilFlag: "video_gen" },
      sampleMatrix: [{ character: "seed", seconds: 4 }],
      dryRunSummary: { sampleCount: 2, successRate: 1, blockedRate: 0 },
      version: 1,
      status: "active",
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    create: {
      id: "seed-template-video-character-v1",
      templateKey: "template_video_character_default",
      label: "Video character beta",
      mode: "video",
      useCase: "character",
      body: "Video generation beta template. Draftable while video_gen is disabled.",
      negativeBase: "low quality, flicker, watermark, text",
      presetOrder: ["pose", "mode"],
      safetyHints: { disabledUntilFlag: "video_gen" },
      sampleMatrix: [{ character: "seed", seconds: 4 }],
      dryRunSummary: { sampleCount: 2, successRate: 1, blockedRate: 0 },
      version: 1,
      status: "active",
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
  });

  await prisma.generationModelProfile.upsert({
    where: { id: "seed-profile-image-default-v1" },
    update: {
      profileKey: "profile_image_default_v1",
      label: "Default image",
      mode: "image",
      runner: "sd_cpp",
      pipelineModel: "pornmaster-zimage-turbo",
      sourceModelPath: Z_IMAGE_SOURCE_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        cliPath: SDCPP_CLI_PATH,
        llmPath: Z_IMAGE_LLM_PATH,
        vaePath: Z_IMAGE_VAE_PATH,
        apiModelId: "pornmaster-zimage-turbo",
      },
      defaultWidth: 768,
      defaultHeight: 1024,
      allowedOrientations: ["1:1", "4:5", "3:4", "9:16", "16:9"],
      steps: 28,
      sampler: "dpmpp_2m",
      cfgScale: 7,
      negativeTemplateId: "template_image_character_default",
      costMultiplier: 1,
      requiredEntitlement: null,
      maxCount: 4,
      concurrencyLimit: 2,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: { sampleCount: 6, successRate: 1, p95LatencyMs: 900 },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    create: {
      id: "seed-profile-image-default-v1",
      profileKey: "profile_image_default_v1",
      label: "Default image",
      mode: "image",
      runner: "sd_cpp",
      pipelineModel: "pornmaster-zimage-turbo",
      sourceModelPath: Z_IMAGE_SOURCE_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        cliPath: SDCPP_CLI_PATH,
        llmPath: Z_IMAGE_LLM_PATH,
        vaePath: Z_IMAGE_VAE_PATH,
        apiModelId: "pornmaster-zimage-turbo",
      },
      defaultWidth: 768,
      defaultHeight: 1024,
      allowedOrientations: ["1:1", "4:5", "3:4", "9:16", "16:9"],
      steps: 28,
      sampler: "dpmpp_2m",
      cfgScale: 7,
      negativeTemplateId: "template_image_character_default",
      costMultiplier: 1,
      requiredEntitlement: null,
      maxCount: 4,
      concurrencyLimit: 2,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: { sampleCount: 6, successRate: 1, p95LatencyMs: 900 },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
  });

  await prisma.generationModelProfile.upsert({
    where: { id: "seed-profile-image-premium-v1" },
    update: {
      profileKey: "profile_image_premium_v1",
      label: "Premium image",
      mode: "image",
      runner: "sd_cpp",
      pipelineModel: "pornmaster-zimage-turbo",
      sourceModelPath: Z_IMAGE_SOURCE_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        cliPath: SDCPP_CLI_PATH,
        llmPath: Z_IMAGE_LLM_PATH,
        vaePath: Z_IMAGE_VAE_PATH,
        apiModelId: "pornmaster-zimage-turbo",
      },
      defaultWidth: 1024,
      defaultHeight: 1365,
      allowedOrientations: ["1:1", "4:5", "3:4", "9:16", "16:9"],
      steps: 36,
      sampler: "dpmpp_2m",
      cfgScale: 6.5,
      negativeTemplateId: "template_image_character_default",
      costMultiplier: 1.5,
      requiredEntitlement: "premium_models",
      maxCount: 4,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: { sampleCount: 6, successRate: 1, p95LatencyMs: 1200 },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    create: {
      id: "seed-profile-image-premium-v1",
      profileKey: "profile_image_premium_v1",
      label: "Premium image",
      mode: "image",
      runner: "sd_cpp",
      pipelineModel: "pornmaster-zimage-turbo",
      sourceModelPath: Z_IMAGE_SOURCE_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        cliPath: SDCPP_CLI_PATH,
        llmPath: Z_IMAGE_LLM_PATH,
        vaePath: Z_IMAGE_VAE_PATH,
        apiModelId: "pornmaster-zimage-turbo",
      },
      defaultWidth: 1024,
      defaultHeight: 1365,
      allowedOrientations: ["1:1", "4:5", "3:4", "9:16", "16:9"],
      steps: 36,
      sampler: "dpmpp_2m",
      cfgScale: 6.5,
      negativeTemplateId: "template_image_character_default",
      costMultiplier: 1.5,
      requiredEntitlement: "premium_models",
      maxCount: 4,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: { sampleCount: 6, successRate: 1, p95LatencyMs: 1200 },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
  });

  await prisma.generationModelProfile.upsert({
    where: { id: "seed-profile-video-beta-v1" },
    update: {
      profileKey: "profile_video_beta_v1",
      label: "Video beta",
      mode: "video",
      runner: "external",
      pipelineModel: "mock-video",
      sourceModelPath: null,
      convertedModelPath: null,
      modelFormat: "external",
      runnerConfig: { disabledUntilFlag: "video_gen" },
      defaultWidth: 768,
      defaultHeight: 1024,
      allowedOrientations: ["9:16", "16:9"],
      steps: 24,
      sampler: "video_default",
      cfgScale: 5,
      negativeTemplateId: "template_video_character_default",
      costMultiplier: 1,
      requiredEntitlement: "video_generation",
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 0,
      version: 1,
      status: "active",
      dryRunSummary: { sampleCount: 2, successRate: 1, disabledByFlag: "video_gen" },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    create: {
      id: "seed-profile-video-beta-v1",
      profileKey: "profile_video_beta_v1",
      label: "Video beta",
      mode: "video",
      runner: "external",
      pipelineModel: "mock-video",
      sourceModelPath: null,
      convertedModelPath: null,
      modelFormat: "external",
      runnerConfig: { disabledUntilFlag: "video_gen" },
      defaultWidth: 768,
      defaultHeight: 1024,
      allowedOrientations: ["9:16", "16:9"],
      steps: 24,
      sampler: "video_default",
      cfgScale: 5,
      negativeTemplateId: "template_video_character_default",
      costMultiplier: 1,
      requiredEntitlement: "video_generation",
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 0,
      version: 1,
      status: "active",
      dryRunSummary: { sampleCount: 2, successRate: 1, disabledByFlag: "video_gen" },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
  });

  await prisma.pricingRule.upsert({
    where: { id: "seed-pricing-image-default-v1" },
    update: {
      ruleKey: "generation_image_default",
      label: "Image generation default",
      mode: "image",
      baseCost: 5,
      multiplier: 1,
      status: "active",
      version: 1,
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    create: {
      id: "seed-pricing-image-default-v1",
      ruleKey: "generation_image_default",
      label: "Image generation default",
      mode: "image",
      baseCost: 5,
      multiplier: 1,
      status: "active",
      version: 1,
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
  });
}

async function seedPolicies() {
  for (const document of safetyDocuments) {
    await prisma.policyVersion.upsert({
      where: {
        slug_version: {
          slug: `safety${document.path}`,
          version: "seed-2026-06-13",
        },
      },
      update: {
        title: document.title,
        body: document.markdown,
        sourceUrl: `https://ourdream.ai/safety${document.path}`,
      },
      create: {
        slug: `safety${document.path}`,
        version: "seed-2026-06-13",
        title: document.title,
        body: document.markdown,
        sourceUrl: `https://ourdream.ai/safety${document.path}`,
      },
    });
  }
}

async function seedRoutePages() {
  const paths = ["/", ...ourdreamRoutePaths];

  for (const path of paths) {
    const route = getOurdreamRoute(path);
    if (!route) continue;

    await prisma.routePage.upsert({
      where: { path: route.path },
      update: {
        template: route.path === "/" ? "home" : route.template,
        title: route.title,
        description: route.description,
        canonical: route.path,
        contentStatus: "template",
        body: {
          eyebrow: route.eyebrow,
        },
      },
      create: {
        path: route.path,
        template: route.path === "/" ? "home" : route.template,
        title: route.title,
        description: route.description,
        canonical: route.path,
        contentStatus: "template",
        body: {
          eyebrow: route.eyebrow,
        },
      },
    });
  }
}

async function main() {
  await seedUsers();
  await seedTags();
  await seedCharacters();
  await seedPlans();
  await seedPresets();
  await seedAdminControlPlane();
  await seedPolicies();
  await seedRoutePages();
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("[seed] complete");
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
