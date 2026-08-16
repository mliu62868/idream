import type { Prisma } from "@prisma/client";
import {
  loadLockedLiveEditorialLegacyGenerationAuthority,
  type LegacyCharacterGenerationAuthority,
} from "@/server/modules/generation/attempt-dispatch";
import { dispatchGenerationAttemptOutbox } from "@/server/modules/generation/generation-attempt-authority";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { dreamcoinBalance, postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  generationCostFromAuthority,
  resolveGenerationPricingAuthority,
} from "@/server/lib/generation-pricing";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { isRecord, toInputJson } from "@/server/lib/request-json";
import { jsonStringArray, pruneUndefined } from "./json-values";
import { dimensionsForImageOrientation } from "./generation-dimensions";
import {
  resolveGenerationVisualProfile,
  type resolveGenerationLook,
} from "./generation-character-authority";
import {
  assertGenerationProfileCanDispatchReferences,
  normalizedGenerationReferenceRole,
} from "./generation-profile-selection";
import { publicCharacterAudienceWhere } from "./public-content-audience";
import {
  assertQuoteStillValid,
  generationPlanRouteFingerprint,
  generationPricingFingerprint,
  resolveGenerationPlan,
  type GenerationProfileSelectionAuthority,
} from "./generation-quote";
import { lockUserLedger } from "./subscription-lifecycle";
import {
  buildGenerationPrompt,
  buildMomentSpec,
  defaultImageNegativePrompt,
  imageNegativePrompt,
} from "./generation-prompt";
import { loadLockedGenerationReferenceAuthority } from "./generation-reference-set";
import {
  activeGenerationStatuses,
  appendGenerationEvent,
  assertGenerationJobRequestFingerprint,
  assertGenerationSourceImageAuthorityInTx,
  findExistingGenerationJob,
  isUniqueConstraintError,
  maxInflightJobs,
  reserveInitialGenerationAttempt,
  wakeQueuedGenerationDispatch,
} from "./generation-job-authority";
import type {
  GenerationCreateBody,
  GenerationSource,
} from "./generation-request-schema";

// SPEC: 用户侧「发起一次生成」的完整业务动作 —— 定路线、验报价、锁身份与素材权威、
// 扣币、落 Generation Job、预留首个 Attempt 并唤醒投递。
//
// INTENT: 运营侧的同一个概念（admin-v2/creative/run-create.ts）早就是独立模块、有名字有
// 契约；用户侧却埋在路由文件里，只能经 HTTP 触达。这里消掉那个不对称：入参是已解析的
// 业务参数，出参是 GenerationJob 行，HTTP 解析与状态码留在 service.ts 的薄壳 handler。
//
// INVARIANT: 幂等键 / (sourceType,sourceId) 命中已存在的 Job 时，永远解析到同一行并
// 唤醒它的投递，而不是再建一行 —— 前置快查与 P2002 兜底走同一个 findExistingGenerationJob。

export async function createGenerationJobForUser(
  userId: string,
  body: GenerationCreateBody,
  options: {
    idempotencyKey?: string | null;
    requestFingerprint?: string;
    source?: GenerationSource;
    fallbackToActiveOnStaleVisualProfile?: boolean;
    profileSelectionAuthority?: GenerationProfileSelectionAuthority;
    requireQuoteAuthority?: boolean;
  } = {},
) {
  const preexisting = await findExistingGenerationJob(userId, options);
  if (preexisting) {
    await wakeQueuedGenerationDispatch(preexisting);
    return preexisting;
  }
  if (
    (
      options.profileSelectionAuthority === "public_generator" ||
      options.requireQuoteAuthority
    ) &&
    !body.quoteAuthority
  ) {
    throw Errors.conflict(
      "An exact generation quote is required before submitting.",
    );
  }

  const plan = await resolveGenerationPlan(userId, body, {
    source: options.source,
    fallbackToActiveOnStaleVisualProfile:
      options.fallbackToActiveOnStaleVisualProfile,
    profileSelectionAuthority: options.profileSelectionAuthority,
    // A public write validates route, price, count, orientation, and balance
    // before a legacy Character bootstrap can create any row.
    bootstrapVisualProfile:
      options.profileSelectionAuthority !== "public_generator" &&
      !options.requireQuoteAuthority,
  });
  const {
    character,
    consistencyMode,
    entitlements,
    profile,
    recipe,
    requestedLookReferenceAssetId,
    requestedSourceImageAssetId,
    selectedLook,
    workflowDescriptor,
  } = plan;
  const lookSnapshot = selectedLook ? characterLookSnapshot(selectedLook) : null;
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  const orientation =
    body.orientation ??
    body.controls.orientation ??
    allowedOrientations[0] ??
    "4:5";
  const pricingAuthority = await resolveGenerationPricingAuthority(body.mode);
  const pricingFingerprint = generationPricingFingerprint(pricingAuthority);
  const cost = generationCostFromAuthority(
    pricingAuthority,
    body.outputCount,
    profile.costMultiplier,
  );
  const routeFingerprint = generationPlanRouteFingerprint(plan);
  if (body.quoteAuthority) {
    assertQuoteStillValid(body.quoteAuthority, {
      profileId: profile.profileKey,
      profileVersion: profile.version,
      routeFingerprint,
      pricingFingerprint,
      outputCount: body.outputCount,
      costDreamcoins: cost,
    });
  }
  if (body.outputCount > profile.maxCount) {
    throw Errors.badRequest("Output count exceeds selected model limit", {
      maxCount: profile.maxCount,
      profileId: profile.profileKey,
      profileVersion: profile.version,
    });
  }
  if (!allowedOrientations.includes(orientation)) {
    throw Errors.badRequest(
      "Orientation is unavailable for the selected generation route",
      {
        orientation,
        allowedOrientations,
        profileId: profile.profileKey,
        profileVersion: profile.version,
      },
    );
  }
  const availableBalance = await dreamcoinBalance(userId);
  if (availableBalance < cost) {
    throw Errors.paymentRequired("Insufficient DreamCoins", {
      required: cost,
      available: availableBalance,
    });
  }
  const acceptedQuoteAuthority = body.quoteAuthority
    ? {
        schemaVersion: "generation-quote-authority-v1",
        profileId: profile.profileKey,
        profileVersion: profile.version,
        routeFingerprint,
        pricing: {
          ruleId: pricingAuthority.id,
          ruleKey: pricingAuthority.ruleKey,
          version: pricingAuthority.version,
          effectiveFrom:
            pricingAuthority.effectiveFrom?.toISOString() ?? null,
          fingerprint: pricingFingerprint,
        },
        outputCount: body.outputCount,
        costDreamcoins: cost,
      }
    : null;

  let visualProfile = plan.visualProfile;
  if (
    (
      options.profileSelectionAuthority === "public_generator" ||
      options.requireQuoteAuthority
    ) &&
    body.mode === "image" &&
    character &&
    !visualProfile
  ) {
    visualProfile = await resolveGenerationVisualProfile(
      character,
      body.visualProfileId,
      { bootstrapIfMissing: true },
    );
  }
  const dimensions =
    body.mode === "image"
      ? dimensionsForImageOrientation({
          orientation,
          defaultWidth: profile.defaultWidth,
          defaultHeight: profile.defaultHeight,
        })
      : { width: profile.defaultWidth, height: profile.defaultHeight };
  const momentSpec = buildMomentSpec(
    body,
    options.source,
    options.requestFingerprint,
  );
  const seed = body.seed ?? visualProfile?.defaultSeed ?? null;
  const presetFragment = await resolvePresetPromptFragment(body.controls, userId);
  const prompt = buildGenerationPrompt({
    mode: body.mode,
    character,
    visualProfile,
    consistencyMode,
    userPrompt: body.prompt,
    presetFragment,
    lookFragment: selectedLook ? JSON.stringify(selectedLook.appearanceDelta) : "",
    sourceType: options.source?.sourceType,
  });
  const negativePrompt =
    body.mode === "image"
      ? imageNegativePrompt(
          body.negativePrompt ?? defaultImageNegativePrompt(recipe.negativeBase, options.source?.sourceType),
          visualProfile,
        )
      : (body.negativePrompt ?? null);

  // Create in a tx; if a concurrent writer (or a redelivered chat.image.requested for the
  // same attachment) committed the same idempotencyKey / (sourceType,sourceId) first, the
  // unique constraint throws P2002 — resolve to that existing job rather than a 500 / a
  // spurious chat.image.failed (handled below).
  const runCreateTx = () => prisma.$transaction(async (tx) => {
    let legacyReleaseAuthority:
      LegacyCharacterGenerationAuthority | null = null;
    if (options.source) {
      const existing = await tx.generationJob.findFirst({
        where: { sourceType: options.source.sourceType, sourceId: options.source.sourceId },
      });
      if (existing) {
        assertGenerationJobRequestFingerprint(
          existing,
          options.requestFingerprint,
        );
        const reservation = existing.status === "queued"
          ? await reserveInitialGenerationAttempt(tx, existing)
          : null;
        return {
          job: existing,
          outboxId: reservation?.outbox.id ?? null,
        };
      }
    }
    if (character) {
      await lockCharacterGenerationAuthority(tx, character.id);
      const lockedCharacter = await tx.character.findFirst({
        where: {
          AND: [
            {
              id: character.id,
              deletedAt: null,
              age: { gte: 18 },
              status: "approved",
            },
            body.mode === "video"
              ? publicCharacterAudienceWhere
              : {
                  OR: [
                    { creatorId: userId },
                    publicCharacterAudienceWhere,
                  ],
                },
          ],
        },
        select: { id: true, imageAssetId: true },
      });
      if (!lockedCharacter) {
        throw Errors.conflict(
          "Character changed before generation authority could be reserved",
          { characterId: character.id },
        );
      }
      if (
        body.mode === "video" &&
        lockedCharacter.imageAssetId !== requestedSourceImageAssetId
      ) {
        throw Errors.conflict(
          "Character primary image changed before video authority could be reserved",
          {
            characterId: character.id,
            pinnedSourceImageAssetId: requestedSourceImageAssetId,
            currentSourceImageAssetId: lockedCharacter.imageAssetId,
          },
        );
      }
      if (body.mode === "image") {
        const lockedLegacyReleaseAuthority =
          await loadLockedLiveEditorialLegacyGenerationAuthority(
            tx,
            character.id,
          );
        if (lockedLegacyReleaseAuthority && visualProfile) {
          throw Errors.conflict(
            "Character Release authority changed after generation identity was selected",
            { characterId: character.id },
          );
        }
        if (!lockedLegacyReleaseAuthority && !visualProfile) {
          throw Errors.conflict(
            "Legacy Character generation authority changed before the job could be queued",
            { characterId: character.id },
          );
        }
        legacyReleaseAuthority = lockedLegacyReleaseAuthority;
      }
    }
    const sourceImageAssetId =
      typeof requestedSourceImageAssetId === "string"
        ? requestedSourceImageAssetId
        : null;
    const additionalMediaAssetIds = [
      sourceImageAssetId,
      requestedLookReferenceAssetId,
    ].filter((assetId): assetId is string => Boolean(assetId));
    const referenceAuthority =
      visualProfile && character
        ? await loadLockedGenerationReferenceAuthority(
            tx,
            character.id,
            visualProfile,
            consistencyMode,
            additionalMediaAssetIds,
          )
        : null;
    if (!referenceAuthority) {
      await lockCharacterMediaAssetAuthorities(tx, additionalMediaAssetIds);
    }
    if (sourceImageAssetId) {
      await assertGenerationSourceImageAuthorityInTx(tx, {
        sourceImageAssetId,
        userId,
        characterId: character?.id ?? null,
      });
    }
    const referenceAssetIds =
      referenceAuthority?.referenceAssetIds ?? [];
    const referenceSetRevision = referenceAuthority?.referenceSetRevision ?? null;
    const referenceManifest =
      referenceAuthority?.referenceManifest ?? [];
    if (
      referenceAssetIds.length > 0 ||
      sourceImageAssetId ||
      requestedLookReferenceAssetId
    ) {
      assertGenerationProfileCanDispatchReferences({
        profile,
        workflowDescriptor,
        pinnedReferences: referenceManifest.map((reference) => ({
          assetId: reference.mediaAssetId,
          role: normalizedGenerationReferenceRole(reference.role),
        })),
        sourceImageAssetId,
        lookReferenceAssetId: requestedLookReferenceAssetId,
      });
    }
    if (selectedLook && character && visualProfile) {
      await assertGenerationLookAuthorityInTx(tx, {
        look: selectedLook,
        userId,
        characterId: character.id,
        visualProfileId: visualProfile.id,
      });
    }
    const controls = pruneUndefined({
      ...body.controls,
      orientation,
      model: profile.profileKey,
      profileId: profile.profileKey,
      generationProfileKey: profile.profileKey,
      generationProfileVersion: profile.version,
      workflowKey: workflowDescriptor?.workflowKey,
      workflowVersion: workflowDescriptor?.version,
      width: dimensions.width,
      height: dimensions.height,
      sourceImageAssetId: sourceImageAssetId ?? undefined,
      lookReferenceAssetId: requestedLookReferenceAssetId ?? undefined,
      workflowIdentity: workflowDescriptor?.identity,
      consistencyMode: visualProfile ? consistencyMode : undefined,
      generationQuoteAuthority: acceptedQuoteAuthority ?? undefined,
      legacyReleaseAuthority: legacyReleaseAuthority ?? undefined,
      visualIdentity: visualProfile
        ? {
            visualProfileId: visualProfile.id,
            visualProfileVersion: visualProfile.version,
            consistencyMode,
            referenceAssetIds,
            referenceSetRevisionId: referenceSetRevision?.id,
            referenceManifest,
            anchorAssetIds: referenceAuthority?.anchorAssetIds ?? [],
            seed,
          }
        : undefined,
    });
    await lockUserLedger(tx, userId);
    const balance = await dreamcoinBalance(userId, tx);
    if (balance < cost) {
      throw Errors.paymentRequired("Insufficient dreamcoins", {
        balance,
        cost,
        required: cost,
      });
    }
    const active = await tx.generationJob.count({
      where: { userId, status: { in: activeGenerationStatuses() } },
    });
    const max = maxInflightJobs(entitlements);
    if (active >= max) {
      throw Errors.rateLimited("Too many active generation jobs", { active, max });
    }

    const created = await tx.generationJob.create({
      data: {
        userId,
        characterId: body.characterId,
        visualProfileId: visualProfile?.id,
        visualProfileVersion: visualProfile?.version,
        consistencyMode: visualProfile ? consistencyMode : null,
        seed,
        referenceAssetIds: visualProfile ? toInputJson(referenceAssetIds) : undefined,
        referenceSetRevisionId: referenceSetRevision?.id,
        referenceManifest: referenceSetRevision ? toInputJson(referenceManifest) : undefined,
        momentSpec: toInputJson(momentSpec),
        lookId: selectedLook?.id,
        lookSnapshot: lookSnapshot ? toInputJson(lookSnapshot) : undefined,
        idempotencyKey: options.idempotencyKey,
        mode: body.mode,
        prompt,
        negativePrompt,
        controls: toInputJson(controls),
        presetIds: toInputJson(body.presetIds),
        model: profile.workflowKey ?? profile.pipelineModel,
        profileId: profile.profileKey,
        profileVersion: profile.version,
        recipeId: recipe.recipeKey,
        recipeVersion: recipe.version,
        orientation,
        outputCount: body.outputCount,
        status: "queued",
        costDreamcoins: cost,
        provider: profile.runner,
        sourceType: options.source?.sourceType ?? "generator",
        sourceId: options.source?.sourceId,
        sourceMeta: options.source?.sourceMeta,
      },
    });
    await appendGenerationEvent(tx, created.id, "created", "Generation job accepted", {
      mode: created.mode,
      profileId: created.profileId,
      recipeId: created.recipeId,
      visualProfileId: created.visualProfileId,
      visualProfileVersion: created.visualProfileVersion,
      referenceSetRevisionId: created.referenceSetRevisionId,
      consistencyMode: created.consistencyMode,
      idempotencyKey: options.idempotencyKey ?? null,
      sourceType: created.sourceType,
      sourceId: created.sourceId,
    });
    await postDreamcoinEntry(tx, {
      kind: "generation_spend",
      userId,
      amount: cost,
      sourceId: created.id,
      idempotencyKey: `generation:${created.id}:reserve`,
    });
    await appendGenerationEvent(tx, created.id, "reserved", "Dreamcoins reserved", {
      amount: cost,
    });
    await appendGenerationEvent(tx, created.id, "queued", "Generation job queued", {});
    const reservation = await reserveInitialGenerationAttempt(tx, created);
    return { job: created, outboxId: reservation.outbox.id };
  });

  let reservation: Awaited<ReturnType<typeof runCreateTx>>;
  try {
    reservation = await runCreateTx();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await findExistingGenerationJob(userId, options);
      if (existing) {
        await wakeQueuedGenerationDispatch(existing);
        return existing;
      }
    }
    throw error;
  }
  const job = reservation.job;

  if (job.status !== "queued") return job;
  if (reservation.outboxId) {
    await dispatchGenerationAttemptOutbox(prisma, {
      outboxIds: [reservation.outboxId],
    });
  }
  return job;
}

function characterLookSnapshot(look: {
  readonly id: string;
  readonly label: string;
  readonly visualProfileId: string;
  readonly appearanceDelta: Prisma.JsonValue;
  readonly referenceAssetId: string | null;
}) {
  return {
    schemaVersion: "1",
    lookId: look.id,
    label: look.label,
    visualProfileId: look.visualProfileId,
    appearanceDelta: look.appearanceDelta,
    referenceAssetId: look.referenceAssetId,
    capturedAt: new Date().toISOString(),
  };
}

async function assertGenerationLookAuthorityInTx(
  tx: Prisma.TransactionClient,
  input: {
    readonly look: Awaited<ReturnType<typeof resolveGenerationLook>>;
    readonly userId: string;
    readonly characterId: string;
    readonly visualProfileId: string;
  },
) {
  if (!input.look) return;
  await lockCharacterMediaAssetAuthorities(
    tx,
    input.look.referenceAssetId ? [input.look.referenceAssetId] : [],
  );
  const current = await tx.characterLook.findFirst({
    where: {
      id: input.look.id,
      ownerId: input.userId,
      characterId: input.characterId,
      visualProfileId: input.visualProfileId,
      status: "active",
      updatedAt: input.look.updatedAt,
    },
    include: {
      referenceAsset: {
        select: {
          id: true,
          ownerId: true,
          characterId: true,
          type: true,
          deletedAt: true,
          safetyStatus: true,
          storageKey: true,
          url: true,
          metadata: true,
        },
      },
    },
  });
  if (
    !current ||
    current.referenceAssetId !== input.look.referenceAssetId ||
    (
      current.referenceAssetId &&
      (
        !current.referenceAsset ||
        current.referenceAsset.ownerId !== input.userId ||
        current.referenceAsset.characterId !== input.characterId ||
        current.referenceAsset.type !== "image" ||
        current.referenceAsset.deletedAt !== null ||
        current.referenceAsset.safetyStatus !== "passed" ||
        !isMediaAssetOperationalForAuthority(current.referenceAsset.metadata) ||
        !hasHydratableMediaBlobAuthority(current.referenceAsset)
      )
    )
  ) {
    throw Errors.conflict(
      "Character Look authority changed or became unavailable before generation was pinned",
      {
        lookId: input.look.id,
        referenceAssetId: input.look.referenceAssetId,
      },
    );
  }
}

// SPEC: turn selected mode/background/pose/outfit preset ids into a descriptive prompt fragment.
// INTENT: presets are open to every tier (unlike custom prompt); only built-in or the user's
// own active presets or public community presets resolve, so a stranger's private
// id can't be injected. Empty when none selected.
async function resolvePresetPromptFragment(
  controls: {
    modePresetId?: string;
    backgroundPresetId?: string;
    posePresetId?: string;
    outfitPresetId?: string;
  },
  userId: string,
): Promise<string> {
  const ids = [
    controls.modePresetId,
    controls.backgroundPresetId,
    controls.posePresetId,
    controls.outfitPresetId,
  ].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return "";
  const presets = await prisma.generationPreset.findMany({
    where: {
      id: { in: ids },
      status: "active",
      OR: [
        { scope: "built_in" },
        { scope: "community", visibility: "public" },
        { ownerId: userId },
      ],
    },
  });
  const fragments: string[] = [];
  for (const id of ids) {
    const preset = presets.find((item) => item.id === id);
    if (!preset) continue;
    const values = isRecord(preset.controls)
      ? Object.values(preset.controls)
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .map((value) => value.trim())
      : [];
    fragments.push(values.length ? values.join(", ") : preset.label);
  }
  return fragments.join(", ");
}
