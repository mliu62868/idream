import { characterDraftImageSelectionResultSchema } from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { inTransaction } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { characterWorkspaceTabLink } from "./character-deep-link";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "./generation-authority-lock";
import { resolveSelectableCharacterImage } from "./image-qualification";

type CharacterAssetPurpose =
  | "character_cover"
  | "character_hero"
  | "character_chat";

type DraftAssetEntry = {
  assetId: string;
  runId?: string;
  itemId?: string;
  reviewDecisionId?: string;
  generationJobId?: string;
  generationRouteFingerprint?: string;
  bootstrapIdentity?: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function draftAssetEntries(
  value: Prisma.JsonValue,
): Partial<Record<CharacterAssetPurpose, DraftAssetEntry>> {
  const source = record(value);
  return Object.fromEntries(
    (["character_cover", "character_hero", "character_chat"] as const).flatMap(
      (purpose) => {
        const raw = source[purpose];
        if (typeof raw === "string") return [[purpose, { assetId: raw }]];
        const entry = record(raw);
        if (typeof entry.assetId !== "string") return [];
        return [[purpose, {
          assetId: entry.assetId,
          ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
          ...(typeof entry.itemId === "string" ? { itemId: entry.itemId } : {}),
          ...(typeof entry.reviewDecisionId === "string"
            ? { reviewDecisionId: entry.reviewDecisionId }
            : {}),
          ...(typeof entry.generationJobId === "string"
            ? { generationJobId: entry.generationJobId }
            : {}),
          ...(typeof entry.generationRouteFingerprint === "string"
            ? { generationRouteFingerprint: entry.generationRouteFingerprint }
            : {}),
          ...(entry.bootstrapIdentity === true
            ? { bootstrapIdentity: true }
            : {}),
        }]];
      },
    ),
  );
}

function draftAssetIds(value: Prisma.JsonValue) {
  return Object.fromEntries(
    Object.entries(draftAssetEntries(value)).map(([purpose, entry]) => [
      purpose,
      entry.assetId,
    ]),
  );
}

/**
 * SPEC: 运营位可直接采用来源完整且通过基础自动检查的角色图片。
 * INTENT: 选择动作不接收客户端创造的资格；Main 重新校验素材可用性，上传与生成各自保留
 *         独立来源事实，再把精确 authority pin 进草稿供 Preview / Release 使用。
 */
export async function selectCharacterDraftImage(
  input: {
    readonly characterId: string;
    readonly expectedProjectVersion: number;
    readonly purpose: CharacterAssetPurpose;
    readonly assetId: string;
    readonly runId?: string;
    readonly itemId?: string;
    readonly reviewDecisionId?: string;
    readonly actor: AdminActor;
    readonly reason: string;
    readonly requestId: string;
  },
  db?: Prisma.TransactionClient,
) {
  const execute = async (tx: Prisma.TransactionClient) => {
    await lockCharacterGenerationAuthority(tx, input.characterId);
    await lockCharacterMediaAssetAuthorities(tx, [input.assetId]);

    const project = await tx.characterProject.findFirst({
      where: { characterId: input.characterId },
      orderBy: { updatedAt: "desc" },
    });
    if (!project) throw Errors.notFound("Character Project not found");
    if (project.version !== input.expectedProjectVersion) {
      throw Errors.conflict(
        "Character Project changed before the image placement was selected",
        { currentVersion: project.version },
      );
    }
    const activeRelease = await tx.characterRelease.findFirst({
      where: {
        projectId: project.id,
        status: "approved",
      },
      select: { id: true, status: true },
    });
    if (activeRelease) {
      throw Errors.conflict(
        "The active Character Release already pins an immutable image set",
        {
          releaseId: activeRelease.id,
          status: activeRelease.status,
          deepLink: characterWorkspaceTabLink(input.characterId, "release"),
        },
      );
    }

    const selection = await resolveSelectableCharacterImage(tx, {
      characterId: input.characterId,
      assetId: input.assetId,
      purpose: input.purpose,
      assertedRunId: input.runId,
      assertedItemId: input.itemId,
      assertedReviewDecisionId: input.reviewDecisionId,
    });
    const asset = selection.asset;
    const nextEntry: DraftAssetEntry = selection.entry;
    const currentAssetPack = draftAssetEntries(project.draftAssetPack);
    const duplicatePurpose = Object.entries(currentAssetPack).find(
      ([purpose, entry]) =>
        purpose !== input.purpose && entry.assetId === asset.id,
    )?.[0];
    if (duplicatePurpose) {
      throw Errors.conflict(
        "Each Character placement must use a different image",
        { duplicatePurpose, assetId: asset.id },
      );
    }
    const nextAssetPack = {
      ...currentAssetPack,
      [input.purpose]: nextEntry,
    };
    const changed = await tx.characterProject.updateMany({
      where: { id: project.id, version: project.version },
      data: {
        draftImageAssetId:
          input.purpose === "character_cover"
            ? asset.id
            : project.draftImageAssetId,
        draftAssetPack: toInputJson(nextAssetPack),
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      throw Errors.conflict(
        "Character Project changed during image placement selection",
      );
    }
    const updated = await tx.characterProject.findUniqueOrThrow({
      where: { id: project.id },
    });

    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "character.project.image_placement_selected",
        targetType: "character_project",
        targetId: project.id,
        reason: input.reason,
        before: toInputJson({
          draftImageAssetId: project.draftImageAssetId,
          draftAssetPack: draftAssetIds(project.draftAssetPack),
          version: project.version,
        }),
        after: toInputJson({
          draftImageAssetId: updated.draftImageAssetId,
          draftAssetPack: draftAssetIds(updated.draftAssetPack),
          selectedPurpose: input.purpose,
          assetId: asset.id,
          version: updated.version,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "character.project.draft_image_selected.v2",
        aggregateType: "character_project",
        aggregateId: project.id,
        payload: toInputJson({
          characterId: input.characterId,
          projectId: project.id,
          projectVersion: updated.version,
          assetId: asset.id,
          purpose: input.purpose,
        }),
      },
    });

    return characterDraftImageSelectionResultSchema.parse({
      characterId: input.characterId,
      projectVersion: updated.version,
      selectedPurpose: input.purpose,
      selectedAssetId: asset.id,
      draftImageAssetId: updated.draftImageAssetId,
      draftAssetPack: draftAssetIds(updated.draftAssetPack),
      deepLink: characterWorkspaceTabLink(input.characterId, "preview"),
    });
  };
  return inTransaction(db, execute);
}
