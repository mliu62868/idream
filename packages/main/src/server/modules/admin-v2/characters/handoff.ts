import type { CharacterHandoff, Prisma } from "@prisma/client";
import {
  characterHandoffSchema,
  characterWorkspaceHandoffSchema,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "../shared/authority";
import { writeCommandSideEffects } from "../content/merchandising";
import { listCharacterImageSources } from "./image-sources";

type HandoffFacts = {
  readonly contentVersionId: string | null;
  readonly visualProfileId: string | null;
  readonly visualProfileVersion: number | null;
  readonly referenceSetRevisionId: string | null;
};

const CHARACTER_LIBRARY_PURPOSE = "character_library";

// SPEC: 与创建 Release 取同一组「当前」事实，交接里的版本才能和之后的 Release 对上。
async function currentHandoffFacts(
  db: Prisma.TransactionClient | typeof prisma,
  input: { readonly characterId: string; readonly projectId: string },
): Promise<HandoffFacts> {
  // INVARIANT: db 可能是事务客户端，同一 pg 连接上的查询必须串行。
  const revision = await db.characterRevision.findFirst({
    where: { projectId: input.projectId },
    orderBy: { revision: "desc" },
    select: { characterContentVersionId: true },
  });
  const profile = await db.characterVisualProfile.findFirst({
    where: { characterId: input.characterId, status: "active" },
    orderBy: { version: "desc" },
    select: { id: true, version: true },
  });
  const referenceSet = profile
    ? await db.referenceSetRevision.findFirst({
        where: { visualProfileId: profile.id, status: "active" },
        orderBy: { revision: "desc" },
        select: { id: true },
      })
    : null;
  return {
    contentVersionId: revision?.characterContentVersionId ?? null,
    visualProfileId: profile?.id ?? null,
    visualProfileVersion: profile?.version ?? null,
    referenceSetRevisionId: referenceSet?.id ?? null,
  };
}

// 能被选到至少一个产品槽位的图片数，和选槽位的图库走同一份资格判断。
export async function countSelectableCharacterImages(characterId: string) {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await listCharacterImageSources({
      characterId,
      purpose: CHARACTER_LIBRARY_PURPOSE,
      cursor,
    });
    count += page.items.filter(
      (asset) => (asset.qualification?.selectablePurposes.length ?? 0) > 0,
    ).length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return count;
}

function handoffDto(row: CharacterHandoff) {
  return {
    id: row.id,
    characterId: row.characterId,
    projectId: row.projectId,
    contentVersionId: row.contentVersionId,
    visualProfileId: row.visualProfileId,
    visualProfileVersion: row.visualProfileVersion,
    referenceSetRevisionId: row.referenceSetRevisionId,
    selectableImageCount: row.selectableImageCount,
    note: row.note,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * SPEC: 一键记录创作交接，事实全部由服务端快照。
 * INVARIANT: 只写交接记录和审计；不创建 Release、不改 Serving、不动 Project 版本，
 *            所以它既不会让发布冲突，也不需要 CAS。发布从不读这张表。
 */
export async function recordCharacterHandoff(input: {
  readonly tx: Prisma.TransactionClient;
  readonly request: Request;
  readonly actor: AdminActor;
  readonly requestId: string;
  readonly characterId: string;
  readonly note: string | null;
  readonly selectableImageCount: number;
}) {
  const { tx, request, actor, requestId, characterId, note, selectableImageCount } = input;
  const project = await tx.characterProject.findFirst({
    where: { characterId },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!project) throw Errors.notFound("Character project not found");
  const facts = await currentHandoffFacts(tx, { characterId, projectId: project.id });
  const row = await tx.characterHandoff.create({
    data: {
      characterId,
      projectId: project.id,
      ...facts,
      selectableImageCount,
      note,
      createdById: actor.id,
    },
  });
  const dto = characterHandoffSchema.parse(handoffDto(row));
  await writeCommandSideEffects(tx, request, actor, requestId, {
    action: "character.handoff.recorded",
    targetId: characterId,
    ...(note ? { reason: note } : {}),
    before: null,
    after: dto,
    eventType: "admin.character.handoff_recorded.v2",
  });
  return dto;
}

export function characterHandoffDrift(handoff: HandoffFacts, current: HandoffFacts) {
  return [
    ...(handoff.contentVersionId !== current.contentVersionId ? ["content" as const] : []),
    ...(handoff.visualProfileId !== current.visualProfileId ||
    handoff.visualProfileVersion !== current.visualProfileVersion
      ? ["visual_identity" as const]
      : []),
    ...(handoff.referenceSetRevisionId !== current.referenceSetRevisionId
      ? ["reference_set" as const]
      : []),
  ];
}

// 工作区只读：最近一次交接，以及它之后内容 / 身份 / 参考集有没有变。
export async function loadCharacterWorkspaceHandoff(input: {
  readonly characterId: string;
  readonly projectId: string;
}) {
  const row = await prisma.characterHandoff.findFirst({
    where: { characterId: input.characterId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!row) return null;
  const [creator, current] = await Promise.all([
    prisma.user.findUnique({
      where: { id: row.createdById },
      select: { displayName: true, name: true, email: true },
    }),
    currentHandoffFacts(prisma, {
      characterId: input.characterId,
      projectId: input.projectId,
    }),
  ]);
  return characterWorkspaceHandoffSchema.parse({
    ...handoffDto(row),
    createdByName: creator?.displayName ?? creator?.name ?? creator?.email ?? null,
    drift: characterHandoffDrift(row, current),
  });
}
