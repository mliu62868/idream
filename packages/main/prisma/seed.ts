import { PrismaClient } from "@prisma/client";
import {
  categoryFilters,
  characterCards,
  getOurdreamRoute,
  ourdreamRoutePaths,
} from "../src/lib/ourdream-data";
import { createPrismaClientOptions } from "../src/server/lib/prisma-adapter";
import { safetyDocuments } from "../src/lib/ourdream-safety-data";

process.env.DB_PROVIDER ??= "sqlite";
process.env.DATABASE_URL ??= "file:./dev.db";

const prisma = new PrismaClient(createPrismaClientOptions());

const SYSTEM_USER_ID = "seed-system-creator";
const ADMIN_USER_ID = "seed-admin-user";
const DEV_USER_ID = "seed-dev-user";

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
