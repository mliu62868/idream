import type {
  CharacterDraftPersona,
  CharacterDraftVisualDirection,
} from "@idream/shared/admin";
import { characterProjectDraftResumeSchema } from "@idream/shared/admin";
import { loadCharacterSoulSnapshot } from "@idream/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
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
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-validation";
import { findOperationalGenerationRoute } from "./visual-authority";

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
    (["character_cover", "character_hero", "character_chat"] as const).flatMap((purpose) => {
      const raw = source[purpose];
      if (typeof raw === "string") {
        return [[purpose, {
          assetId: raw,
          runId: null,
          itemId: null,
          reviewDecisionId: null,
          generationJobId: null,
          bootstrapIdentity: false,
          generationRouteFingerprint: null,
          routeCurrent: routeAuthority.routeCurrentByPurpose[purpose] ?? false,
        }]];
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const entry = raw as Record<string, unknown>;
      if (typeof entry.assetId !== "string") return [];
      return [[purpose, {
        assetId: entry.assetId,
        runId: typeof entry.runId === "string" ? entry.runId : null,
        itemId: typeof entry.itemId === "string" ? entry.itemId : null,
        reviewDecisionId: typeof entry.reviewDecisionId === "string" ? entry.reviewDecisionId : null,
        generationJobId: typeof entry.generationJobId === "string" ? entry.generationJobId : null,
        bootstrapIdentity: entry.bootstrapIdentity === true,
        generationRouteFingerprint:
          typeof entry.generationRouteFingerprint === "string"
            ? entry.generationRouteFingerprint
            : null,
        routeCurrent: routeAuthority.routeCurrentByPurpose[purpose] ?? false,
      }]];
    }),
  );
}

export function projectDto(project: {
  id: string;
  characterId: string;
  ownerId: string | null;
  phase: string;
  audience: Prisma.JsonValue;
  hypothesis: string | null;
  differentiation: string | null;
  successCriteria: Prisma.JsonValue;
  draftImageAssetId: string | null;
  draftAssetPack: Prisma.JsonValue;
  plannedLaunchAt: Date | null;
  version: number;
  updatedAt: Date;
}, currentRouteFingerprint: string | null) {
  const audience = record(project.audience);
  const draftAssetRouteAuthority = evaluateDraftAssetRouteAuthority(
    project.draftAssetPack,
    currentRouteFingerprint,
  );
  return {
    id: project.id,
    characterId: project.characterId,
    ownerId: project.ownerId,
    phase: project.phase,
    audience: text(audience.audience),
    companionNeed: text(audience.companionNeed),
    hypothesis: project.hypothesis ?? "",
    differentiation: project.differentiation ?? "",
    targetPlacementKeys: strings(audience.targetPlacementKeys as Prisma.JsonValue | undefined),
    successCriteria: strings(project.successCriteria),
    productionPackage: text(audience.productionPackage),
    qaPlan: text(audience.qaPlan),
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
      qaReady: draftAssetRouteAuthority.qaReady,
      qaBlockers: draftAssetRouteAuthority.qaBlockers,
    },
    plannedLaunchAt: project.plannedLaunchAt?.toISOString() ?? null,
    version: project.version,
    updatedAt: project.updatedAt.toISOString(),
  };
}

export async function getCharacterProjectDraftForResume(characterId: string) {
  const [character, project, content, visualAuthority] = await Promise.all([
    prisma.character.findFirst({
      where: operationalCharacterWhere({ id: characterId, deletedAt: null }),
    }),
    prisma.characterProject.findFirst({ where: { characterId }, orderBy: { updatedAt: "desc" } }),
    prisma.characterContentVersion.findFirst({ where: { characterId }, orderBy: { version: "desc" } }),
    prisma.characterVisualProfile.findFirst({
      where: { characterId, status: "active" },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      select: {
        style: true,
        referenceSetRevisions: {
          where: { status: "active" },
          orderBy: [{ revision: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            references: {
              orderBy: { position: "asc" },
              select: { role: true },
            },
          },
        },
      },
    }),
  ]);
  if (!character || !project || !content) throw Errors.notFound("Character Project draft not found");
  const activeReferences =
    visualAuthority?.referenceSetRevisions[0]?.references ?? [];
  const qualifiedRoute = visualAuthority
    ? await findOperationalGenerationRoute(prisma, {
        style: visualAuthority.style,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        at: new Date(),
        requiredReferenceCount: activeReferences.length,
        requiredReferenceRoles:
          activeReferences.map((reference) => reference.role),
      })
    : null;
  const projectView = projectDto(project, qualifiedRoute?.routeFingerprint ?? null);
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
      positioning: {
        audience: projectView.audience,
        companionNeed: projectView.companionNeed,
        hypothesis: projectView.hypothesis,
        differentiation: projectView.differentiation,
      },
      persona: {
        name: soul?.identity.name || text(persona.name) || character.name,
        age: soul?.identity.age ?? (typeof persona.age === "number" ? persona.age : character.age),
        gender: soul?.identity.gender || text(persona.gender) || character.gender,
        relationshipArchetype: soul?.identity.relationshipArchetype || text(persona.relationshipArchetype) || character.relationship,
        characterPromise: soul?.identity.characterPromise || text(persona.characterPromise) || character.description,
        personality: soul?.innerLife.personality ?? text(persona.personality),
        values: soul?.innerLife.values,
        wants: soul?.innerLife.wants,
        fears: soul?.innerLife.fears,
        contradictions: soul?.innerLife.contradictions,
        tone: soul?.voice.tone ?? text(persona.tone),
        cadence: soul?.voice.cadence,
        vocabulary: soul?.voice.vocabulary,
        voiceHabits: soul?.voice.habits,
        voiceAvoid: soul?.voice.avoid,
        backstory: soul?.innerLife.backstory ?? text(persona.backstory),
        firstMessage: text(opening.firstMessage),
        exampleDialogue: soul
          ? soul.dialogue.positive.map((example) => example.assistant)
          : strings(persona.exampleDialogue as Prisma.JsonValue | undefined),
        interaction: soul?.interaction,
        canon: soul?.canon,
        negativeDialogue: soul?.dialogue.negative,
      },
      visualDirection: {
        identityAnchor: text(appearance.identityAnchor),
        stableTraits: strings(appearance.stableTraits as Prisma.JsonValue | undefined),
        style: text(appearance.style) || character.style,
        referenceDirection: text(appearance.referenceDirection),
      },
      commercialIntent: {
        ownerId: projectView.ownerId,
        plannedLaunchAt: projectView.plannedLaunchAt,
        targetPlacementKeys: projectView.targetPlacementKeys,
        successCriteria: projectView.successCriteria,
        productionPackage: projectView.productionPackage,
        qaPlan: projectView.qaPlan,
      },
    },
  });
}

export async function updateCharacterProjectDraft(input: {
  readonly characterId: string;
  readonly expectedVersion: number;
  readonly actor: AdminActor;
  readonly ownerId: string | null;
  readonly audience: string;
  readonly companionNeed: string;
  readonly hypothesis: string;
  readonly differentiation: string;
  readonly targetPlacementKeys: readonly string[];
  readonly successCriteria: readonly string[];
  readonly productionPackage: string;
  readonly qaPlan: string;
  readonly plannedLaunchAt: string | null;
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
    const project = await tx.characterProject.findFirst({ where: { characterId: input.characterId } });
    if (!project) throw Errors.notFound("Character Project not found");
    const visualAuthority = await tx.characterVisualProfile.findFirst({
      where: { characterId: input.characterId, status: "active" },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      select: {
        style: true,
        referenceSetRevisions: {
          where: { status: "active" },
          orderBy: [{ revision: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            references: {
              orderBy: { position: "asc" },
              select: { role: true },
            },
          },
        },
      },
    });
    const activeReferences =
      visualAuthority?.referenceSetRevisions[0]?.references ?? [];
    const qualifiedRoute = visualAuthority
      ? await findOperationalGenerationRoute(tx, {
          style: visualAuthority.style,
          policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
          at: new Date(),
          requiredReferenceCount: activeReferences.length,
          requiredReferenceRoles:
            activeReferences.map((reference) => reference.role),
        })
      : null;
    const currentRouteFingerprint = qualifiedRoute?.routeFingerprint ?? null;
    const changed = await tx.characterProject.updateMany({
      where: { id: project.id, version: input.expectedVersion },
      data: {
        ownerId: input.ownerId,
        audience: toInputJson({
          audience: input.audience,
          companionNeed: input.companionNeed,
          targetPlacementKeys: input.targetPlacementKeys,
          productionPackage: input.productionPackage,
          qaPlan: input.qaPlan,
        }),
        hypothesis: input.hypothesis,
        differentiation: input.differentiation,
        successCriteria: toInputJson(input.successCriteria),
        plannedLaunchAt: input.plannedLaunchAt ? new Date(input.plannedLaunchAt) : null,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      const current = await tx.characterProject.findUniqueOrThrow({ where: { id: project.id } });
      throw Errors.conflict("Character Project changed in another session", {
        currentVersion: current.version,
        current: projectDto(current, currentRouteFingerprint),
      });
    }
    const updated = await tx.characterProject.findUniqueOrThrow({ where: { id: project.id } });
    let contentVersion: { id: string; version: number; contentHash: string } | null = null;
    let revision: { id: string; revision: number } | null = null;
    if (input.content) {
      const snapshots = characterDraftSnapshots(input.content);
      const latestContent = await tx.characterContentVersion.findFirst({
        where: { characterId: input.characterId },
        orderBy: { version: "desc" },
      });
      if (!latestContent || latestContent.contentHash !== snapshots.contentHash) {
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
        revision = { id: createdRevision.id, revision: createdRevision.revision };
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
    await tx.adminCollaborationActivity.create({
      data: {
        targetType: "character_project",
        targetId: project.id,
        kind: "draft_saved",
        actorId: input.actor.id,
        body: "Saved Character Project draft",
        metadata: toInputJson({ projectVersion: updated.version, contentVersion, revision }),
        idempotencyKey: `character_project_draft_saved:${input.requestId}`,
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
