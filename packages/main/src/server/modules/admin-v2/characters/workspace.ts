import type {
  CharacterDraftPersona,
  CharacterDraftVisualDirection,
} from "@idream/shared/admin";
import { characterProjectDraftResumeSchema } from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin/service";
import { listCharacterPortfolioData } from "./portfolio";
import { collectReleaseMonitorFacts } from "./release-monitor";
import { toInputJson } from "../shared/prisma-json";
import { characterDraftSnapshots } from "./draft-content";

function record(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function projectDto(project: {
  id: string;
  characterId: string;
  ownerId: string | null;
  phase: string;
  audience: Prisma.JsonValue;
  hypothesis: string | null;
  differentiation: string | null;
  successCriteria: Prisma.JsonValue;
  plannedLaunchAt: Date | null;
  version: number;
  updatedAt: Date;
}) {
  const audience = record(project.audience);
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
    plannedLaunchAt: project.plannedLaunchAt?.toISOString() ?? null,
    version: project.version,
    updatedAt: project.updatedAt.toISOString(),
  };
}

function servingDto(serving: {
  characterId: string;
  state: string;
  currentReleaseId: string | null;
  scheduledReleaseId: string | null;
  scheduledAt: Date | null;
  version: number;
  updatedAt: Date;
} | null) {
  return serving ? {
    characterId: serving.characterId,
    state: serving.state,
    currentReleaseId: serving.currentReleaseId,
    scheduledReleaseId: serving.scheduledReleaseId,
    scheduledAt: serving.scheduledAt?.toISOString() ?? null,
    version: serving.version,
    updatedAt: serving.updatedAt.toISOString(),
  } : null;
}

function releaseDto(release: {
  id: string;
  projectId: string;
  revisionId: string;
  characterContentVersionId: string;
  visualProfileId: string | null;
  visualProfileVersion: number | null;
  referenceSetRevisionId: string | null;
  generationProvenance: Prisma.JsonValue;
  releasePlacementManifest: Prisma.JsonValue;
  snapshotHash: string;
  readiness: string;
  legacy: boolean;
  status: string;
  publishedAt: Date | null;
  supersedesId: string | null;
  rollbackOfReleaseId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...release,
    generationProvenance: record(release.generationProvenance),
    releasePlacementManifest: record(release.releasePlacementManifest),
    publishedAt: release.publishedAt?.toISOString() ?? null,
    createdAt: release.createdAt.toISOString(),
    updatedAt: release.updatedAt.toISOString(),
  };
}

function previewSnapshot(input: {
  character: { name: string; description: string; appearance: Prisma.JsonValue; advancedDetails: Prisma.JsonValue };
  content: {
    id: string;
    personaSnapshot: Prisma.JsonValue;
    openingSnapshot: Prisma.JsonValue;
    appearanceSnapshot: Prisma.JsonValue;
  } | null;
  releaseId: string | null;
  imageUrl: string | null;
  label: "Live" | "Draft Preview";
}) {
  const persona = input.content ? record(input.content.personaSnapshot) : record(input.character.advancedDetails);
  const opening = input.content ? record(input.content.openingSnapshot) : {
    firstMessage: record(input.character.advancedDetails).firstMessage ?? null,
  };
  const appearance = input.content ? record(input.content.appearanceSnapshot) : record(input.character.appearance);
  return {
    releaseId: input.releaseId,
    contentVersionId: input.content?.id ?? null,
    label: input.label,
    name: text(persona.name) || input.character.name,
    description: text(persona.description) || input.character.description,
    persona,
    opening,
    appearance,
    imageUrl: input.imageUrl,
  };
}

function changedFields(
  live: ReturnType<typeof previewSnapshot> | null,
  draft: ReturnType<typeof previewSnapshot>,
) {
  if (!live) return ["new_release"];
  return (["name", "description", "persona", "opening", "appearance", "imageUrl"] as const)
    .filter((key) => JSON.stringify(live[key]) !== JSON.stringify(draft[key]));
}

export async function getCharacterWorkspace(characterId: string) {
  const [character, project, serving] = await Promise.all([
    prisma.character.findUnique({ where: { id: characterId }, include: { imageAsset: true, stats: true } }),
    prisma.characterProject.findFirst({ where: { characterId }, orderBy: { updatedAt: "desc" } }),
    prisma.characterServing.findUnique({ where: { characterId } }),
  ]);
  if (!character || !project) throw Errors.notFound("Character Project not found");
  const releases = await prisma.characterRelease.findMany({
    where: { projectId: project.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const releaseIds = releases.map((release) => release.id);
  const validationRuns = await prisma.releaseValidationRun.findMany({
    where: { releaseId: { in: releaseIds } },
    orderBy: { startedAt: "desc" },
  });
  const latestValidationIds = Array.from(new Set(releaseIds.flatMap((releaseId) => {
    const latest = validationRuns.find((run) => run.releaseId === releaseId);
    return latest ? [latest.id] : [];
  })));
  const [checks, monitors, contents] = await Promise.all([
    prisma.releaseCheckResult.findMany({ where: { validationRunId: { in: latestValidationIds } } }),
    prisma.releaseMonitor.findMany({ where: { releaseId: { in: releaseIds } }, orderBy: { startedAt: "desc" } }),
    prisma.characterContentVersion.findMany({
      where: { characterId },
      orderBy: { version: "desc" },
    }),
  ]);
  const imageUrl = character.imageAsset?.thumbnailUrl ?? character.imageAsset?.url ?? null;
  const currentRelease = releases.find((release) => release.id === serving?.currentReleaseId) ?? null;
  const candidateRelease = releases.find((release) => !["published", "superseded", "withdrawn"].includes(release.status)) ?? null;
  const liveContent = contents.find((content) => content.id === currentRelease?.characterContentVersionId) ?? null;
  const draftContent = contents.find((content) => content.id === candidateRelease?.characterContentVersionId) ?? contents[0] ?? null;
  const live = currentRelease ? previewSnapshot({ character, content: liveContent, releaseId: currentRelease.id, imageUrl, label: "Live" }) : null;
  const draft = previewSnapshot({ character, content: draftContent, releaseId: candidateRelease?.id ?? null, imageUrl, label: "Draft Preview" });
  const portfolio = await listCharacterPortfolioData(prisma, {
    limit: 1,
    search: characterId,
    sort: "project_id_asc",
  });
  const performance = portfolio.items.find((item) => item.characterId === characterId)?.performance ?? [];
  return {
    character: {
      id: character.id,
      name: character.name,
      age: character.age,
      description: character.description,
      gender: character.gender,
      style: character.style,
      visibility: character.visibility,
      legacyStatus: character.status,
      imageUrl,
      updatedAt: character.updatedAt.toISOString(),
    },
    project: projectDto(project),
    serving: servingDto(serving),
    releases: releases.map((release) => {
      const validation = validationRuns.find((run) => run.releaseId === release.id);
      return {
        release: releaseDto(release),
        checks: validation ? checks.filter((check) => check.validationRunId === validation.id).map((check) => ({
          checkKey: check.checkKey,
          result: check.result,
          evidence: record(check.evidence),
          checkedAt: check.checkedAt.toISOString(),
        })) : [],
        monitors: monitors.filter((monitor) => monitor.releaseId === release.id).map((monitor) => ({
          id: monitor.id,
          window: monitor.window,
          status: monitor.status,
          baseline: record(monitor.baseline),
          observed: record(monitor.observed),
          verification: record(monitor.verification),
          startedAt: monitor.startedAt.toISOString(),
          finishedAt: monitor.finishedAt?.toISOString() ?? null,
        })),
      };
    }),
    preview: { live, draft, changedFields: changedFields(live, draft) },
    performance,
  };
}

export async function getCharacterProjectDraftForResume(characterId: string) {
  const [character, project, content] = await Promise.all([
    prisma.character.findUnique({ where: { id: characterId } }),
    prisma.characterProject.findFirst({ where: { characterId }, orderBy: { updatedAt: "desc" } }),
    prisma.characterContentVersion.findFirst({ where: { characterId }, orderBy: { version: "desc" } }),
  ]);
  if (!character || !project || !content) throw Errors.notFound("Character Project draft not found");
  const projectView = projectDto(project);
  const persona = record(content.personaSnapshot);
  const opening = record(content.openingSnapshot);
  const appearance = record(content.appearanceSnapshot);
  return characterProjectDraftResumeSchema.parse({
    authority: {
      characterId,
      projectId: project.id,
      projectVersion: project.version,
      deepLink: `/admin/characters/${characterId}`,
    },
    draft: {
      positioning: {
        audience: projectView.audience,
        companionNeed: projectView.companionNeed,
        hypothesis: projectView.hypothesis,
        differentiation: projectView.differentiation,
      },
      persona: {
        name: text(persona.name) || character.name,
        age: typeof persona.age === "number" ? persona.age : character.age,
        gender: text(persona.gender) || character.gender,
        relationshipArchetype: text(persona.relationshipArchetype) || character.relationship,
        characterPromise: text(persona.characterPromise) || character.description,
        personality: text(persona.personality),
        tone: text(persona.tone),
        backstory: text(persona.backstory),
        firstMessage: text(opening.firstMessage),
        exampleDialogue: strings(persona.exampleDialogue as Prisma.JsonValue | undefined),
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
  readonly phase?: string;
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
  if (input.phase === "retired") {
    throw Errors.conflict("Retirement must use the verified Character retirement command");
  }
  return prisma.$transaction(async (tx) => {
    const project = await tx.characterProject.findFirst({ where: { characterId: input.characterId } });
    if (!project) throw Errors.notFound("Character Project not found");
    const changed = await tx.characterProject.updateMany({
      where: { id: project.id, version: input.expectedVersion },
      data: {
        ...(input.phase ? { phase: input.phase } : {}),
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
        current: projectDto(current),
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
              project: projectDto(updated),
              contentHash: snapshots.contentHash,
            }),
            createdById: input.actor.id,
          },
        });
        await tx.character.updateMany({
          where: { id: input.characterId, status: "draft", visibility: "private" },
          data: {
            name: input.content.persona.name,
            age: input.content.persona.age,
            description: input.content.persona.characterPromise,
            systemPrompt: [
              input.content.persona.personality,
              input.content.persona.tone,
              input.content.persona.backstory,
            ].join("\n\n"),
            style: input.content.visualDirection.style,
            gender: input.content.persona.gender,
            relationship: input.content.persona.relationshipArchetype,
            appearance: toInputJson(snapshots.appearanceSnapshot),
            advancedDetails: toInputJson({ ...snapshots.personaSnapshot, ...snapshots.openingSnapshot }),
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
        before: toInputJson(projectDto(project)),
        after: toInputJson({ project: projectDto(updated), contentVersion, revision }),
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
    return projectDto(updated);
  });
}

export async function refreshCharacterReleaseMonitor(input: {
  readonly characterId: string;
  readonly releaseId: string;
  readonly expectedVersion: number;
  readonly window: "24h" | "72h";
}) {
  const [project, release] = await Promise.all([
    prisma.characterProject.findFirst({ where: { characterId: input.characterId } }),
    prisma.characterRelease.findUnique({ where: { id: input.releaseId } }),
  ]);
  if (!project || !release || release.projectId !== project.id) {
    throw Errors.notFound("Character Release not found");
  }
  if (release.version !== input.expectedVersion) {
    throw Errors.conflict("Character Release changed before monitor refresh", {
      currentVersion: release.version,
    });
  }
  const result = await collectReleaseMonitorFacts(prisma, {
    releaseId: release.id,
    window: input.window,
  });
  return {
    releaseId: release.id,
    window: input.window,
    status: result.monitor.status,
    mature: result.mature,
    recommendation: result.recommendation,
    observed: result.observed,
  };
}
