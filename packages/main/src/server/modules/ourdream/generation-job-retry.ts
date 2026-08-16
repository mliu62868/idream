import type { Prisma, GenerationJob as GenerationJobRow } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  assertPinnedLegacyCharacterGenerationAuthority,
  legacyCharacterGenerationAuthorityFromControls,
} from "@/server/modules/generation/attempt-dispatch";
import { dispatchGenerationAttemptOutbox } from "@/server/modules/generation/generation-attempt-authority";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import { isProductionLtxVideoProfile } from "@/server/modules/generation/production-video-profile";
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
import { toInputJson } from "@/server/lib/request-json";
import {
  jsonRecord,
  jsonStringArray,
  numberFromRecord,
  pruneUndefined,
  stringFromRecord,
} from "./json-values";
import { entitlementMap, lockUserLedger } from "./subscription-lifecycle";
import { publicCharacterAudienceWhere } from "./public-content-audience";
import { isExecutableGenerationProfile } from "./generation-profile-catalog";
import {
  assertGenerationProfileCanDispatchReferences,
  generationRequirementsFromManifest,
  selectGenerationProfile,
} from "./generation-profile-selection";
import {
  assertQuoteStillValid,
  generationPricingFingerprint,
} from "./generation-quote";
import type { GenerationQuoteAuthority } from "./generation-quote-contract";
import {
  activeGenerationStatuses,
  appendGenerationEvent,
  assertGenerationSourceImageAuthorityInTx,
  maxInflightJobs,
  reserveInitialGenerationAttempt,
  wakeQueuedGenerationDispatch,
} from "./generation-job-authority";
import {
  generationJobInclude,
  type GenerationJobWithRelations,
} from "./generation-job-read-model";

// SPEC: 用户侧「重试一次失败的生成」的完整业务动作。
//
// INTENT: 重试和下单是同一条 fail-closed 协议的两个入口 —— 报价令牌、余额、在飞上限、
// 素材权威全都要重新校验；差别只在路线指纹来自被重试的那一行，而不是一份新计划。
//
// INVARIANT: 重试永远新建一行 Job（derivedFromJobId 指回去），不复用、不改写原行；
// 同一个 Idempotency-Key 第二次到达时解析回同一行重试，且必须仍指向同一个源 Job。

type RetryableGenerationJob = GenerationJobRow & { mode: "image" | "video" };

function assertGenerationJobIsRetryable(
  job: GenerationJobRow,
): asserts job is RetryableGenerationJob {
  if (job.status === "blocked") {
    throw Errors.forbidden("Blocked generation jobs cannot be retried");
  }
  if (job.status !== "failed") {
    throw Errors.badRequest("Only failed generation jobs can be retried");
  }
  if (job.mode !== "image" && job.mode !== "video") {
    throw Errors.badRequest("Unsupported generation mode");
  }
}

// SPEC: 重试的第一段 —— 在读请求 body 之前就判定「这次是重放，还是一次新的重试」。
// INTENT: 重放请求不需要（也不该被要求）带新的报价令牌。旧实现正是靠「先查重放、
// 后读 body」拿到这个顺序；拆成两段时必须原样保住，否则重放会因为缺报价被 409。
export async function resolveGenerationRetryTarget(input: {
  readonly userId: string;
  readonly generationJobId: string;
  readonly idempotencyKey: string;
}): Promise<
  | { readonly kind: "replay"; readonly job: GenerationJobWithRelations }
  | { readonly kind: "retryable"; readonly job: RetryableGenerationJob }
> {
  const job = await prisma.generationJob.findFirst({
    where: { id: input.generationJobId, userId: input.userId },
  });
  if (!job) throw Errors.notFound("Generation job not found");
  const replay = await prisma.generationJob.findFirst({
    where: {
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (replay) {
    if (replay.derivedFromJobId !== job.id) {
      throw Errors.conflict(
        "Idempotency-Key was already used for a different generation request",
      );
    }
    const existing = await prisma.generationJob.findUniqueOrThrow({
      where: { id: replay.id },
      include: generationJobInclude(),
    });
    await wakeQueuedGenerationDispatch(existing);
    return { kind: "replay", job: existing };
  }
  assertGenerationJobIsRetryable(job);
  return { kind: "retryable", job };
}

// SPEC: 重试报价 —— 重算一次权威，投影成客户端提交前要回传的那份令牌事实。
// INVARIANT: 报价不落库、不预留额度；它的权威性由 retryGenerationJobForUser 里
// 同源重算的 assertQuoteStillValid 兑现。
export async function quoteGenerationRetry(input: {
  readonly userId: string;
  readonly generationJobId: string;
}) {
  const job = await prisma.generationJob.findFirst({
    where: { id: input.generationJobId, userId: input.userId },
  });
  if (!job) throw Errors.notFound("Generation job not found");
  assertGenerationJobIsRetryable(job);
  const authority = await resolveGenerationRetryAuthority(input.userId, job);
  const balance = await dreamcoinBalance(input.userId);
  return {
    quote: {
      mode: job.mode,
      generationJobId: job.id,
      profileId: authority.profile.profileKey,
      profileVersion: authority.profile.version,
      routeFingerprint: authority.routeFingerprint,
      pricing: {
        ruleId: authority.pricingAuthority.id,
        ruleKey: authority.pricingAuthority.ruleKey,
        version: authority.pricingAuthority.version,
        effectiveFrom:
          authority.pricingAuthority.effectiveFrom?.toISOString() ?? null,
        fingerprint: authority.pricingFingerprint,
      },
      outputCount: job.outputCount,
      costDreamcoins: authority.cost,
      balance,
    },
  };
}

async function resolveGenerationRetryAuthority(
  userId: string,
  job: RetryableGenerationJob,
) {
  const entitlements = await entitlementMap(userId);
  const controls = jsonRecord(job.controls);
  const retrySourceImageAssetId = stringFromRecord(
    controls,
    "sourceImageAssetId",
  );
  const retryLookReferenceAssetId =
    stringFromRecord(controls, "lookReferenceAssetId") ??
    stringFromRecord(jsonRecord(job.lookSnapshot), "referenceAssetId");
  const retryPinnedReferences = generationRequirementsFromManifest(
    job.referenceManifest,
  );
  const retryReferenceRequirements =
    job.mode === "image"
      ? {
          pinnedReferences: retryPinnedReferences,
          sourceImageAssetId: retrySourceImageAssetId ?? null,
          lookReferenceAssetId: retryLookReferenceAssetId ?? null,
        }
      : undefined;
  const exactProfiles =
    job.profileId && job.profileVersion !== null
      ? await prisma.generationModelProfile.findMany({
          where: {
            mode: job.mode,
            version: job.profileVersion,
            status: "active",
            enabled: true,
            OR: [
              { profileKey: job.profileId },
              { id: job.profileId },
            ],
          },
          take: 2,
        })
      : [];
  const exactProfile =
    exactProfiles.find(
      (candidate) => candidate.profileKey === job.profileId,
    ) ?? exactProfiles[0];
  const profile =
    exactProfile &&
    isExecutableGenerationProfile(exactProfile) &&
    (job.mode !== "video" || isProductionLtxVideoProfile(exactProfile))
    ? exactProfile
    : generationJobRequiresPinnedLegacyAuthority(job) &&
        !job.profileId &&
        job.profileVersion === null
      ? await selectGenerationProfile({
          mode: job.mode,
          requested: job.model ?? undefined,
          referenceRequirements: retryReferenceRequirements,
          accessibleEntitlements: entitlements,
        })
      : null;
  if (!profile) {
    throw Errors.conflict(
      "The failed generation job's pinned profile version is unavailable",
      {
        generationJobId: job.id,
        pinnedProfileId: job.profileId,
        pinnedProfileVersion: job.profileVersion,
        resolvedProfileId: null,
        resolvedProfileVersion: null,
      },
    );
  }
  if (generationJobRequiresPinnedLegacyAuthority(job)) {
    await prisma.$transaction((tx) =>
      assertPinnedLegacyCharacterGenerationAuthority(tx, {
        generationJobId: job.id,
        characterId: job.characterId!,
        controls: job.controls,
      })
    );
  }
  const workflowDescriptor = await generationWorkflowDescriptor(
    profile.workflowKey ?? profile.pipelineModel,
  );
  const pinnedWorkflowKey = stringFromRecord(controls, "workflowKey");
  const pinnedWorkflowVersion = numberFromRecord(
    controls,
    "workflowVersion",
  );
  if (
    (
      pinnedWorkflowKey !== undefined ||
      pinnedWorkflowVersion !== undefined
    ) &&
    (
      pinnedWorkflowKey !== workflowDescriptor?.workflowKey ||
      pinnedWorkflowVersion !== workflowDescriptor?.version
    )
  ) {
    throw Errors.conflict(
      "The failed generation job's pinned workflow version is unavailable",
      {
        generationJobId: job.id,
        pinnedWorkflowKey: pinnedWorkflowKey ?? null,
        pinnedWorkflowVersion: pinnedWorkflowVersion ?? null,
        resolvedWorkflowKey: workflowDescriptor?.workflowKey ?? null,
        resolvedWorkflowVersion: workflowDescriptor?.version ?? null,
      },
    );
  }
  if (
    job.mode === "image" &&
    (
      retryPinnedReferences.length > 0 ||
      retrySourceImageAssetId ||
      retryLookReferenceAssetId
    )
  ) {
    assertGenerationProfileCanDispatchReferences({
      profile,
      workflowDescriptor,
      pinnedReferences: retryPinnedReferences,
      sourceImageAssetId: retrySourceImageAssetId ?? null,
      lookReferenceAssetId: retryLookReferenceAssetId ?? null,
    });
  }
  if (
    profile.requiredEntitlement &&
    !entitlements[profile.requiredEntitlement]
  ) {
    throw Errors.paymentRequired("Selected model requires entitlement", {
      entitlement: profile.requiredEntitlement,
    });
  }
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  if (
    job.outputCount > profile.maxCount ||
    job.orientation === null ||
    !allowedOrientations.includes(job.orientation)
  ) {
    throw Errors.conflict(
      "The failed generation job no longer fits its pinned retry route",
      {
        generationJobId: job.id,
        outputCount: job.outputCount,
        maxCount: profile.maxCount,
        orientation: job.orientation,
        allowedOrientations,
      },
    );
  }
  const pricingAuthority = await resolveGenerationPricingAuthority(job.mode);
  const pricingFingerprint =
    generationPricingFingerprint(pricingAuthority);
  const cost = generationCostFromAuthority(
    pricingAuthority,
    job.outputCount,
    profile.costMultiplier,
  );
  const retryReferenceAssetIds = [
    ...new Set([
      ...jsonStringArray(job.referenceAssetIds),
      ...retryPinnedReferences.map((reference) => reference.assetId),
    ]),
  ];
  const routeFingerprint = createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: "generation-retry-plan-v1",
      generationJobId: job.id,
      generationJobVersion: job.version,
      mode: job.mode,
      profileId: profile.profileKey,
      profileVersion: profile.version,
      workflowKey:
        profile.workflowKey ?? profile.pipelineModel,
      workflowVersion: workflowDescriptor?.version ?? null,
      characterId: job.characterId,
      visualProfileId: job.visualProfileId,
      visualProfileVersion: job.visualProfileVersion,
      referenceSetRevisionId: job.referenceSetRevisionId,
      retryPinnedReferences,
      sourceImageAssetId: retrySourceImageAssetId ?? null,
      lookReferenceAssetId: retryLookReferenceAssetId ?? null,
      orientation: job.orientation,
      outputCount: job.outputCount,
      costMultiplier: profile.costMultiplier,
    }))
    .digest("hex");

  return {
    allowedOrientations,
    controls,
    cost,
    entitlements,
    pricingAuthority,
    pricingFingerprint,
    profile,
    retryLookReferenceAssetId,
    retryPinnedReferences,
    retryReferenceAssetIds,
    retrySourceImageAssetId,
    routeFingerprint,
    workflowDescriptor,
  };
}

export async function retryGenerationJobForUser(input: {
  readonly userId: string;
  readonly job: RetryableGenerationJob;
  readonly idempotencyKey: string;
  readonly quoteAuthority?: GenerationQuoteAuthority;
}): Promise<GenerationJobWithRelations> {
  const { idempotencyKey: retryIdempotencyKey, job, userId } = input;
  if (!input.quoteAuthority) {
    throw Errors.conflict(
      "An exact generation retry quote is required before retrying.",
    );
  }
  const authority = await resolveGenerationRetryAuthority(userId, job);
  const {
    controls,
    cost,
    entitlements,
    pricingAuthority,
    pricingFingerprint,
    profile,
    retryLookReferenceAssetId,
    retryReferenceAssetIds,
    retrySourceImageAssetId,
    routeFingerprint,
    workflowDescriptor,
  } = authority;
  // 重试走同一条 fail-closed 协议，只是路线指纹来自被重试的 job 而不是新计划。
  assertQuoteStillValid(
    input.quoteAuthority,
    {
      profileId: profile.profileKey,
      profileVersion: profile.version,
      routeFingerprint,
      pricingFingerprint,
      outputCount: job.outputCount,
      costDreamcoins: cost,
    },
    "retry",
  );
  const availableBalance = await dreamcoinBalance(userId);
  if (availableBalance < cost) {
    throw Errors.paymentRequired("Insufficient DreamCoins", {
      required: cost,
      available: availableBalance,
    });
  }
  const acceptedRetryQuoteAuthority = {
    schemaVersion: "generation-retry-quote-authority-v1",
    generationJobId: job.id,
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
    outputCount: job.outputCount,
    costDreamcoins: cost,
  };
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`generation-retry-idempotency:${userId}:${retryIdempotencyKey}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`generation-retry-authority:${job.id}`}))`;
    const lockedJob = await tx.generationJob.findFirst({
      where: { id: job.id, userId },
    });
    if (
      !lockedJob ||
      lockedJob.status !== "failed" ||
      lockedJob.version !== job.version
    ) {
      throw Errors.conflict(
        "Generation job changed before retry authority could be reserved",
        { generationJobId: job.id },
      );
    }
    const existingRetry = await tx.generationJob.findFirst({
      where: {
        userId,
        idempotencyKey: retryIdempotencyKey,
      },
    });
    if (existingRetry) {
      if (existingRetry.derivedFromJobId !== job.id) {
        throw Errors.conflict(
          "Idempotency-Key was already used for a different generation request",
        );
      }
      const dispatch = existingRetry.status === "queued"
        ? await reserveInitialGenerationAttempt(tx, existingRetry)
        : null;
      return {
        job: existingRetry,
        created: false,
        outboxId: dispatch?.outbox.id ?? null,
      } as const;
    }
    const retryCount = await tx.generationJob.count({
      where: { derivedFromJobId: job.id },
    });
    if (retryCount >= 3) {
      throw Errors.rateLimited("Retry limit reached for this generation job", {
        retries: retryCount,
        max: 3,
      });
    }
    if (job.characterId) {
      await lockCharacterGenerationAuthority(tx, job.characterId);
      const character = await tx.character.findFirst({
        where: {
          AND: [
            {
              id: job.characterId,
              deletedAt: null,
              age: { gte: 18 },
              status: "approved",
            },
            job.mode === "video"
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
      if (!character) {
        throw Errors.conflict(
          "Character changed before retry authority could be reserved",
          { characterId: job.characterId },
        );
      }
      if (
        job.mode === "video" &&
        character.imageAssetId !== retrySourceImageAssetId
      ) {
        throw Errors.conflict(
          "Character primary image changed before video retry authority could be reserved",
          {
            characterId: job.characterId,
            pinnedSourceImageAssetId: retrySourceImageAssetId ?? null,
            currentSourceImageAssetId: character.imageAssetId,
          },
        );
      }
      if (generationJobRequiresPinnedLegacyAuthority(lockedJob)) {
        await assertPinnedLegacyCharacterGenerationAuthority(tx, {
          generationJobId: lockedJob.id,
          characterId: lockedJob.characterId!,
          controls: lockedJob.controls,
        });
      }
    }
    await lockCharacterMediaAssetAuthorities(tx, [
      ...retryReferenceAssetIds,
      ...(retrySourceImageAssetId ? [retrySourceImageAssetId] : []),
      ...(retryLookReferenceAssetId ? [retryLookReferenceAssetId] : []),
    ]);
    await assertRetryGenerationReferenceAuthoritiesInTx(tx, {
      referenceAssetIds: retryReferenceAssetIds,
      characterId: job.characterId,
    });
    if (retrySourceImageAssetId) {
      await assertGenerationSourceImageAuthorityInTx(tx, {
        sourceImageAssetId: retrySourceImageAssetId,
        userId,
        characterId: job.characterId,
      });
    }
    if (retryLookReferenceAssetId) {
      await assertGenerationSourceImageAuthorityInTx(tx, {
        sourceImageAssetId: retryLookReferenceAssetId,
        userId,
        characterId: job.characterId,
      });
    }
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
        characterId: job.characterId,
        visualProfileId: job.visualProfileId,
        visualProfileVersion: job.visualProfileVersion,
        consistencyMode: job.consistencyMode,
        seed: job.seed,
        referenceAssetIds: job.referenceAssetIds === null ? undefined : job.referenceAssetIds,
        referenceSetRevisionId: job.referenceSetRevisionId,
        referenceManifest: job.referenceManifest === null ? undefined : job.referenceManifest,
        momentSpec: job.momentSpec === null ? undefined : job.momentSpec,
        lookId: job.lookId,
        lookSnapshot: job.lookSnapshot === null ? undefined : job.lookSnapshot,
        derivedFromJobId: job.id,
        idempotencyKey: retryIdempotencyKey,
        mode: job.mode,
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
        controls: toInputJson(pruneUndefined({
          ...controls,
          generationProfileKey: profile.profileKey,
          generationProfileVersion: profile.version,
          workflowKey: workflowDescriptor?.workflowKey,
          workflowVersion: workflowDescriptor?.version,
          workflowIdentity: workflowDescriptor?.identity,
          lookReferenceAssetId: retryLookReferenceAssetId,
          generationRetryQuoteAuthority:
            acceptedRetryQuoteAuthority,
        })),
        presetIds: toInputJson(jsonStringArray(job.presetIds)),
        model: profile.workflowKey ?? profile.pipelineModel,
        profileId: profile.profileKey,
        profileVersion: profile.version,
        recipeId: job.recipeId,
        recipeVersion: job.recipeVersion,
        orientation: job.orientation,
        outputCount: job.outputCount,
        status: "queued",
        costDreamcoins: cost,
        provider: profile.runner,
      },
    });
    await appendGenerationEvent(tx, created.id, "created", "Retry generation job accepted", {
      derivedFromJobId: job.id,
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
    await appendGenerationEvent(tx, created.id, "queued", "Retry generation job queued", {});
    const dispatch = await reserveInitialGenerationAttempt(tx, created);
    return {
      job: created,
      created: true,
      outboxId: dispatch.outbox.id,
    } as const;
  });
  const retry = reservation.job;
  if (reservation.outboxId) {
    await dispatchGenerationAttemptOutbox(prisma, {
      outboxIds: [reservation.outboxId],
    });
  }
  return prisma.generationJob.findUniqueOrThrow({
    where: { id: retry.id },
    include: generationJobInclude(),
  });
}

function generationJobRequiresPinnedLegacyAuthority(job: {
  readonly characterId: string | null;
  readonly controls: Prisma.JsonValue;
  readonly mode: string;
  readonly sourceType: string | null;
  readonly visualProfileId: string | null;
}) {
  return (
    job.mode === "image" &&
    job.characterId !== null &&
    job.visualProfileId === null &&
    (
      job.sourceType !== "content_production_item" ||
      legacyCharacterGenerationAuthorityFromControls(job.controls) !== null
    )
  );
}

async function assertRetryGenerationReferenceAuthoritiesInTx(
  tx: Prisma.TransactionClient,
  input: {
    readonly referenceAssetIds: readonly string[];
    readonly characterId: string | null;
  },
) {
  if (input.referenceAssetIds.length === 0) return;
  if (!input.characterId) {
    throw Errors.conflict(
      "Pinned Character references cannot be retried without their Character authority",
      { referenceAssetIds: input.referenceAssetIds },
    );
  }
  const references = await tx.mediaAsset.findMany({
    where: {
      id: { in: [...input.referenceAssetIds] },
      characterId: input.characterId,
      type: "image",
      deletedAt: null,
      safetyStatus: "passed",
    },
    select: {
      id: true,
      storageKey: true,
      url: true,
      metadata: true,
    },
  });
  const usableReferenceIds = new Set(
    references
      .filter((reference) =>
        isMediaAssetOperationalForAuthority(reference.metadata) &&
        hasHydratableMediaBlobAuthority(reference)
      )
      .map((reference) => reference.id),
  );
  const unavailableReferenceAssetIds = input.referenceAssetIds.filter(
    (assetId) => !usableReferenceIds.has(assetId),
  );
  if (unavailableReferenceAssetIds.length > 0) {
    throw Errors.conflict(
      "Pinned Character references changed or became unavailable before retry",
      {
        characterId: input.characterId,
        unavailableReferenceAssetIds,
      },
    );
  }
}
