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
// 但保留 Release 指针，以便日后重新过审后恢复。

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
  const shouldRebuildPrompt = body.name !== undefined || body.description !== undefined;
  await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, id);
    const existing = await tx.character.findFirst({
      where: { id, creatorId: userId, deletedAt: null },
    });
    if (!existing) throw Errors.notFound("Character not found");
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
          relationship: existing.relationship,
          style: existing.style,
          gender: existing.gender,
          appearance: existing.appearance,
          advancedDetails: existing.advancedDetails,
          immutableContentSnapshot: immutableContentSnapshot ?? undefined,
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
      ...(body.visibility === "public" && existing.imageAssetId
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
    if (body.visibility === "public" && existing.imageAssetId) {
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
      const serving = await tx.characterServing.findUnique({
        where: { characterId: existing.id },
      });
      if (serving?.state === "live") {
        // INVARIANT: private presentation and live Serving authority cannot coexist.
        // Keep the immutable Release pinned so a later reviewed publication can resume it.
        await transitionCharacterServing(tx, {
          servingId: serving.id,
          to: "paused",
          expectedVersion: serving.version,
          expectedCurrentReleaseId: serving.currentReleaseId,
          data: {
            scheduledReleaseId: null,
            scheduledAt: null,
          },
        });
      } else if (serving && (serving.scheduledReleaseId || serving.scheduledAt)) {
        // INVARIANT: a private Character cannot retain a future publish command.
        // Inactive and paused Serving remain non-live; only the mutable schedule is cancelled.
        const cancelled = await tx.characterServing.updateMany({
          where: {
            id: serving.id,
            state: serving.state,
            version: serving.version,
          },
          data: {
            scheduledReleaseId: null,
            scheduledAt: null,
            version: { increment: 1 },
          },
        });
        if (cancelled.count !== 1) {
          throw Errors.conflict("Character Serving changed before privacy update");
        }
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
        status: body.visibility === "public"
          ? "pending_review"
          : body.visibility && existing.status === "pending_review"
            ? "approved"
            : undefined,
      },
    });
    if (body.visibility === "public") {
      const pendingSubmission = await tx.characterSubmission.findFirst({
        where: { characterId: updated.id, status: "pending" },
        orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (!pendingSubmission) {
        await tx.characterSubmission.create({
          data: {
            characterId: updated.id,
            submitterId: userId,
            status: "pending",
          },
        });
      }
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
