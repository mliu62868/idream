import { randomUUID } from "node:crypto";
import {
  characterProjectCreateResponseSchema,
  type CharacterProjectCreateRequest,
  type CharacterProjectCreateResponse,
} from "@idream/shared/admin";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { characterDraftSnapshots } from "./draft-content";
import { characterWorkspaceLink } from "./character-deep-link";

const CREATE_COMMAND = "character.project.create";

function commandScope(actorId: string) {
  return `${env.APP_ENV}:${actorId}:${CREATE_COMMAND}`;
}

function tagSlug(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
}

async function resolveExisting(input: {
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
}, db: typeof prisma | Prisma.TransactionClient = prisma): Promise<CharacterProjectCreateResponse | null> {
  const existing = await db.controlPlaneCommand.findUnique({
    where: {
      scope_idempotencyKey: {
        scope: commandScope(input.actorId),
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (!existing) return null;
  if (existing.requestHash !== input.requestHash) {
    throw Errors.conflict("Idempotency key was reused with a different Character Project request", {
      commandId: existing.id,
      existingRequestHash: existing.requestHash,
      submittedRequestHash: input.requestHash,
    });
  }
  if (existing.status !== "succeeded" || !existing.result) {
    throw Errors.conflict("The original Character Project request has not completed", {
      commandId: existing.id,
      status: existing.status,
    });
  }
  return characterProjectCreateResponseSchema.parse({
    ...(existing.result as Record<string, unknown>),
    replayed: true,
  });
}

export async function createCharacterProject(input: {
  actor: AdminActor;
  request: CharacterProjectCreateRequest;
  idempotencyKey: string;
  requestId: string;
  legacyTagLabels?: readonly string[];
}): Promise<CharacterProjectCreateResponse> {
  const legacyTagLabels = [...new Set((input.legacyTagLabels ?? []).map((label) => label.trim()).filter(Boolean))];
  const requestHash = canonicalSha256({ commandType: CREATE_COMMAND, payload: input.request, legacyTagLabels });
  const prior = await resolveExisting({
    actorId: input.actor.id,
    idempotencyKey: input.idempotencyKey,
    requestHash,
  });
  if (prior) return prior;

  const characterId = randomUUID();
  const contentVersionId = randomUUID();
  const projectId = randomUUID();
  const revisionId = randomUUID();
  const commandId = randomUUID();
  const { positioning, persona, visualDirection, commercialIntent } = input.request;
  const { personaSnapshot, openingSnapshot, appearanceSnapshot, contentHash } = characterDraftSnapshots({
    persona,
    visualDirection,
  });
  const projectSnapshot = {
    positioning,
    commercialIntent,
    contentHash,
  };
  const response = characterProjectCreateResponseSchema.parse({
    characterId,
    characterContentVersionId: contentVersionId,
    projectId,
    revisionId,
    projectVersion: 1,
    contentVersion: 1,
    deepLink: characterWorkspaceLink(characterId),
    replayed: false,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${`${commandScope(input.actor.id)}:${input.idempotencyKey}`})
        )
      `;
      const existing = await resolveExisting({
        actorId: input.actor.id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      }, tx);
      if (existing) return existing;
      await tx.controlPlaneCommand.create({
        data: {
          id: commandId,
          scope: commandScope(input.actor.id),
          idempotencyKey: input.idempotencyKey,
          commandType: CREATE_COMMAND,
          targetType: "character_project",
          targetId: projectId,
          actorId: input.actor.id,
          requestId: input.requestId,
          requestHash,
          requestPayload: toInputJson(input.request),
          retryMode: "idempotent",
          status: "succeeded",
          result: toInputJson(response),
          finishedAt: new Date(),
        },
      });
      await tx.character.create({
        data: {
          id: characterId,
          name: persona.name,
          age: persona.age,
          description: persona.characterPromise,
          systemPrompt: personaSnapshot.systemPrompt,
          visibility: "private",
          status: "draft",
          source: "official",
          style: visualDirection.style,
          gender: persona.gender,
          relationship: persona.relationshipArchetype,
          appearance: toInputJson(appearanceSnapshot),
          advancedDetails: toInputJson({ ...personaSnapshot, ...openingSnapshot }),
        },
      });
      await tx.characterStats.create({ data: { characterId } });
      for (const label of legacyTagLabels) {
        const slug = tagSlug(label);
        if (!slug) continue;
        const tag = await tx.tag.upsert({
          where: { slug },
          create: { slug, label },
          update: {},
        });
        await tx.characterTag.upsert({
          where: { characterId_tagId: { characterId, tagId: tag.id } },
          create: { characterId, tagId: tag.id },
          update: {},
        });
      }
      await tx.characterContentVersion.create({
        data: {
          id: contentVersionId,
          characterId,
          version: 1,
          contentHash,
          personaSnapshot: toInputJson(personaSnapshot),
          openingSnapshot: toInputJson(openingSnapshot),
          appearanceSnapshot: toInputJson(appearanceSnapshot),
          sourceType: "admin_character_project_create",
          sourceId: projectId,
          createdById: input.actor.id,
        },
      });
      await tx.characterProject.create({
        data: {
          id: projectId,
          characterId,
          ownerId: commercialIntent.ownerId,
          phase: "idea",
          audience: toInputJson({
            audience: positioning.audience,
            companionNeed: positioning.companionNeed,
            targetPlacementKeys: commercialIntent.targetPlacementKeys,
            productionPackage: commercialIntent.productionPackage,
            qaPlan: commercialIntent.qaPlan,
          }),
          hypothesis: positioning.hypothesis,
          differentiation: positioning.differentiation,
          successCriteria: toInputJson(commercialIntent.successCriteria),
          plannedLaunchAt: commercialIntent.plannedLaunchAt ? new Date(commercialIntent.plannedLaunchAt) : null,
          activeKey: `official:${characterId}`,
        },
      });
      await tx.characterServing.create({
        data: {
          characterId,
          state: "inactive",
        },
      });
      await tx.characterRevision.create({
        data: {
          id: revisionId,
          projectId,
          revision: 1,
          characterContentVersionId: contentVersionId,
          projectSnapshot: toInputJson(projectSnapshot),
          createdById: input.actor.id,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: "character.project.created",
          targetType: "character_project",
          targetId: projectId,
          reason: input.request.reason.summary,
          after: toInputJson({ ...response, requestHash, reason: input.request.reason }),
          requestId: input.requestId,
        },
      });
      await tx.adminCollaborationActivity.create({
        data: {
          targetType: "character_project",
          targetId: projectId,
          kind: "status_change",
          actorId: input.actor.id,
          body: "Created the server-authoritative Character Project draft",
          metadata: toInputJson({
            from: null,
            to: "idea",
            characterId,
            characterContentVersionId: contentVersionId,
            revisionId,
            requestHash,
          }),
          idempotencyKey: `character_project_create:${input.idempotencyKey}`,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "character.project.created.v2",
          aggregateType: "character_project",
          aggregateId: projectId,
          payload: toInputJson({
            projectId,
            characterId,
            characterContentVersionId: contentVersionId,
            revisionId,
            projectVersion: 1,
            contentVersion: 1,
            actorId: input.actor.id,
            requestHash,
          }),
        },
      });
      return response;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await resolveExisting({
        actorId: input.actor.id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      });
      if (raced) return raced;
      throw Errors.conflict("Character Project idempotency evidence conflicts with an existing write");
    }
    throw error;
  }
}
