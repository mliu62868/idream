import { Prisma, PrismaClient } from "@prisma/client";
import { buildCharacterSystemPrompt } from "@idream/shared";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
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
const CHAT_PROBE_USER_ID = "seed-chat-probe-user";
const SUPPORT_USER_ID = "seed-support-user";
const OPS_USER_ID = "seed-ops-user";
const ANALYST_USER_ID = "seed-analyst-user";
const KREA2_TEXT_ENCODER_PATH =
  "/Users/kk/.localai/models/krea2/text_encoders/Qwen3VL-4B-Instruct-Q4_K_M.gguf";
const KREA2_VAE_PATH = "/Users/kk/.localai/models/krea2/vae/wan_2.1_vae.safetensors";
const COMFYUI_MODEL_ROOT =
  process.env.COMFYUI_MODEL_ROOT ?? "/Users/kk/ComfyUI-Shared/models";
const DARKBEAST_BFS_FLUX2_MODEL_PATH = path.join(
  COMFYUI_MODEL_ROOT,
  "diffusion_models",
  "darkBeastINT8Convrot2_dbkleinv2BFS.safetensors",
);
const DARKBEAST_BFS_FLUX2_TEXT_ENCODER_PATH = path.join(
  COMFYUI_MODEL_ROOT,
  "text_encoders",
  "qwen_3_8b_fp8mixed.safetensors",
);
const DARKBEAST_BFS_FLUX2_VAE_PATH = path.join(
  COMFYUI_MODEL_ROOT,
  "vae",
  "flux2-vae.safetensors",
);
const DARKBEAST_BFS_FLUX2_WORKFLOW_PATH = fileURLToPath(
  new URL(
    "../../gen/workflows/darkbeast-flux2-klein-9b-multi-reference.json",
    import.meta.url,
  ),
);
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
const REDMIX3_WORKFLOW_PATH = fileURLToPath(
  new URL(
    "../../gen/workflows/redcraft-krea2-redmix3-txt2img.json",
    import.meta.url,
  ),
);

function darkBeastComparisonProfileData() {
  return {
    profileKey: "darkbeast-flux2-klein-bfs-comparison",
    label: "Dark Beast FLUX.2 Klein 9B BFS comparison",
    mode: "image",
    runner: "comfyui",
    pipelineModel: "darkbeast-flux2-klein-9b-bfs",
    workflowKey: "darkbeast-flux2-klein-9b-multi-reference",
    sourceModelPath: DARKBEAST_BFS_FLUX2_MODEL_PATH,
    convertedModelPath: null,
    modelFormat: "safetensors",
    runnerConfig: {
      diffusionModelPath: DARKBEAST_BFS_FLUX2_MODEL_PATH,
      textEncoderPath: DARKBEAST_BFS_FLUX2_TEXT_ENCODER_PATH,
      vaePath: DARKBEAST_BFS_FLUX2_VAE_PATH,
      workflowPath: DARKBEAST_BFS_FLUX2_WORKFLOW_PATH,
      apiModelId: "darkbeast-flux2-klein-9b-bfs",
      templateIntent: "image_edit_identity_source_comparison",
      baseModel: "Flux.2 Klein 9B",
      civitaiModelId: 2242173,
      civitaiVersionId: 2740209,
      civitaiVersionName: "DBKleinV2 BFS",
      civitaiAutoV2: "B20B6F2744",
      civitaiSha256:
        "B20B6F2744E152FD3EFA2638E88A5FEAB478C778EE25C81B183FD80E03A099C3",
      verificationStatus: "workflow_registered_runtime_assets_missing",
      comparisonBaseline: {
        modelId: "qwen-image-edit-multi-reference",
        workflowKey: "qwen-image-edit-multi-reference",
      },
      workflow: {
        kind: "flux2_klein_native_multi_reference",
        source: "https://civitai.com/api/v1/model-versions/2740453",
        identityReferenceRole: "identity_reference",
        sourceReferenceRole: "source_image",
        sampler: "euler",
        scheduler: "flux2",
        steps: 5,
        cfgScale: 1,
        notes:
          "The comparison descriptor uses two native ReferenceLatent chains without optional BFS LoRA or SeedVR2 post-processing, so model behavior remains attributable during Qwen Image Edit A/B.",
      },
      componentStatus: {
        diffusionModel: {
          status: "configured",
          path: DARKBEAST_BFS_FLUX2_MODEL_PATH,
        },
        qwenTextEncoder: {
          status: "configured",
          path: DARKBEAST_BFS_FLUX2_TEXT_ENCODER_PATH,
        },
        flux2Vae: {
          status: "configured",
          path: DARKBEAST_BFS_FLUX2_VAE_PATH,
        },
        comfyWorkflow: {
          status: "registered",
          path: DARKBEAST_BFS_FLUX2_WORKFLOW_PATH,
        },
      },
      requiredComponents: [
        "darkBeastINT8Convrot2_dbkleinv2BFS.safetensors",
        "qwen_3_8b_fp8mixed.safetensors",
        "flux2-vae.safetensors",
        "ComfyUI 0.28+ native ReferenceLatent workflow",
      ],
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
    allowedOrientations: ["4:5"],
    steps: 5,
    sampler: "euler",
    scheduler: "flux2",
    cfgScale: 1,
    costMultiplier: 1.2,
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
      failureMode: "runtime_assets_not_verified",
      testedAt: "2026-07-19",
      notes:
        "The exact Civitai 2740209 checkpoint is FLUX.2 Klein 9B, not Krea 2. Its two-reference descriptor is registered for an identity+source A/B against qwen-image-edit-multi-reference. Keep disabled at zero rollout until the exact model, Qwen 8B encoder, and FLUX.2 VAE are installed on a compatible runner and a real artifact smoke passes.",
    },
    publishedAt: null,
  } satisfies Prisma.GenerationModelProfileUncheckedUpdateInput;
}

function darkBeastUserImageEditProfileData() {
  const candidate = darkBeastComparisonProfileData();
  return {
    ...candidate,
    profileKey: "character-image-variation-darkbeast",
    label: "Dark Beast · Identity Focus",
    runnerConfig: {
      ...candidate.runnerConfig,
      verificationStatus: "runtime_verified_mps",
      publicSelection: {
        surface: "generator_image_edit",
        referenceMode: "identity_source",
        explicitOnly: true,
      },
    },
    enabled: true,
    rolloutPercent: 100,
    status: "active",
    dryRunSummary: {
      sampleCount: 1,
      successRate: 1,
      p95LatencyMs: 116_500,
      testedAt: "2026-07-19",
      smokeOutputPath:
        "/Users/kk/ComfyUI-Shared/output/idream_darkbeast_flux2_klein_multi_00001_.png",
      smokeOutputSha256:
        "be3f9252c37b9d203d4e4eb98b51d5a1e57e6c5de183a6944e54063b12f59f5a",
      notes:
        "Verified on ComfyUI 0.28.0 with Apple MPS at 832x1216, 5 Euler steps. Published only as an explicit identity-plus-source image-edit choice; automatic routing remains unchanged.",
    },
    publishedAt: new Date("2026-07-24T00:00:00.000Z"),
  } satisfies Prisma.GenerationModelProfileUncheckedUpdateInput;
}

function redMix3ComparisonProfileData() {
  return {
    profileKey: "redcraft-krea2-redmix3-comparison",
    label: "RedCraft Krea2 RedMix3 comparison",
    mode: "image",
    runner: "comfyui",
    pipelineModel: "redcraft-krea2-redmix3-fp8",
    workflowKey: "redcraft-krea2-redmix3-txt2img",
    sourceModelPath: REDMIX3_FP8_MODEL_PATH,
    // SPEC: run the Civitai release file as-is. Once fp4-fp8-for-torch-mps is in
    // the runner venv, ComfyUI dequantizes scaled-fp8 per layer on MPS, so the
    // former bf16 conversion product is neither needed nor equivalent to it
    // (measured RMSE 25.5 against the same seed on the krea2Edition pair).
    convertedModelPath: null,
    modelFormat: "safetensors",
    runnerConfig: {
      sourceFp8Path: REDMIX3_FP8_MODEL_PATH,
      diffusionModelPath: REDMIX3_FP8_MODEL_PATH,
      textEncoderPath: REDMIX3_TEXT_ENCODER_PATH,
      vaePath: REDMIX3_VAE_PATH,
      workflowPath: REDMIX3_WORKFLOW_PATH,
      apiModelId: "redcraft-krea2-redmix3-fp8",
      templateIntent: "redmix3_text_to_image_comparison",
      baseModel: "Krea 2",
      civitaiModelId: 958009,
      civitaiVersionId: 3139241,
      civitaiVersionName: "赤佬 3.0 (Krea2)",
      civitaiFileId: 3019490,
      civitaiFileName: "redcraft23INT8INT4FP8_30Krea2.safetensors",
      civitaiPrecision: "fp8",
      civitaiAutoV2: "F6088960C0",
      civitaiSha256:
        "F6088960C0FEBD27CBD372FC758BB07D012F2D8AE3CD10C45C903D48B94409EA",
      // Header expectations are still worth asserting on download; they just no
      // longer feed a conversion step.
      weightLayout: {
        format: "scaled_fp8_e4m3",
        expectedFp8Weights: 256,
        expectedWeightScales: 256,
        expectedComfyQuantSidecars: 256,
      },
      verificationStatus: "runtime_verified_mps",
      comparisonBaseline: {
        modelId: "redcraft-krea2-redmix3-fp8",
        workflowKey: "redcraft-krea2-redmix3-txt2img",
      },
      workflow: {
        sampler: "euler",
        scheduler: "simple",
        steps: 12,
        cfgScale: 1,
        notes:
          "The candidate graph excludes author showcase LoRA and upscalers. The current route uses 10-step ER-SDE, so paired artifacts compare version-native recipes rather than model weights alone.",
      },
      componentStatus: {
        sourceFp8: {
          // SHA-256 verified against the Civitai release on 2026-07-29.
          status: "present",
          path: REDMIX3_FP8_MODEL_PATH,
        },
        qwenTextEncoder: {
          status: "present",
          path: REDMIX3_TEXT_ENCODER_PATH,
        },
        qwenVae: {
          status: "present",
          path: REDMIX3_VAE_PATH,
        },
        comfyWorkflow: {
          status: "registered",
          path: REDMIX3_WORKFLOW_PATH,
        },
      },
      requiredComponents: [
        "Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors",
        "qwen3vl_4b_bf16.safetensors",
        "qwen_image_vae.safetensors",
        "ComfyUI 0.28+ MPS workflow",
      ],
      capabilities: {
        textToImage: true,
        stableSeed: true,
        referenceImages: false,
        initImage: false,
        lora: false,
      },
    },
    defaultWidth: 832,
    defaultHeight: 1216,
    allowedOrientations: ["3:4", "4:5", "1:1"],
    steps: 12,
    sampler: "euler",
    scheduler: "simple",
    cfgScale: 1,
    costMultiplier: 1.2,
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
      failureMode: "artifact_smoke_pending",
      testedAt: "2026-07-19",
      notes:
        "RedMix3 is registered as an isolated BF16 conversion candidate. Keep disabled at zero rollout until the exact FP8 hash, conversion integrity, and a real MPS artifact smoke pass.",
    },
    publishedAt: null,
  } satisfies Prisma.GenerationModelProfileUncheckedUpdateInput;
}

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

async function seedCharacters() {
  for (const card of officialCharacterSeeds) {
    const mediaAssetId = `seed-image-${card.id}`;
    const age = parseAge(card.age);
    const tags = inferredTagSlugs(card);
    const personaDetails: Prisma.InputJsonObject = {
      relationshipArchetype: card.relationship,
      personality: card.personality,
      tone: card.tone,
      backstory: card.backstory,
      firstMessage: card.firstMessage,
      exampleDialogue: [...card.exampleDialogue],
    };
    const systemPrompt = buildCharacterSystemPrompt({
      name: card.title,
      age,
      description: card.description,
      relationship: card.relationship,
      style: card.title.toLowerCase().includes("anime") ? "anime" : "realistic",
      gender: "female",
      tags,
      appearance: { sourceImage: card.image },
      advancedDetails: personaDetails,
    });
    const [existingAsset, existingCharacter] = await Promise.all([
      prisma.mediaAsset.findUnique({
        where: { id: mediaAssetId },
        select: { metadata: true, ownerId: true },
      }),
      prisma.character.findUnique({
        where: { id: card.id },
        select: {
          advancedDetails: true,
          relationship: true,
          systemPrompt: true,
        },
      }),
    ]);
    const existingMetadata = inputJsonObject(existingAsset?.metadata);
    const existingAdvancedDetails = inputJsonObject(
      existingCharacter?.advancedDetails,
    );
    const existingProvenance = inputJsonObject(
      existingAdvancedDetails.provenance,
    );
    const hasExistingStructuredPersona =
      Boolean(existingCharacter?.relationship?.trim()) &&
      [
        "personality",
        "tone",
        "backstory",
        "firstMessage",
      ].every((key) =>
        Boolean(nonBlankJsonString(existingAdvancedDetails[key])),
      ) &&
      Array.isArray(existingAdvancedDetails.exampleDialogue) &&
      existingAdvancedDetails.exampleDialogue.some(
        (line) => typeof line === "string" && line.trim(),
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
      ...personaDetails,
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
        relationship:
          existingCharacter?.relationship?.trim() || card.relationship,
        systemPrompt:
          hasExistingStructuredPersona &&
          existingCharacter?.systemPrompt?.trim()
            ? existingCharacter.systemPrompt
            : systemPrompt,
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
        relationship: card.relationship,
        imageAssetId: mediaAssetId,
        vivid: card.vivid ?? false,
        appearance: {
          sourceImage: card.image,
        },
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
    update: {
      profileKey: "profile_image_default_v1",
      label: "Default image",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "redcraft-krea2-redmix3-fp8",
      workflowKey: "redcraft-krea2-redmix3-txt2img",
      sourceModelPath: REDMIX3_FP8_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        modelPath: REDMIX3_FP8_MODEL_PATH,
        apiModelId: "redcraft-krea2-redmix3-fp8",
        workflowPath: REDMIX3_WORKFLOW_PATH,
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
      pipelineModel: "redcraft-krea2-redmix3-fp8",
      workflowKey: "redcraft-krea2-redmix3-txt2img",
      sourceModelPath: REDMIX3_FP8_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        modelPath: REDMIX3_FP8_MODEL_PATH,
        apiModelId: "redcraft-krea2-redmix3-fp8",
        workflowPath: REDMIX3_WORKFLOW_PATH,
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
      pipelineModel: "redcraft-krea2-redmix3-fp8",
      workflowKey: "redcraft-krea2-redmix3-txt2img",
      sourceModelPath: REDMIX3_FP8_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        modelPath: REDMIX3_FP8_MODEL_PATH,
        apiModelId: "redcraft-krea2-redmix3-fp8",
        workflowPath: REDMIX3_WORKFLOW_PATH,
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
      pipelineModel: "redcraft-krea2-redmix3-fp8",
      workflowKey: "redcraft-krea2-redmix3-txt2img",
      sourceModelPath: REDMIX3_FP8_MODEL_PATH,
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        modelPath: REDMIX3_FP8_MODEL_PATH,
        apiModelId: "redcraft-krea2-redmix3-fp8",
        workflowPath: REDMIX3_WORKFLOW_PATH,
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

  if (!existingProfileKeys.has("darkbeast-flux2-klein-bfs-comparison")) {
    const profileData = darkBeastComparisonProfileData();
    await prisma.generationModelProfile.upsert({
      where: { id: "seed-profile-sdcpp-darkbeast-krea2-img2img-v1" },
      update: profileData,
      create: {
        id: "seed-profile-sdcpp-darkbeast-krea2-img2img-v1",
        ...profileData,
      },
    });
  }

  if (!existingProfileKeys.has("character-image-variation-darkbeast")) {
    const profileData = darkBeastUserImageEditProfileData();
    await prisma.generationModelProfile.upsert({
      where: { id: "seed-profile-darkbeast-user-image-edit-v1" },
      update: profileData,
      create: {
        id: "seed-profile-darkbeast-user-image-edit-v1",
        ...profileData,
      },
    });
  }

  if (!existingProfileKeys.has("redcraft-krea2-redmix3-comparison")) {
    const profileData = redMix3ComparisonProfileData();
    await prisma.generationModelProfile.upsert({
      where: { id: "seed-profile-redcraft-krea2-redmix3-v1" },
      update: profileData,
      create: {
        id: "seed-profile-redcraft-krea2-redmix3-v1",
        ...profileData,
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

  const legacyVideoBetaProfile =
    await prisma.generationModelProfile.findUnique({
      where: { id: "seed-profile-video-beta-v1" },
      select: {
        profileKey: true,
        label: true,
        mode: true,
        runner: true,
        pipelineModel: true,
        workflowKey: true,
        sourceModelPath: true,
        convertedModelPath: true,
        modelFormat: true,
        runnerConfig: true,
        defaultWidth: true,
        defaultHeight: true,
        allowedOrientations: true,
        steps: true,
        sampler: true,
        scheduler: true,
        cfgScale: true,
        costMultiplier: true,
        requiredEntitlement: true,
        maxCount: true,
        concurrencyLimit: true,
        enabled: true,
        rolloutPercent: true,
        version: true,
        status: true,
        dryRunSummary: true,
        publishedAt: true,
        archivedAt: true,
      },
    });
  const isUntouchedLegacyVideoBeta =
    legacyVideoBetaProfile?.profileKey === "profile_video_beta_v1" &&
    legacyVideoBetaProfile.label === "Video beta" &&
    legacyVideoBetaProfile.mode === "video" &&
    legacyVideoBetaProfile.runner === "external" &&
    legacyVideoBetaProfile.pipelineModel === "mock-video" &&
    legacyVideoBetaProfile.workflowKey === null &&
    legacyVideoBetaProfile.sourceModelPath === null &&
    legacyVideoBetaProfile.convertedModelPath === null &&
    legacyVideoBetaProfile.modelFormat === "external" &&
    isDeepStrictEqual(
      legacyVideoBetaProfile.runnerConfig,
      { disabledUntilFlag: "video_gen" },
    ) &&
    legacyVideoBetaProfile.defaultWidth === 768 &&
    legacyVideoBetaProfile.defaultHeight === 1024 &&
    isDeepStrictEqual(
      legacyVideoBetaProfile.allowedOrientations,
      ["9:16", "16:9"],
    ) &&
    legacyVideoBetaProfile.steps === 24 &&
    legacyVideoBetaProfile.sampler === "video_default" &&
    legacyVideoBetaProfile.scheduler === "model_default" &&
    legacyVideoBetaProfile.cfgScale === 5 &&
    legacyVideoBetaProfile.costMultiplier === 1 &&
    legacyVideoBetaProfile.requiredEntitlement === "video_generation" &&
    legacyVideoBetaProfile.maxCount === 1 &&
    legacyVideoBetaProfile.concurrencyLimit === 1 &&
    legacyVideoBetaProfile.enabled === true &&
    legacyVideoBetaProfile.rolloutPercent === 0 &&
    legacyVideoBetaProfile.version === 1 &&
    legacyVideoBetaProfile.status === "active" &&
    isDeepStrictEqual(
      legacyVideoBetaProfile.dryRunSummary,
      {
        status: "not_run",
        source: "seed_configuration_state",
        disabledByFlag: "video_gen",
      },
    ) &&
    legacyVideoBetaProfile.publishedAt?.getTime() ===
      new Date("2026-06-24T00:00:00.000Z").getTime() &&
    legacyVideoBetaProfile.archivedAt === null;
  if (
    !existingProfileKeys.has("profile_video_beta_v1") ||
    isUntouchedLegacyVideoBeta
  ) {
    await prisma.generationModelProfile.upsert({
    where: { id: "seed-profile-video-beta-v1" },
    update: {
      profileKey: "profile_video_beta_v1",
      label: "LTX 2.3 GTAnimation I2V",
      mode: "video",
      runner: "comfyui",
      pipelineModel: "ltx23-gtanimation-int4-convrot",
      workflowKey: "ltx23-gtanimation-i2v",
      sourceModelPath: "diffusion_models/ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors",
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        workflowVersion: 1,
        capabilities: {
          textToImage: false,
          stableSeed: true,
          referenceImages: false,
          initImage: true,
          imageToVideo: true,
          audio: true,
          fps: 25,
          maxDurationSeconds: 4,
        },
      },
      defaultWidth: 768,
      defaultHeight: 1152,
      allowedOrientations: ["2:3"],
      steps: 13,
      sampler: "euler",
      scheduler: "manual_sigmas",
      cfgScale: 1,
      costMultiplier: 1,
      requiredEntitlement: "video_generation",
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: {
        status: "passed",
        source: "local_mps_exact_model_probe",
        testedAt: "2026-07-25",
        resolution: "768x1152",
        seconds: 6,
        fps: 25,
        wallTimeSeconds: 854.106,
        peakRssGiB: 25.034,
        notes:
          "Exact INT4 ConvRot checkpoint completed the two-stage LTX 2.3 I2V workflow with audio on Apple Silicon MPS.",
      },
      publishedAt: new Date("2026-07-25T00:00:00.000Z"),
    },
    create: {
      id: "seed-profile-video-beta-v1",
      profileKey: "profile_video_beta_v1",
      label: "LTX 2.3 GTAnimation I2V",
      mode: "video",
      runner: "comfyui",
      pipelineModel: "ltx23-gtanimation-int4-convrot",
      workflowKey: "ltx23-gtanimation-i2v",
      sourceModelPath: "diffusion_models/ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors",
      convertedModelPath: null,
      modelFormat: "safetensors",
      runnerConfig: {
        workflowVersion: 1,
        capabilities: {
          textToImage: false,
          stableSeed: true,
          referenceImages: false,
          initImage: true,
          imageToVideo: true,
          audio: true,
          fps: 25,
          maxDurationSeconds: 4,
        },
      },
      defaultWidth: 768,
      defaultHeight: 1152,
      allowedOrientations: ["2:3"],
      steps: 13,
      sampler: "euler",
      scheduler: "manual_sigmas",
      cfgScale: 1,
      costMultiplier: 1,
      requiredEntitlement: "video_generation",
      maxCount: 1,
      concurrencyLimit: 1,
      enabled: true,
      rolloutPercent: 100,
      version: 1,
      status: "active",
      dryRunSummary: {
        status: "passed",
        source: "local_mps_exact_model_probe",
        testedAt: "2026-07-25",
        resolution: "768x1152",
        seconds: 6,
        fps: 25,
        wallTimeSeconds: 854.106,
        peakRssGiB: 25.034,
        notes:
          "Exact INT4 ConvRot checkpoint completed the two-stage LTX 2.3 I2V workflow with audio on Apple Silicon MPS.",
      },
      publishedAt: new Date("2026-07-25T00:00:00.000Z"),
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
