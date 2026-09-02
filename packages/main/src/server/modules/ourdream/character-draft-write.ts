import type { CharacterDraft, Prisma } from "@prisma/client";
import { dispatchGenerationAttemptOutbox } from "@/server/modules/generation/generation-attempt-authority";
import { lockCharacterMediaAssetAuthorities } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { canonicalJsonEqual } from "@/server/modules/admin-v2/shared/idempotency";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { isRecord, toInputJson } from "@/server/lib/request-json";
import { moderateText } from "@/server/moderation/text-authority";
import {
  jsonNonBlankString,
  jsonRecord,
  jsonStringArray,
  pruneUndefined,
} from "./json-values";
import { entitlementMap } from "./subscription-lifecycle";
import { dimensionsForImageOrientation } from "./generation-dimensions";
import {
  selectGenerationProfile,
  selectRecipe,
} from "./generation-profile-selection";
import { characterVisualProfileCreateData } from "./generation-character-authority";
import {
  appendGenerationEvent,
  generationWriteRequestFingerprint,
  isUniqueConstraintError,
  reserveInitialGenerationAttempt,
  wakeQueuedGenerationDispatch,
} from "./generation-job-authority";
import { createReferenceSetRevision } from "./generation-reference-set";
import {
  assertIdentityImageMediaInTx,
  assertNonSyntheticMediaAsset,
} from "./customer-media-authority";
import {
  compileUserSoulOrBadRequest,
  materializeUserCharacterContentVersion,
} from "./character-soul";
import { readCurrentCharacterDraftDetails } from "./character-draft-details";
import {
  prepareCharacterDraftVoice,
  bindCharacterDraftVoice,
  cleanupPreparedCharacterDraftVoice,
} from "./character-draft-voice";
import { logger } from "@/server/lib/logger";

// SPEC: 用户侧建角色向导的两个写入动作 —— 生成身份预览图、把草稿提交成 Character。
//
// INTENT: 这两步共享同一份草稿所有权判定，且都是「一个业务动作 = 一个事务」的形状；
// HTTP 只负责鉴权、读 Idempotency-Key 和读 body，其余全在这里。

export async function assertDraftOwner(id: string, userId: string) {
  const draft = await prisma.characterDraft.findFirst({
    where: { id, ownerId: userId },
  });
  if (!draft) throw Errors.notFound("Character draft not found");
  return draft;
}

const PREVIEW_PROMPT_SUFFIX = ". single subject, clear face, identity reference portrait";

function characterPreviewDetails(value: unknown) {
  const details = { ...jsonRecord(value) };
  delete details.voiceSelection;
  return details;
}

function characterPreviewPromptPrefix(draft: CharacterDraft, recipeBody: string) {
  return [
    recipeBody,
    `${draft.style ?? "realistic"} portrait of an adult ${draft.gender ?? "female"} character`,
    draft.name ? `Character name: ${draft.name}` : null,
    `Appearance: ${JSON.stringify(draft.appearance ?? {})}`,
    `Hair: ${JSON.stringify(draft.hair ?? {})}`,
    `Body: ${JSON.stringify(draft.body ?? {})}`,
  ].filter((part): part is string => Boolean(part)).join(". ") + ". Details: ";
}

function characterPreviewPrompt(draft: CharacterDraft, recipeBody: string) {
  return characterPreviewPromptPrefix(draft, recipeBody) +
    JSON.stringify(characterPreviewDetails(draft.advancedDetails)) + PREVIEW_PROMPT_SUFFIX;
}

export async function characterPreviewMatchesDraft(
  draft: CharacterDraft,
  previewJobId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const request = await db.generationJob.findFirst({
    where: { userId: draft.ownerId, sourceType: "character_preview", sourceId: previewJobId },
    select: { prompt: true, recipeId: true, recipeVersion: true },
    orderBy: { createdAt: "desc" },
  });
  if (!request?.recipeId || !request.prompt || request.recipeVersion === null) return false;
  const recipe = await db.generationRecipe.findFirst({
    where: { recipeKey: request.recipeId, version: request.recipeVersion },
    select: { body: true },
  });
  if (!recipe) return false;
  const prefix = characterPreviewPromptPrefix(draft, recipe.body);
  if (!request.prompt.startsWith(prefix) || !request.prompt.endsWith(PREVIEW_PROMPT_SUFFIX)) return false;
  // Existing prompts may contain voiceSelection. Only that nonvisual field is
  // ignored; the pinned recipe, portrait traits and remaining details must match.
  try {
    const details: unknown = JSON.parse(request.prompt.slice(prefix.length, -PREVIEW_PROMPT_SUFFIX.length));
    return isRecord(details) && canonicalJsonEqual(
      characterPreviewDetails(details), characterPreviewDetails(draft.advancedDetails),
    );
  } catch {
    return false;
  }
}

export async function previewCharacterDraft(input: {
  readonly userId: string;
  readonly draftId: string;
  readonly idempotencyKey: string;
}) {
  const { draftId: id, idempotencyKey, userId } = input;
  const draft = await assertDraftOwner(id, userId);
  const requestFingerprint = generationWriteRequestFingerprint(
    "character.preview.create",
    {},
    draft.id,
  );
  const existingReservation = await findCharacterPreviewReservation(
    userId,
    draft.id,
    idempotencyKey,
  );
  if (existingReservation) {
    await wakeQueuedGenerationDispatch(existingReservation.generationJob);
    return { previewJob: existingReservation.previewJob };
  }
  const moderation = await moderateText(
    "character_draft",
    id,
    `${draft.name ?? ""} ${JSON.stringify(draft.advancedDetails)}`,
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Draft failed safety checks", moderation);
  }

  const profile = await selectGenerationProfile({
    mode: "image",
    referenceRequirements: {
      pinnedReferences: [],
      sourceImageAssetId: null,
      lookReferenceAssetId: null,
    },
    catalogScope: "public_text_to_image",
    accessibleEntitlements: await entitlementMap(userId),
  });
  const recipe = await selectRecipe("image", "character");
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  const orientation = allowedOrientations.includes("4:5")
    ? "4:5"
    : (allowedOrientations[0] ?? "4:5");
  const dimensions = dimensionsForImageOrientation({
    orientation,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
  });
  const prompt = characterPreviewPrompt(draft, recipe.body);

  // INVARIANT: Preview business state, Generation Request, first Attempt and
  // dispatch Outbox either all exist or none do. Gen consumes the same formal
  // image envelope as every other image use case.
  let reservation;
  try {
    reservation = await prisma.$transaction(async (tx) => {
      const previewJob = await tx.characterPreviewJob.create({
        data: {
          draftId: id,
          status: "queued",
          provider: profile.runner,
        },
      });
      const generationJob = await tx.generationJob.create({
        data: {
          userId,
          idempotencyKey,
          momentSpec: toInputJson({ requestFingerprint }),
          mode: "image",
          prompt,
          negativePrompt: recipe.negativeBase,
          controls: toInputJson(pruneUndefined({
            width: dimensions.width,
            height: dimensions.height,
            orientation,
            workflowKey: profile.workflowKey ?? undefined,
          })),
          presetIds: toInputJson([]),
          model: profile.workflowKey ?? profile.pipelineModel,
          profileId: profile.profileKey,
          profileVersion: profile.version,
          recipeId: recipe.recipeKey,
          recipeVersion: recipe.version,
          orientation,
          outputCount: 1,
          costDreamcoins: 0,
          provider: profile.runner,
          sourceType: "character_preview",
          sourceId: previewJob.id,
          sourceMeta: toInputJson({
            draftId: id,
            previewJobId: previewJob.id,
          }),
        },
      });
      await appendGenerationEvent(
        tx,
        generationJob.id,
        "created",
        "Character Preview Generation Request accepted",
        { previewJobId: previewJob.id, draftId: id },
      );
      await appendGenerationEvent(
        tx,
        generationJob.id,
        "queued",
        "Character Preview Generation Request queued",
        {},
      );
      const attempt = await reserveInitialGenerationAttempt(tx, generationJob);
      return {
        previewJob,
        outboxId: attempt.outbox.id,
      };
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // A concurrent replay can lose the unique-key race after the first request
    // committed. Resolve that same durable Preview/Generation pair instead of
    // turning a safe retry into a second reservation.
    const replay = await findCharacterPreviewReservation(
      userId,
      draft.id,
      idempotencyKey,
    );
    if (!replay) throw error;
    await wakeQueuedGenerationDispatch(replay.generationJob);
    return { previewJob: replay.previewJob };
  }
  await dispatchGenerationAttemptOutbox(prisma, {
    outboxIds: [reservation.outboxId],
  });
  return { previewJob: reservation.previewJob };
}

async function findCharacterPreviewReservation(
  userId: string,
  draftId: string,
  idempotencyKey: string,
) {
  const generationJob = await prisma.generationJob.findFirst({
    where: { userId, idempotencyKey },
  });
  if (!generationJob) return null;
  if (generationJob.sourceType !== "character_preview" || !generationJob.sourceId) {
    throw Errors.conflict(
      "Idempotency-Key was already used for a different generation request",
      { generationJobId: generationJob.id },
    );
  }
  const previewJob = await prisma.characterPreviewJob.findFirst({
    where: { id: generationJob.sourceId, draftId },
  });
  if (!previewJob) {
    throw Errors.conflict(
      "Idempotency-Key was already used for a different Character Preview request",
      { generationJobId: generationJob.id },
    );
  }
  return { generationJob, previewJob };
}

export async function submitCharacterDraft(input: {
  readonly userId: string;
  readonly draftId: string;
  readonly visibility: "private" | "unlisted" | "public";
}) {
  const { draftId: id, userId } = input;
  const draft = await assertDraftOwner(id, userId);
  if (!draft.name) throw Errors.badRequest("Draft name is required before submit");
  const draftName = draft.name;
  const advancedDetails = readCurrentCharacterDraftDetails(draft.advancedDetails);
  const historicalSubmission = advancedDetails.submittedCharacterId
    ? null
    : await prisma.characterContentVersion.findFirst({
        where: { sourceType: "user", sourceId: draft.id },
        select: { characterId: true },
      });
  const submittedCharacterId =
    advancedDetails.submittedCharacterId ?? historicalSubmission?.characterId;
  if (submittedCharacterId) {
    const existing = await prisma.character.findFirst({
      where: {
        id: submittedCharacterId,
        creatorId: userId,
        deletedAt: null,
      },
    });
    if (!existing) {
      throw Errors.conflict("This draft was submitted but its Character is unavailable");
    }
    return { character: existing };
  }
  const age = advancedDetails.age;
  if (age === undefined) {
    throw Errors.badRequest("Complete the character persona before publishing", {
      missingFields: ["age"],
    });
  }
  const personaDescription = jsonNonBlankString(advancedDetails.description);
  const description = personaDescription ?? "";
  const style = draft.style ?? "realistic";
  const gender = draft.gender ?? "female";
  const missingPersonaFields = requiredCharacterPersonaFields({
    description: personaDescription,
    advancedDetails,
  });
  const storedAdvancedDetails = {
    detailsMarkdown: advancedDetails.detailsMarkdown ?? "",
    firstMessage: jsonNonBlankString(advancedDetails.firstMessage),
  };
  const moderation = await moderateText(
    "character_draft",
    id,
    `${draft.name} ${description} ${JSON.stringify(draft.advancedDetails)}`,
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Character failed safety checks", moderation);
  }
  const selectedPreview = draft.previewJobId
    ? await prisma.characterPreviewJob.findFirst({
        where: {
          id: draft.previewJobId,
          draftId: draft.id,
          status: "completed",
          resultAssetId: { not: null },
        },
      })
    : null;
  if (!selectedPreview?.resultAssetId) {
    throw Errors.badRequest("Choose an identity image before publishing this character");
  }
  const anchorAssetId = selectedPreview.resultAssetId;
  const anchorAsset = await prisma.mediaAsset.findFirst({
    where: {
      id: anchorAssetId,
      ownerId: userId,
      deletedAt: null,
      type: "image",
    },
  });
  if (!anchorAsset) {
    throw Errors.badRequest("The selected identity image is no longer available");
  }
  assertNonSyntheticMediaAsset(
    anchorAsset,
    "Demo preview images cannot be published as a character identity",
  );
  if (missingPersonaFields.length > 0) {
    throw Errors.badRequest("Complete the character persona before publishing", {
      missingFields: missingPersonaFields,
    });
  }
  // The draft stores these groups separately; the permanent Character and its
  // immutable content/Visual Profile consume one complete appearance snapshot.
  const face = draftVisualFields(draft.appearance);
  const hair = { ...draftVisualFields(face.hair ?? null), ...draftVisualFields(draft.hair) };
  const body = { ...draftVisualFields(face.body ?? null), ...draftVisualFields(draft.body) };
  const appearance = {
    ...face,
    ...(Object.keys(hair).length ? { hair } : {}),
    ...(Object.keys(body).length ? { body } : {}),
  };
  const userContent = compileUserSoulOrBadRequest({
    name: draftName,
    age,
    description,
    style,
    gender,
    appearance,
    advancedDetails,
  });
  const characterAdvancedDetails = {
    ...storedAdvancedDetails,
    soulFingerprint: userContent.personaSnapshot.compiled.fingerprint,
    compilerVersion: userContent.personaSnapshot.compiled.compilerVersion,
  };

  const preparedVoice = advancedDetails.voiceSelection
    ? await prepareCharacterDraftVoice({ ...advancedDetails.voiceSelection, userId, draftId: draft.id })
    : null;

  const character = await prisma.$transaction(async (tx) => {
    await lockCharacterMediaAssetAuthorities(tx, [anchorAssetId]);
    const lockedAnchorAsset = await assertIdentityImageMediaInTx(
      tx,
      anchorAssetId,
      userId,
    );
    if (lockedAnchorAsset.characterId !== null) {
      throw Errors.conflict(
        "The selected identity image already belongs to another Character. Choose an unassigned image or clone it first.",
        {
          mediaAssetId: lockedAnchorAsset.id,
          mediaCharacterId: lockedAnchorAsset.characterId,
        },
      );
    }

    const created = await tx.character.create({
      data: {
        creatorId: userId,
        name: draftName,
        age,
        description,
        systemPrompt: userContent.personaSnapshot.compiled.systemPrompt,
        visibility: input.visibility,
        status: input.visibility === "private" ? "approved" : "pending_review",
        style,
        gender,
        imageAssetId: anchorAssetId,
        appearance: toInputJson(appearance),
        advancedDetails: toInputJson(characterAdvancedDetails),
      },
    });

    if (preparedVoice) {
      await bindCharacterDraftVoice(tx, { characterId: created.id, userId, prepared: preparedVoice });
    }

    const contentVersion = await materializeUserCharacterContentVersion({
      tx,
      characterId: created.id,
      sourceId: draft.id,
      createdById: userId,
      content: userContent,
    });
    await tx.character.update({
      where: { id: created.id },
      data: { currentContentVersionId: contentVersion.id },
    });

    const claimedAnchor = await tx.mediaAsset.updateMany({
      where: {
        id: anchorAssetId,
        ownerId: userId,
        deletedAt: null,
        type: "image",
        characterId: null,
      },
      data: { characterId: created.id },
    });
    if (claimedAnchor.count !== 1) {
      throw Errors.conflict(
        "The selected identity image changed while the Character was being created. Review the image and submit again.",
        {
          mediaAssetId: anchorAssetId,
          targetCharacterId: created.id,
        },
      );
    }
    const visualProfile = await tx.characterVisualProfile.create({
      data: characterVisualProfileCreateData({
        characterId: created.id,
        version: 1,
        status: "active",
        style,
        name: draftName,
        age,
        description,
        gender,
        appearance,
        advancedDetails,
        anchorAssetIds: [anchorAssetId],
        createdFrom: "create_preview",
      }),
    });
    await createReferenceSetRevision(
      tx,
      visualProfile,
      "create_preview",
    );
    await tx.characterStats.create({ data: { characterId: created.id } });
    await tx.characterSubmission.create({
      data: {
        characterId: created.id,
        submitterId: userId,
        status: input.visibility === "private" ? "approved" : "pending",
      },
    });
    await tx.characterDraft.update({
      where: { id: draft.id },
      data: {
        advancedDetails: toInputJson({
          ...advancedDetails,
          age,
          submittedCharacterId: created.id,
        }),
      },
    });

    return tx.character.findUniqueOrThrow({ where: { id: created.id } });
  }).catch(async (error) => {
    if (preparedVoice) {
      await cleanupPreparedCharacterDraftVoice(preparedVoice).catch((cleanupError) => {
        logger.error({ err: cleanupError, draftId: draft.id }, "Could not clean up a prepared Character voice after submit failure");
      });
    }
    throw error;
  });

  return { character };
}

function draftVisualFields(value: Prisma.JsonValue): Prisma.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function requiredCharacterPersonaFields(input: {
  description: string | null;
  advancedDetails: Record<string, unknown>;
}) {
  const missingFields: string[] = [];
  if (!input.description) missingFields.push("description");
  if (!jsonNonBlankString(input.advancedDetails.firstMessage)) {
    missingFields.push("firstMessage");
  }
  return missingFields;
}
