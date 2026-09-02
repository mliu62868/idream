import type { ContentCharacterChatToolsRequest } from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "../shared/authority";
import { toInputJson } from "../shared/prisma-json";
import { writeContentAudit } from "./audit";

// SPEC: 运营对单角色开关聊天 Agent 生图工具。合并写 Character.advancedDetails.imageToolEnabled，
//       其余键原样保留。
// INTENT: 复用既有 advancedDetails JSON 槽位，未设置=默认开。
// INVARIANT: 与 Release 投影共用行锁；开关与审计同事务，不覆盖并发发布的新 Soul。

export async function setCharacterChatTools(input: {
  request: Request;
  actor: AdminActor;
  characterId: string;
  body: ContentCharacterChatToolsRequest;
}) {
  const { request, actor, characterId, body } = input;
  return prisma.$transaction(async (tx) => {
    const [existing] = await tx.$queryRaw<Array<{ id: string; advancedDetails: Prisma.JsonValue }>>`
      SELECT "id", "advancedDetails" FROM "characters"
      WHERE "id" = ${characterId} AND "deletedAt" IS NULL FOR UPDATE
    `;
    if (!existing) throw Errors.notFound("Character not found");

    const existingAdvancedDetails = isRecord(existing.advancedDetails)
      ? existing.advancedDetails
      : {};
    const nextAdvancedDetails = {
      ...existingAdvancedDetails,
      imageToolEnabled: body.imageToolEnabled,
    };

    await tx.character.update({
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
    }, tx);

    return { character: { id: characterId, imageToolEnabled: body.imageToolEnabled } };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
