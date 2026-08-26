// SPEC: 官方角色 CMS —— admin 凭 content.official.write 在后台生产 / 编辑 / 上下架官方角色。
//       官方角色 source="official"，先进入 draft/private 的内部制作阶段，运营完成资料、视觉与素材后
//       再通过 state 端点发布为 approved/public。
// INTENT: v2 cutover 之后这一层只是适配器：创建走 `createCharacterProject`，编辑走
//         `updateCharacterProjectDraft`，上下架走 Character Release / Serving 命令。
// INVARIANTS:
//   - 两条硬底线不得绕过：age>=18（契约 min(18)）+ moderation blocked → forbidden。
//   - update / setState 仅作用于 source==="official" 的角色，否则 404。
//   - 文本（name/description/advancedDetails）变更必重新 moderate。
import { randomUUID } from "node:crypto";
import { legacySoulDetailsMarkdown } from "@idream/shared";
import type { Prisma } from "@prisma/client";
import type {
  ContentOfficialCreateRequest,
  ContentOfficialQuery,
  ContentOfficialStateRequest,
  ContentOfficialUpdateRequest,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { moderateText } from "@/server/moderation/text-authority";
import { createCharacterProject } from "../characters/creation";
import {
  getCharacterProjectDraftForResume,
  updateCharacterProjectDraft,
} from "../characters/project-draft";
import { executeCharacterReleaseCommand } from "../characters/release-executor";
import type { AdminActor } from "../shared/authority";
import { acceptControlPlaneCommand } from "../shared/control-plane-command";

const officialInclude = {
  stats: { select: { chatsCount: true, likesCount: true, viewsCount: true } },
  tags: { include: { tag: true } },
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
} satisfies Prisma.CharacterInclude;

type OfficialCharacterRow = Prisma.CharacterGetPayload<{ include: typeof officialInclude }>;

function officialCharacterDTO(character: OfficialCharacterRow) {
  const [visualProfile] = character.visualProfiles;
  return {
    id: character.id,
    name: character.name,
    age: character.age,
    description: character.description,
    gender: character.gender,
    style: character.style,
    status: character.status,
    visibility: character.visibility,
    appearance: character.appearance,
    advancedDetails: character.advancedDetails,
    imageAssetId: character.imageAssetId,
    createdAt: character.createdAt.toISOString(),
    updatedAt: character.updatedAt.toISOString(),
    tags: character.tags.map((link) => link.tag.label),
    stats: character.stats,
    visualProfile: visualProfile ?? null,
  };
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

const LEGACY_SOUL_DETAIL_KEYS = [
  "personality",
  "values",
  "wants",
  "fears",
  "contradictions",
  "tone",
  "speakingStyle",
  "cadence",
  "vocabulary",
  "voiceHabits",
  "voiceAvoid",
  "backstory",
  "exampleDialogue",
  "interaction",
  "canon",
  "negativeDialogue",
] as const;

function hasOwn(row: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function touchesSoulDetails(row: Record<string, unknown>) {
  return hasOwn(row, "detailsMarkdown") || LEGACY_SOUL_DETAIL_KEYS.some((key) => hasOwn(row, key));
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const normalized = (values: readonly string[]) =>
    [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

export async function listOfficialCharacters(query: ContentOfficialQuery) {
  const where: Prisma.CharacterWhereInput = {
    source: "official",
    deletedAt: null,
    status: query.status,
    gender: query.gender,
    style: query.style,
  };
  if (query.search) {
    where.OR = [
      { id: { contains: query.search, mode: "insensitive" } },
      { name: { contains: query.search, mode: "insensitive" } },
    ];
  }
  const [total, items] = await prisma.$transaction([
    prisma.character.count({ where }),
    prisma.character.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: officialInclude,
    }),
  ]);
  return {
    items: items.map(officialCharacterDTO),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export async function createOfficialCharacter(input: {
  request: Request;
  actor: AdminActor;
  idempotencyKey: string;
  body: ContentOfficialCreateRequest;
}) {
  const { request, actor, idempotencyKey, body } = input;
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

  const advanced = jsonRecord(body.advancedDetails);
  const appearance = jsonRecord(body.appearance);
  const relationshipArchetype = text(advanced.relationshipArchetype) || text(advanced.relationship);
  const firstMessage = text(advanced.firstMessage);
  const missingFields = [
    ...(!relationshipArchetype ? ["relationshipArchetype"] : []),
    ...(!firstMessage ? ["firstMessage"] : []),
  ];
  if (missingFields.length > 0) {
    throw Errors.badRequest("Complete the official Character Soul before creating it", {
      missingFields,
    });
  }
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
        relationshipArchetype,
        characterPromise: body.description,
        detailsMarkdown: legacySoulDetailsMarkdown(advanced),
        firstMessage,
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
  return { character: officialCharacterDTO(character), project: created };
}

export async function updateOfficialCharacter(input: {
  request: Request;
  actor: AdminActor;
  id: string;
  body: ContentOfficialUpdateRequest;
}) {
  const { request, actor, id, body } = input;
  const existing = await prisma.character.findUnique({
    where: { id },
    include: officialInclude,
  });
  if (!existing || existing.source !== "official" || existing.deletedAt) {
    throw Errors.notFound("Official character not found");
  }

  if (body.tags && !sameStrings(body.tags, existing.tags.map((link) => link.tag.label))) {
    throw Errors.conflict(
      "Legacy profile edit cannot mutate live taxonomy; use the Taxonomy workspace",
      { deepLink: "/admin/characters/taxonomy" },
    );
  }
  const resumed = await getCharacterProjectDraftForResume(id);
  const advanced = jsonRecord(body.advancedDetails);
  const appearance = jsonRecord(body.appearance);
  const persona = {
    ...resumed.draft.persona,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.age !== undefined ? { age: body.age } : {}),
    ...(body.gender !== undefined ? { gender: body.gender } : {}),
    ...(body.description !== undefined ? { characterPromise: body.description } : {}),
    ...(text(advanced.relationshipArchetype) ? { relationshipArchetype: text(advanced.relationshipArchetype) } : {}),
    ...(touchesSoulDetails(advanced)
      // SPEC: advancedDetails is one replacement document at this legacy
      // boundary. Replaying the same PATCH must not append duplicate sections.
      ? { detailsMarkdown: legacySoulDetailsMarkdown(advanced) }
      : {}),
    ...(text(advanced.firstMessage) ? { firstMessage: text(advanced.firstMessage) } : {}),
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
  return {
    character: officialCharacterDTO(character),
    projectId: project.id,
    projectVersion: project.version,
    deepLink: resumed.authority.deepLink,
  };
}

export async function setOfficialState(input: {
  request: Request;
  actor: AdminActor;
  id: string;
  body: ContentOfficialStateRequest;
}) {
  const { request, actor, id, body } = input;
  const existing = await prisma.character.findUnique({ where: { id } });
  if (!existing || existing.source !== "official" || existing.deletedAt) {
    throw Errors.notFound("Official character not found");
  }
  const serving = await prisma.characterServing.findUnique({ where: { characterId: id } });
  if (!serving) {
    throw Errors.badRequest("Character has not completed the v2 Release backfill", {
      repairDeepLink: `/admin/characters/${id}?tab=overview`,
    });
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
      throw Errors.badRequest("Publishing requires an approved Character Release candidate", {
        repairDeepLink: `/admin/characters/${id}?tab=overview`,
      });
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
      `official-state:${id}:${expectedVersion}:${body.status}`,
    commandType,
    target,
    expectedVersion,
    payload: { reason: body.reason, adapter: "official.state.v2" },
    retryMode: "idempotent",
    reason: body.reason,
    requestId,
  });
  const executed = await executeCharacterReleaseCommand(prisma, {
    commandId: accepted.commandId,
    workerId: `official-state-inline:${requestId}`,
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
  return {
    character: { id: after.id, status: after.status, visibility: after.visibility },
    commandId: accepted.commandId,
  };
}
