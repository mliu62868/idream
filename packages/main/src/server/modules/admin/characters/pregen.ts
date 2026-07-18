// SPEC: per-character 预生图 pack：cover(封面×4→character_cover)、hero(主图×4→character_hero)、
//       chat(聊天包×8→character_chat)。POST 包一层默认值后委托 createProductionBatchCore；
//       GET 列该角色全部 production batch + 现有 character_avatar/hero 投放。
// INVARIANTS: 不新增任何生成链路——一切走既有 Batch→Job→Asset→Placement。
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/release-executor";
import { findQualifiedGenerationRoute } from "@/server/modules/admin-v2/characters/visual-authority";
import { actorWithPermission, jsonBody } from "@/server/modules/admin/shared/legacy-primitives";
import { generationWorkflowDescriptor } from "@/server/modules/admin/generation-catalog";
import {
  createProductionBatchCore,
  productionBatchDTO,
  productionBatchInclude,
  type ProductionBatchCreateInput,
} from "@/server/modules/admin/content-ops";

const PREGEN_PACKS = {
  cover: { purpose: "character_cover", count: 4 },
  hero: { purpose: "character_hero", count: 4 },
  chat: { purpose: "character_chat", count: 8 },
} as const;

const pregenCreateSchema = z.object({
  pack: z.enum(["cover", "hero", "chat"]),
  profileId: z.string().trim().min(1).max(180).optional(),
  recipeId: z.string().trim().min(1).max(180).optional(),
  count: z.number().int().min(1).max(24).optional(),
  brief: z.string().trim().max(2_000).optional(),
  reason: z.string().trim().max(2_000).optional(),
});

// Accepts any non-deleted character (official or user-created) — same authz
// scope as Production Studio, not restricted to admin-managed "official" ones.
async function requirePregenTargetCharacter(characterId: string) {
  const character = await prisma.character.findFirst({
    where: { id: characterId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!character) throw Errors.badRequest("Pregen target character not found");
  return character;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function resolveDefaultProfileKey(input: {
  bootstrapIdentity: boolean;
  characterId: string;
}) {
  if (input.bootstrapIdentity) {
    const profiles = await prisma.generationModelProfile.findMany({
      where: {
        mode: "image",
        status: "active",
        enabled: true,
        rolloutPercent: { gt: 0 },
      },
      orderBy: [{ costMultiplier: "asc" }, { version: "desc" }],
      take: 40,
    });
    for (const profile of profiles) {
      const workflowKey = profile.workflowKey ?? profile.pipelineModel;
      const workflow = await generationWorkflowDescriptor(workflowKey);
      const capabilities = record(record(profile.runnerConfig).capabilities);
      if (
        workflow &&
        workflow.identity.mode === "none" &&
        workflow.identity.maxReferences === 0 &&
        workflow.capabilities.includes("textToImage") &&
        capabilities.textToImage === true
      ) {
        return profile.profileKey;
      }
    }
    throw Errors.badRequest("Pregen requires an active text-to-image identity bootstrap profile");
  }

  const identity = await prisma.characterVisualProfile.findFirst({
    where: { characterId: input.characterId, status: "active" },
    orderBy: { version: "desc" },
    select: {
      style: true,
      referenceSetRevisions: {
        where: { status: "active" },
        orderBy: { revision: "desc" },
        take: 1,
        select: {
          references: {
            orderBy: { position: "asc" },
            select: { role: true },
          },
        },
      },
    },
  });
  if (!identity) {
    throw Errors.conflict("Pregen requires an established Character Visual Identity", {
      deepLink: `/admin/characters/${input.characterId}?tab=assets`,
    });
  }
  const activeReferences =
    identity.referenceSetRevisions[0]?.references ?? [];
  const qualifiedRoute = await findQualifiedGenerationRoute(prisma, {
    style: identity.style,
    policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
    evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
    at: new Date(),
    requiredReferenceCount: activeReferences.length,
    requiredReferenceRoles:
      activeReferences.map((reference) => reference.role),
  });
  if (!qualifiedRoute) {
    throw Errors.conflict("Pregen requires a current qualified Character identity route", {
      deepLink: `/admin/characters/${input.characterId}?tab=visual`,
    });
  }
  return qualifiedRoute.generationProfileKey;
}

export async function createCharacterPregenBatch(request: Request, characterId: string) {
  const actor = await actorWithPermission(request, "content.production.write");
  const body = pregenCreateSchema.parse(await jsonBody(request));
  const character = await requirePregenTargetCharacter(characterId);
  const pack = PREGEN_PACKS[body.pack];
  const activeIdentity = await prisma.characterVisualProfile.findFirst({
    where: { characterId: character.id, status: "active" },
    select: { id: true },
  });
  const bootstrapIdentity = pack.purpose === "character_cover" && !activeIdentity;
  const input: ProductionBatchCreateInput = {
    title: `${character.name} ${body.pack} pack`,
    purpose: pack.purpose,
    targetType: "character",
    targetId: character.id,
    profileId: body.profileId ?? (await resolveDefaultProfileKey({
      bootstrapIdentity,
      characterId: character.id,
    })),
    recipeId: body.recipeId,
    presetIds: [],
    referenceAssetIds: [],
    bootstrapIdentity,
    orientation: undefined,
    count: body.count ?? pack.count,
    brief: body.brief,
    consistencyMode: "balanced",
    priority: "normal",
    reason: body.reason,
  };
  return createProductionBatchCore(request, actor, input);
}

export async function listCharacterPregenBatches(request: Request, characterId: string) {
  await actorWithPermission(request, "content.asset.read");
  const character = await requirePregenTargetCharacter(characterId);
  const [batches, placements] = await Promise.all([
    prisma.contentProductionBatch.findMany({
      where: { targetType: "character", targetId: character.id },
      include: productionBatchInclude,
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.mediaAssetPlacement.findMany({
      where: {
        targetType: "character",
        targetId: character.id,
        slot: { in: ["character_avatar", "character_hero"] },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  return ok({
    items: batches.map((batch) => productionBatchDTO(batch)),
    placements: placements.map((placement) => ({
      id: placement.id,
      slot: placement.slot,
      status: placement.status,
      mediaAssetId: placement.mediaAssetId,
      publishedAt: placement.publishedAt,
    })),
  });
}
