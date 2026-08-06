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
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
} from "@/server/modules/admin/shared/legacy-primitives";
import { moderateText } from "@/server/moderation/text-authority";
import { acceptControlPlaneCommand } from "@/server/modules/admin-v2/shared/control-plane-command";
import { executeCharacterReleaseCommand } from "@/server/modules/admin-v2/characters/release-executor";
import { createCharacterProject } from "@/server/modules/admin-v2/characters/creation";
import {
  getCharacterProjectDraftForResume,
  updateCharacterProjectDraft,
} from "@/server/modules/admin-v2/characters/workspace";
import { CHARACTER_STYLES, GENDERS } from "@idream/shared/catalog";

const OFFICIAL_PERMISSION = "content.official.write" as const;

const genderEnum = z.enum(GENDERS);
const styleEnum = z.enum(CHARACTER_STYLES);
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

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function negativeDialogue(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = jsonRecord(item);
    const assistant = text(row.assistant);
    const reason = text(row.reason);
    return assistant && reason ? [{ assistant, reason }] : [];
  });
}

function interactionDetails(value: unknown) {
  const row = jsonRecord(value);
  return {
    initiative: text(row.initiative),
    curiosity: text(row.curiosity),
    pacing: text(row.pacing),
    affection: text(row.affection),
    conflict: text(row.conflict),
    repair: text(row.repair),
  };
}

function canonDetails(value: unknown) {
  const row = jsonRecord(value);
  return {
    facts: stringList(row.facts),
    unknowns: stringList(row.unknowns),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const normalized = (values: readonly string[]) => [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
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

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) throw Errors.badRequest("Idempotency-Key is required for Character Project creation");
  const advanced = jsonRecord(body.advancedDetails);
  const appearance = jsonRecord(body.appearance);
  const created = await createCharacterProject({
    actor,
    idempotencyKey,
    requestId: request.headers.get("x-request-id") ?? randomUUID(),
    legacyTagLabels: body.tags,
    request: {
      positioning: {
        audience: "Unspecified legacy draft audience; complete in Character Studio",
        companionNeed: "Unspecified legacy draft companion need; complete in Character Studio",
        hypothesis: "Legacy draft requires an explicit value hypothesis before release",
        differentiation: "Legacy draft requires explicit differentiation before release",
      },
      persona: {
        name: body.name,
        age: body.age,
        gender: body.gender,
        relationshipArchetype: text(advanced.relationshipArchetype) || text(advanced.relationship) || "Unspecified relationship archetype",
        characterPromise: body.description,
        personality: text(advanced.personality) || "Unspecified personality; complete before release",
        values: stringList(advanced.values),
        wants: stringList(advanced.wants),
        fears: stringList(advanced.fears),
        contradictions: stringList(advanced.contradictions),
        tone: text(advanced.tone) || "Unspecified tone; complete before release",
        backstory: text(advanced.backstory) || "Unspecified backstory; complete before release",
        firstMessage: text(advanced.firstMessage) || "Draft opening message; complete before release.",
        exampleDialogue: stringList(advanced.exampleDialogue).length > 0
          ? stringList(advanced.exampleDialogue)
          : ["Draft example dialogue; complete before release."],
        cadence: text(advanced.cadence),
        vocabulary: stringList(advanced.vocabulary),
        voiceHabits: stringList(advanced.voiceHabits),
        voiceAvoid: stringList(advanced.voiceAvoid),
        interaction: interactionDetails(advanced.interaction),
        canon: canonDetails(advanced.canon),
        negativeDialogue: negativeDialogue(advanced.negativeDialogue),
      },
      visualDirection: {
        identityAnchor: text(appearance.identityAnchor) || `${body.name} canonical identity anchor requires production evidence`,
        stableTraits: stringList(appearance.stableTraits).length > 0
          ? stringList(appearance.stableTraits)
          : ["Unspecified stable trait; complete before release"],
        style: body.style,
        referenceDirection: text(appearance.referenceDirection) || "Unspecified reference direction; complete before release",
      },
      commercialIntent: {
        ownerId: actor.id,
        plannedLaunchAt: null,
        targetPlacementKeys: [],
        successCriteria: ["Complete explicit Character Project success criteria before release"],
        productionPackage: "Legacy draft requires an explicit production package before release",
        qaPlan: "Legacy draft requires persona, visual, mobile, desktop, and conversation QA before release",
      },
      reason: { code: "legacy_official_create_adapter", summary: body.reason },
      confirmation: "CREATE CHARACTER",
    },
  });
  const character = await prisma.character.findUniqueOrThrow({
    where: { id: created.characterId },
    include: officialInclude,
  });
  return ok({ character, ...created });
}

export async function updateOfficialCharacter(
  request: Request,
  id: string,
): Promise<Response> {
  const actor = await actorWithPermission(request, OFFICIAL_PERMISSION);
  await actorWithPermission(request, "character.project.write", { characterId: id });
  const body = updateSchema.parse(await jsonBody(request));

  const existing = await prisma.character.findUnique({
    where: { id },
    include: officialInclude,
  });
  if (!existing || existing.source !== "official" || existing.deletedAt) {
    throw Errors.notFound("Official character not found");
  }

  if (body.tags && !sameStrings(body.tags, tagLabels(existing))) {
    throw Errors.conflict("Legacy profile edit cannot mutate live taxonomy; use the Taxonomy workspace", {
      deepLink: "/admin/characters/taxonomy",
    });
  }
  const resumed = await getCharacterProjectDraftForResume(id);
  const advanced = jsonRecord(body.advancedDetails);
  const appearance = jsonRecord(body.appearance);
  const interaction = interactionDetails(advanced.interaction);
  const canon = canonDetails(advanced.canon);
  const dialogueAvoid = negativeDialogue(advanced.negativeDialogue);
  const persona = {
    ...resumed.draft.persona,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.age !== undefined ? { age: body.age } : {}),
    ...(body.gender !== undefined ? { gender: body.gender } : {}),
    ...(body.description !== undefined ? { characterPromise: body.description } : {}),
    ...(text(advanced.relationshipArchetype) ? { relationshipArchetype: text(advanced.relationshipArchetype) } : {}),
    ...(text(advanced.personality) ? { personality: text(advanced.personality) } : {}),
    ...(stringList(advanced.values).length > 0 ? { values: stringList(advanced.values) } : {}),
    ...(stringList(advanced.wants).length > 0 ? { wants: stringList(advanced.wants) } : {}),
    ...(stringList(advanced.fears).length > 0 ? { fears: stringList(advanced.fears) } : {}),
    ...(stringList(advanced.contradictions).length > 0 ? { contradictions: stringList(advanced.contradictions) } : {}),
    ...(text(advanced.tone) ? { tone: text(advanced.tone) } : {}),
    ...(text(advanced.cadence) ? { cadence: text(advanced.cadence) } : {}),
    ...(stringList(advanced.vocabulary).length > 0 ? { vocabulary: stringList(advanced.vocabulary) } : {}),
    ...(stringList(advanced.voiceHabits).length > 0 ? { voiceHabits: stringList(advanced.voiceHabits) } : {}),
    ...(stringList(advanced.voiceAvoid).length > 0 ? { voiceAvoid: stringList(advanced.voiceAvoid) } : {}),
    ...(text(advanced.backstory) ? { backstory: text(advanced.backstory) } : {}),
    ...(text(advanced.firstMessage) ? { firstMessage: text(advanced.firstMessage) } : {}),
    ...(stringList(advanced.exampleDialogue).length > 0 ? { exampleDialogue: stringList(advanced.exampleDialogue) } : {}),
    ...(Object.values(interaction).some(Boolean)
      ? { interaction: {
          initiative: interaction.initiative || resumed.draft.persona.interaction?.initiative || "",
          curiosity: interaction.curiosity || resumed.draft.persona.interaction?.curiosity || "",
          pacing: interaction.pacing || resumed.draft.persona.interaction?.pacing || "",
          affection: interaction.affection || resumed.draft.persona.interaction?.affection || "",
          conflict: interaction.conflict || resumed.draft.persona.interaction?.conflict || "",
          repair: interaction.repair || resumed.draft.persona.interaction?.repair || "",
        } }
      : {}),
    ...(canon.facts.length > 0 || canon.unknowns.length > 0
      ? { canon: {
          facts: canon.facts.length > 0 ? canon.facts : resumed.draft.persona.canon?.facts ?? [],
          unknowns: canon.unknowns.length > 0 ? canon.unknowns : resumed.draft.persona.canon?.unknowns ?? [],
        } }
      : {}),
    ...(dialogueAvoid.length > 0 ? { negativeDialogue: dialogueAvoid } : {}),
  };
  const visualDirection = {
    ...resumed.draft.visualDirection,
    ...(body.style !== undefined ? { style: body.style } : {}),
    ...(text(appearance.identityAnchor) ? { identityAnchor: text(appearance.identityAnchor) } : {}),
    ...(stringList(appearance.stableTraits).length > 0 ? { stableTraits: stringList(appearance.stableTraits) } : {}),
    ...(text(appearance.referenceDirection) ? { referenceDirection: text(appearance.referenceDirection) } : {}),
  };
  const moderation = await moderateText(
    "character",
    id,
    `${persona.name} ${persona.characterPromise} ${JSON.stringify(persona)}`,
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Character failed safety checks", moderation);
  }
  const project = await updateCharacterProjectDraft({
    characterId: id,
    expectedVersion: resumed.authority.projectVersion,
    actor,
    ownerId: resumed.draft.commercialIntent.ownerId,
    audience: resumed.draft.positioning.audience,
    companionNeed: resumed.draft.positioning.companionNeed,
    hypothesis: resumed.draft.positioning.hypothesis,
    differentiation: resumed.draft.positioning.differentiation,
    targetPlacementKeys: resumed.draft.commercialIntent.targetPlacementKeys,
    successCriteria: resumed.draft.commercialIntent.successCriteria,
    productionPackage: resumed.draft.commercialIntent.productionPackage,
    qaPlan: resumed.draft.commercialIntent.qaPlan,
    plannedLaunchAt: resumed.draft.commercialIntent.plannedLaunchAt,
    content: { persona, visualDirection },
    reason: body.reason,
    requestId: request.headers.get("x-request-id") ?? randomUUID(),
  });
  const character = await prisma.character.findUniqueOrThrow({
    where: { id },
    include: officialInclude,
  });
  return ok({ character, project, deepLink: resumed.authority.deepLink });
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
