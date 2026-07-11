// SPEC: 官方角色 CMS 服务层（CHARACTER_MANAGEMENT_PLAN §A / Feature A）。
//       admin 凭 content.official.write 在后台生产 / 编辑 / 上下架官方角色。
//       官方角色 source="official"，先进入 draft/private 的内部制作阶段，运营完成资料、视觉与素材后
//       再通过 state 端点发布为 approved/public；仍复用既有 moderation 与审计。
// INTENT: 复用 admin/service 与 ourdream 既有 helper，保持与 F2 内容治理一致的审计/门控语义。
// INVARIANTS:
//   - 所有 handler 经 actorWithPermission(req, "content.official.write") 门控（含 list）。
//   - create 强制 source="official" / status="draft" / visibility="private"。
//   - update / setState 仅作用于 source==="official" 的角色，否则 404。
//   - 两条硬底线不得绕过：age>=18（zod min(18)）+ moderation blocked → forbidden。
//   - 文本（name/description/advancedDetails）变更必重新 moderate 并重算 systemPrompt。
// EXAMPLE: POST /api/v1/admin/content/official { name, age:24, gender, style, description, reason }
//          → ok({ character }) with source="official", status="draft".
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildCharacterSystemPrompt } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
  writeAudit,
} from "@/server/modules/admin/service";
import {
  characterVisualProfileCreateData,
  createActiveCharacterVisualProfileVersion,
  moderateText,
} from "@/server/modules/ourdream/service";
import { acceptControlPlaneCommand } from "@/server/modules/admin-v2/shared/control-plane-command";
import { executeCharacterReleaseCommand } from "@/server/modules/admin-v2/characters/release-executor";

const OFFICIAL_PERMISSION = "content.official.write" as const;

const genderEnum = z.enum(["female", "male", "trans"]);
const styleEnum = z.enum(["realistic", "anime", "hybrid", "other"]);
// 顶层只接 string→unknown 的记录，避免把任意结构（数组/标量）当成 appearance/advancedDetails。
const recordSchema = z.record(z.string(), z.unknown());

const createSchema = z.object({
  name: z.string().min(1).max(80),
  age: z.number().int().min(18).max(99),
  gender: genderEnum,
  style: styleEnum,
  description: z.string().min(1).max(1500),
  appearance: recordSchema.default({}),
  advancedDetails: recordSchema.default({}),
  tags: z.array(z.string()).max(12).default([]),
  reason: z.string().min(3),
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  age: z.number().int().min(18).max(99).optional(),
  gender: genderEnum.optional(),
  style: styleEnum.optional(),
  description: z.string().min(1).max(1500).optional(),
  appearance: recordSchema.optional(),
  advancedDetails: recordSchema.optional(),
  tags: z.array(z.string()).max(12).optional(),
  reason: z.string().min(3),
});

const stateSchema = z.object({
  status: z.enum(["approved", "archived"]),
  reason: z.string().min(3),
});

// SPEC: 小写、空格→`-`、去掉非 [a-z0-9-]，并裁掉首尾连字符。
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
}

// 整体替换该角色的 CharacterTag：先清空，再按 slug upsert Tag 并连接。
async function syncTags(
  tx: Prisma.TransactionClient,
  characterId: string,
  tags: string[],
) {
  await tx.characterTag.deleteMany({ where: { characterId } });
  const seen = new Set<string>();
  for (const raw of tags) {
    const label = raw.trim();
    if (!label) continue;
    const slug = slugify(label);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const tag = await tx.tag.upsert({
      where: { slug },
      create: { slug, label },
      update: {},
    });
    await tx.characterTag.create({ data: { characterId, tagId: tag.id } });
  }
}

const officialInclude = {
  stats: true,
  tags: { include: { tag: true } },
  visualProfiles: {
    where: { status: "active" },
    orderBy: { version: "desc" },
    take: 1,
  },
} satisfies Prisma.CharacterInclude;

function tagLabels(character: {
  tags: { tag: { label: string } }[];
}): string[] {
  return character.tags.map((link) => link.tag.label);
}

export async function listOfficialCharacters(
  request: Request,
): Promise<Response> {
  await actorWithPermission(request, OFFICIAL_PERMISSION);
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim();
  const status = url.searchParams.get("status") ?? undefined;
  const gender = url.searchParams.get("gender") ?? undefined;
  const style = url.searchParams.get("style") ?? undefined;
  const page = clampInt(url.searchParams.get("page"), 1, 10_000, 1);
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 24);
  const where: Prisma.CharacterWhereInput = {
    source: "official",
    deletedAt: null,
    status,
    gender,
    style,
  };
  if (search) {
    where.OR = [
      { id: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
    ];
  }
  const [total, items] = await prisma.$transaction([
    prisma.character.count({ where }),
    prisma.character.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        name: true,
        age: true,
        description: true,
        gender: true,
        style: true,
        status: true,
        visibility: true,
        appearance: true,
        advancedDetails: true,
        imageAssetId: true,
        createdAt: true,
        updatedAt: true,
        tags: { include: { tag: true } },
        stats: {
          select: { chatsCount: true, likesCount: true, viewsCount: true },
        },
        visualProfiles: {
          where: { status: "active" },
          orderBy: { version: "desc" },
          take: 1,
          select: {
            id: true,
            version: true,
            status: true,
            style: true,
            qualityScore: true,
            consistencyScore: true,
            faceTraits: true,
            anchorAssetIds: true,
            referenceAssetIds: true,
          },
        },
      },
    }),
  ]);
  return ok({
    items: items.map((item) => {
      const [visualProfile] = item.visualProfiles;
      return {
        ...item,
        tags: item.tags.map((link) => link.tag.label),
        visualProfiles: undefined,
        visualProfile: visualProfile ?? null,
      };
    }),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
}

export async function createOfficialCharacter(
  request: Request,
): Promise<Response> {
  const actor = await actorWithPermission(request, OFFICIAL_PERMISSION);
  const body = createSchema.parse(await jsonBody(request));

  // 硬底线：moderation blocked 直接拦截（mock provider 会命中 underage/minor/csam）。
  const moderation = await moderateText(
    "character",
    "pending",
    `${body.name} ${body.description} ${JSON.stringify(body.advancedDetails)}`,
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Character failed safety checks", moderation);
  }

  const systemPrompt = buildCharacterSystemPrompt({
    name: body.name,
    age: body.age,
    description: body.description,
    style: body.style,
    gender: body.gender,
    tags: body.tags,
    appearance: body.appearance,
    advancedDetails: body.advancedDetails,
  });

  const character = await prisma.$transaction(async (tx) => {
    const created = await tx.character.create({
      data: {
        creatorId: actor.id,
        name: body.name,
        age: body.age,
        description: body.description,
        systemPrompt,
        source: "official",
        status: "draft",
        visibility: "private",
        style: body.style,
        gender: body.gender,
        appearance: toInputJson(body.appearance),
        advancedDetails: toInputJson(body.advancedDetails),
      },
    });
    await tx.characterVisualProfile.create({
      data: characterVisualProfileCreateData({
        characterId: created.id,
        version: 1,
        status: "active",
        style: body.style,
        name: body.name,
        age: body.age,
        description: body.description,
        gender: body.gender,
        appearance: body.appearance as Prisma.JsonValue,
        advancedDetails: body.advancedDetails as Prisma.JsonValue,
        anchorAssetIds: [],
        createdFrom: "admin_official_create",
      }),
    });
    await tx.characterStats.create({ data: { characterId: created.id } });
    await syncTags(tx, created.id, body.tags);
    return tx.character.findUniqueOrThrow({
      where: { id: created.id },
      include: officialInclude,
    });
  });

  await writeAudit(request, actor, {
    action: "content.official.create",
    targetType: "character",
    targetId: character.id,
    reason: body.reason,
    after: {
      name: character.name,
      status: character.status,
      source: character.source,
    },
  });
  return ok({ character });
}

export async function updateOfficialCharacter(
  request: Request,
  id: string,
): Promise<Response> {
  const actor = await actorWithPermission(request, OFFICIAL_PERMISSION);
  const body = updateSchema.parse(await jsonBody(request));

  const existing = await prisma.character.findUnique({
    where: { id },
    include: officialInclude,
  });
  if (!existing || existing.source !== "official" || existing.deletedAt) {
    throw Errors.notFound("Official character not found");
  }

  // 合并补丁与现值，便于重算 moderation/systemPrompt。
  const next = {
    name: body.name ?? existing.name,
    age: body.age ?? existing.age,
    description: body.description ?? existing.description,
    style: body.style ?? existing.style,
    gender: body.gender ?? existing.gender,
    appearance: body.appearance ?? existing.appearance,
    advancedDetails: body.advancedDetails ?? existing.advancedDetails,
    tags: body.tags ?? tagLabels(existing),
  };

  const textChanged =
    body.name !== undefined ||
    body.description !== undefined ||
    body.advancedDetails !== undefined;
  const visualIdentityChanged =
    body.name !== undefined ||
    body.age !== undefined ||
    body.gender !== undefined ||
    body.style !== undefined ||
    body.description !== undefined ||
    body.appearance !== undefined ||
    body.advancedDetails !== undefined;

  const data: Prisma.CharacterUpdateInput = {
    name: next.name,
    age: next.age,
    description: next.description,
    style: next.style,
    gender: next.gender,
    appearance: toInputJson(next.appearance),
    advancedDetails: toInputJson(next.advancedDetails),
  };

  if (textChanged) {
    const moderation = await moderateText(
      "character",
      id,
      `${next.name} ${next.description} ${JSON.stringify(next.advancedDetails)}`,
      "input",
    );
    if (moderation.status === "blocked") {
      throw Errors.forbidden("Character failed safety checks", moderation);
    }
    data.systemPrompt = buildCharacterSystemPrompt({
      name: next.name,
      age: next.age,
      description: next.description,
      style: next.style,
      gender: next.gender,
      tags: next.tags,
      appearance: next.appearance,
      advancedDetails: next.advancedDetails,
    });
  }

  const character = await prisma.$transaction(async (tx) => {
    await tx.character.update({ where: { id }, data });
    if (body.tags !== undefined) {
      await syncTags(tx, id, body.tags);
    }
    if (visualIdentityChanged) {
      await createActiveCharacterVisualProfileVersion(
        tx,
        {
          id,
          name: next.name,
          age: next.age,
          description: next.description,
          style: next.style,
          gender: next.gender,
          appearance: next.appearance as Prisma.JsonValue,
          advancedDetails: next.advancedDetails as Prisma.JsonValue,
          imageAssetId: existing.imageAssetId,
        },
        {
          createdFrom: "admin_official_update",
        },
      );
    }
    return tx.character.findUniqueOrThrow({
      where: { id },
      include: officialInclude,
    });
  });

  await writeAudit(request, actor, {
    action: "content.official.update",
    targetType: "character",
    targetId: id,
    reason: body.reason,
    before: {
      name: existing.name,
      description: existing.description,
      status: existing.status,
      tags: tagLabels(existing),
    },
    after: {
      name: character.name,
      description: character.description,
      status: character.status,
      tags: tagLabels(character),
    },
  });
  return ok({ character });
}

export async function setOfficialState(
  request: Request,
  id: string,
): Promise<Response> {
  const actor = await actorWithPermission(request, OFFICIAL_PERMISSION);
  // V1 is only an adapter after the v2 authority cutover. Re-check the stronger
  // release permission so legacy content.write grants cannot indirectly publish.
  await actorWithPermission(request, "character.release.publish");
  const body = stateSchema.parse(await jsonBody(request));

  const existing = await prisma.character.findUnique({
    where: { id },
    include: officialInclude,
  });
  if (!existing || existing.source !== "official" || existing.deletedAt) {
    throw Errors.notFound("Official character not found");
  }
  const serving = await prisma.characterServing.findUnique({
    where: { characterId: id },
  });
  if (!serving) {
    throw Errors.badRequest(
      "Character has not completed the v2 Release backfill",
      {
        repairDeepLink: `/admin/characters/${id}?tab=overview`,
      },
    );
  }

  let commandType:
    | "character.release.publish"
    | "character.serving.pause"
    | "character.serving.resume";
  let target: { type: string; id: string };
  let expectedVersion: number;
  if (body.status === "archived") {
    commandType = "character.serving.pause";
    target = { type: "character_serving", id };
    expectedVersion = serving.version;
  } else if (serving.state === "paused" && serving.currentReleaseId) {
    commandType = "character.serving.resume";
    target = { type: "character_serving", id };
    expectedVersion = serving.version;
  } else {
    const candidateId = serving.scheduledReleaseId;
    const candidate = candidateId
      ? await prisma.characterRelease.findUnique({ where: { id: candidateId } })
      : await prisma.characterRelease.findFirst({
          where: {
            projectId: {
              in: (
                await prisma.characterProject.findMany({
                  where: { characterId: id },
                  select: { id: true },
                })
              ).map((project) => project.id),
            },
            status: "approved",
          },
          orderBy: { createdAt: "desc" },
        });
    if (!candidate) {
      throw Errors.badRequest(
        "V1 publish requires an approved v2 Release candidate",
        {
          repairDeepLink: `/admin/characters/${id}?tab=overview`,
        },
      );
    }
    commandType = "character.release.publish";
    target = { type: "character_release", id: candidate.id };
    expectedVersion = candidate.version;
  }

  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const accepted = await acceptControlPlaneCommand(prisma, {
    environment: env.APP_ENV,
    actor,
    idempotencyKey:
      request.headers.get("idempotency-key")?.trim() ||
      `v1-official-state:${id}:${expectedVersion}:${body.status}`,
    commandType,
    target,
    expectedVersion,
    payload: { reason: body.reason, legacyAdapter: "official.state.v1" },
    retryMode: "idempotent",
    reason: body.reason,
    requestId,
  });
  const executed = await executeCharacterReleaseCommand(prisma, {
    commandId: accepted.commandId,
    workerId: `v1-inline:${requestId}`,
  });
  if (executed.status !== "succeeded") {
    const command = await prisma.controlPlaneCommand.findUnique({
      where: { id: accepted.commandId },
    });
    throw Errors.badRequest("Authoritative Character Release command failed", {
      commandId: accepted.commandId,
      error: command?.error ?? { code: executed.errorCode ?? "unknown" },
      repairDeepLink: `/admin/characters/${id}?tab=overview`,
    });
  }
  const after = await prisma.character.findUniqueOrThrow({ where: { id } });
  return ok({
    character: {
      id: after.id,
      status: after.status,
      visibility: after.visibility,
    },
    commandId: accepted.commandId,
  });
}
