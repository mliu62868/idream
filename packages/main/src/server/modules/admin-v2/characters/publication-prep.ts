import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "../shared/prisma-json";
import { characterWorkspaceTabLink } from "./character-deep-link";
import { lockCharacterGenerationAuthority } from "./generation-authority-lock";
import { transitionCharacterProject } from "./transition";

export type CustomerCharacterPublicationPrep = {
  state: "publication_prep";
  characterId: string;
  submissionId: string;
  projectId: string;
  revisionId: string;
  projectVersion: number;
  servingState: string;
  deepLink: string;
  created: boolean;
};

/**
 * SPEC: customer public approval opens production authority; it does not publish.
 * INVARIANT: this seam may create Project / Revision / inactive Serving only. A
 * public Release, qualification, asset visibility and live Serving remain owned
 * by the Release publish executor.
 */
export async function ensureCustomerCharacterPublicationPrep(
  tx: Prisma.TransactionClient,
  input: {
    characterId: string;
    submissionId: string;
    actorId: string;
  },
): Promise<CustomerCharacterPublicationPrep | null> {
  const character = await tx.character.findUnique({
    where: { id: input.characterId },
    select: {
      id: true,
      source: true,
      visibility: true,
      status: true,
      currentContentVersionId: true,
    },
  });
  if (!character) throw Errors.notFound("Character not found");
  if (character.source !== "user") return null;
  if (
    character.visibility !== "public" ||
    !["pending_review", "approved"].includes(character.status)
  ) {
    throw Errors.conflict("Customer Character is not eligible for publication preparation");
  }
  if (!character.currentContentVersionId) {
    throw Errors.conflict("Customer Character is missing immutable content authority");
  }
  const submission = await tx.characterSubmission.findFirst({
    where: { id: input.submissionId, characterId: character.id },
    select: { id: true, status: true },
  });
  if (
    !submission ||
    !(
      (character.status === "pending_review" && submission.status === "pending") ||
      (character.status === "approved" && submission.status === "approved")
    )
  ) {
    throw Errors.conflict("Character submission does not match publication-prep review authority");
  }
  const contentVersion = await tx.characterContentVersion.findFirst({
    where: {
      id: character.currentContentVersionId,
      characterId: character.id,
    },
    select: { id: true, version: true, contentHash: true },
  });
  if (!contentVersion) {
    throw Errors.conflict("Customer Character content authority is invalid");
  }

  let project = await tx.characterProject.findFirst({
    where: { characterId: character.id },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  let created = false;
  if (!project) {
    project = await tx.characterProject.create({
      data: {
        characterId: character.id,
        ownerId: null,
        phase: "producing",
        audience: toInputJson({
          audience: "approved customer character",
          companionNeed: "prepare approved customer content for public serving",
          targetPlacementKeys: ["explore", "community"],
          productionPackage: "customer_character_release_v2",
          qaPlan: "character_release_policy_v2",
          source: "customer_submission_review",
          submissionId: input.submissionId,
        }),
        successCriteria: toInputJson([
          "release_asset_pack",
          "release_validation",
          "serving_live",
        ]),
        activeKey: `customer-publication:${character.id}`,
      },
    });
    created = true;
  } else if (project.phase === "retired") {
    throw Errors.conflict("Customer Character Project is retired");
  } else if (["idea", "planned"].includes(project.phase)) {
    project = await transitionCharacterProject(tx, {
      projectId: project.id,
      to: "producing",
    });
    created = true;
  }

  let revision = await tx.characterRevision.findFirst({
    where: {
      projectId: project.id,
      characterContentVersionId: contentVersion.id,
    },
    orderBy: [{ revision: "desc" }, { id: "desc" }],
  });
  if (!revision) {
    const latestRevision = await tx.characterRevision.findFirst({
      where: { projectId: project.id },
      orderBy: [{ revision: "desc" }, { id: "desc" }],
      select: { revision: true },
    });
    revision = await tx.characterRevision.create({
      data: {
        projectId: project.id,
        revision: (latestRevision?.revision ?? 0) + 1,
        characterContentVersionId: contentVersion.id,
        projectSnapshot: toInputJson({
          schemaVersion: "customer-character-publication-prep-v1",
          source: "customer_submission_review",
          submissionId: input.submissionId,
          contentVersion: contentVersion.version,
          contentHash: contentVersion.contentHash,
        }),
        createdById: input.actorId,
      },
    });
    created = true;
  }

  let serving = await tx.characterServing.findUnique({
    where: { characterId: character.id },
  });
  if (!serving) {
    serving = await tx.characterServing.create({
      data: { characterId: character.id, state: "inactive" },
    });
    created = true;
  }
  if (serving.state !== "inactive" || serving.currentReleaseId) {
    throw Errors.conflict("Customer Character Serving authority is inconsistent");
  }

  return {
    state: "publication_prep",
    characterId: character.id,
    submissionId: submission.id,
    projectId: project.id,
    revisionId: revision.id,
    projectVersion: project.version,
    servingState: serving.state,
    deepLink: characterWorkspaceTabLink(character.id, "assets"),
    created,
  };
}

export async function prepareApprovedCustomerCharacterPublication(
  tx: Prisma.TransactionClient,
  input: {
    characterId: string;
    actor: { id: string; role: string };
    requestId: string;
    reason: string;
    submissionId: string;
  },
) {
  await lockCharacterGenerationAuthority(tx, input.characterId);
  const character = await tx.character.findUnique({
    where: { id: input.characterId },
    select: { id: true, source: true, visibility: true, status: true },
  });
  if (!character) throw Errors.notFound("Character not found");
  if (
    character.source !== "user" ||
    character.visibility !== "public" ||
    character.status !== "approved"
  ) {
    throw Errors.conflict("Only an approved public customer Character can enter publication preparation");
  }
  const submission = await tx.characterSubmission.findFirst({
    where: {
      id: input.submissionId,
      characterId: character.id,
      status: "approved",
    },
    select: { id: true },
  });
  if (!submission) {
    throw Errors.conflict("Approved customer Character is missing review authority");
  }
  const publication = await ensureCustomerCharacterPublicationPrep(tx, {
    characterId: character.id,
    submissionId: submission.id,
    actorId: input.actor.id,
  });
  if (!publication) {
    throw Errors.conflict("Customer Character publication preparation was not created");
  }
  if (publication.created) {
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "character.publication_prepared",
        targetType: "character_project",
        targetId: publication.projectId,
        reason: input.reason,
        before: toInputJson({ projectId: null, servingState: null }),
        after: toInputJson(publication),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "admin.customer_character.publication_prepared.v1",
        aggregateType: "character_project",
        aggregateId: publication.projectId,
        payload: toInputJson({
          characterId: character.id,
          submissionId: submission.id,
          actorId: input.actor.id,
          requestId: input.requestId,
          publication,
        }),
      },
    });
  }
  return publication;
}
