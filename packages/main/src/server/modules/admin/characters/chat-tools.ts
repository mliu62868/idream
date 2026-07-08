// SPEC: 运营对单角色开关聊天 Agent 生图工具（P4 Task 6）。POST 合并写
//       Character.advancedDetails.imageToolEnabled，其余键原样保留。
// INTENT: 复用既有 advancedDetails JSON 槽位，不新增 Prisma 字段；core.chat_character_view
//         已经 COALESCE 该键为 true（未设置=默认开），这里只负责运营侧的写路径 + 审计。
// INVARIANTS: 仅 content.production.write 可写；reason 审计必填 (≥3)；immutable merge——
//             先读现有 advancedDetails 再 spread，不覆盖其余键。
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, jsonBody, toInputJson, writeAudit } from "@/server/modules/admin/service";

const chatToolsSchema = z.object({
  imageToolEnabled: z.boolean(),
  reason: z.string().trim().min(3),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function setCharacterChatTools(request: Request, characterId: string) {
  const actor = await actorWithPermission(request, "content.production.write");
  const body = chatToolsSchema.parse(await jsonBody(request));

  const existing = await prisma.character.findFirst({
    where: { id: characterId, deletedAt: null },
    select: { id: true, advancedDetails: true },
  });
  if (!existing) throw Errors.notFound("Character not found");

  const existingAdvancedDetails = isRecord(existing.advancedDetails) ? existing.advancedDetails : {};
  const nextAdvancedDetails = { ...existingAdvancedDetails, imageToolEnabled: body.imageToolEnabled };

  await prisma.character.update({
    where: { id: characterId },
    data: { advancedDetails: toInputJson(nextAdvancedDetails) },
  });

  await writeAudit(request, actor, {
    action: "content.chat-tools.write",
    targetType: "character",
    targetId: characterId,
    reason: body.reason,
    before: { imageToolEnabled: existingAdvancedDetails.imageToolEnabled ?? true },
    after: { imageToolEnabled: body.imageToolEnabled },
  });

  return ok({ character: { id: characterId, imageToolEnabled: body.imageToolEnabled } });
}
