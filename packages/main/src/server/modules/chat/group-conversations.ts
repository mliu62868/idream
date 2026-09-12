import { randomUUID } from "node:crypto";
import { GROUP_CHAT_MAX_MEMBERS, GROUP_CHAT_MIN_MEMBERS, groupChatMemberSchema } from "@idream/shared/contracts";
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
    for (const [position, pin] of pins.entries()) {
      await tx.recentChat.create({ data: {
        sessionId: randomUUID(), userId, characterId: pin.character.id,
        groupId: group.id, groupPosition: position, title: pin.character.name,
        characterContentVersionId: pin.content.id,
        characterReleaseId: pin.release?.id ?? null,
        characterVisualProfileId: pin.visual?.id ?? null,
        characterVisualProfileVersion: pin.visual?.version ?? null,
        releasePinnedAt: new Date(),
        // Single-character greetings did not happen in this new group.
        openingMessage: null,
      } });
    }
    return { id: group.id, title: group.title };
  });
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
      members: { orderBy: { groupPosition: "asc" }, include: { character: { select: { creatorId: true } } } },
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
    group: {
      members: group.members.map(member => ({ sessionId: member.sessionId, characterId: member.characterId, name: member.title ?? "Character" })),
      selectedSessionId: selected.sessionId,
    },
    messages: raw.map((message): Record<string, unknown> => ({ ...message, ...messageSpeakers.get(String(message.id)) })),
  };
}

export async function updateGroupConversation(userId: string, groupId: string, input: unknown) {
  const parsed = z.object({ title: z.string().trim().min(1).max(120).optional(), status: z.literal("archived").optional() }).strict().safeParse(input);
  if (!parsed.success) throw Errors.badRequest("Invalid group conversation update", { issues: parsed.error.issues });
  const values = parsed.data;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "group_conversations" WHERE id = ${groupId} FOR UPDATE`;
    const group = await tx.groupConversation.findFirst({ where: { id: groupId, userId } });
    if (!group) throw Errors.notFound("Group conversation not found");
    if (values.status && await tx.chatTurn.count({ where: { groupTurn: { groupId }, assistantStatus: { in: ["pending", "generating"] } } })) {
      throw Errors.conflict("Cancel the active reply before changing this group");
    }
    if (values.status) await tx.recentChat.updateMany({ where: { groupId, userId }, data: { status: values.status } });
    await tx.groupConversation.update({ where: { id: groupId }, data: values });
    return { id: groupId, title: values.title ?? group.title, status: values.status ?? group.status };
  });
}
