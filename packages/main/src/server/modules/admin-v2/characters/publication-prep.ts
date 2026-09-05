import { loadCharacterSoulSnapshot } from "@idream/shared/chat/persona";
import { hasHydratableMediaBlobAuthority } from "@/server/lib/media-asset-authority";
import { moderateText } from "@/server/moderation/text-authority";
import { assertIdentityImageMediaInTx } from "@/server/modules/ourdream/customer-media-authority";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "../shared/prisma-json";
import { characterWorkspaceTabLink } from "./character-deep-link";
import { lockCharacterGenerationAuthority, lockCharacterMediaAssetAuthorities } from "./generation-authority-lock";

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
 * SPEC: public or unlisted sharing opens production authority; it does not publish.
 * INVARIANT: new sharing creates inactive Serving; sharing after withdrawal
 * retains the paused Release. Qualification, asset visibility and live Serving
 * remain owned by the Release publish/resume executor.
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
    !["public", "unlisted"].includes(character.visibility) ||
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
    throw Errors.conflict("Character submission does not match publication preparation");
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
        activeKey: `customer-publication:${character.id}`,
      },
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
          source: "customer_submission",
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
  const pausedRelease = serving.state === "paused" && serving.currentReleaseId
    ? await tx.characterRelease.findFirst({
        where: {
          id: serving.currentReleaseId,
          projectId: project.id,
          status: "published",
          publishedAt: { not: null },
        },
        select: { id: true },
      })
    : null;
  if (!((serving.state === "inactive" && !serving.currentReleaseId) || pausedRelease)) {
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
    select: { id: true, source: true, visibility: true, status: true, age: true, creatorId: true, imageAssetId: true, currentContentVersionId: true, name: true, description: true, advancedDetails: true, deletedAt: true },
  });
  if (!character) throw Errors.notFound("Character not found");
  if (
    character.source !== "user" ||
    !["public", "unlisted"].includes(character.visibility) ||
    !["approved", "pending_review"].includes(character.status) ||
    character.deletedAt !== null ||
    !character.creatorId
  ) {
    throw Errors.conflict("Only a shared customer Character can enter publication preparation");
  }
  const submission = await tx.characterSubmission.findFirst({
    where: {
      id: input.submissionId,
      characterId: character.id,
      status: character.status === "pending_review" ? "pending" : "approved",
      submitterId: character.creatorId,
    },
    select: { id: true },
  });
  if (!submission) {
    throw Errors.conflict("Customer Character is missing matching submission authority");
  }
  const recoveredPending = character.status === "pending_review";
  if (recoveredPending) {
    // Historical submissions use the same automatic checks as new shared characters.
    // All state changes remain in this transaction; no human review is fabricated.
    if (character.age < 18) throw Errors.badRequest("Characters must be at least 18 years old");
    const content = character.currentContentVersionId
      ? await tx.characterContentVersion.findFirst({ where: { id: character.currentContentVersionId, characterId: character.id } })
      : null;
    if (!content) throw Errors.conflict("Customer Character is missing immutable content authority");
    const soul = loadCharacterSoulSnapshot(content.personaSnapshot);
    if (!soul.ok || soul.snapshot.soul.age < 18) throw Errors.badRequest("Character Soul must describe an adult");
    if (!character.imageAssetId) throw Errors.badRequest("The character identity image is missing");
    await lockCharacterMediaAssetAuthorities(tx, [character.imageAssetId]);
    const image = await assertIdentityImageMediaInTx(tx, character.imageAssetId, character.creatorId);
    if (image.characterId !== character.id) throw Errors.badRequest("The identity image belongs to another character");
    if (!hasHydratableMediaBlobAuthority(image)) throw Errors.badRequest("The identity image has no available media source");
    const moderation = await moderateText("character", character.id, JSON.stringify({
      name: character.name, description: character.description, details: character.advancedDetails,
      soul: soul.snapshot.soul, opening: content.openingSnapshot, appearance: content.appearanceSnapshot,
    }), "publication_preparation");
    if (moderation.status === "blocked") throw Errors.forbidden("Character failed safety checks", moderation);
    await tx.character.update({ where: { id: character.id }, data: { status: "approved" } });
    await tx.characterSubmission.update({ where: { id: submission.id }, data: {
      status: "approved", reviewerId: null, reviewedAt: null, reviewReason: null,
    } });
  }
  const publication = await ensureCustomerCharacterPublicationPrep(tx, {
    characterId: character.id,
    submissionId: submission.id,
    actorId: input.actor.id,
  });
  if (!publication) {
    throw Errors.conflict("Customer Character publication preparation was not created");
  }
  if (publication.created || recoveredPending) {
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "character.publication_prepared",
        targetType: "character_project",
        targetId: publication.projectId,
        reason: input.reason,
        before: toInputJson({ characterStatus: character.status, submissionStatus: recoveredPending ? "pending" : "approved" }),
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
