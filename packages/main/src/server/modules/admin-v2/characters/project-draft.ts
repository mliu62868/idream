import type {
  CharacterDraftPersona,
  CharacterDraftVisualDirection,
} from "@idream/shared/admin";
import { characterProjectDraftResumeSchema } from "@idream/shared/admin";
import { loadCharacterSoulSnapshot } from "@idream/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { operationalCharacterWhere } from "@/server/modules/metric-data-scope";
import { canonicalSha256 } from "../shared/canonical-json";
import {
  jsonRecord as record,
  jsonStrings as strings,
  jsonText as text,
  toInputJson,
} from "../shared/prisma-json";
import { characterWorkspaceLink } from "./character-deep-link";
import { characterDraftSnapshots } from "./draft-content";
import {
  characterAssetPack,
  evaluateDraftAssetRouteAuthority,
} from "./draft-asset-route-authority";
import { lockCharacterGenerationAuthority } from "./generation-authority-lock";

function characterAssetSelections(
  value: Prisma.JsonValue,
  currentRouteFingerprint: string | null,
) {
  const routeAuthority = evaluateDraftAssetRouteAuthority(
    value,
    currentRouteFingerprint,
  );
  const source = record(value);
  return Object.fromEntries(
    (["character_cover", "character_hero", "character_chat"] as const).flatMap(
      (purpose) => {
        const raw = source[purpose];
        if (typeof raw === "string") {
          return [
            [
              purpose,
              {
                assetId: raw,
                runId: null,
                itemId: null,
                reviewDecisionId: null,
                generationJobId: null,
                bootstrapIdentity: false,
                generationRouteFingerprint: null,
                routeCurrent:
                  routeAuthority.routeCurrentByPurpose[purpose] ?? false,
              },
            ],
          ];
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const entry = raw as Record<string, unknown>;
        if (typeof entry.assetId !== "string") return [];
        return [
          [
            purpose,
            {
              assetId: entry.assetId,
              runId: typeof entry.runId === "string" ? entry.runId : null,
              itemId: typeof entry.itemId === "string" ? entry.itemId : null,
              reviewDecisionId:
                typeof entry.reviewDecisionId === "string"
                  ? entry.reviewDecisionId
                  : null,
              generationJobId:
                typeof entry.generationJobId === "string"
                  ? entry.generationJobId
                  : null,
              bootstrapIdentity: entry.bootstrapIdentity === true,
              generationRouteFingerprint:
                typeof entry.generationRouteFingerprint === "string"
                  ? entry.generationRouteFingerprint
                  : null,
              routeCurrent:
                routeAuthority.routeCurrentByPurpose[purpose] ?? false,
            },
          ],
        ];
      },
    ),
  );
}

export function projectDto(
  project: {
    id: string;
    characterId: string;
    draftImageAssetId: string | null;
    draftAssetPack: Prisma.JsonValue;
    version: number;
    updatedAt: Date;
  },
  currentRouteFingerprint: string | null,
) {
  const draftAssetRouteAuthority = evaluateDraftAssetRouteAuthority(
    project.draftAssetPack,
    currentRouteFingerprint,
  );
  return {
    id: project.id,
    characterId: project.characterId,
    draftImageAssetId: project.draftImageAssetId,
    draftAssetPackHash: canonicalSha256(project.draftAssetPack),
    draftAssetPack: characterAssetPack(project.draftAssetPack),
    draftAssetSelections: characterAssetSelections(
      project.draftAssetPack,
      currentRouteFingerprint,
    ),
    draftAssetRouteAuthority: {
      status: draftAssetRouteAuthority.status,
      currentRouteFingerprint: draftAssetRouteAuthority.currentRouteFingerprint,
      stalePurposes: draftAssetRouteAuthority.stalePurposes,
      missingPurposes: draftAssetRouteAuthority.missingPurposes,
      recoveryPurpose: draftAssetRouteAuthority.recoveryPurpose,
      releaseReady: draftAssetRouteAuthority.releaseReady,
      releaseBlockers: draftAssetRouteAuthority.releaseBlockers,
    },
    version: project.version,
    updatedAt: project.updatedAt.toISOString(),
  };
}

export async function getCharacterProjectDraftForResume(characterId: string) {
  const [character, project, content] = await Promise.all([
    prisma.character.findFirst({
      where: operationalCharacterWhere({ id: characterId, deletedAt: null }),
    }),
    prisma.characterProject.findFirst({
      where: { characterId },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.characterContentVersion.findFirst({
      where: { characterId },
      orderBy: { version: "desc" },
    }),
  ]);
  if (!character || !project || !content)
    throw Errors.notFound("Character Project draft not found");
  const persona = record(content.personaSnapshot);
  const loadedSoul = loadCharacterSoulSnapshot(content.personaSnapshot);
  const soul = loadedSoul.ok ? loadedSoul.snapshot.soul : null;
  const opening = record(content.openingSnapshot);
  const appearance = record(content.appearanceSnapshot);
  return characterProjectDraftResumeSchema.parse({
    authority: {
      characterId,
      projectId: project.id,
      projectVersion: project.version,
      deepLink: characterWorkspaceLink(characterId),
    },
    draft: {
      persona: {
        name: soul?.name || text(persona.name) || character.name,
        age:
          soul?.age ??
          (typeof persona.age === "number" ? persona.age : character.age),
        gender: soul?.gender || text(persona.gender) || character.gender,
        characterPromise:
          soul?.characterPromise ||
          text(persona.characterPromise) ||
          character.description,
        detailsMarkdown: soul?.detailsMarkdown ?? text(persona.detailsMarkdown),
        firstMessage: text(opening.firstMessage),
      },
      visualDirection: {
        identityAnchor: text(appearance.identityAnchor),
        stableTraits: strings(
          appearance.stableTraits as Prisma.JsonValue | undefined,
        ),
        style: text(appearance.style) || character.style,
        referenceDirection: text(appearance.referenceDirection),
      },
    },
  });
}

export async function updateCharacterProjectDraft(input: {
  readonly characterId: string;
  readonly expectedVersion: number;
  readonly actor: AdminActor;
  readonly content?: {
    readonly persona: CharacterDraftPersona;
    readonly visualDirection: CharacterDraftVisualDirection;
  };
  readonly reason: string;
  readonly requestId: string;
}) {
  return prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, input.characterId);
    const character = await tx.character.findFirst({
      where: operationalCharacterWhere({
        id: input.characterId,
        deletedAt: null,
      }),
      select: { id: true },
    });
    if (!character) throw Errors.notFound("Character Project not found");
    const project = await tx.characterProject.findFirst({
      where: { characterId: input.characterId },
    });
    if (!project) throw Errors.notFound("Character Project not found");
    const currentRouteFingerprint = null;
    const changed = await tx.characterProject.updateMany({
      where: { id: project.id, version: input.expectedVersion },
      data: {
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      const current = await tx.characterProject.findUniqueOrThrow({
        where: { id: project.id },
      });
      throw Errors.conflict("Character Project changed in another session", {
        currentVersion: current.version,
        current: projectDto(current, currentRouteFingerprint),
      });
    }
    const updated = await tx.characterProject.findUniqueOrThrow({
      where: { id: project.id },
    });
    let contentVersion: {
      id: string;
      version: number;
      contentHash: string;
    } | null = null;
    let revision: { id: string; revision: number } | null = null;
    if (input.content) {
      const snapshots = characterDraftSnapshots(input.content);
      const latestContent = await tx.characterContentVersion.findFirst({
        where: { characterId: input.characterId },
        orderBy: { version: "desc" },
      });
      if (
        !latestContent ||
        latestContent.contentHash !== snapshots.contentHash
      ) {
        const latestRevision = await tx.characterRevision.findFirst({
          where: { projectId: project.id },
          orderBy: { revision: "desc" },
        });
        const createdContent = await tx.characterContentVersion.create({
          data: {
            characterId: input.characterId,
            version: (latestContent?.version ?? 0) + 1,
            contentHash: snapshots.contentHash,
            personaSnapshot: toInputJson(snapshots.personaSnapshot),
            openingSnapshot: toInputJson(snapshots.openingSnapshot),
            appearanceSnapshot: toInputJson(snapshots.appearanceSnapshot),
            sourceType: "admin_character_project_autosave",
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
              project: projectDto(updated, currentRouteFingerprint),
              contentHash: snapshots.contentHash,
            }),
            createdById: input.actor.id,
          },
        });
        contentVersion = {
          id: createdContent.id,
          version: createdContent.version,
          contentHash: createdContent.contentHash,
        };
        revision = {
          id: createdRevision.id,
          revision: createdRevision.revision,
        };
      } else {
        contentVersion = {
          id: latestContent.id,
          version: latestContent.version,
          contentHash: latestContent.contentHash,
        };
      }
    }
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "character.project.draft_saved",
        targetType: "character_project",
        targetId: project.id,
        reason: input.reason,
        before: toInputJson(projectDto(project, currentRouteFingerprint)),
        after: toInputJson({
          project: projectDto(updated, currentRouteFingerprint),
          contentVersion,
          revision,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "character.project.draft_saved.v2",
        aggregateType: "character_project",
        aggregateId: project.id,
        payload: toInputJson({
          projectId: project.id,
          characterId: input.characterId,
          version: updated.version,
          contentVersion,
          revision,
          occurredAt: updated.updatedAt.toISOString(),
        }),
      },
    });
    return projectDto(updated, currentRouteFingerprint);
  });
}
