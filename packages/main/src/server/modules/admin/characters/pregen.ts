// SPEC: per-character 预生图 pack：cover(封面×4→character_cover)、hero(主图×4→character_hero)、
//       chat(聊天包×8→character_chat)。POST 包一层默认值后委托 createProductionBatchCore；
//       GET 列该角色全部 production batch + 现有 character_avatar/hero 投放。
// INVARIANTS: 不新增任何生成链路——一切走既有 Batch→Job→Asset→Placement。
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, jsonBody } from "@/server/modules/admin/service";
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

async function resolveDefaultProfileKey() {
  const profile = await prisma.generationModelProfile.findFirst({
    where: { mode: "image", status: "active", enabled: true },
    orderBy: [{ costMultiplier: "asc" }, { version: "desc" }],
  });
  if (!profile) throw Errors.badRequest("Pregen requires an active image profile");
  return profile.profileKey;
}

export async function createCharacterPregenBatch(request: Request, characterId: string) {
  const actor = await actorWithPermission(request, "content.production.write");
  const body = pregenCreateSchema.parse(await jsonBody(request));
  const character = await requirePregenTargetCharacter(characterId);
  const pack = PREGEN_PACKS[body.pack];
  const input: ProductionBatchCreateInput = {
    title: `${character.name} ${body.pack} pack`,
    purpose: pack.purpose,
    targetType: "character",
    targetId: character.id,
    profileId: body.profileId ?? (await resolveDefaultProfileKey()),
    recipeId: body.recipeId,
    presetIds: [],
    orientation: undefined,
    count: body.count ?? pack.count,
    brief: body.brief,
    consistencyMode: "balanced",
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
    items: batches.map(productionBatchDTO),
    placements: placements.map((placement) => ({
      id: placement.id,
      slot: placement.slot,
      status: placement.status,
      mediaAssetId: placement.mediaAssetId,
      publishedAt: placement.publishedAt,
    })),
  });
}
