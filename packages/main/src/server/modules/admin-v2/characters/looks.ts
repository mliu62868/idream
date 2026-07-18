import type { Prisma } from "@prisma/client";
import {
  characterLookArchiveRequestSchema,
  characterLookArchiveResponseSchema,
  type CharacterLookArchiveRequest,
} from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "./generation-authority-lock";

export async function archiveCharacterLookAsAdmin(input: {
  characterId: string;
  lookId: string;
  actor: AdminActor;
  requestId: string;
  request: CharacterLookArchiveRequest;
  tx: Prisma.TransactionClient;
}) {
  const request = characterLookArchiveRequestSchema.parse(input.request);
  if (request.confirmation !== `ARCHIVE LOOK ${input.lookId}`) {
    throw Errors.badRequest("Confirmation did not match the Character Look");
  }

  await lockCharacterGenerationAuthority(input.tx, input.characterId);
  const located = await input.tx.characterLook.findFirst({
    where: {
      id: input.lookId,
      characterId: input.characterId,
      status: { in: ["active", "needs_rebase"] },
    },
    select: {
      id: true,
      referenceAssetId: true,
      status: true,
      updatedAt: true,
    },
  });
  if (!located) throw Errors.notFound("Active Character Look not found");
  await lockCharacterMediaAssetAuthorities(
    input.tx,
    located.referenceAssetId ? [located.referenceAssetId] : [],
  );

  const expectedUpdatedAt = new Date(request.expectedUpdatedAt);
  const updated = await input.tx.characterLook.updateMany({
    where: {
      id: located.id,
      characterId: input.characterId,
      status: { in: ["active", "needs_rebase"] },
      updatedAt: expectedUpdatedAt,
    },
    data: {
      status: "archived",
      activeKey: null,
    },
  });
  if (updated.count !== 1) {
    throw Errors.conflict(
      "Character Look changed before it could be archived. Reload the Character and review the latest state.",
      {
        characterId: input.characterId,
        lookId: input.lookId,
        expectedUpdatedAt: request.expectedUpdatedAt,
        currentUpdatedAt: located.updatedAt.toISOString(),
      },
    );
  }
  const archived = await input.tx.characterLook.findUniqueOrThrow({
    where: { id: located.id },
    select: {
      id: true,
      characterId: true,
      status: true,
      updatedAt: true,
    },
  });
  await input.tx.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "character.look.archived",
      targetType: "character_look",
      targetId: archived.id,
      reason: `${request.reason.code}: ${request.reason.summary}`,
      before: toInputJson({
        characterId: input.characterId,
        status: located.status,
        referenceAssetId: located.referenceAssetId,
        updatedAt: located.updatedAt.toISOString(),
      }),
      after: toInputJson({
        characterId: input.characterId,
        status: archived.status,
        updatedAt: archived.updatedAt.toISOString(),
      }),
      requestId: input.requestId,
    },
  });
  await input.tx.mainOutboxEvent.create({
    data: {
      eventType: "character.look.archived.v1",
      aggregateType: "character",
      aggregateId: input.characterId,
      payload: toInputJson({
        characterId: input.characterId,
        lookId: archived.id,
        referenceAssetId: located.referenceAssetId,
      }),
    },
  });
  return characterLookArchiveResponseSchema.parse({
    ...archived,
    updatedAt: archived.updatedAt.toISOString(),
  });
}
