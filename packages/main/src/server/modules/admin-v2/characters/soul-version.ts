import type {
  CharacterDraftPersona,
  CharacterDraftVisualDirection,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { inTransaction, prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { operationalCharacterWhere } from "@/server/modules/metric-data-scope";
import { characterWorkspaceTabLink } from "./character-deep-link";
import { lockCharacterGenerationAuthority } from "./generation-authority-lock";
import { characterContentModerationText, characterSoulVersionSnapshots } from "./draft-content";
import { moderateText } from "@/server/moderation/text-authority";

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
 * SPEC: a changed Character draft appends one immutable Content Version and Revision.
 * Restoring earlier bytes is a new save; submitting the current bytes is a no-op.
 * INTENT: the visual direction written at creation feeds every image prompt; this is
 * the only place an operator can correct it afterwards.
 * INVARIANT: without visualDirection the previously pinned Appearance bytes are kept
 * as-is; with it, only the four direction keys change and every other appearance key
 * (legacy sourceImage, structured traits) is carried forward. Mutable Character fields
 * are never read as authoring input.
 */
export async function createCharacterSoulVersion(input: {
  readonly characterId: string;
  readonly expectedProjectVersion: number;
  readonly expectedContentVersionId: string;
  readonly actor: AdminActor;
  readonly persona: CharacterDraftPersona;
  readonly visualDirection?: CharacterDraftVisualDirection;
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
      throw Errors.versionConflict("Character Soul changed in another session", {
        projectVersion: project.version,
        contentVersionId: currentContent.id,
      });
    }
    // INVARIANT: same gate as image placement (asset-studio) and Visual Identity
    // versions. A candidate pins its revision; a newer Soul would never ship with
    // it, and the editor reads the candidate's opening/appearance as its baseline.
    const candidateRelease = await tx.characterRelease.findFirst({
      where: { projectId: project.id, status: "approved" },
      select: { id: true, status: true },
    });
    if (candidateRelease) {
      throw Errors.conflict(
        "Publish or discard the candidate Character Release before editing the Soul",
        {
          releaseId: candidateRelease.id,
          status: candidateRelease.status,
          deepLink: characterWorkspaceTabLink(input.characterId, "release"),
        },
      );
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
        visualDirection: input.visualDirection,
      });
    } catch (cause) {
      throw Errors.badRequest(
        cause instanceof Error ? cause.message : "Character Soul compilation failed",
      );
    }
    const moderation = await moderateText("character", input.characterId,
      characterContentModerationText(snapshots), "character_authoring");
    if (moderation.status === "blocked") throw Errors.forbidden("Character failed safety checks", moderation);
    if (currentContent.contentHash === snapshots.contentHash) {
      if (!latestRevision || latestRevision.characterContentVersionId !== currentContent.id) {
        throw Errors.conflict("The current Character draft has no matching revision", {
          blocker: "draft_revision_missing",
        });
      }
      return {
        characterId: input.characterId,
        projectId: project.id,
        projectVersion: project.version,
        contentVersionId: currentContent.id,
        contentVersion: currentContent.version,
        revisionId: latestRevision.id,
        revision: latestRevision.revision,
        fingerprint: snapshots.personaSnapshot.compiled.fingerprint,
      };
    }

    const changed = await tx.characterProject.updateMany({
      where: { id: project.id, version: input.expectedProjectVersion },
      data: { version: { increment: 1 } },
    });
    if (changed.count !== 1) {
      throw Errors.versionConflict("Character Project changed in another session");
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
        before: toInputJson({
          projectVersion: project.version,
          contentVersionId: currentContent.id,
          contentVersion: currentContent.version,
        }),
        after: toInputJson(result),
        requestId: input.requestId,
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

  return inTransaction(db, execute);
}
