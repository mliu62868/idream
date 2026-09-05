import { Prisma, PrismaClient } from "@prisma/client";
import {
  compileCharacterSoul,
  minimaxH3VideoProductionRecipe,
  redgraftLtx25VideoProductionRecipe,
} from "@idream/shared";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { categoryFilters } from "../src/lib/ourdream-data";
import { createPrismaClientOptions } from "../src/server/lib/prisma-adapter";
import {
  PRODUCTION_H3_VIDEO_PROFILE,
  PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE,
} from "../src/server/modules/generation/production-video-profile";
import { safetyDocuments } from "../src/lib/ourdream-safety-data";
import {
  officialCharacterSeeds,
  officialFeedbackItems,
  resolveOfficialColdStartPersonaWrite,
} from "../src/lib/official-cold-start-content";
import { ensureOfficialEditorialCatalogQualification } from "../src/server/modules/ourdream/public-catalog-qualification";

process.env.DB_PROVIDER ??= "postgresql";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5433/idream";

const prisma = new PrismaClient(createPrismaClientOptions());

const SYSTEM_USER_ID = "seed-system-creator";
const ADMIN_USER_ID = "seed-admin-user";
const DEV_USER_ID = "seed-dev-user";
const CHAT_PROBE_USER_ID = "seed-chat-probe-user";
const SUPPORT_USER_ID = "seed-support-user";
const OPS_USER_ID = "seed-ops-user";
const ANALYST_USER_ID = "seed-analyst-user";
const COMFYUI_MODEL_ROOT =
  process.env.COMFYUI_MODEL_ROOT ?? "/Users/kk/ComfyUI-Shared/models";
const REDMIX3_FP8_MODEL_PATH = path.join(
  COMFYUI_MODEL_ROOT,
  "diffusion_models",
  "Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors",
);
const REDMIX3_TEXT_ENCODER_PATH = path.join(
  COMFYUI_MODEL_ROOT,
  "text_encoders",
  "qwen3vl_4b_bf16.safetensors",
);
const REDMIX3_VAE_PATH = path.join(
  COMFYUI_MODEL_ROOT,
  "vae",
  "qwen_image_vae.safetensors",
);
const REDMIX3_IDENTITY_LORA_PATH = path.join(
  COMFYUI_MODEL_ROOT,
  "loras",
  "Krea2",
  "krea2_identity_edit_v1_2.safetensors",
);
const REDMIX3_WORKFLOW_PATH = fileURLToPath(
  new URL(
    "../../gen/workflows/redcraft-krea2-redmix3-txt2img.json",
    import.meta.url,
  ),
);
const REDMIX3_IDENTITY_WORKFLOW_PATH = fileURLToPath(
  new URL(
    "../../gen/workflows/redcraft-krea2-identity-edit.json",
    import.meta.url,
  ),
);
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

  await prisma.user.upsert({
    where: { id: CHAT_PROBE_USER_ID },
    update: {
      role: "user",
      status: "active",
      dataClass: "audit",
      deletedAt: null,
    },
    create: {
      id: CHAT_PROBE_USER_ID,
      email: "chat-probe@idream.local",
      emailVerified: true,
      displayName: "Chat Launch Probe",
      role: "user",
      status: "active",
      dataClass: "audit",
    },
  });

  // The launch chat-service probe has a dedicated audit actor. It is never a
  // dev-login account and never shares a customer/developer conversation.
  // Keep its eligibility deterministic so a fresh seed can exercise the full
  // create → send → stream → read path instead of stopping at the age gate.
  await prisma.ageGateAcceptance.upsert({
    where: { id: "seed-chat-probe-user-age-gate" },
    update: {
      userId: CHAT_PROBE_USER_ID,
      sourcePath: "/launch-probe",
      policyVersion: "seed-v1",
    },
    create: {
      id: "seed-chat-probe-user-age-gate",
      userId: CHAT_PROBE_USER_ID,
      sourcePath: "/launch-probe",
      policyVersion: "seed-v1",
    },
  });

  // Live probes are operational checks, not customer consumption. Without this
  // entitlement, the deterministic probe user reaches the daily message cap
  // after repeated health checks and turns a healthy service red.
  await prisma.entitlement.upsert({
    where: { userId_key: { userId: CHAT_PROBE_USER_ID, key: "unlimited_messages" } },
    update: { value: true, source: "manual", expiresAt: null },
    create: {
      id: "seed-chat-probe-user-unlimited-messages",
      userId: CHAT_PROBE_USER_ID,
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

async function seedCharacters(
  cards: readonly (typeof officialCharacterSeeds)[number][] = officialCharacterSeeds,
) {
  for (const card of cards) {
    const mediaAssetId = `seed-image-${card.id}`;
    const age = parseAge(card.age);
    const tags = inferredTagSlugs(card);
    const detailsMarkdown = [
      `## Personality\n${card.personality}`,
      `## Voice\n${card.tone}`,
      `## Background\n${card.backstory}`,
      `## Scenario\n${card.setup}`,
      card.exampleDialogue.length > 0
        ? `## Dialogue examples\n${card.exampleDialogue.map((line) => `- ${line}`).join("\n")}`
        : "",
    ].filter(Boolean).join("\n\n");
    const personaDetails: Prisma.InputJsonObject = {
      detailsMarkdown,
      firstMessage: card.firstMessage,
    };
    const seedAppearance: Prisma.InputJsonObject = {
      sourceImage: card.image,
      identityAnchor: card.identityAnchor,
      stableTraits: [...card.stableTraits],
    };
    const compiledSoul = compileCharacterSoul({
      name: card.title,
      age,
      gender: "female",
      characterPromise: card.description,
      detailsMarkdown,
    });
    if (!compiledSoul.ok) {
      throw new Error(
        `Official seed Soul failed to compile for ${card.id}: ${JSON.stringify(compiledSoul.diagnostics)}`,
      );
    }
    const systemPrompt = compiledSoul.snapshot.compiled.systemPrompt;
    const [existingAsset, existingCharacter] = await Promise.all([
      prisma.mediaAsset.findUnique({
        where: { id: mediaAssetId },
        select: { metadata: true, ownerId: true },
      }),
      prisma.character.findUnique({
        where: { id: card.id },
        select: {
          advancedDetails: true,
          appearance: true,
          serving: {
            select: {
              currentRelease: { select: { legacy: true } },
            },
          },
          systemPrompt: true,
        },
      }),
    ]);
    const existingMetadata = inputJsonObject(existingAsset?.metadata);
    const existingAdvancedDetails = inputJsonObject(
      existingCharacter?.advancedDetails,
    );
    const officialAppearance: Prisma.InputJsonObject = {
      ...inputJsonObject(existingCharacter?.appearance),
      ...seedAppearance,
    };
    const existingProvenance = inputJsonObject(
      existingAdvancedDetails.provenance,
    );
    const hasExistingStructuredPersona =
      [
        "detailsMarkdown",
        "firstMessage",
      ].every((key) =>
        Boolean(nonBlankJsonString(existingAdvancedDetails[key])),
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
    const personaWrite = resolveOfficialColdStartPersonaWrite({
      currentReleaseLegacy:
        existingCharacter?.serving?.currentRelease?.legacy,
      seedAdvancedDetails: personaDetails,
      existingAdvancedDetails,
      compiledSystemPrompt: systemPrompt,
      existingSystemPrompt: existingCharacter?.systemPrompt,
      existingPersonaComplete: hasExistingStructuredPersona,
    });
    const officialAdvancedDetails: Prisma.InputJsonObject = {
      ...personaWrite.advancedDetails,
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
        style: card.style,
        appearance: officialAppearance,
        systemPrompt: personaWrite.systemPrompt,
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
        style: card.style,
        gender: "female",
        imageAssetId: mediaAssetId,
        vivid: card.vivid ?? false,
        appearance: officialAppearance,
        advancedDetails: officialAdvancedDetails,
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

async function seedOfficialCatalogQualifications(
  cards: readonly (typeof officialCharacterSeeds)[number][] = officialCharacterSeeds,
) {
  for (const card of cards) {
    const currentRelease = await prisma.character.findUnique({
      where: { id: card.id },
      select: {
        serving: {
          select: {
            currentRelease: { select: { legacy: true } },
          },
        },
      },
    });
    // INVARIANT: a modern operator Release supersedes the cold-start editorial
    // import. Repeat seeds must not replace it merely because its avatar is no
    // longer the original seed asset.
    if (currentRelease?.serving?.currentRelease?.legacy === false) {
      continue;
    }
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
    {"id": "seed-preset-background-rainy-cafe", "type": "background", "label": "Rainy Café", "category": "Everyday", "controls": {"background": "a quiet cafe beside a rain-streaked window", "lighting": "warm interior lamps and soft window light"}},
    {"id": "seed-preset-background-sunlit-garden", "type": "background", "label": "Sunlit Garden", "category": "Outdoors", "controls": {"background": "a leafy garden path with flowering plants", "lighting": "soft late-afternoon daylight"}},
    {"id": "seed-preset-background-city-evening", "type": "background", "label": "City Evening", "category": "Evening", "controls": {"background": "a city street at blue hour with distant shop lights", "lighting": "gentle evening reflections"}},
    {"id": "seed-preset-background-quiet-library", "type": "background", "label": "Quiet Library", "category": "Everyday", "controls": {"background": "a reading corner with bookshelves and a wooden desk", "lighting": "warm reading lamp"}},
    {"id": "seed-preset-pose-seated-portrait", "type": "pose", "label": "Seated Portrait", "category": "Studio", "controls": {"pose": "seated comfortably with relaxed shoulders, looking toward the camera"}},
    {"id": "seed-preset-pose-walking", "type": "pose", "label": "Walking", "category": "Outdoors", "controls": {"pose": "walking naturally, caught mid-step in a candid moment"}},
    {"id": "seed-preset-pose-over-shoulder", "type": "pose", "label": "Over the Shoulder", "category": "Studio", "controls": {"pose": "turned slightly away, looking back over one shoulder"}},
    {"id": "seed-preset-pose-relaxed-reading", "type": "pose", "label": "Relaxed Reading", "category": "Everyday", "controls": {"pose": "sitting comfortably and reading an open book"}},
    {"id": "seed-preset-outfit-knitwear", "type": "outfit", "label": "Knitwear", "category": "Everyday", "controls": {"outfit": "a soft knitted sweater and simple everyday trousers"}},
    {"id": "seed-preset-outfit-evening-dress", "type": "outfit", "label": "Evening Dress", "category": "Evening", "controls": {"outfit": "an elegant evening dress with subtle accessories"}},
    {"id": "seed-preset-outfit-athletic", "type": "outfit", "label": "Athletic", "category": "Outdoors", "controls": {"outfit": "a fitted sports top, track pants and running shoes"}},
    {"id": "seed-preset-outfit-tailored-suit", "type": "outfit", "label": "Tailored Suit", "category": "Studio", "controls": {"outfit": "a tailored suit over a plain shirt"}},
    {"id": "seed-preset-mode-editorial-photo", "type": "mode", "label": "Editorial Photo", "category": "Studio", "controls": {"style": "editorial portrait photography, natural skin texture, restrained color grading"}},
    {"id": "seed-preset-mode-cinematic", "type": "mode", "label": "Cinematic", "category": "Evening", "controls": {"style": "cinematic composition, atmospheric lighting, subtle film color"}},
    {"id": "seed-preset-mode-watercolor", "type": "mode", "label": "Watercolor", "category": "Illustration", "controls": {"style": "watercolor illustration with soft pigment washes and visible paper texture"}},
    {"id": "seed-preset-mode-line-art", "type": "mode", "label": "Line Art", "category": "Illustration", "controls": {"style": "clean expressive line illustration with restrained flat colors"}},
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
      enabled: true,
      rolloutPercent: 100,
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
      update: {},
      create: {
        id: "seed-profile-image-default-v1",
        profileKey: "profile_image_default_v1",
        label: "Default image · Krea 2 RedMix3",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "redcraft-krea2-redmix3-fp8",
        workflowKey: "redcraft-krea2-redmix3-txt2img",
        sourceModelPath: REDMIX3_FP8_MODEL_PATH,
        convertedModelPath: null,
        modelFormat: "safetensors",
        runnerConfig: {
          sourceFp8Path: REDMIX3_FP8_MODEL_PATH,
          diffusionModelPath: REDMIX3_FP8_MODEL_PATH,
          textEncoderPath: REDMIX3_TEXT_ENCODER_PATH,
          vaePath: REDMIX3_VAE_PATH,
          workflowPath: REDMIX3_WORKFLOW_PATH,
          workflowVersion: 2,
          apiModelId: "redcraft-krea2-redmix3-fp8",
          precisionPolicy: "fp8_resident_bf16_transient_mps",
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
        steps: 12,
        sampler: "euler",
        scheduler: "simple",
        cfgScale: 1,
        costMultiplier: 1,
        requiredEntitlement: null,
        maxCount: 1,
        concurrencyLimit: 1,
        enabled: true,
        rolloutPercent: 100,
        version: 2,
        status: "active",
        dryRunSummary: {
          status: "runtime_verified_mps",
          source: "redmix3_scaled_fp8_local_runtime",
          notes:
            "Scaled-FP8 weights stay resident; M1-M4 decode individual operations to BF16 without a whole-model BF16 serving copy.",
        },
        publishedAt: new Date("2026-08-01T01:07:04.054Z"),
      },
    });
  }

  if (!existingProfileKeys.has("profile_image_premium_v1")) {
    await prisma.generationModelProfile.upsert({
      where: { id: "seed-profile-image-premium-v1" },
      update: {},
      create: {
        id: "seed-profile-image-premium-v1",
        profileKey: "profile_image_premium_v1",
        label: "Premium image",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "redcraft-krea2-redmix3-fp8",
        workflowKey: "redcraft-krea2-redmix3-txt2img",
        sourceModelPath: REDMIX3_FP8_MODEL_PATH,
        convertedModelPath: null,
        modelFormat: "safetensors",
        runnerConfig: {
          sourceFp8Path: REDMIX3_FP8_MODEL_PATH,
          diffusionModelPath: REDMIX3_FP8_MODEL_PATH,
          textEncoderPath: REDMIX3_TEXT_ENCODER_PATH,
          vaePath: REDMIX3_VAE_PATH,
          workflowPath: REDMIX3_WORKFLOW_PATH,
          workflowVersion: 2,
          apiModelId: "redcraft-krea2-redmix3-fp8",
          precisionPolicy: "fp8_resident_bf16_transient_mps",
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
        cfgScale: 1,
        costMultiplier: 1.5,
        requiredEntitlement: "premium_models",
        maxCount: 4,
        concurrencyLimit: 1,
        enabled: true,
        rolloutPercent: 100,
        version: 2,
        status: "active",
        dryRunSummary: {
          status: "runtime_verified_mps",
          source: "redmix3_scaled_fp8_local_runtime",
          notes:
            "Scaled-FP8 weights stay resident; M1-M4 decode individual operations to BF16 without a whole-model BF16 serving copy.",
        },
        publishedAt: new Date("2026-08-12T20:12:36.042Z"),
      },
    });
  }

  if (!existingProfileKeys.has("character-image-single-identity-redcraft")) {
    await prisma.generationModelProfile.upsert({
      where: { id: "seed-profile-character-image-single-identity-redcraft-v1" },
      update: {},
      create: {
        id: "seed-profile-character-image-single-identity-redcraft-v1",
        profileKey: "character-image-single-identity-redcraft",
        label: "Character Single-Reference Identity (RedCraft Krea2)",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "redcraft-krea2-identity-edit",
        workflowKey: "redcraft-krea2-identity-edit",
        sourceModelPath: REDMIX3_FP8_MODEL_PATH,
        convertedModelPath: null,
        modelFormat: "safetensors",
        runnerConfig: {
          sourceFp8Path: REDMIX3_FP8_MODEL_PATH,
          diffusionModelPath: REDMIX3_FP8_MODEL_PATH,
          textEncoderPath: REDMIX3_TEXT_ENCODER_PATH,
          vaePath: REDMIX3_VAE_PATH,
          identityLoraPath: REDMIX3_IDENTITY_LORA_PATH,
          workflowPath: REDMIX3_IDENTITY_WORKFLOW_PATH,
          workflowVersion: 5,
          apiModelId: "redcraft-krea2-identity-edit",
          precisionPolicy: "fp8_resident_bf16_transient_mps",
          templateIntent: "single_face_reference_identity_restaging",
          publicSelection: { explicitOnly: true },
          capabilities: {
            textToImage: false,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: true,
          },
          identityEdit: {
            nodePack: "comfyui-krea2edit@1.2.5",
            nodePackRevision: "bdfa8b267fdb13730868d435b277dcfe696ec083",
            fileName: "krea2_identity_edit_v1_2.safetensors",
            sha256: "6ADF9A69CC9502D286DB7B69964D37DA7E9CFE4B05B4D004BC275F087D3FD3CF",
            strength: 1,
            refBoost: 4,
            fitMode: "fit",
            groundingPx: 768,
            referenceFraming: "face_closeup",
            bodyAuthority: "character_appearance_text",
          },
        },
        defaultWidth: 832,
        defaultHeight: 1216,
        allowedOrientations: ["4:5", "3:4", "1:1"],
        steps: 8,
        sampler: "euler",
        scheduler: "simple",
        cfgScale: 1,
        costMultiplier: 1.3,
        requiredEntitlement: null,
        maxCount: 1,
        concurrencyLimit: 1,
        enabled: true,
        rolloutPercent: 100,
        version: 5,
        status: "active",
        dryRunSummary: {
          status: "runtime_smoke_passed_reference_limited",
          source: "local_comfyui_mps_2026-08-28",
          notes:
            "A face-only identity anchor passed identity, hotel restaging, and clothing-removal intent at 832x1216. Full-body references leaked outfit and pose; body traits remain text-authoritative. Keep explicit-only pending a broader fixed A/B.",
        },
        publishedAt: new Date("2026-08-28T00:00:00.000Z"),
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
        workflowVersion: 2,
        publicSelection: { surface: "generator_image_edit" },
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
      version: 2,
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
        workflowVersion: 2,
        publicSelection: { surface: "generator_image_edit" },
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
      version: 2,
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
          workflowVersion: 3,
          publicSelection: { surface: "generator_image_edit" },
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
        version: 3,
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
          workflowVersion: 3,
          publicSelection: { surface: "generator_image_edit" },
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
        version: 3,
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
          workflowVersion: 2,
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
        version: 2,
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
          workflowVersion: 2,
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
        version: 2,
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

  const retiredLtx23Profiles = await prisma.generationModelProfile.findMany({
    where: {
      OR: [
        { id: "seed-profile-video-beta-v1" },
        { profileKey: "profile_video_beta_v1" },
        { pipelineModel: "ltx23-gtanimation-int4-convrot" },
        { workflowKey: "ltx23-gtanimation-i2v" },
      ],
    },
    select: { id: true, archivedAt: true },
  });
  for (const profile of retiredLtx23Profiles) {
    await prisma.generationModelProfile.update({
      where: { id: profile.id },
      data: {
        enabled: false,
        rolloutPercent: 0,
        status: "archived",
        archivedAt: profile.archivedAt ?? new Date(),
      },
    });
  }

  if (!existingProfileKeys.has(minimaxH3VideoProductionRecipe.profileKey)) {
    const recipe = minimaxH3VideoProductionRecipe;
    const profile = PRODUCTION_H3_VIDEO_PROFILE;
    await prisma.generationModelProfile.upsert({
      where: { id: "seed-profile-video-h3-v1" },
      update: {},
      create: {
        id: "seed-profile-video-h3-v1",
        ...profile,
        label: recipe.modelLabel,
        mode: "video",
        convertedModelPath: null,
        costMultiplier: 1,
        enabled: true,
        status: "active",
        dryRunSummary: {
          status: "passed",
          source: "local_mps_exact_model_probe",
          testedAt: "2026-08-19",
          resolution: `${recipe.width}x${recipe.height}`,
          frames: recipe.frameCount,
          seconds: recipe.expectedDurationSeconds,
          fps: recipe.fps,
          wallTimeSeconds: 792.917,
          notes:
            "Exact RedCraft MiniMax H3 INT8 ConvRot workflow completed I2V with AAC audio on Apple Silicon MPS.",
        },
        publishedAt: new Date("2026-08-19T00:00:00.000Z"),
      },
    });
  }

  if (!existingProfileKeys.has(redgraftLtx25VideoProductionRecipe.profileKey)) {
    const recipe = redgraftLtx25VideoProductionRecipe;
    const profile = PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE;
    await prisma.generationModelProfile.upsert({
      where: { id: "seed-profile-video-redgraft-ltx25-v1" },
      update: {},
      create: {
        id: "seed-profile-video-redgraft-ltx25-v1",
        ...profile,
        label: recipe.modelLabel,
        mode: "video",
        convertedModelPath: null,
        costMultiplier: 1,
        enabled: true,
        status: "active",
        dryRunSummary: {
          status: "passed",
          source: "local_mps_multi_seed_and_cutover_probe",
          testedAt: "2026-08-28",
          resolution: `${recipe.width}x${recipe.height}`,
          frames: recipe.frameCount,
          seconds: recipe.expectedDurationSeconds,
          fps: recipe.fps,
          wallTimeSeconds: 866.617,
          notes:
            "Exact Civitai 3250230 checkpoint completed multi-seed and repeat I2V validation with AAC audio on ComfyUI 0.34.2 / PyTorch 2.13 MPS.",
        },
        publishedAt: new Date("2026-08-28T00:00:00.000Z"),
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

  // The native 2× model was exercised on the shared MPS backend before this
  // route was published. It is never an automatic text/character generator.
  if (!existingProfileKeys.has("image-enhance-2x")) {
    await prisma.generationModelProfile.create({ data: {
      id: "seed-profile-image-enhance-2x-v1", profileKey: "image-enhance-2x", label: "Enhance 2×",
      mode: "image", runner: "comfyui", pipelineModel: "realesrgan-x2plus-enhance", workflowKey: "realesrgan-x2plus-enhance",
      sourceModelPath: "upscale_models/RealESRGAN_x2plus.pth", modelFormat: "pytorch",
      runnerConfig: {
        workflowVersion: 1, publicSelection: { surface: "gallery_enhance", explicitOnly: true },
        capabilities: { textToImage: false, initImage: true, referenceImages: true, stableSeed: false, lora: false },
        enhancement: { scale: 2 },
        modelAsset: { filename: "RealESRGAN_x2plus.pth", sha256: "49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb", source: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth", license: "BSD-3-Clause" },
      },
      defaultWidth: 1024, defaultHeight: 1024, allowedOrientations: ["original"], steps: 1,
      sampler: "native", scheduler: "native", cfgScale: 1, costMultiplier: 1, maxCount: 1,
      status: "active", enabled: true, rolloutPercent: 100,
      publishedAt: new Date("2026-09-02T21:37:19.133Z"),
      dryRunSummary: { status: "runtime_verified_mps", source: "native_realesrgan_x2plus", sourceWidth: 512, sourceHeight: 640, width: 1024, height: 1280, elapsedMs: 3260, sourceSha256: "f5080a1fb7c9ff5db42fd8ed3fb3c1c3a068090e77e2e395424425133d6bdfe1", outputSha256: "4943ceb81006bfb4986b526578085309eece0f6f2dc38297c2380d2be7d8a18b" },
    } });
  }
  if (!await prisma.generationRecipe.findFirst({ where: { recipeKey: "image-enhance-2x" } })) {
    await prisma.generationRecipe.create({ data: {
      id: "seed-recipe-image-enhance-2x-v1", recipeKey: "image-enhance-2x", label: "Enhance 2×",
      mode: "image", useCase: "enhance", body: "Enhance the source image at its original aspect ratio by exactly 2×.",
      presetOrder: [], safetyHints: {}, sampleMatrix: [], status: "active", publishedAt: new Date("2026-09-02T21:37:19.133Z"),
    } });
  }

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
  const officialCharacterId =
    process.env.IDREAM_SEED_OFFICIAL_CHARACTER_ID?.trim();
  if (officialCharacterId) {
    const card = officialCharacterSeeds.find(
      (candidate) => candidate.id === officialCharacterId,
    );
    if (!card) {
      throw new Error(
        `Unknown official Character seed: ${officialCharacterId}`,
      );
    }
    // SPEC: Operators may refresh one cold-start Character without replaying
    // unrelated catalog, billing, preset, or control-plane seed mutations.
    await seedCharacters([card]);
    await seedOfficialCatalogQualifications([card]);
    return;
  }
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
