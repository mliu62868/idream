import { randomUUID } from "node:crypto";
import { GROUP_CHAT_MAX_MEMBERS, GROUP_CHAT_MIN_MEMBERS, groupChatMemberSchema } from "@idream/shared/contracts";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { chatSessionCharacterPin, chatTurnMessagesForOwner } from "./turn-ledger";

const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  characterIds: z.array(z.string().trim().min(1).max(160)).min(GROUP_CHAT_MIN_MEMBERS).max(GROUP_CHAT_MAX_MEMBERS),
}).strict().refine(value => new Set(value.characterIds).size === value.characterIds.length, {
  message: "Choose distinct Characters for this group",
});

export async function createGroupConversation(userId: string, input: unknown) {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw Errors.badRequest("Choose between 2 and 12 distinct Characters and a group name", { issues: parsed.error.issues });
  const values = parsed.data;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true, deletedAt: true } });
    if (!user || user.status !== "active" || user.deletedAt) throw Errors.unauthorized("Account is not active");
    const pins = [];
    for (const characterId of values.characterIds) pins.push(await chatSessionCharacterPin(userId, characterId, tx));
    const group = await tx.groupConversation.create({ data: { id: randomUUID(), userId, title: values.title } });
    for (const [position, pin] of pins.entries()) await createGroupMember(tx, userId, group.id, position, pin);
    return { id: group.id, title: group.title };
  });
}

async function createGroupMember(tx: Prisma.TransactionClient, userId: string, groupId: string, position: number, pin: Awaited<ReturnType<typeof chatSessionCharacterPin>>) {
  await tx.recentChat.create({ data: {
    sessionId: randomUUID(), userId, characterId: pin.character.id,
    groupId, groupPosition: position, title: pin.character.name,
    characterContentVersionId: pin.content.id,
    characterReleaseId: pin.release?.id ?? null,
    characterVisualProfileId: pin.visual?.id ?? null,
    characterVisualProfileVersion: pin.visual?.version ?? null,
    releasePinnedAt: new Date(),
    // Single-character greetings did not happen in this group.
    openingMessage: null,
  } });
}

export async function listGroupConversations(userId: string) {
  const groups = await prisma.groupConversation.findMany({
    where: { userId }, orderBy: { updatedAt: "desc" },
    include: { members: { orderBy: { groupPosition: "asc" }, select: { characterId: true, sessionId: true, title: true } } },
  });
  return groups.map(group => ({
    id: group.id, title: group.title, status: group.status,
    createdAt: group.createdAt.toISOString(), updatedAt: group.updatedAt.toISOString(),
    members: group.members.map(member => groupChatMemberSchema.parse({ characterId: member.characterId, sessionId: member.sessionId, name: member.title ?? "Character" })),
  }));
}

export async function listGroupCandidates(userId: string, query: string, cursor?: string) {
  const rows = await prisma.character.findMany({
    where: {
      age: { gte: 18 }, deletedAt: null,
      ...(query.trim() ? { name: { contains: query.trim().slice(0, 80), mode: "insensitive" } } : {}),
      OR: [
        { creatorId: userId, OR: [{ currentContentVersionId: { not: null } }, { serving: { state: "live", currentRelease: { status: "published" } } }] },
        { visibility: "public", status: "approved", serving: { state: "live", currentRelease: { status: "published" } } },
      ],
    },
    orderBy: { id: "asc" }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), take: 33,
    select: { id: true, name: true, description: true, creatorId: true },
  });
  return {
    ownerScope: `user:${userId}`,
    items: rows.slice(0, 32).map(row => ({ id: row.id, name: row.name, description: row.description.slice(0, 160), owned: row.creatorId === userId })),
    nextCursor: rows.length > 32 ? rows[31].id : null,
  };
}

export async function groupSpeakerSession(userId: string, groupId: string, characterId: string) {
  const member = await prisma.recentChat.findFirst({
    where: { userId, groupId, characterId, group: { userId } },
    select: { sessionId: true, characterId: true, title: true, group: { select: { status: true } } },
  });
  if (!member) throw Errors.notFound("Choose a Character who belongs to this group");
  // An archived group keeps its members: report the ended group, not a wrong speaker.
  if (member.group?.status !== "active") throw Errors.gone("Group conversation is unavailable or archived");
  return { sessionId: member.sessionId, characterId: member.characterId, speakerName: member.title ?? "Character" };
}

export async function getGroupConversation(userId: string, groupId: string, selectedCharacterId?: string) {
  const group = await prisma.groupConversation.findFirst({
    where: { id: groupId, userId },
    include: {
      members: { orderBy: { groupPosition: "asc" }, include: { character: { select: { creatorId: true, imageAsset: { select: { url: true, thumbnailUrl: true } } } } } },
      turns: { orderBy: { ordinal: "asc" }, include: { turn: { include: { attachments: { orderBy: { createdAt: "asc" } } } } } },
    },
  });
  if (!group) throw Errors.notFound("Group conversation not found");
  const selected = selectedCharacterId ? group.members.find(member => member.characterId === selectedCharacterId) : group.members[0];
  if (!selected || group.members.length < GROUP_CHAT_MIN_MEMBERS) throw Errors.gone("This group no longer has enough available Characters");
  const memberBySession = new Map(group.members.map(member => [member.sessionId, member]));
  const raw = await chatTurnMessagesForOwner(userId, group.turns.map(entry => entry.turn));
  const messageSpeakers = new Map(group.turns.flatMap(entry => {
    const member = memberBySession.get(entry.turn.sessionId);
    if (!member) throw Errors.gone("Group transcript identity is unavailable");
    const speaker = { sessionId: member.sessionId, characterId: member.characterId, speakerName: member.title ?? "Character", requestKey: entry.turn.idempotencyKey };
    return [[entry.turn.userMessageId, speaker], [entry.turn.assistantMessageId, speaker]] as const;
  }));
  return {
    id: group.id, ownerScope: `user:${userId}`, title: group.title, status: group.status,
    characterId: selected.characterId, memoryEnabled: selected.memoryEnabled,
    character: { name: selected.title ?? "Character", canUpdateIdentity: selected.character.creatorId === userId },
    // 群聊头部的成员头像组；group.members 是 Main→Chat 的执行契约，不往里加展示字段。
    memberImages: Object.fromEntries(group.members.flatMap(member => {
      const image = member.character.imageAsset?.thumbnailUrl ?? member.character.imageAsset?.url;
      return image ? [[member.characterId, image]] : [];
    })),
    group: {
      members: group.members.map(member => ({ sessionId: member.sessionId, characterId: member.characterId, name: member.title ?? "Character" })),
      selectedSessionId: selected.sessionId,
    },
    messages: raw.map((message): Record<string, unknown> => ({ ...message, ...messageSpeakers.get(String(message.id)) })),
  };
}

const characterIdsSchema = z.array(z.string().trim().min(1).max(160));
const updateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  status: z.literal("archived").optional(),
  addCharacterIds: characterIdsSchema.min(1).max(GROUP_CHAT_MAX_MEMBERS).optional(),
}).strict().refine(value => !(value.status && value.addCharacterIds), {
  message: "Add Characters or archive the group, not both",
}).refine(value => !value.addCharacterIds || new Set(value.addCharacterIds).size === value.addCharacterIds.length, {
  message: "Choose distinct Characters to add",
});

// SPEC: PATCH 改名 / 归档 / 追加成员；追加的成员在群尾按顺序得到新的会话，资格与建群同一规则（chatSessionCharacterPin）。
// INTENT: 只加不减——移除要保留历史发言者身份（getGroupConversation 要求每条历史的 member 仍在），另起一片。
// INTENT: 已在群内的角色视为已加入：首个响应丢失后的原样重放不重复添加、也不报错。
// INVARIANT: 锁序同 turn-scope：users → group_conversations → recent_chats；全部校验通过才写入，任一失败整批不加。
export async function updateGroupConversation(userId: string, groupId: string, input: unknown) {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw Errors.badRequest("Invalid group conversation update", { issues: parsed.error.issues });
  const { addCharacterIds, ...values } = parsed.data;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "group_conversations" WHERE id = ${groupId} FOR UPDATE`;
    const group = await tx.groupConversation.findFirst({ where: { id: groupId, userId } });
    if (!group) throw Errors.notFound("Group conversation not found");
    if (values.status && await tx.chatTurn.count({ where: { groupTurn: { groupId }, assistantStatus: { in: ["pending", "generating"] } } })) {
      throw Errors.conflict("Cancel the active reply before changing this group");
    }
    if (addCharacterIds) {
      if (group.status !== "active") throw Errors.gone("Group conversation is unavailable or archived");
      const current = await tx.recentChat.findMany({ where: { groupId, userId }, select: { characterId: true, groupPosition: true } });
      const joining = addCharacterIds.filter(id => !current.some(member => member.characterId === id));
      if (current.length + joining.length > GROUP_CHAT_MAX_MEMBERS) {
        throw Errors.conflict(`A group can have up to ${GROUP_CHAT_MAX_MEMBERS} Characters`, { remaining: GROUP_CHAT_MAX_MEMBERS - current.length });
      }
      const pins = [];
      for (const characterId of joining) pins.push(await chatSessionCharacterPin(userId, characterId, tx));
      let position = Math.max(-1, ...current.map(member => member.groupPosition ?? -1)) + 1;
      for (const pin of pins) await createGroupMember(tx, userId, groupId, position++, pin);
    }
    await tx.groupConversation.update({ where: { id: groupId }, data: values });
    const members = await tx.recentChat.findMany({ where: { groupId, userId }, orderBy: { groupPosition: "asc" }, select: { characterId: true, sessionId: true, title: true } });
    return {
      id: groupId, title: values.title ?? group.title, status: values.status ?? group.status,
      members: members.map(member => groupChatMemberSchema.parse({ characterId: member.characterId, sessionId: member.sessionId, name: member.title ?? "Character" })),
    };
  });
}
