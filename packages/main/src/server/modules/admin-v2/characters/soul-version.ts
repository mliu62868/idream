import type { CharacterDraftPersona } from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { operationalCharacterWhere } from "@/server/modules/metric-data-scope";
import { lockCharacterGenerationAuthority } from "./generation-authority-lock";
import { characterSoulVersionSnapshots } from "./draft-content";

export type CharacterSoulVersionResult = {
  readonly characterId: string;
  readonly projectId: string;
  readonly projectVersion: number;
  readonly contentVersionId: string;
  readonly contentVersion: number;
  readonly revisionId: string;
  readonly revision: number;
  readonly fingerprint: string;
};

/**
 * SPEC: editing Soul creates one immutable Content Version and Revision.
 * INVARIANT: it preserves the previously pinned Appearance bytes and never
 * reads mutable Character fields as authoring input.
 */
export async function createCharacterSoulVersion(input: {
  readonly characterId: string;
  readonly expectedProjectVersion: number;
  readonly expectedContentVersionId: string;
  readonly actor: AdminActor;
  readonly persona: CharacterDraftPersona;
  readonly reason: string;
  readonly requestId: string;
}, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<CharacterSoulVersionResult> {
  const execute = async (tx: Prisma.TransactionClient) => {
    await lockCharacterGenerationAuthority(tx, input.characterId);
    const character = await tx.character.findFirst({
      where: operationalCharacterWhere({ id: input.characterId, deletedAt: null }),
      select: { id: true },
    });
    const project = await tx.characterProject.findFirst({
      where: { characterId: input.characterId },
    });
    const currentContent = await tx.characterContentVersion.findFirst({
      where: { characterId: input.characterId },
      orderBy: [{ version: "desc" }, { id: "desc" }],
    });
    if (!character || !project || !currentContent) {
      throw Errors.notFound("Character Soul authority not found");
    }
    if (
      project.version !== input.expectedProjectVersion ||
      currentContent.id !== input.expectedContentVersionId
    ) {
      throw Errors.conflict("Character Soul changed in another session", {
        projectVersion: project.version,
        contentVersionId: currentContent.id,
      });
    }
    const latestRevision = await tx.characterRevision.findFirst({
      where: { projectId: project.id },
      orderBy: [{ revision: "desc" }, { id: "desc" }],
    });

    let snapshots: ReturnType<typeof characterSoulVersionSnapshots>;
    try {
      snapshots = characterSoulVersionSnapshots({
        persona: input.persona,
        appearanceSnapshot: currentContent.appearanceSnapshot,
      });
    } catch (cause) {
      throw Errors.badRequest(
        cause instanceof Error ? cause.message : "Character Soul compilation failed",
      );
    }
    const historical = await tx.characterContentVersion.findFirst({
      where: { characterId: input.characterId, contentHash: snapshots.contentHash },
      select: { id: true, version: true },
    });
    if (historical) {
      throw Errors.conflict("This exact Character Soul version already exists; select the historical version instead", {
        contentVersionId: historical.id,
        contentVersion: historical.version,
      });
    }

    const changed = await tx.characterProject.updateMany({
      where: { id: project.id, version: input.expectedProjectVersion },
      data: { version: { increment: 1 } },
    });
    if (changed.count !== 1) {
      throw Errors.conflict("Character Project changed in another session");
    }
    const createdContent = await tx.characterContentVersion.create({
      data: {
        characterId: input.characterId,
        version: currentContent.version + 1,
        contentHash: snapshots.contentHash,
        personaSnapshot: toInputJson(snapshots.personaSnapshot),
        openingSnapshot: toInputJson(snapshots.openingSnapshot),
        appearanceSnapshot: toInputJson(snapshots.appearanceSnapshot),
        sourceType: "admin_character_soul_version",
        sourceId: project.id,
        createdById: input.actor.id,
      },
    });
    const createdRevision = await tx.characterRevision.create({
      data: {
        projectId: project.id,
        revision: (latestRevision?.revision ?? 0) + 1,
        characterContentVersionId: createdContent.id,
        projectSnapshot: toInputJson({
          source: "admin_character_soul_version",
          contentHash: snapshots.contentHash,
          soulFingerprint: snapshots.personaSnapshot.compiled.fingerprint,
        }),
        createdById: input.actor.id,
      },
    });
    const result: CharacterSoulVersionResult = {
      characterId: input.characterId,
      projectId: project.id,
      projectVersion: project.version + 1,
      contentVersionId: createdContent.id,
      contentVersion: createdContent.version,
      revisionId: createdRevision.id,
      revision: createdRevision.revision,
      fingerprint: snapshots.personaSnapshot.compiled.fingerprint,
    };
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "character.soul.version_created",
        targetType: "character_project",
        targetId: project.id,
        reason: input.reason,
        before: toInputJson({
          projectVersion: project.version,
          contentVersionId: currentContent.id,
          contentVersion: currentContent.version,
        }),
        after: toInputJson(result),
        requestId: input.requestId,
      },
    });
    await tx.adminCollaborationActivity.create({
      data: {
        targetType: "character_project",
        targetId: project.id,
        kind: "draft_saved",
        actorId: input.actor.id,
        body: `Created Character Soul version ${createdContent.version}`,
        metadata: toInputJson(result),
        idempotencyKey: `character_soul_version_created:${input.requestId}`,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "character.soul.version_created.v1",
        aggregateType: "character_project",
        aggregateId: project.id,
        payload: toInputJson({ ...result, occurredAt: createdContent.createdAt.toISOString() }),
      },
    });
    return result;
  };

  return "$transaction" in db ? db.$transaction(execute) : execute(db);
}
