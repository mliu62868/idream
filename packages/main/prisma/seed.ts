import { Prisma, PrismaClient } from "@prisma/client";
import { buildCharacterSystemPrompt } from "@idream/shared";
import { categoryFilters } from "../src/lib/ourdream-data";
import { createPrismaClientOptions } from "../src/server/lib/prisma-adapter";
import { safetyDocuments } from "../src/lib/ourdream-safety-data";
import {
  officialCharacterSeeds,
  officialFeedbackItems,
} from "../src/lib/official-cold-start-content";
import { ensureOfficialEditorialCatalogQualification } from "../src/server/modules/ourdream/public-catalog-qualification";

process.env.DB_PROVIDER ??= "postgresql";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5433/idream";

const prisma = new PrismaClient(createPrismaClientOptions());

const SYSTEM_USER_ID = "seed-system-creator";
const ADMIN_USER_ID = "seed-admin-user";
const DEV_USER_ID = "seed-dev-user";
const SUPPORT_USER_ID = "seed-support-user";
const OPS_USER_ID = "seed-ops-user";
const ANALYST_USER_ID = "seed-analyst-user";
const KREA2_TEXT_ENCODER_PATH =
  "/Users/kk/.localai/models/krea2/text_encoders/Qwen3VL-4B-Instruct-Q4_K_M.gguf";
const KREA2_VAE_PATH = "/Users/kk/.localai/models/krea2/vae/wan_2.1_vae.safetensors";
const REDCRAFT_KREA2_MODEL_PATH =
  "/Users/kk/Downloads/models/redcraftKREA2RedMix_krea2Edition.safetensors";
const REDCRAFT_COMFYUI_RUNTIME_PATH = "/Users/kk/ComfyUI-Installs/idream (1)/ComfyUI";
const REDCRAFT_COMFYUI_WORKFLOW_PATH =
  "/Users/kk/code/idream/packages/gen/workflows/redcraft-krea2-comfyui-text.json";
const REDCRAFT_COMFYUI_TEXT_ENCODER_PATH =
  "/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_4b_fp8_scaled.safetensors";
const REDCRAFT_COMFYUI_VAE_PATH = "/Users/kk/ComfyUI-Shared/models/vae/qwen_image_vae.safetensors";
const DARKBEAST_BFS_FLUX2_MODEL_PATH =
  "/Users/kk/Downloads/models/darkBeastKrea2_dbkleinv2BFS.safetensors";
const FLUX2_VAE_PATH = "/Users/kk/.localai/models/flux2-vae.safetensors";

const sensitiveTags = new Set(["teen", "bdsm", "virgin"]);

const communityCollections = [
  {
    id: "seed-collection-slow-burn-favorites",
    name: "Slow Burn Favorites",
    characterIds: ["melissa-burke", "sarah-mercer", "raya-reyes", "emily-coming-home"],
  },
  {
    id: "seed-collection-high-drama",
    name: "High Drama Roleplay",
    characterIds: ["truth-confessional", "truth-stepmother", "eleanor-dawn", "bailey-price"],
  },
  {
    id: "seed-collection-fantasy-escapes",
    name: "Fantasy Escapes",
    characterIds: ["summoned-world", "lola-moonstruck", "diana-weird-girl", "kennedy-graham"],
  },
] as const;

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseAge(value: string) {
  const age = Number.parseInt(value, 10);
  return Number.isFinite(age) && age >= 18 ? age : 18;
}

function inputJsonObject(value: unknown): Prisma.InputJsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.InputJsonObject)
    : {};
}

function nonBlankJsonString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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

function inferredTagSlugs(card: (typeof officialCharacterSeeds)[number]) {
  const haystack = `${card.title} ${card.description}`.toLowerCase();
  return categoryFilters
    .filter((label) => label !== "All")
    .map(slugify)
    .filter((slug) => haystack.includes(slug.replace(/-/g, " ")));
}

async function seedUsers() {
  await prisma.user.upsert({
    where: { id: SYSTEM_USER_ID },
    update: { dataClass: "internal" },
    create: {
      id: SYSTEM_USER_ID,
      email: "system@idream.local",
      emailVerified: true,
      displayName: "System Creator",
      role: "admin",
      dataClass: "internal",
    },
  });

  await prisma.user.upsert({
    where: { id: ADMIN_USER_ID },
    update: { dataClass: "internal" },
    create: {
      id: ADMIN_USER_ID,
      email: "admin@idream.local",
      emailVerified: true,
      displayName: "Admin",
      role: "admin",
      dataClass: "internal",
    },
  });

  await prisma.user.upsert({
    where: { id: DEV_USER_ID },
    update: { dataClass: "internal" },
    create: {
      id: DEV_USER_ID,
      email: "user@idream.local",
      emailVerified: true,
      displayName: "Dev User",
      role: "user",
      dataClass: "internal",
    },
  });

  // The launch chat-service probe uses DEV_USER_ID for a real conversation.
  // Keep its eligibility deterministic so a fresh seed can exercise the full
  // create → send → stream → read path instead of stopping at the age gate.
  await prisma.ageGateAcceptance.upsert({
    where: { id: "seed-dev-user-age-gate" },
    update: {
      userId: DEV_USER_ID,
      sourcePath: "/launch-probe",
      policyVersion: "seed-v1",
    },
    create: {
      id: "seed-dev-user-age-gate",
      userId: DEV_USER_ID,
      sourcePath: "/launch-probe",
      policyVersion: "seed-v1",
    },
  });

  // Live probes are operational checks, not customer consumption. Without this
  // entitlement, the deterministic probe user reaches the daily message cap
  // after repeated health checks and turns a healthy service red.
  await prisma.entitlement.upsert({
    where: { userId_key: { userId: DEV_USER_ID, key: "unlimited_messages" } },
    update: { value: true, source: "manual", expiresAt: null },
    create: {
      id: "seed-dev-user-unlimited-messages",
      userId: DEV_USER_ID,
      key: "unlimited_messages",
      value: true,
      source: "manual",
    },
  });

  await prisma.user.upsert({
    where: { id: SUPPORT_USER_ID },
    update: { dataClass: "internal" },
    create: {
      id: SUPPORT_USER_ID,
      email: "support@idream.local",
      emailVerified: true,
      displayName: "Support",
      role: "support",
      dataClass: "internal",
    },
  });

  await prisma.user.upsert({
    where: { id: OPS_USER_ID },
    update: { dataClass: "internal" },
    create: {
      id: OPS_USER_ID,
      email: "ops@idream.local",
      emailVerified: true,
      displayName: "Ops",
      role: "ops",
      dataClass: "internal",
    },
  });

  await prisma.user.upsert({
    where: { id: ANALYST_USER_ID },
    update: { dataClass: "internal" },
    create: {
      id: ANALYST_USER_ID,
      email: "analyst@idream.local",
      emailVerified: true,
      displayName: "Analyst",
      role: "analyst",
      dataClass: "internal",
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
  for (const card of officialCharacterSeeds) {
    const mediaAssetId = `seed-image-${card.id}`;
    const age = parseAge(card.age);
    const tags = inferredTagSlugs(card);
    const systemPrompt = buildCharacterSystemPrompt({
      name: card.title,
      age,
      description: card.description,
      style: card.title.toLowerCase().includes("anime") ? "anime" : "realistic",
      gender: "female",
      tags,
      appearance: { sourceImage: card.image },
      advancedDetails: {},
    });
    const [existingAsset, existingCharacter] = await Promise.all([
      prisma.mediaAsset.findUnique({
        where: { id: mediaAssetId },
        select: { metadata: true, ownerId: true },
      }),
      prisma.character.findUnique({
        where: { id: card.id },
        select: { advancedDetails: true },
      }),
    ]);
    const existingMetadata = inputJsonObject(existingAsset?.metadata);
    const existingAdvancedDetails = inputJsonObject(
      existingCharacter?.advancedDetails,
    );
    const existingProvenance = inputJsonObject(
      existingAdvancedDetails.provenance,
    );
    const originalOwnerId =
      nonBlankJsonString(existingMetadata.originalOwnerId) ??
      nonBlankJsonString(existingProvenance.legacyCreatorId) ??
      (existingAsset?.ownerId && existingAsset.ownerId !== SYSTEM_USER_ID
        ? existingAsset.ownerId
        : null);
    const officialMetadata: Prisma.InputJsonObject = {
      ...existingMetadata,
      seedSource: "src/lib/official-cold-start-content.ts",
      originalCreator: card.originalCreator,
      ...(originalOwnerId ? { originalOwnerId } : {}),
      ownership: "platform_official",
    };
    const officialAdvancedDetails: Prisma.InputJsonObject = {
      ...existingAdvancedDetails,
      provenance: {
        ...existingProvenance,
        seedSource: "src/lib/official-cold-start-content.ts",
        originalCreator: card.originalCreator,
        ownership: "platform_official",
      },
    };

    await prisma.mediaAsset.upsert({
      where: { id: mediaAssetId },
      update: {
        ownerId: SYSTEM_USER_ID,
        metadata: officialMetadata,
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
          seedSource: "src/lib/official-cold-start-content.ts",
          originalCreator: card.originalCreator,
          ownership: "platform_official",
        },
      },
    });

    await prisma.character.upsert({
      where: { id: card.id },
      update: {
        creatorId: SYSTEM_USER_ID,
        relationship: null,
        advancedDetails: officialAdvancedDetails,
      },
      create: {
        id: card.id,
        creatorId: SYSTEM_USER_ID,
        name: card.title,
        age,
        description: card.description,
        systemPrompt,
        visibility: "public",
        status: "approved",
        source: "official",
        style: card.title.toLowerCase().includes("anime") ? "anime" : "realistic",
        gender: "female",
        relationship: null,
        imageAssetId: mediaAssetId,
        vivid: card.vivid ?? false,
        appearance: {
          sourceImage: card.image,
        },
        advancedDetails: {
          provenance: {
            seedSource: "src/lib/official-cold-start-content.ts",
            originalCreator: card.originalCreator,
            ownership: "platform_official",
          },
        },
      },
    });
    const attachedAsset = await prisma.mediaAsset.updateMany({
      where: {
        id: mediaAssetId,
        OR: [{ characterId: null }, { characterId: card.id }],
      },
      data: { characterId: card.id },
    });
    if (attachedAsset.count !== 1) {
      throw new Error(
        `Official seed asset ${mediaAssetId} is already owned by another Character`,
      );
    }

    await prisma.characterStats.upsert({
      where: { characterId: card.id },
      update: {},
      create: {
        characterId: card.id,
        likesCount: 0,
        chatsCount: 0,
      },
    });

    for (const slug of tags) {
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

async function seedOfficialCatalogQualifications() {
  for (const card of officialCharacterSeeds) {
    await ensureOfficialEditorialCatalogQualification(prisma, {
      characterId: card.id,
      expectedAssetId: `seed-image-${card.id}`,
      expectedSeedSource: "src/lib/official-cold-start-content.ts",
    });
  }
}

async function seedCommunityCollections() {
  for (const collection of communityCollections) {
    await prisma.mediaCollection.upsert({
      where: { id: collection.id },
      update: {
        ownerId: SYSTEM_USER_ID,
        source: "official",
      },
      create: {
        id: collection.id,
        ownerId: SYSTEM_USER_ID,
        name: collection.name,
        visibility: "public",
        source: "official",
      },
    });

    await prisma.mediaCollectionItem.createMany({
      data: collection.characterIds.map((characterId, index) => ({
        collectionId: collection.id,
        mediaAssetId: `seed-image-${characterId}`,
        sortOrder: index,
      })),
      skipDuplicates: true,
    });
  }
}

async function seedOfficialFeedbackItems() {
  for (const item of officialFeedbackItems) {
    await prisma.productFeedbackItem.upsert({
      where: { sourceKey: item.sourceKey },
      update: {},
      create: {
        ...item,
        source: "official",
        voteCount: 0,
      },
    });
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
        voiceEnabled: true,
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
        voiceEnabled: true,
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
        voiceEnabled: true,
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
        voiceEnabled: true,
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
      update: {},
      create: plan,
    });
  }
}

async function seedPresets() {
  const presets: Array<{
    id: string;
    scope?: "built_in" | "community";
    type: "background" | "pose" | "outfit" | "mode";
    label: string;
    category?: string | null;
    controls: Record<string, string>;
  }> = [
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
      id: "seed-preset-background-neon-rooftop",
      scope: "community",
      type: "background",
      label: "Neon Rooftop",
      category: "community",
      controls: { background: "neon rooftop", lighting: "pink skyline" },
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
      id: "seed-preset-outfit-evening-glam",
      scope: "community",
      type: "outfit",
      label: "Evening Glam",
      category: "community",
      controls: { outfit: "evening glam", accessories: "silver jewelry" },
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
      update: {},
      create: {
        id: preset.id,
        scope: preset.scope ?? "built_in",
        type: preset.type,
        label: preset.label,
        category: preset.category ?? null,
        controls: preset.controls,
        visibility: "public",
        status: "active",
      },
    });
  }
}

async function ensureDefaultPricingRule(input: {
  id: string;
  ruleKey: string;
  label: string;
  mode: "image" | "video" | "voice";
  baseCost: number;
  publishedAt: Date;
}) {
  const activeAuthorities = await prisma.pricingRule.findMany({
    where: { mode: input.mode, status: "active" },
    select: { id: true },
    take: 2,
  });
  if (activeAuthorities.length > 1) {
    throw new Error(`Multiple active pricing rules exist for ${input.mode}`);
  }
  if (activeAuthorities.length === 1) return;

  const existingHistory = await prisma.pricingRule.findFirst({
    where: { mode: input.mode },
    select: { id: true },
  });
  if (existingHistory) {
    throw new Error(
      `Pricing authority for ${input.mode} has history but no active rule; publish one explicitly`,
    );
  }

  const authority = {
    ruleKey: input.ruleKey,
    label: input.label,
    mode: input.mode,
    baseCost: input.baseCost,
    multiplier: 1,
    status: "active",
    version: 1,
    effectiveFrom: input.publishedAt,
    publishedAt: input.publishedAt,
    archivedAt: null,
  };
  await prisma.pricingRule.create({
    data: { id: input.id, ...authority },
  });
}

async function seedAdminControlPlane() {
  await prisma.featureFlag.upsert({
    where: { key: "video_gen" },
    update: {
      label: "Video generation",
      description: "Single gate for all video generation traffic.",
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
    where: { key: "voice_gen" },
    update: {
      label: "Voice generation",
      description: "Single gate for all on-demand voice (TTS) traffic.",
    },
    create: {
      key: "voice_gen",
      label: "Voice generation",
      description: "Single gate for all on-demand voice (TTS) traffic.",
      enabled: true,
      rolloutPercent: 100,
      targetRoles: [],
      targetPlans: ["premium", "deluxe"],
      hardPolicy: false,
    },
  });

  await prisma.featureFlag.upsert({
    where: { key: "image_edit" },
    update: {
      label: "Image edit",
      description: "Unlocks the image edit surface when providers are ready.",
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

  await prisma.generationRecipe.upsert({
    where: { id: "seed-template-image-character-v1" },
    update: {},
    create: {
      id: "seed-template-image-character-v1",
      recipeKey: "template_image_character_default",
      label: "Image character default",
      mode: "image",
      useCase: "character",
      body: "Character image generation template with appearance, pose, outfit, background, style, and quality blocks.",
      negativeBase: "low quality, distorted anatomy, extra fingers, watermark, text",
      presetOrder: ["background", "pose", "outfit", "mode"],
      safetyHints: { hardPolicies: ["age_under_18", "real_person_nonconsensual"] },
      sampleMatrix: [{ character: "seed", orientation: "4:5", presets: ["background", "pose"] }],
      dryRunSummary: { sampleCount: 6, validationPassRate: 1, blockedRate: 0, source: "seed_matrix_validation" },
      version: 1,
      status: "active",
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
  });

  await prisma.generationRecipe.upsert({
    where: { id: "seed-template-image-freeplay-v1" },
    update: {},
    create: {
      id: "seed-template-image-freeplay-v1",
      recipeKey: "template_image_freeplay_default",
      label: "Image freeplay default",
      mode: "image",
      useCase: "freeplay",
      body: "Freeplay image generation template with user prompt, style, preset fragments, and quality blocks.",
      negativeBase: "low quality, distorted anatomy, watermark, text",
      presetOrder: ["background", "pose", "outfit", "mode"],
      safetyHints: { hardPolicies: ["age_under_18", "real_person_nonconsensual"] },
      sampleMatrix: [{ freeplay: true, orientation: "1:1" }],
      dryRunSummary: { sampleCount: 4, validationPassRate: 1, blockedRate: 0, source: "seed_matrix_validation" },
      version: 1,
      status: "active",
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
  });

  await prisma.generationRecipe.upsert({
    where: { id: "seed-template-video-character-v1" },
    update: {},
    create: {
      id: "seed-template-video-character-v1",
      recipeKey: "template_video_character_default",
      label: "Video character beta",
      mode: "video",
      useCase: "character",
      body: "Video generation beta template. Draftable while video_gen is disabled.",
      negativeBase: "low quality, flicker, watermark, text",
      presetOrder: ["pose", "mode"],
      safetyHints: { disabledUntilFlag: "video_gen" },
      sampleMatrix: [{ character: "seed", seconds: 4 }],
      dryRunSummary: { sampleCount: 2, validationPassRate: 1, blockedRate: 0, source: "seed_matrix_validation" },
      version: 1,
      status: "active",
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
  });

  const existingProfileKeys = new Set(
    (await prisma.generationModelProfile.findMany({
      select: { profileKey: true },
    })).map((profile) => profile.profileKey),
  );

  if (!existingProfileKeys.has("profile_image_default_v1")) {
    await prisma.generationModelProfile.upsert({
    where: { id: "seed-profile-image-default-v1" },
    update: {
      profileKey: "profile_image_default_v1",
      label: "Default image",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "redcraft-krea2-comfyui",
      workflowKey: "redcraft-krea2-txt2img",
      sourceModelPath: REDCRAFT_KREA2_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        modelPath: REDCRAFT_KREA2_MODEL_PATH,
        apiModelId: "redcraft-krea2-comfyui",
        workflowPath: REDCRAFT_COMFYUI_WORKFLOW_PATH,
        capabilities: {
          textToImage: true,
          stableSeed: true,
          referenceImages: false,
          initImage: false,
          lora: false,
        },
      },
      defaultWidth: 512,
      defaultHeight: 512,
      allowedOrientations: ["1:1", "4:5", "3:4", "9:16", "16:9"],
      steps: 8,
      sampler: "euler",
      scheduler: "model_default",
      cfgScale: 1,      costMultiplier: 1,
      requiredEntitlement: null,
      maxCount: 4,
      concurrencyLimit: 2,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: { configurationSampleCount: 6, configurationPassRate: 1, source: "seed_configuration_check" },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    create: {
      id: "seed-profile-image-default-v1",
      profileKey: "profile_image_default_v1",
      label: "Default image",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "redcraft-krea2-comfyui",
      workflowKey: "redcraft-krea2-txt2img",
      sourceModelPath: REDCRAFT_KREA2_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        modelPath: REDCRAFT_KREA2_MODEL_PATH,
        apiModelId: "redcraft-krea2-comfyui",
        workflowPath: REDCRAFT_COMFYUI_WORKFLOW_PATH,
        capabilities: {
          textToImage: true,
          stableSeed: true,
          referenceImages: false,
          initImage: false,
          lora: false,
        },
      },
      defaultWidth: 512,
      defaultHeight: 512,
      allowedOrientations: ["1:1", "4:5", "3:4", "9:16", "16:9"],
      steps: 8,
      sampler: "euler",
      scheduler: "model_default",
      cfgScale: 1,      costMultiplier: 1,
      requiredEntitlement: null,
      maxCount: 4,
      concurrencyLimit: 2,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: { configurationSampleCount: 6, configurationPassRate: 1, source: "seed_configuration_check" },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    });
  }

  if (!existingProfileKeys.has("profile_image_premium_v1")) {
    await prisma.generationModelProfile.upsert({
    where: { id: "seed-profile-image-premium-v1" },
    update: {
      profileKey: "profile_image_premium_v1",
      label: "Premium image",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "redcraft-krea2-comfyui",
      workflowKey: "redcraft-krea2-txt2img",
      sourceModelPath: REDCRAFT_KREA2_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        modelPath: REDCRAFT_KREA2_MODEL_PATH,
        apiModelId: "redcraft-krea2-comfyui",
        workflowPath: REDCRAFT_COMFYUI_WORKFLOW_PATH,
        capabilities: {
          textToImage: true,
          stableSeed: true,
          referenceImages: false,
          initImage: false,
          lora: false,
        },
      },
      defaultWidth: 640,
      defaultHeight: 640,
      allowedOrientations: ["1:1", "4:5", "3:4", "9:16", "16:9"],
      steps: 12,
      sampler: "euler",
      scheduler: "model_default",
      cfgScale: 1,      costMultiplier: 1.5,
      requiredEntitlement: "premium_models",
      maxCount: 4,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: { configurationSampleCount: 6, configurationPassRate: 1, source: "seed_configuration_check" },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    create: {
      id: "seed-profile-image-premium-v1",
      profileKey: "profile_image_premium_v1",
      label: "Premium image",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "redcraft-krea2-comfyui",
      workflowKey: "redcraft-krea2-txt2img",
      sourceModelPath: REDCRAFT_KREA2_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        modelPath: REDCRAFT_KREA2_MODEL_PATH,
        apiModelId: "redcraft-krea2-comfyui",
        workflowPath: REDCRAFT_COMFYUI_WORKFLOW_PATH,
        capabilities: {
          textToImage: true,
          stableSeed: true,
          referenceImages: false,
          initImage: false,
          lora: false,
        },
      },
      defaultWidth: 640,
      defaultHeight: 640,
      allowedOrientations: ["1:1", "4:5", "3:4", "9:16", "16:9"],
      steps: 12,
      sampler: "euler",
      scheduler: "model_default",
      cfgScale: 1,      costMultiplier: 1.5,
      requiredEntitlement: "premium_models",
      maxCount: 4,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: { configurationSampleCount: 6, configurationPassRate: 1, source: "seed_configuration_check" },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    });
  }

  if (!existingProfileKeys.has("profile_comfyui_redcraft_krea2_checkpoint_v1")) {
    await prisma.generationModelProfile.upsert({
    where: { id: "seed-profile-sdcpp-redcraft-krea2-text-v1" },
    update: {
      profileKey: "profile_comfyui_redcraft_krea2_checkpoint_v1",
      label: "Redcraft Krea2 ComfyUI checkpoint candidate",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "redcraft-krea2-comfyui",
      sourceModelPath: REDCRAFT_KREA2_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        modelPath: REDCRAFT_KREA2_MODEL_PATH,
        apiModelId: "redcraft-krea2-comfyui",
        profileTemplate: "reference_identity_comfyui",
        templateIntent: "comfyui_krea2_text_checkpoint",
        assetFormat: "fp8_scaled_comfyui_checkpoint",
        workflowPath: REDCRAFT_COMFYUI_WORKFLOW_PATH,
        verificationStatus: "manual_passed",
        productionRunnerPolicy: {
          gateway: "openai_compatible_comfyui_image_gateway",
          readinessEndpoint: "/readyz",
          generationEndpoint: "/images/generations",
          trafficExposure: "draft_disabled_zero_rollout_until_managed_gateway",
          localProbe:
            "bun run launch:probe:redcraft-consistency:local -- --output .tmp/redcraft-consistency-review --seed redcraft-serena-cvp-v1",
          note:
            "Redcraft is a built-in ComfyUI profile, not an admin-managed model. Publishing traffic requires a managed gateway process with health checks; local CPU smoke is sufficient for candidate readiness, not automatic rollout.",
        },
        componentStatus: {
          comfyuiRuntime: {
            status: "verified_cpu",
            path: REDCRAFT_COMFYUI_RUNTIME_PATH,
          },
          krea2ComfyuiTextEncoder: { status: "present", path: REDCRAFT_COMFYUI_TEXT_ENCODER_PATH },
          krea2ComfyuiVae: { status: "present", path: REDCRAFT_COMFYUI_VAE_PATH },
          krea2Workflow: { status: "present", path: REDCRAFT_COMFYUI_WORKFLOW_PATH },
          krea2SdcppTextEncoder: { status: "present", path: KREA2_TEXT_ENCODER_PATH },
          krea2SdcppVae: { status: "present", path: KREA2_VAE_PATH },
        },
        probeFindings: {
          sdcppMetal: "pure_white_output",
          sdcppCpu: "timed_out_without_256x384_output",
          sdcppOfficialWanVaeMetal: "aborted_on_metal_vae_decode_im2col_3d",
          sdcppOfficialWanVaeCpu: "exit_zero_but_sanity_rejected_pure_white",
          sdcppQwenVaeCpu: "exit_zero_but_sanity_rejected_pure_white",
          sdcppGuidanceZero: "exit_zero_but_sanity_rejected_pure_white",
          sdcppGuidanceMatrix: "guidance_0_1_3_5_all_exit_zero_but_pure_white",
          sdcppSchedulerMatrix: "model_default_simple_logit_normal_mu_1_15_all_pure_white",
          sdcppVaeFormatMatrix: "auto_flux_sd3_flux2_all_pure_white",
          sdcppGgufDiffusion: "exit_zero_but_sanity_rejected_pure_white",
          sdcppFp8TextEncoder: "metadata_shape_validation_failed",
          civitaiAssetFormat: "fp8_scaled_comfyui_checkpoint",
          sdcppModelFlag: "exit_zero_but_sanity_rejected_pure_white",
          sdcppCpuBackend: "exit_zero_but_sanity_rejected_pure_white",
          comfyuiMps: "unsupported_float8_e4m3fn_dtype",
          comfyuiGgufClip: "clip_loader_torch_load_unpickling_error_for_gguf",
          comfyuiFp8CpuClip: "ksampler_mps_float8_e4m3fn_unsupported",
          comfyuiCpu: "smoke_passed_256x384_2_steps_nonblank",
          comfyuiOpenAiGateway: "pipeline_probe_completed_blob_written",
          comfyuiConsistencySamples: "20_locked_seed_samples_manual_passed_17_of_20",
        },
        capabilities: {
          textToImage: true,
          stableSeed: true,
          referenceImages: false,
          initImage: false,
          lora: false,
        },
      },
      defaultWidth: 960,
      defaultHeight: 1440,
      allowedOrientations: ["3:4", "4:5", "1:1"],
      steps: 10,
      sampler: "er_sde",
      scheduler: "simple",
      cfgScale: 1,      costMultiplier: 1.1,
      requiredEntitlement: null,
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: false,
      rolloutPercent: 0,
      version: 1,
      status: "draft",
      dryRunSummary: {
        sampleCount: 20,
        successRate: 1,
        p95LatencyMs: 20_000,
        testedAt: "2026-06-30",
        smokeOutputPath: "/tmp/idream-redcraft-comfyui-cpu-smoke.png",
        pipelineSmokeReportPath: "/tmp/idream-redcraft-pipeline-image-local.json",
        consistencyManifestPath: "/Users/kk/code/idream/.tmp/redcraft-consistency-review/manifest.json",
        consistencyReviewPath: "/Users/kk/code/idream/.tmp/redcraft-consistency-review/review.html",
        consistencyManualReviewPath: "/Users/kk/code/idream/.tmp/redcraft-consistency-review/manual-review.json",
        consistencyContactSheetPath: "/Users/kk/code/idream/.tmp/redcraft-consistency-review/contact-sheet.jpg",
        consistencySampleCount: 20,
        consistencyPassCount: 17,
        consistencyRate: 0.85,
        seedMode: "locked",
        notes:
          "Local sd.cpp tests with Redcraft safetensors and gguf produced all-white PNGs. Header inspection shows a diffusion-only fp8-scaled ComfyUI checkpoint with CheckpointLoaderSimple workflow metadata, so this asset is no longer modeled as a sd.cpp template. A 2026-06-30 sd.cpp matrix covered scheduler model_default/simple/logit_normal mu=1.15, guidance 0/1/3.5, VAE format auto/flux/sd3/flux2, qwen_image VAE, no diffusion-fa, no offload, --model loading, GGUF diffusion, and CPU backend; all successful exits were rejected by image sanity as pure white. Apple Silicon MPS ComfyUI still fails on Float8_e4m3fn. The split-node ComfyUI CPU workflow in packages/gen/workflows/redcraft-krea2-comfyui-text.json produced a 256x384 PNG that passed image sanity. The local OpenAI-compatible gateway also completed launch:probe:redcraft-image:local and wrote a PNG through gen probe:image/blob storage. launch:probe:redcraft-consistency:local now runs with seedMode=locked, matching CharacterVisualProfile.defaultSeed behavior; 20 pipeline samples were manually reviewed at 17/20 same-character, consistencyRate=0.85. Redcraft remains disabled at zero rollout until a managed ComfyUI gateway is deployed.",
      },
      publishedAt: null,
    },
    create: {
      id: "seed-profile-sdcpp-redcraft-krea2-text-v1",
      profileKey: "profile_comfyui_redcraft_krea2_checkpoint_v1",
      label: "Redcraft Krea2 ComfyUI checkpoint candidate",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "redcraft-krea2-comfyui",
      sourceModelPath: REDCRAFT_KREA2_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        modelPath: REDCRAFT_KREA2_MODEL_PATH,
        apiModelId: "redcraft-krea2-comfyui",
        profileTemplate: "reference_identity_comfyui",
        templateIntent: "comfyui_krea2_text_checkpoint",
        assetFormat: "fp8_scaled_comfyui_checkpoint",
        workflowPath: REDCRAFT_COMFYUI_WORKFLOW_PATH,
        verificationStatus: "manual_passed",
        productionRunnerPolicy: {
          gateway: "openai_compatible_comfyui_image_gateway",
          readinessEndpoint: "/readyz",
          generationEndpoint: "/images/generations",
          trafficExposure: "draft_disabled_zero_rollout_until_managed_gateway",
          localProbe:
            "bun run launch:probe:redcraft-consistency:local -- --output .tmp/redcraft-consistency-review --seed redcraft-serena-cvp-v1",
          note:
            "Redcraft is a built-in ComfyUI profile, not an admin-managed model. Publishing traffic requires a managed gateway process with health checks; local CPU smoke is sufficient for candidate readiness, not automatic rollout.",
        },
        componentStatus: {
          comfyuiRuntime: {
            status: "verified_cpu",
            path: REDCRAFT_COMFYUI_RUNTIME_PATH,
          },
          krea2ComfyuiTextEncoder: { status: "present", path: REDCRAFT_COMFYUI_TEXT_ENCODER_PATH },
          krea2ComfyuiVae: { status: "present", path: REDCRAFT_COMFYUI_VAE_PATH },
          krea2Workflow: { status: "present", path: REDCRAFT_COMFYUI_WORKFLOW_PATH },
          krea2SdcppTextEncoder: { status: "present", path: KREA2_TEXT_ENCODER_PATH },
          krea2SdcppVae: { status: "present", path: KREA2_VAE_PATH },
        },
        probeFindings: {
          sdcppMetal: "pure_white_output",
          sdcppCpu: "timed_out_without_256x384_output",
          sdcppOfficialWanVaeMetal: "aborted_on_metal_vae_decode_im2col_3d",
          sdcppOfficialWanVaeCpu: "exit_zero_but_sanity_rejected_pure_white",
          sdcppQwenVaeCpu: "exit_zero_but_sanity_rejected_pure_white",
          sdcppGuidanceZero: "exit_zero_but_sanity_rejected_pure_white",
          sdcppGuidanceMatrix: "guidance_0_1_3_5_all_exit_zero_but_pure_white",
          sdcppSchedulerMatrix: "model_default_simple_logit_normal_mu_1_15_all_pure_white",
          sdcppVaeFormatMatrix: "auto_flux_sd3_flux2_all_pure_white",
          sdcppGgufDiffusion: "exit_zero_but_sanity_rejected_pure_white",
          sdcppFp8TextEncoder: "metadata_shape_validation_failed",
          civitaiAssetFormat: "fp8_scaled_comfyui_checkpoint",
          sdcppModelFlag: "exit_zero_but_sanity_rejected_pure_white",
          sdcppCpuBackend: "exit_zero_but_sanity_rejected_pure_white",
          comfyuiMps: "unsupported_float8_e4m3fn_dtype",
          comfyuiGgufClip: "clip_loader_torch_load_unpickling_error_for_gguf",
          comfyuiFp8CpuClip: "ksampler_mps_float8_e4m3fn_unsupported",
          comfyuiCpu: "smoke_passed_256x384_2_steps_nonblank",
          comfyuiOpenAiGateway: "pipeline_probe_completed_blob_written",
          comfyuiConsistencySamples: "20_locked_seed_samples_manual_passed_17_of_20",
        },
        capabilities: {
          textToImage: true,
          stableSeed: true,
          referenceImages: false,
          initImage: false,
          lora: false,
        },
      },
      defaultWidth: 960,
      defaultHeight: 1440,
      allowedOrientations: ["3:4", "4:5", "1:1"],
      steps: 10,
      sampler: "er_sde",
      scheduler: "simple",
      cfgScale: 1,      costMultiplier: 1.1,
      requiredEntitlement: null,
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: false,
      rolloutPercent: 0,
      version: 1,
      status: "draft",
      dryRunSummary: {
        sampleCount: 20,
        successRate: 1,
        p95LatencyMs: 20_000,
        testedAt: "2026-06-30",
        smokeOutputPath: "/tmp/idream-redcraft-comfyui-cpu-smoke.png",
        pipelineSmokeReportPath: "/tmp/idream-redcraft-pipeline-image-local.json",
        consistencyManifestPath: "/Users/kk/code/idream/.tmp/redcraft-consistency-review/manifest.json",
        consistencyReviewPath: "/Users/kk/code/idream/.tmp/redcraft-consistency-review/review.html",
        consistencyManualReviewPath: "/Users/kk/code/idream/.tmp/redcraft-consistency-review/manual-review.json",
        consistencyContactSheetPath: "/Users/kk/code/idream/.tmp/redcraft-consistency-review/contact-sheet.jpg",
        consistencySampleCount: 20,
        consistencyPassCount: 17,
        consistencyRate: 0.85,
        seedMode: "locked",
        notes:
          "Local sd.cpp tests with Redcraft safetensors and gguf produced all-white PNGs. Header inspection shows a diffusion-only fp8-scaled ComfyUI checkpoint with CheckpointLoaderSimple workflow metadata, so this asset is no longer modeled as a sd.cpp template. A 2026-06-30 sd.cpp matrix covered scheduler model_default/simple/logit_normal mu=1.15, guidance 0/1/3.5, VAE format auto/flux/sd3/flux2, qwen_image VAE, no diffusion-fa, no offload, --model loading, GGUF diffusion, and CPU backend; all successful exits were rejected by image sanity as pure white. Apple Silicon MPS ComfyUI still fails on Float8_e4m3fn. The split-node ComfyUI CPU workflow in packages/gen/workflows/redcraft-krea2-comfyui-text.json produced a 256x384 PNG that passed image sanity. The local OpenAI-compatible gateway also completed launch:probe:redcraft-image:local and wrote a PNG through gen probe:image/blob storage. launch:probe:redcraft-consistency:local now runs with seedMode=locked, matching CharacterVisualProfile.defaultSeed behavior; 20 pipeline samples were manually reviewed at 17/20 same-character, consistencyRate=0.85. Redcraft remains disabled at zero rollout until a managed ComfyUI gateway is deployed.",
      },
      publishedAt: null,
    },
    });
  }

  if (!existingProfileKeys.has("profile_sdcpp_darkbeast_krea2_img2img_v1")) {
    await prisma.generationModelProfile.upsert({
    where: { id: "seed-profile-sdcpp-darkbeast-krea2-img2img-v1" },
    update: {
      profileKey: "profile_sdcpp_darkbeast_krea2_img2img_v1",
      label: "DarkBeast reference candidate",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "darkbeast-reference-candidate",
      sourceModelPath: DARKBEAST_BFS_FLUX2_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        diffusionModelPath: DARKBEAST_BFS_FLUX2_MODEL_PATH,
        apiModelId: "darkbeast-reference-candidate",
        templateIntent: "image_to_image_identity_reference",
        baseModel: "Flux.2 Klein 9B",
        civitaiModelId: 2242173,
        civitaiVersionId: 2740209,
        civitaiVersionName: "DBKleinV2 BFS",
        civitaiAutoV2: "B20B6F2744",
        note:
          "The Dark Beast collection also has a Krea 2 version 3078453, but this local dbkleinv2BFS file is version 2740209 and baseModel Flux.2 Klein 9B.",
        verificationStatus: "missing_flux2_klein_reference_runtime_components",
        workflow: {
          kind: "bfs_head_swap_flux2_klein",
          source:
            "https://huggingface.co/Alissonerdx/BFS-Best-Face-Swap/resolve/main/workflows/Head%20Swap%20V1%20Flux%202%20Klein%204b_9b%20(base_distill).json",
          bodyReferenceRole: "source_image",
          faceReferenceRole: "identity_reference",
          sampler: "lcm",
          cfgScale: 1,
          notes:
            "BFS workflow uses a body/base image plus a face/identity image through Flux2 conditioning and a head-swap LoRA; this is not a single-checkpoint sd.cpp img2img template.",
        },
        componentStatus: {
          flux2Vae: `missing:${FLUX2_VAE_PATH}`,
          flux2BaseModel: "missing",
          qwenTextEncoder: "missing",
          bfsHeadSwapLora: "missing",
          comfyWorkflow: "inspected_not_imported",
        },
        requiredComponents: [
          "flux-2-klein-base-4b-fp8.safetensors",
          "qwen_3_4b.safetensors",
          "head_swap_flux-klein_9b_000003750.safetensors",
          "Flux2 conditioning reference workflow",
        ],
        capabilities: {
          textToImage: false,
          stableSeed: true,
          referenceImages: true,
          initImage: true,
          lora: false,
        },
      },
      defaultWidth: 512,
      defaultHeight: 640,
      allowedOrientations: ["4:5", "1:1", "3:4"],
      steps: 8,
      sampler: "euler",
      scheduler: "model_default",
      cfgScale: 1,      costMultiplier: 1.2,
      requiredEntitlement: null,
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: false,
      rolloutPercent: 0,
      version: 1,
      status: "draft",
      dryRunSummary: {
        sampleCount: 0,
        successRate: 0,
        failureMode: "missing_runtime_components",
        testedAt: "2026-06-30",
        notes:
          "The local DarkBeast dbkleinv2BFS file is Civitai version 2740209, baseModel Flux.2 Klein 9B. The same collection has a separate Krea 2 version, but that file is not present locally. The inspected BFS workflow needs a Flux.2 Klein base model, Qwen text encoder, Flux2 VAE, head-swap LoRA, and a two-image reference workflow. Current local state is missing flux2-vae, Flux.2 Klein base, Qwen encoder, BFS LoRA, and an imported workflow.",
      },
      publishedAt: null,
    },
    create: {
      id: "seed-profile-sdcpp-darkbeast-krea2-img2img-v1",
      profileKey: "profile_sdcpp_darkbeast_krea2_img2img_v1",
      label: "DarkBeast reference candidate",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "darkbeast-reference-candidate",
      sourceModelPath: DARKBEAST_BFS_FLUX2_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        diffusionModelPath: DARKBEAST_BFS_FLUX2_MODEL_PATH,
        apiModelId: "darkbeast-reference-candidate",
        templateIntent: "image_to_image_identity_reference",
        baseModel: "Flux.2 Klein 9B",
        civitaiModelId: 2242173,
        civitaiVersionId: 2740209,
        civitaiVersionName: "DBKleinV2 BFS",
        civitaiAutoV2: "B20B6F2744",
        note:
          "The Dark Beast collection also has a Krea 2 version 3078453, but this local dbkleinv2BFS file is version 2740209 and baseModel Flux.2 Klein 9B.",
        verificationStatus: "missing_flux2_klein_reference_runtime_components",
        workflow: {
          kind: "bfs_head_swap_flux2_klein",
          source:
            "https://huggingface.co/Alissonerdx/BFS-Best-Face-Swap/resolve/main/workflows/Head%20Swap%20V1%20Flux%202%20Klein%204b_9b%20(base_distill).json",
          bodyReferenceRole: "source_image",
          faceReferenceRole: "identity_reference",
          sampler: "lcm",
          cfgScale: 1,
          notes:
            "BFS workflow uses a body/base image plus a face/identity image through Flux2 conditioning and a head-swap LoRA; this is not a single-checkpoint sd.cpp img2img template.",
        },
        componentStatus: {
          flux2Vae: `missing:${FLUX2_VAE_PATH}`,
          flux2BaseModel: "missing",
          qwenTextEncoder: "missing",
          bfsHeadSwapLora: "missing",
          comfyWorkflow: "inspected_not_imported",
        },
        requiredComponents: [
          "flux-2-klein-base-4b-fp8.safetensors",
          "qwen_3_4b.safetensors",
          "head_swap_flux-klein_9b_000003750.safetensors",
          "Flux2 conditioning reference workflow",
        ],
        capabilities: {
          textToImage: false,
          stableSeed: true,
          referenceImages: true,
          initImage: true,
          lora: false,
        },
      },
      defaultWidth: 512,
      defaultHeight: 640,
      allowedOrientations: ["4:5", "1:1", "3:4"],
      steps: 8,
      sampler: "euler",
      scheduler: "model_default",
      cfgScale: 1,      costMultiplier: 1.2,
      requiredEntitlement: null,
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: false,
      rolloutPercent: 0,
      version: 1,
      status: "draft",
      dryRunSummary: {
        sampleCount: 0,
        successRate: 0,
        failureMode: "missing_runtime_components",
        testedAt: "2026-06-30",
        notes:
          "The local DarkBeast dbkleinv2BFS file is Civitai version 2740209, baseModel Flux.2 Klein 9B. The same collection has a separate Krea 2 version, but that file is not present locally. The inspected BFS workflow needs a Flux.2 Klein base model, Qwen text encoder, Flux2 VAE, head-swap LoRA, and a two-image reference workflow. Current local state is missing flux2-vae, Flux.2 Klein base, Qwen encoder, BFS LoRA, and an imported workflow.",
      },
      publishedAt: null,
    },
    });
  }

  if (!existingProfileKeys.has("chat-image-edit")) {
    await prisma.generationModelProfile.upsert({
    where: { id: "seed-profile-chat-image-edit-v1" },
    update: {
      profileKey: "chat-image-edit",
      label: "Chat Image Edit (Qwen-Edit)",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "qwen-image-edit",
      workflowKey: "qwen-image-edit-img2img",
      sourceModelPath: null,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        capabilities: {
          textToImage: false,
          stableSeed: true,
          referenceImages: true,
          initImage: true,
          lora: false,
        },
      },
      defaultWidth: 832,
      defaultHeight: 1216,
      allowedOrientations: ["4:5", "16:9"],
      steps: 4,
      sampler: "sa_solver",
      scheduler: "beta",
      cfgScale: 1,      costMultiplier: 1.5,
      requiredEntitlement: null,
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: { status: "not_run", source: "seed_configuration_state", notes: "Qwen-Edit img2img profile for chat edit_last_image; landing without a provider test batch." },
      publishedAt: new Date("2026-07-07T00:00:00.000Z"),
    },
    create: {
      id: "seed-profile-chat-image-edit-v1",
      profileKey: "chat-image-edit",
      label: "Chat Image Edit (Qwen-Edit)",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "qwen-image-edit",
      workflowKey: "qwen-image-edit-img2img",
      sourceModelPath: null,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        capabilities: {
          textToImage: false,
          stableSeed: true,
          referenceImages: true,
          initImage: true,
          lora: false,
        },
      },
      defaultWidth: 832,
      defaultHeight: 1216,
      allowedOrientations: ["4:5", "16:9"],
      steps: 4,
      sampler: "sa_solver",
      scheduler: "beta",
      cfgScale: 1,      costMultiplier: 1.5,
      requiredEntitlement: null,
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: { status: "not_run", source: "seed_configuration_state", notes: "Qwen-Edit img2img profile for chat edit_last_image; landing without a provider test batch." },
      publishedAt: new Date("2026-07-07T00:00:00.000Z"),
    },
    });
  }

  if (!existingProfileKeys.has("character-image-variation")) {
    await prisma.generationModelProfile.upsert({
      where: { id: "seed-profile-character-image-variation-v1" },
      update: {
        profileKey: "character-image-variation",
        label: "Character Image Variation (Qwen-Edit)",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey: "qwen-image-edit-multi-reference",
        sourceModelPath: null,
        convertedModelPath: null,
        modelFormat: "safetensors",
        runnerConfig: {
          capabilities: {
            textToImage: false,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
        defaultWidth: 832,
        defaultHeight: 1216,
        allowedOrientations: ["4:5", "16:9"],
        steps: 4,
        sampler: "sa_solver",
        scheduler: "beta",
        cfgScale: 1,
        costMultiplier: 1.5,
        requiredEntitlement: null,
        maxCount: 1,
        concurrencyLimit: 1,
        enabled: true,
        rolloutPercent: 100,
        version: 1,
        status: "active",
        dryRunSummary: {
          status: "configuration_validated",
          source: "seed_workflow_contract",
          notes:
            "Two concrete Qwen-Edit image slots preserve Character identity while applying an explicit source image.",
        },
        publishedAt: new Date("2026-07-17T00:00:00.000Z"),
      },
      create: {
        id: "seed-profile-character-image-variation-v1",
        profileKey: "character-image-variation",
        label: "Character Image Variation (Qwen-Edit)",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey: "qwen-image-edit-multi-reference",
        sourceModelPath: null,
        convertedModelPath: null,
        modelFormat: "safetensors",
        runnerConfig: {
          capabilities: {
            textToImage: false,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
        defaultWidth: 832,
        defaultHeight: 1216,
        allowedOrientations: ["4:5", "16:9"],
        steps: 4,
        sampler: "sa_solver",
        scheduler: "beta",
        cfgScale: 1,
        costMultiplier: 1.5,
        requiredEntitlement: null,
        maxCount: 1,
        concurrencyLimit: 1,
        enabled: true,
        rolloutPercent: 100,
        version: 1,
        status: "active",
        dryRunSummary: {
          status: "configuration_validated",
          source: "seed_workflow_contract",
          notes:
            "Two concrete Qwen-Edit image slots preserve Character identity while applying an explicit source image.",
        },
        publishedAt: new Date("2026-07-17T00:00:00.000Z"),
      },
    });
  }

  if (!existingProfileKeys.has("character-image-multi-identity")) {
    await prisma.generationModelProfile.upsert({
      where: { id: "seed-profile-character-image-multi-identity-v1" },
      update: {
        profileKey: "character-image-multi-identity",
        label: "Character Multi-Reference Identity (Qwen-Edit)",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey: "qwen-image-edit-multi-identity",
        sourceModelPath: null,
        convertedModelPath: null,
        modelFormat: "safetensors",
        runnerConfig: {
          capabilities: {
            textToImage: false,
            stableSeed: true,
            referenceImages: true,
            initImage: false,
            lora: false,
          },
        },
        defaultWidth: 832,
        defaultHeight: 1216,
        allowedOrientations: ["4:5", "16:9"],
        steps: 4,
        sampler: "sa_solver",
        scheduler: "beta",
        cfgScale: 1,
        costMultiplier: 1.4,
        requiredEntitlement: null,
        maxCount: 1,
        concurrencyLimit: 1,
        enabled: true,
        rolloutPercent: 100,
        version: 1,
        status: "active",
        dryRunSummary: {
          status: "configuration_validated",
          source: "seed_workflow_contract",
          notes:
            "Two concrete Qwen-Edit identity slots preserve an anchor plus one supporting identity reference.",
        },
        publishedAt: new Date("2026-07-17T00:00:00.000Z"),
      },
      create: {
        id: "seed-profile-character-image-multi-identity-v1",
        profileKey: "character-image-multi-identity",
        label: "Character Multi-Reference Identity (Qwen-Edit)",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey: "qwen-image-edit-multi-identity",
        sourceModelPath: null,
        convertedModelPath: null,
        modelFormat: "safetensors",
        runnerConfig: {
          capabilities: {
            textToImage: false,
            stableSeed: true,
            referenceImages: true,
            initImage: false,
            lora: false,
          },
        },
        defaultWidth: 832,
        defaultHeight: 1216,
        allowedOrientations: ["4:5", "16:9"],
        steps: 4,
        sampler: "sa_solver",
        scheduler: "beta",
        cfgScale: 1,
        costMultiplier: 1.4,
        requiredEntitlement: null,
        maxCount: 1,
        concurrencyLimit: 1,
        enabled: true,
        rolloutPercent: 100,
        version: 1,
        status: "active",
        dryRunSummary: {
          status: "configuration_validated",
          source: "seed_workflow_contract",
          notes:
            "Two concrete Qwen-Edit identity slots preserve an anchor plus one supporting identity reference.",
        },
        publishedAt: new Date("2026-07-17T00:00:00.000Z"),
      },
    });
  }

  if (!existingProfileKeys.has("profile_video_beta_v1")) {
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
      scheduler: "model_default",
      cfgScale: 5,      costMultiplier: 1,
      requiredEntitlement: "video_generation",
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 0,
      version: 1,
      status: "active",
      dryRunSummary: { status: "not_run", source: "seed_configuration_state", disabledByFlag: "video_gen" },
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
      scheduler: "model_default",
      cfgScale: 5,      costMultiplier: 1,
      requiredEntitlement: "video_generation",
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 0,
      version: 1,
      status: "active",
      dryRunSummary: { status: "not_run", source: "seed_configuration_state", disabledByFlag: "video_gen" },
      publishedAt: new Date("2026-06-24T00:00:00.000Z"),
    },
    });
  }

  await ensureDefaultPricingRule({
    id: "seed-pricing-image-default-v1",
    ruleKey: "generation_image_default",
    label: "Image generation default",
    mode: "image",
    baseCost: 5,
    publishedAt: new Date("2026-06-24T00:00:00.000Z"),
  });

  await ensureDefaultPricingRule({
    id: "seed-pricing-video-default-v1",
    ruleKey: "generation_video_default",
    label: "Video generation default",
    mode: "video",
    baseCost: 100,
    publishedAt: new Date("2026-06-24T00:00:00.000Z"),
  });

  // Per-clip overflow price once a user's monthly voice-minute allowance is spent.
  await ensureDefaultPricingRule({
    id: "seed-pricing-voice-default-v1",
    ruleKey: "generation_voice_default",
    label: "Voice clip overflow",
    mode: "voice",
    baseCost: 2,
    publishedAt: new Date("2026-06-28T00:00:00.000Z"),
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

async function main() {
  await seedUsers();
  await seedTags();
  await seedCharacters();
  await seedOfficialCatalogQualifications();
  await seedCommunityCollections();
  await seedOfficialFeedbackItems();
  await seedPlans();
  await seedPresets();
  await seedAdminControlPlane();
  await seedPolicies();
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
