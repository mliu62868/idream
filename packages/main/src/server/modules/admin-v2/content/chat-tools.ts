import type { ContentCharacterChatToolsRequest } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "../shared/authority";
import { toInputJson } from "../shared/prisma-json";
import { writeContentAudit } from "./audit";

// SPEC: 运营对单角色开关聊天 Agent 生图工具。合并写 Character.advancedDetails.imageToolEnabled，
//       其余键原样保留。
// INTENT: 复用既有 advancedDetails JSON 槽位，不新增 Prisma 字段；core.chat_character_view
//         已经 COALESCE 该键为 true（未设置=默认开），这里只负责运营侧的写路径 + 审计。
// INVARIANT: immutable merge —— 先读现有 advancedDetails 再 spread，不覆盖其余键。

export async function setCharacterChatTools(input: {
  request: Request;
  actor: AdminActor;
  characterId: string;
  body: ContentCharacterChatToolsRequest;
}) {
  const { request, actor, characterId, body } = input;
  const existing = await prisma.character.findFirst({
    where: { id: characterId, deletedAt: null },
    select: { id: true, advancedDetails: true },
  });
  if (!existing) throw Errors.notFound("Character not found");

  const existingAdvancedDetails = isRecord(existing.advancedDetails)
    ? existing.advancedDetails
    : {};
  const nextAdvancedDetails = {
    ...existingAdvancedDetails,
    imageToolEnabled: body.imageToolEnabled,
  };

  await prisma.character.update({
    where: { id: characterId },
    data: { advancedDetails: toInputJson(nextAdvancedDetails) },
  });

  await writeContentAudit(request, actor, {
    action: "content.chat-tools.write",
    targetType: "character",
    targetId: characterId,
    reason: body.reason,
    before: { imageToolEnabled: existingAdvancedDetails.imageToolEnabled ?? true },
    after: { imageToolEnabled: body.imageToolEnabled },
  });

  return { character: { id: characterId, imageToolEnabled: body.imageToolEnabled } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
