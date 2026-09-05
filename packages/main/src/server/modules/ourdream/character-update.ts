import { ensureCustomerCharacterPublicationPrep } from "@/server/modules/admin-v2/characters/publication-prep";
import { moderateText } from "@/server/moderation/text-authority";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { transitionCharacterServing } from "@/server/modules/admin-v2/characters/transition";
import { jsonStringArray } from "./json-values";
import { assertCharacterIdentityAuthorityMutable } from "./generation-character-authority";
import { assertNonSyntheticMediaAsset } from "./customer-media-authority";
import { createActiveCharacterVisualProfileVersion } from "./generation-reference-set";
import {
  compileUserSoulOrBadRequest,
  loadCurrentCharacterContentSnapshot,
  materializeUserCharacterContentVersion,
} from "./character-soul";

// SPEC: 创作者改自己 Character 的名字 / 简介 / 可见性。
//
// INVARIANT: 名字或简介一变就意味着人设重编译 —— 追加一版不可变 content version，
// 并滚一版 CharacterVisualProfile，绝不原地改写既有版本。
// INVARIANT: private 与 live Serving 不能共存；转私有时暂停 Serving 并清掉排程发布，
// 但保留 Release 指针，以便日后显式恢复发布。

export async function updateCharacterForUser(input: {
  readonly userId: string;
  readonly characterId: string;
  readonly patch: {
    readonly name?: string;
    readonly description?: string;
    readonly visibility?: "private" | "unlisted" | "public";
  };
}) {
  const { characterId: id, patch: body, userId } = input;
  // A direct link shares the same publication authority as a directory listing.
  const requestsSharing = body.visibility === "public" || body.visibility === "unlisted";
  const shouldRebuildPrompt = body.name !== undefined || body.description !== undefined;
  await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, id);
    const existing = await tx.character.findFirst({
      where: { id, creatorId: userId, deletedAt: null },
    });
    if (!existing) throw Errors.notFound("Character not found");
    if (existing.age < 18) throw Errors.badRequest("Characters must be at least 18 years old");
    if (requestsSharing && ["rejected", "removed"].includes(existing.status)) {
      throw Errors.forbidden("This Character is unavailable for sharing. Resolve its report or appeal first.");
    }
    if (shouldRebuildPrompt || requestsSharing) {
      const moderation = await moderateText("character", id,
        `${body.name ?? existing.name} ${body.description ?? existing.description} ${JSON.stringify(existing.advancedDetails)}`, "input");
      if (moderation.status === "blocked") throw Errors.forbidden("Character failed safety checks", moderation);
    }
    const serving = body.visibility
      ? await tx.characterServing.findUnique({ where: { characterId: id }, include: { currentRelease: true } })
      : null;
    // An already published shared Character only changes its listing preference.
    // Sharing after withdrawal returns to publication preparation.
    const listingChange = requestsSharing && !shouldRebuildPrompt &&
      ["public", "unlisted"].includes(existing.visibility) && existing.status === "approved" &&
      serving?.state === "live" && serving.currentRelease?.status === "published";
    const requiresPublication = requestsSharing && !listingChange;
    const nextName = body.name ?? existing.name;
    const nextDescription = body.description ?? existing.description;
    const immutableContentSnapshot = shouldRebuildPrompt
      ? await loadCurrentCharacterContentSnapshot(
          tx,
          existing.id,
          existing.currentContentVersionId,
        )
      : null;
    const userContent = shouldRebuildPrompt
      ? compileUserSoulOrBadRequest({
          name: nextName,
          age: existing.age,
          description: nextDescription,
          style: existing.style,
          gender: existing.gender,
          appearance: existing.appearance,
          advancedDetails: existing.advancedDetails,
          immutableContentSnapshot: immutableContentSnapshot ?? undefined,
          immutableSoulOverrides: {
            ...(body.name !== undefined ? { name: nextName } : {}),
            ...(body.description !== undefined
              ? { characterPromise: nextDescription }
              : {}),
          },
        })
      : null;
    const activeProfile = shouldRebuildPrompt
      ? await tx.characterVisualProfile.findFirst({
          where: { characterId: id, status: "active" },
          orderBy: { version: "desc" },
          include: {
            referenceSetRevisions: {
              where: { status: "active" },
              orderBy: { revision: "desc" },
              take: 1,
              select: { references: { select: { mediaAssetId: true } } },
            },
          },
        })
      : null;
    await lockCharacterMediaAssetAuthorities(tx, [
      ...(requestsSharing && existing.imageAssetId
        ? [existing.imageAssetId]
        : []),
      // anchorAssetIds 是候选图池仍要锁；参考集本身取 active Reference Set，不读影子副本。
      ...jsonStringArray(activeProfile?.anchorAssetIds),
      ...(activeProfile?.referenceSetRevisions[0]?.references
        .map((reference) => reference.mediaAssetId) ?? []),
    ]);
    if (shouldRebuildPrompt) {
      await assertCharacterIdentityAuthorityMutable(tx, id);
    }
    if (requestsSharing && existing.imageAssetId) {
      const imageAsset = await tx.mediaAsset.findFirst({
        where: {
          id: existing.imageAssetId,
          deletedAt: null,
          type: "image",
        },
        select: {
          id: true,
          characterId: true,
          safetyStatus: true,
          metadata: true,
        },
      });
      if (
        !imageAsset ||
        imageAsset.characterId !== id ||
        imageAsset.safetyStatus !== "passed" ||
        !isMediaAssetOperationalForAuthority(imageAsset.metadata)
      ) {
        throw Errors.badRequest("The character identity image is no longer available");
      }
      assertNonSyntheticMediaAsset(
        imageAsset,
        "Synthetic media cannot be published as a character identity",
      );
    }
    const contentVersion = userContent
      ? await materializeUserCharacterContentVersion({
          tx,
          characterId: existing.id,
          sourceId: existing.id,
          createdById: userId,
          content: userContent,
        })
      : null;
    if (body.visibility === "private") {
      if (serving?.state === "live") {
        // INVARIANT: private presentation and live Serving authority cannot coexist.
        // Keep the immutable Release pinned so an explicit publication can resume it.
        await transitionCharacterServing(tx, {
          servingId: serving.id,
          to: "paused",
          expectedVersion: serving.version,
          expectedCurrentReleaseId: serving.currentReleaseId,
          data: {},
        });
      }
    }
    const updated = await tx.character.update({
      where: { id: existing.id },
      data: {
        name: body.name,
        description: body.description,
        systemPrompt: userContent?.personaSnapshot.compiled.systemPrompt,
        currentContentVersionId: contentVersion?.id,
        visibility: body.visibility,
        status: requiresPublication
          ? "approved"
          : body.visibility && existing.status === "pending_review"
            ? "approved"
            : undefined,
      },
    });
    if (requiresPublication) {
      // 自动检查完成后直接准备发布；不创建人工待审任务。
      await tx.characterSubmission.updateMany({
        where: { characterId: updated.id, status: "pending" },
        data: { status: "approved", reviewReason: "automatic_checks_passed" },
      });
      const accepted = !shouldRebuildPrompt ? await tx.characterSubmission.findFirst({
        where: { characterId: updated.id, status: "approved" },
        orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      }) : null;
      const submission = accepted ?? await tx.characterSubmission.create({
        data: { characterId: updated.id, submitterId: userId, status: "approved", reviewReason: "automatic_checks_passed" },
      });
      await ensureCustomerCharacterPublicationPrep(tx, {
        characterId: updated.id, submissionId: submission.id, actorId: userId,
      });
    } else if (body.visibility && existing.status === "pending_review") {
      await tx.characterSubmission.updateMany({
        where: { characterId: updated.id, status: "pending" },
        data: {
          status: "rejected",
          reviewReason: "withdrawn_by_submitter",
          reviewedAt: new Date(),
        },
      });
    }
    if (shouldRebuildPrompt) {
      await createActiveCharacterVisualProfileVersion(tx, updated, {
        createdFrom: "character_update",
      });
    }
  });
}
