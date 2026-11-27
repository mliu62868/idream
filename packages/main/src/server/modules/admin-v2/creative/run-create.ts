import { assertMediaAssetCustomerPublishable } from "@/server/lib/media-asset-authority-query";
import {
  characterRouteEvaluationMatrixKey,
  characterRouteEvaluationMatrixSchemaVersion,
  characterVideoProductionRecipe,
} from "@idream/shared";
import { creativeRunFillSkipSchema, creativeRunGroupIdsSchema, type CreativeRunFillSkip } from "@idream/shared/admin";
import { dimensionsForImageOrientation } from "@idream/shared/media/image-orientation";
import type { Prisma } from "@prisma/client";
import { resolveGenerationPricingAuthority } from "@/server/lib/generation-pricing";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { hasHydratableMediaBlobAuthority, isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { toInputJson } from "@/server/lib/request-json";
import type {
  AdminActor,
  AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import { auditedTransaction } from "@/server/modules/admin-v2/shared/audited-transaction";
import { refreshContentProductionBatchStats } from "@/server/modules/content-production-state";
import {
  dispatchGenerationAttemptOutbox,
  reserveInitialGenerationAttempt,
} from "@/server/modules/generation/generation-attempt-authority";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { workflowRunsWithoutReferences } from "@idream/shared/gen-workflow";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import { generationBackendHealth } from "@/server/modules/admin-v2/generation/diagnostics";
import {
  ensureOperationalGenerationRoute,
  findOperationalGenerationRoute,
} from "@/server/modules/admin-v2/characters/visual-authority";
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/release-validation";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "@/server/modules/admin-v2/characters/release-snapshot";
import { loadCharacterIdentityBootstrapAuthority } from "@/server/modules/admin-v2/characters/identity-bootstrap-authority";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { checkMissingCharacterImage } from "@/server/modules/admin-v2/characters/fill-missing-image";
import { freezeGenerationReferences } from "@/server/modules/ourdream/generation-reference-snapshot";
import { lockUserLedger } from "@/server/modules/ourdream/subscription-lifecycle";
import {
  generationSourceVariationAuthority,
  identityCalibrationGenerationModes,
} from "@/server/modules/admin-v2/characters/generation-route-authority";
import { operationalMediaAssetWhere } from "@/server/modules/metric-data-scope";
import { isDefaultProductionVideoProfile } from "@/server/modules/generation/production-video-profile";
import { pinCharacterVideoSourceIdentity } from "@/server/modules/admin-v2/characters/video-source-identity";
import { resolveImageRecipeNegative } from "@/server/modules/ourdream/generation-profile-selection";
import { imageNegativePrompt } from "@/server/modules/ourdream/generation-prompt";
import {
  appendProductionJobEvent,
  generationProfileCapabilities,
  jsonRecord,
  jsonStringArray,
  parseOptionalDate,
  presetPromptFragment,
  productionControls,
  productionNegativePrompt,
  productionPrompt,
  purposeLabel,
  resolveProductionBootstrapAuthority,
  resolveProductionProfile,
  resolveProductionRecipe,
  resolveProductionReferenceSet,
  resolveProductionTarget,
  resolveProductionVisualProfile,
} from "./run-create-authority";
import { creativeRunCostQuote } from "./run-pricing";

// SPEC: 建一次 Creative Run —— 校验并 pin 生成路线、原子写入 Run + items + Generation
// Request/Attempt + dispatch Outbox + 幂等命令 + 审计，然后投递 dispatch。
// INTENT: 这是「Creative Run 存在」这一事实的唯一写入口。它此前住在按目录命名的
// legacy `admin/content-ops.ts` 里，和 Image Library、Placement 两套不相干的权威共处
// 一个文件，而 v2 路由直接 import 它 —— 权威在 v1 杂物间、调用方在 v2，是错的方向。
// INVARIANT: 每个展示位 Run 仅一张图；同一批请求的所有 Run 共用事务和回执。identity/route/source 三类
// 权威都必须在事务内复核一次，preflight 结论不作数。

// SPEC: 入参就是 manifest 为 `POST /api/v2/admin/creative/runs` 声明的 body 契约。
// INTENT: 按 contract ref 取型，而不是 import 请求 schema —— 后者会在 manifest 之外
// 形成第二处契约引用（ADR-13 §2.3.1），api-manifest 守卫会当场拒绝。
export type CreativeRunCreateInput =
  AdminV2RequestBody<"creativeRunCreateRequestSchema+idempotency-key">;

type CreativeRunReceiptKey = { scope: string; idempotencyKey: string; requestHash: string };
type CreatedRun = { id: string; items: { id: string }[] };
type CreativeRunReceipt = { batches: CreatedRun[] } | { skip: CreativeRunFillSkip };

function createdRunResponse(batches: CreatedRun[], replayed: boolean) {
  return {
    batch: { id: batches[0].id },
    ...(batches.length > 1 ? { runIds: batches.map(({ id }) => id) } : {}),
    replayed,
  };
}

async function readCreativeRunReceipt(db: Prisma.TransactionClient, key: CreativeRunReceiptKey): Promise<CreativeRunReceipt | null> {
  const existing = await db.controlPlaneCommand.findUnique({
    where: { scope_idempotencyKey: { scope: key.scope, idempotencyKey: key.idempotencyKey } },
  });
  if (!existing) return null;
  if (existing.requestHash !== key.requestHash) {
    throw Errors.conflict("Idempotency key was reused with a different Creative Run brief", { commandId: existing.id });
  }
  const result = jsonRecord(existing.result);
  if (existing.status === "succeeded") {
    const skip = creativeRunFillSkipSchema.safeParse(result.fillSkip);
    if (skip.success) return { skip: skip.data };
    if (typeof result.batchId === "string") {
      const groupSize = jsonRecord(existing.requestPayload).runCount;
      const ids = groupSize ? creativeRunGroupIdsSchema.parse(result.runIds) : [result.batchId];
      if (ids[0] !== result.batchId || (groupSize && ids.length !== groupSize)) {
        throw Errors.conflict("The Creative Run receipt contains inconsistent Run IDs");
      }
      // INVARIANT: db 可能是事务 adapter（单个 pg client），一次查询取回整组，不在其上并发多条查询。
      const found = await db.contentProductionBatch.findMany({
        where: { id: { in: ids } }, select: { id: true, items: { select: { id: true } } },
      });
      const byId = new Map(found.map((batch) => [batch.id, batch]));
      const batches = ids.map((id) => {
        const batch = byId.get(id);
        if (!batch) throw Errors.conflict("The Creative Run receipt references a missing Run", { runId: id });
        return batch;
      });
      return { batches };
    }
  }
  throw Errors.conflict("The original Creative Run create command has not completed", {
    commandId: existing.id,
    status: existing.status,
  });
}

async function lockCreativeRunReceipt(tx: Prisma.TransactionClient, key: CreativeRunReceiptKey) {
  await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext(${`${key.scope}:${key.idempotencyKey}`}))`;
  return readCreativeRunReceipt(tx, key);
}

async function skipMissingImageFill(
  tx: Prisma.TransactionClient,
  input: { key: CreativeRunReceiptKey; actor: AdminActor; body: CreativeRunCreateInput; characterId: string; requestId: string },
) {
  const decision = await checkMissingCharacterImage(tx, input.characterId, input.body.purpose);
  if (!decision) return null;
  await tx.controlPlaneCommand.create({
    data: {
      ...input.key,
      commandType: "creative.run.create",
      targetType: "character_project",
      targetId: decision.projectId,
      actorId: input.actor.id,
      requestId: input.requestId,
      requestPayload: toInputJson(input.body),
      retryMode: "idempotent",
      status: "succeeded",
      result: toInputJson({ fillSkip: decision.skip }),
      finishedAt: new Date(),
    },
  });
  await tx.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "content.production.batch.fill.skipped",
      targetType: "character_project",
      targetId: decision.projectId,
      reason: input.body.reason,
      after: toInputJson({ purpose: input.body.purpose, ...decision.skip }),
      requestId: input.requestId,
    },
  });
  return { skip: decision.skip };
}

function productionCandidateSeed(input: {
  readonly baseSeed: string | null | undefined;
  readonly batchId: string;
  readonly directionId: string | null;
  readonly variantIndex: number;
}) {
  const baseSeed = input.baseSeed?.trim() || "candidate";
  return [
    baseSeed,
    `batch:${input.batchId}`,
    `direction:${input.directionId ?? "default"}`,
    `variant:${input.variantIndex + 1}`,
  ].join(":");
}

export function identityExperimentCandidateSeed(input: {
  readonly strategy: "random" | "locked" | "reuse_source";
  readonly baseSeed: string | null | undefined;
  readonly sourceSeed: string | null | undefined;
  readonly batchId: string;
  readonly variantIndex: number;
}) {
  const variant = `variant:${input.variantIndex + 1}`;
  if (input.strategy === "locked") {
    return [input.baseSeed?.trim() || "locked", variant].join(":");
  }
  if (input.strategy === "reuse_source") {
    return [input.sourceSeed?.trim() || "source", "continued", variant].join(":");
  }
  return [
    input.baseSeed?.trim() || "random",
    `batch:${input.batchId}`,
    variant,
  ].join(":");
}

// NOTE: takes `request` + full `AdminActor` (not just `actor: {id}`) because
// the atomic Audit row needs actor.role plus request headers.
export async function createCreativeRun(
  request: Request,
  actor: AdminActor,
  body: CreativeRunCreateInput,
): Promise<{ batch: { id: string }; runIds?: string[]; replayed: boolean } | { skip: CreativeRunFillSkip; replayed: boolean }> {
  const characterLibraryImagePackRun = body.purpose === "character_library_image_pack";
  const characterLibraryVideoPackRun = body.purpose === "character_library_video_pack";
  const characterVideoRun = body.purpose === "character_video" || characterLibraryVideoPackRun;
  const productionMode = characterVideoRun ? "video" as const : "image" as const;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;
  const commandScope = `${env.APP_ENV}:${actor.id}:creative.run.create`;
  const requestHash = canonicalSha256({ commandType: "creative.run.create", payload: body });
  const receiptKey = idempotencyKey ? { scope: commandScope, idempotencyKey, requestHash } : null;
  const existing = receiptKey ? await readCreativeRunReceipt(prisma, receiptKey) : null;
  if (existing) return "skip" in existing
    ? { skip: existing.skip, replayed: true }
    : createdRunResponse(existing.batches, true);

  const fill = body.fillMissing && receiptKey && body.targetId
    ? { key: receiptKey, actor, body, characterId: body.targetId, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID() }
    : null;
  if (body.fillMissing && !fill) throw Errors.badRequest("A Character placement fill requires an idempotency key and target");
  if (fill) {
    // Do not require current generation availability to report an existing
    // image or an already-pending Run. Recheck in the write transaction below.
    const skipped = await auditedTransaction("content.production.batch.fill", async (tx) => {
      const replay = await lockCreativeRunReceipt(tx, fill.key);
      if (replay) return "skip" in replay
        ? { skip: replay.skip, replayed: true }
        : createdRunResponse(replay.batches, true);
      await lockCharacterGenerationAuthority(tx, fill.characterId);
      const resolved = await skipMissingImageFill(tx, fill);
      return resolved ? { ...resolved, replayed: false } : null;
    }, { timeout: 60_000 });
    if (skipped) return skipped;
  }
  const profile = await resolveProductionProfile(
    body.profileId,
    undefined,
    productionMode,
  );
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  const orientation = body.orientation ?? allowedOrientations[0] ?? "4:5";
  // Creative Runs do not derive dimensions from a verified source snapshot.
  if (orientation === "original") {
    throw Errors.badRequest("Creative Runs do not support original source dimensions. Choose an explicit aspect ratio.");
  }
  const workflowKey = profile.workflowKey ?? profile.pipelineModel;
  const workflow = await generationWorkflowDescriptor(workflowKey);
  const configuredWorkflowVersion = jsonRecord(profile.runnerConfig).workflowVersion;
  const workflowVersion = workflow?.version ?? (
    typeof configuredWorkflowVersion === "number" && Number.isSafeInteger(configuredWorkflowVersion) && configuredWorkflowVersion > 0
      ? configuredWorkflowVersion
      : null
  );
  if (workflowVersion === null) {
    throw Errors.conflict("The exact production workflow version is unavailable", { workflowKey });
  }
  if (body.bootstrapIdentity && workflow) {
    const backendHealth = await generationBackendHealth(
      workflow.backendKind,
      // 身份图引导走图片链路；错误文案也说 image-generation runtime。
      "image",
    );
    if (!backendHealth.ok) {
      throw Errors.unavailable(
        `The ${workflow.backendKind} image-generation runtime is not ready. Restore backend health, then generate again. No Run was created.`,
      );
    }
  }
  const recipe = await resolveProductionRecipe(
    body.recipeId,
    body.targetType,
    undefined,
    productionMode,
  );
  const recipeNegative = productionMode === "image" ? await resolveImageRecipeNegative(recipe) : null;
  const target = await resolveProductionTarget(body.targetType, body.targetId);
  const visualProfile = characterVideoRun
    ? null
    : await resolveProductionVisualProfile(
        prisma,
        body.targetType,
        body.targetId,
      );
  const bootstrapAuthority = body.bootstrapIdentity && body.targetId
    ? await resolveProductionBootstrapAuthority(prisma, body.targetId, body.brief ?? null)
    : null;
  const identityBootstrapAuthority = body.bootstrapIdentity && body.targetId
    ? await loadCharacterIdentityBootstrapAuthority(prisma, body.targetId)
    : null;
  const characterTargetRun = body.targetType === "character";
  const routeEvaluationRun =
    characterTargetRun && body.purpose === "model_eval";
  const identityExperimentRun =
    characterTargetRun && body.purpose === "identity_calibration";
  const batchCharacterLibraryRun =
    characterTargetRun && (characterLibraryImagePackRun || characterLibraryVideoPackRun);
  if (characterTargetRun && !routeEvaluationRun && !batchCharacterLibraryRun && body.count !== 1) {
    throw Errors.badRequest(
      "Character asset production creates exactly one output per Run",
      {
        requestedCount: body.count,
        requiredCount: 1,
      },
    );
  }
  let generationRouteAuthority: {
    readonly qualificationId: string;
    readonly routeFingerprint: string;
  } | null = null;
  const profileCapabilities = generationProfileCapabilities(profile.runnerConfig);
  if (body.bootstrapIdentity) {
    if (!bootstrapAuthority) {
      throw Errors.conflict("Character identity bootstrap requires a current Project and Content draft");
    }
    if (!identityBootstrapAuthority?.allowed) {
      throw Errors.conflict("This Character already has identity authority that cannot be bootstrapped", {
        visualProfileId: visualProfile?.id ?? null,
        visualProfileVersion: visualProfile?.version ?? null,
        blockers: identityBootstrapAuthority?.blockers ?? ["identity_bootstrap_authority_unavailable"],
      });
    }
    if (
      !workflow ||
      !workflowRunsWithoutReferences(workflow) ||
      profileCapabilities.textToImage !== true
    ) {
      throw Errors.conflict("The selected profile is not an explicit text-to-image identity bootstrap route", {
        profileKey: profile.profileKey,
        workflowKey,
      });
    }
  } else if (identityExperimentRun) {
    const experiment = body.identityExperiment;
    if (!experiment) {
      throw Errors.badRequest("Identity calibration requires an experiment snapshot");
    }
    const supportedModes = identityCalibrationGenerationModes({
      workflow,
      profileCapabilities,
    });
    if (!supportedModes.includes(experiment.mode)) {
      throw Errors.conflict(
        `The selected profile cannot run ${experiment.mode.replaceAll("_", "-")} identity calibration`,
        {
          profileKey: profile.profileKey,
          workflowKey,
          mode: experiment.mode,
        },
      );
    }
  } else if (characterVideoRun) {
    if (
      !isDefaultProductionVideoProfile(profile) ||
      !workflow ||
      !workflow.capabilities.includes("video") ||
      !workflow.capabilities.includes("img2video") ||
      workflow.identity.maxReferences !== 1 ||
      !workflow.identity.acceptedRoles.includes("source_image") ||
      profileCapabilities.initImage !== true
    ) {
      throw Errors.conflict(
        "The exact Character image-to-video production route is unavailable",
        {
          profileKey: profile.profileKey,
          workflowKey,
        },
      );
    }
  } else if (characterTargetRun) {
    if (!visualProfile) {
      throw Errors.conflict("Character asset production requires an active sealed Visual Identity", {
        deepLink: `/admin/characters/${body.targetId}?tab=assets`,
      });
    }
    if (
      visualProfile.immutableHash === null ||
      visualProfile.immutableHash !== characterVisualProfileSnapshotHash(visualProfile)
    ) {
      throw Errors.conflict("Character asset production requires a sealed, non-drifted Visual Identity", {
        visualProfileId: visualProfile.id,
        visualProfileVersion: visualProfile.version,
        deepLink: `/admin/characters/${body.targetId}?tab=visual`,
      });
    }
    if (
      !workflow ||
      workflow.identity.mode === "none" ||
      workflow.identity.maxReferences < 1 ||
      !workflow.capabilities.includes("referenceImages") ||
      profileCapabilities.referenceImages !== true
    ) {
      throw Errors.conflict("The selected generation route cannot apply Character identity references", {
        profileKey: profile.profileKey,
        workflowKey,
      });
    }
    if (
      routeEvaluationRun &&
      body.routeEvaluationMatrixKey !==
        characterRouteEvaluationMatrixKey(visualProfile.style)
    ) {
      throw Errors.badRequest(
        "Route evaluation matrix key does not match the active Character identity style",
        {
          expectedMatrixKey:
            characterRouteEvaluationMatrixKey(visualProfile.style),
          receivedMatrixKey: body.routeEvaluationMatrixKey ?? null,
        },
      );
    }
  } else if (
    !workflow ||
    !workflowRunsWithoutReferences(workflow) ||
    profileCapabilities.textToImage !== true
  ) {
    throw Errors.conflict("Generic image production requires an explicit text-to-image route", {
      profileKey: profile.profileKey,
      workflowKey,
    });
  }
  const additionalReferenceAssetIds = body.identityExperiment?.sourceAssetId
    ? [body.identityExperiment.sourceAssetId]
    : body.referenceAssetIds;
  const additionalReferenceAssets = additionalReferenceAssetIds.length > 0
    ? await prisma.mediaAsset.findMany({
        where: operationalMediaAssetWhere({
          id: { in: additionalReferenceAssetIds },
          type: "image",
          safetyStatus: "passed",
          deletedAt: null,
        }),
        select: {
          id: true,
          characterId: true,
          metadata: true,
          sourceJobId: true,
          storageKey: true,
          url: true,
          sourceJob: {
            select: {
              id: true,
              seed: true,
              sourceType: true,
              sourceId: true,
              status: true,
              visualProfileId: true,
              visualProfileVersion: true,
              referenceSetRevisionId: true,
            },
          },
        },
      })
    : [];
  if (
    additionalReferenceAssets.length !== additionalReferenceAssetIds.length ||
    additionalReferenceAssets.some((asset) =>
      !isMediaAssetOperationalForAuthority(asset.metadata)
    )
  ) {
    throw Errors.badRequest("Additional Creative Run references must be available image assets");
  }
  if (
    body.targetType === "character" &&
    additionalReferenceAssets.some((asset) => asset.characterId !== body.targetId)
  ) {
    throw Errors.badRequest("Additional Creative Run references must belong to the target Character");
  }
  if (identityExperimentRun && additionalReferenceAssets.length > 0) {
    if (
      body.identityExperiment?.seedStrategy === "reuse_source" &&
      !additionalReferenceAssets[0]?.sourceJob?.seed
    ) {
      throw Errors.conflict("The selected calibration source has no generation seed to reuse");
    }
  }
  const activeReferenceSet = visualProfile &&
      characterTargetRun &&
      !characterVideoRun &&
      !body.bootstrapIdentity &&
      !identityExperimentRun
    ? await resolveProductionReferenceSet(prisma, visualProfile.id)
    : null;
  if (
    characterTargetRun &&
    !characterVideoRun &&
    !body.bootstrapIdentity &&
    !identityExperimentRun
  ) {
    if (
      !visualProfile ||
      !activeReferenceSet ||
      activeReferenceSet.snapshotHash === null ||
      activeReferenceSet.snapshotHash !== referenceSetSnapshotHash(activeReferenceSet) ||
      activeReferenceSet.references.length < 1 ||
      activeReferenceSet.references.some((reference) =>
        reference.mediaAsset.deletedAt !== null ||
        reference.mediaAsset.safetyStatus !== "passed" ||
        !isMediaAssetOperationalForAuthority(reference.mediaAsset.metadata) ||
        reference.mediaAsset.characterId !== body.targetId
      )
    ) {
      throw Errors.conflict("Character asset production requires an active sealed and available Reference Set", {
        deepLink: `/admin/characters/${body.targetId}?tab=visual`,
      });
    }
    const requiredRouteReferenceRoles = [
      ...activeReferenceSet.references.map((reference) => reference.role),
      ...additionalReferenceAssets.map(() => "source_image" as const),
    ];
    if (!routeEvaluationRun) {
      const qualifiedRoute = await findOperationalGenerationRoute(prisma, {
        style: visualProfile.style,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        at: new Date(),
        requiredReferenceCount: requiredRouteReferenceRoles.length,
        requiredReferenceRoles: requiredRouteReferenceRoles,
      });
      if (
        !qualifiedRoute ||
        qualifiedRoute.generationProfileKey !== profile.profileKey ||
        qualifiedRoute.generationProfileVersion !== profile.version ||
        qualifiedRoute.workflowKey !== workflowKey ||
        qualifiedRoute.workflowVersion !== workflowVersion
      ) {
        throw Errors.conflict("The selected profile is not the current qualified Character identity route", {
          profileKey: profile.profileKey,
          workflowKey,
          qualifiedProfileKey: qualifiedRoute?.generationProfileKey ?? null,
        });
      }
      generationRouteAuthority = {
        qualificationId: qualifiedRoute.id,
        routeFingerprint: qualifiedRoute.routeFingerprint,
      };
    }
    if (additionalReferenceAssets.some((asset) =>
      !hasHydratableMediaBlobAuthority(asset) ||
      asset.sourceJob?.status !== "completed" ||
      asset.sourceJob?.visualProfileId !== visualProfile.id ||
      asset.sourceJob.visualProfileVersion !== visualProfile.version ||
      asset.sourceJob.referenceSetRevisionId !== activeReferenceSet.id
    )) {
      throw Errors.conflict("A variation source must be derived from the active Character identity authority");
    }
    for (const asset of additionalReferenceAssets) {
      await assertMediaAssetCustomerPublishable(prisma, asset);
    }
    const variationSourceItems = additionalReferenceAssets.map((asset) => ({
      assetId: asset.id,
      jobId: asset.sourceJob?.id,
      itemId: asset.sourceJob?.sourceType === "content_production_item"
        ? asset.sourceJob.sourceId
        : null,
    }));
    if (variationSourceItems.some((source) => !source.itemId)) {
      throw Errors.conflict("A variation source must come from a completed Creative Run candidate");
    }
    const variationItems = await prisma.contentProductionItem.findMany({
      where: { id: { in: variationSourceItems.flatMap((source) => source.itemId ? [source.itemId] : []) } },
      select: { id: true, mediaAssetId: true, jobId: true },
    });
    if (variationSourceItems.some((source) => !variationItems.some((item) =>
      item.id === source.itemId && item.mediaAssetId === source.assetId && item.jobId === source.jobId))) {
      throw Errors.conflict("Variation source does not match its generated Run item");
    }
  }
  const presets = await prisma.generationPreset.findMany({
    where: { id: { in: body.presetIds }, scope: "built_in", status: "active" },
  });
  if (presets.length !== body.presetIds.length) {
    throw Errors.badRequest("Production batch presets must be active built-in presets");
  }
  if (allowedOrientations.length > 0 && !allowedOrientations.includes(orientation)) {
    throw Errors.badRequest("Orientation is not allowed for this profile", {
      orientation,
      allowedOrientations,
    });
  }
  const dimensions = characterVideoRun
    ? { width: profile.defaultWidth, height: profile.defaultHeight }
    : dimensionsForImageOrientation({
        orientation,
        defaultWidth: profile.defaultWidth,
        defaultHeight: profile.defaultHeight,
      });
  const title =
    body.title ??
    `${purposeLabel(body.purpose)} ${new Date().toISOString().slice(0, 10)}`;
  const presetFragment = presetPromptFragment(body.presetIds, presets);
  // A recoverable empty candidate is history, not generation authority. The
  // bootstrap image must remain a true no-reference/no-profile definition.
  const generationVisualProfile =
    body.bootstrapIdentity || identityExperimentRun ? null : visualProfile;
  const identityNegative = identityExperimentRun ? body.identityExperiment?.negativePrompt : generationVisualProfile?.negativeIdentityPrompt;
  const compiledNegativePrompt = productionNegativePrompt(
    recipeNegative?.base ?? recipe.negativeBase,
    recipeNegative?.negativeRecipe ? null : identityNegative,
    body.purpose,
    body.negativePrompt,
  );
  const effectiveNegativePrompt = recipeNegative?.negativeRecipe
    ? imageNegativePrompt(compiledNegativePrompt, { negativeIdentityPrompt: identityNegative ?? null })
    : compiledNegativePrompt;
  const canonicalReferenceManifest = activeReferenceSet
    ? activeReferenceSet.references.map((reference) => ({
        mediaAssetId: reference.mediaAssetId,
        position: reference.position,
        role: reference.role,
        weight: reference.weight,
        selectorVersion: reference.selectorVersion,
        selectionReason: reference.selectionReason,
        qualityScore: reference.qualityScore,
        identityScore: reference.identityScore,
        referenceSetRevisionId: activeReferenceSet.id,
        referenceSetRevision: activeReferenceSet.revision,
        snapshotHash: activeReferenceSet.snapshotHash,
      }))
    : [];
  // Source intent is a role, not an asset-identity distinction. The same
  // approved asset may intentionally occupy both a canonical identity slot
  // and the source_image slot for a More-like request.
  const variationSourceCount = additionalReferenceAssets.length;
  const sourceVariationAuthority = generationSourceVariationAuthority({
    routeFingerprint: generationRouteAuthority?.routeFingerprint ?? null,
    routeQualified: generationRouteAuthority !== null,
    workflow,
    qualificationWorkflowVersion: workflowVersion,
    profileCapabilities,
    canonicalReferenceRoles: canonicalReferenceManifest.map(
      (reference) => reference.role,
    ),
    sourceReferenceCount: variationSourceCount,
  });
  if (
    variationSourceCount > 0 &&
    !characterVideoRun &&
    !identityExperimentRun &&
    !sourceVariationAuthority.ready
  ) {
    throw Errors.conflict(
      "The current qualified route cannot create a More-like variation from this Character asset",
      {
        sourceVariationAuthority,
        workflowKey,
        deepLink: `/admin/characters/${body.targetId}?tab=visual`,
      },
    );
  }
  const nextReferencePosition = Math.max(
    -1,
    ...canonicalReferenceManifest.map((reference) => reference.position),
  ) + 1;
  const sourceReferenceManifest = additionalReferenceAssets
    .map((asset, index) => ({
      mediaAssetId: asset.id,
      position: nextReferencePosition + index,
      role: "source_image",
      weight: characterVideoRun
        ? 1
        : identityExperimentRun
        ? body.identityExperiment?.strength ?? 0.65
        : body.consistencyMode === "strict"
          ? 0.9
          : body.consistencyMode === "creative"
            ? 0.7
            : 0.8,
      selectorVersion: activeReferenceSet?.selectorVersion ?? "operator-source-v1",
      selectionReason: characterVideoRun
        ? "Operator-selected Character video source image"
        : identityExperimentRun
        ? "Operator-selected visual identity calibration source"
        : "Operator-selected identity-consistent variation source",
      sourceJobId: asset.sourceJob?.id ?? null,
      referenceSetRevisionId: activeReferenceSet?.id ?? null,
      referenceSetRevision: activeReferenceSet?.revision ?? null,
      snapshotHash: activeReferenceSet?.snapshotHash ?? null,
    }));
  const referenceManifest = [
    ...canonicalReferenceManifest,
    ...sourceReferenceManifest,
  ];
  const referenceAssetIds = referenceManifest.map((reference) => reference.mediaAssetId);
  if (
    workflow &&
    !characterLibraryVideoPackRun &&
    referenceAssetIds.length > workflow.identity.maxReferences
  ) {
    throw Errors.conflict("The selected identity route cannot accept the required reference set", {
      referenceCount: referenceAssetIds.length,
      maxReferences: workflow.identity.maxReferences,
      workflowKey,
    });
  }
  const controls = {
    ...productionControls({
      orientation,
      dimensions,
      profile,
      presets,
      visualProfile: generationVisualProfile,
      consistencyMode: body.consistencyMode,
      referenceAssetIds,
      workflowIdentity: workflow?.identity,
      generationRouteFingerprint: generationRouteAuthority?.routeFingerprint,
      compositionRequirement: identityExperimentRun
        ? "single_subject_single_frame"
        : undefined,
    }),
    ...(identityExperimentRun && body.identityExperiment?.sourceAssetId
      ? {
          sourceImageAssetId: body.identityExperiment.sourceAssetId,
          strength: body.identityExperiment.strength,
        }
      : {}),
    ...(characterVideoRun
      ? {
          sourceImageAssetId: additionalReferenceAssets[0]?.id,
          seconds: characterVideoProductionRecipe.durationSeconds,
        }
      : {}),
  };
  const pricingAuthority = await resolveGenerationPricingAuthority(productionMode);
  const workItems = body.directions
    ? body.directions.flatMap((direction) => Array.from(
        { length: body.outputsPerDirection ?? 1 },
        (_, variantIndex) => ({ direction, variantIndex }),
      ))
    : Array.from(
        { length: body.count },
        (_, variantIndex) => ({ direction: null, variantIndex }),
      );
  const totalOutputCount = workItems.length;
  // Each Run of this command is billed by the same rule the pre-submit estimate shows.
  const runCostQuote = creativeRunCostQuote({
    authority: pricingAuthority,
    profileCostMultiplier: profile.costMultiplier,
    itemCount: totalOutputCount,
  });
  const perItemCostDreamcoins = runCostQuote.perItemCostDreamcoins;

  let replayed = false;
  const result = await auditedTransaction<CreativeRunReceipt>("content.production.batch.create", async (tx) => {
    await lockUserLedger(tx, actor.id);
    if (receiptKey) {
      const existing = await lockCreativeRunReceipt(tx, receiptKey);
      if (existing) {
        replayed = true;
        return existing;
      }
    }
    if (recipeNegative && (await resolveImageRecipeNegative(recipe, tx)).promptRecipeFingerprint !== recipeNegative.promptRecipeFingerprint) {
      throw Errors.conflict("The negative recipe changed before the Run was committed. Refresh and create the Run again.");
    }
    if (body.targetType === "character" && body.targetId) {
      await lockCharacterGenerationAuthority(tx, body.targetId);
      if (fill) {
        // A skipped fill can lock its one candidate and exits. An admitted Run
        // takes the complete sorted reference lock set below.
        const skipped = await skipMissingImageFill(tx, fill);
        if (skipped) return skipped;
      }
      await lockCharacterMediaAssetAuthorities(tx, referenceAssetIds);
      const lockedCharacter = await tx.character.findFirst({
        where: {
          id: body.targetId,
          deletedAt: null,
          status: { notIn: ["archived", "removed"] },
        },
        select: { id: true },
      });
      if (!lockedCharacter) {
        throw Errors.conflict(
          "Character was archived before the Creative Run could pin production authority",
          {
            characterId: body.targetId,
            deepLink: `/admin/characters/${body.targetId}?tab=assets`,
          },
        );
      }
    } else {
      await lockCharacterMediaAssetAuthorities(tx, referenceAssetIds);
    }
    let verifiedBootstrapAuthority = bootstrapAuthority;
    let verifiedIdentityBootstrapAuthority = identityBootstrapAuthority;
    let videoSources: Awaited<ReturnType<typeof tx.mediaAsset.findMany>> = [];
    let videoSource: Awaited<ReturnType<typeof tx.mediaAsset.findFirst>> = null;
    if (body.bootstrapIdentity && body.targetId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`character-identity-bootstrap:${body.targetId}`}))`;
      if (bootstrapAuthority) {
        await tx.$queryRaw`
          SELECT "id"
          FROM "character_projects"
          WHERE "id" = ${bootstrapAuthority.projectId}
          FOR UPDATE
        `;
      }
      const currentBootstrapAuthority = await resolveProductionBootstrapAuthority(
        tx,
        body.targetId,
        body.brief ?? null,
      );
      const currentIdentityBootstrapAuthority = await loadCharacterIdentityBootstrapAuthority(
        tx,
        body.targetId,
      );
      const existingBootstrapJob = await tx.generationJob.findFirst({
        where: {
          characterId: body.targetId,
          sourceMeta: { path: ["bootstrapIdentity"], equals: true },
          status: { in: ["queued", "moderating_input", "running", "moderating_output"] },
        },
        select: { id: true, sourceId: true, status: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (
        existingBootstrapJob ||
        !currentBootstrapAuthority ||
        !currentIdentityBootstrapAuthority.allowed ||
        currentBootstrapAuthority.projectId !== bootstrapAuthority?.projectId ||
        currentBootstrapAuthority.projectVersion !== bootstrapAuthority?.projectVersion ||
        currentBootstrapAuthority.characterContentVersionId !== bootstrapAuthority?.characterContentVersionId ||
        currentBootstrapAuthority.visualBriefHash !== bootstrapAuthority?.visualBriefHash ||
        currentIdentityBootstrapAuthority.state !== identityBootstrapAuthority?.state ||
        currentIdentityBootstrapAuthority.nextVersion !== identityBootstrapAuthority?.nextVersion ||
        currentIdentityBootstrapAuthority.historyFingerprint !== identityBootstrapAuthority?.historyFingerprint
      ) {
        throw Errors.conflict(
          "Character identity authority changed before the first-portrait Run was committed",
          {
            deepLink: `/admin/characters/${body.targetId}?tab=assets`,
            blockers: currentIdentityBootstrapAuthority.blockers,
            existingBootstrapJob,
          },
        );
      }
      verifiedBootstrapAuthority = currentBootstrapAuthority;
      verifiedIdentityBootstrapAuthority = currentIdentityBootstrapAuthority;
    } else if (identityExperimentRun && body.targetId) {
      const currentProfile = await tx.generationModelProfile.findUnique({
        where: { id: profile.id },
        select: {
          profileKey: true,
          version: true,
          status: true,
          enabled: true,
          runnerConfig: true,
        },
      });
      if (
        !currentProfile ||
        currentProfile.profileKey !== profile.profileKey ||
        currentProfile.version !== profile.version ||
        currentProfile.status !== "active" ||
        !currentProfile.enabled
      ) {
        throw Errors.conflict(
          "The identity calibration route changed before the Run was committed",
        );
      }
      const currentSource = body.identityExperiment?.sourceAssetId
        ? await tx.mediaAsset.findFirst({
            where: operationalMediaAssetWhere({
              id: body.identityExperiment.sourceAssetId,
              type: "image",
              safetyStatus: "passed",
              deletedAt: null,
              characterId: body.targetId,
            }),
            select: {
              id: true,
              metadata: true,
              sourceJob: { select: { seed: true } },
            },
          })
        : null;
      if (
        body.identityExperiment?.sourceAssetId &&
        (
          !currentSource ||
          !isMediaAssetOperationalForAuthority(currentSource.metadata) ||
          (
            body.identityExperiment.seedStrategy === "reuse_source" &&
            !currentSource.sourceJob?.seed
          )
        )
      ) {
        throw Errors.conflict(
          "The identity calibration source changed before the Run was committed",
        );
      }
    } else if (characterVideoRun && body.targetId) {
      const currentProfile = await tx.generationModelProfile.findUnique({
        where: { id: profile.id },
      });
      const currentRecipe = await tx.generationRecipe.findUnique({
        where: { id: recipe.id },
        select: {
          id: true,
          recipeKey: true,
          version: true,
          mode: true,
          useCase: true,
          status: true,
        },
      });
      const requestedSourceIds = characterLibraryVideoPackRun
        ? additionalReferenceAssets.map((asset) => asset.id)
        : [additionalReferenceAssets[0]?.id].filter((id): id is string => Boolean(id));
      const currentSources = await tx.mediaAsset.findMany({
        where: operationalMediaAssetWhere({
          id: { in: requestedSourceIds },
          type: "image",
          safetyStatus: "passed",
          deletedAt: null,
          characterId: body.targetId,
        }),
      });
      const currentSourceById = new Map(currentSources.map((asset) => [asset.id, asset]));
      const orderedSources = requestedSourceIds
        .map((id) => currentSourceById.get(id))
        .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
      if (
        !currentProfile ||
        !isDefaultProductionVideoProfile(currentProfile) ||
        currentProfile.id !== profile.id ||
        !currentRecipe ||
        currentRecipe.recipeKey !== recipe.recipeKey ||
        currentRecipe.version !== recipe.version ||
        currentRecipe.mode !== "video" ||
        currentRecipe.useCase !== "character" ||
        currentRecipe.status !== "active" ||
        orderedSources.length !== requestedSourceIds.length ||
        orderedSources.some((source) => !isMediaAssetOperationalForAuthority(source.metadata))
      ) {
        throw Errors.conflict(
          "Character video authority changed before the Run was committed",
          {
            characterId: body.targetId,
            sourceAssetId: requestedSourceIds[0] ?? null,
          },
        );
      }
      videoSources = orderedSources;
      videoSource = videoSources[0] ?? null;
    } else if (body.targetType === "character" && body.targetId) {
      if (!visualProfile || !activeReferenceSet) {
        throw Errors.conflict("Character generation authority disappeared before the Run was committed", {
          deepLink: `/admin/characters/${body.targetId}?tab=visual`,
        });
      }
      const currentVisualProfile = await resolveProductionVisualProfile(
        tx,
        "character",
        body.targetId,
      );
      const currentReferenceSet = await resolveProductionReferenceSet(tx, visualProfile.id);
      const currentProfile = await tx.generationModelProfile.findUnique({
        where: { id: profile.id },
        select: {
          id: true,
          profileKey: true,
          version: true,
          status: true,
          enabled: true,
          runnerConfig: true,
        },
      });
      const currentContent = await tx.characterContentVersion.findFirst({
        where: { characterId: body.targetId },
        orderBy: { version: "desc" },
        select: { id: true, version: true },
      });
      const currentAdditionalReferenceAssets = body.referenceAssetIds.length > 0
        ? await tx.mediaAsset.findMany({
            where: operationalMediaAssetWhere({
              id: { in: body.referenceAssetIds },
              type: "image",
              safetyStatus: "passed",
              deletedAt: null,
              characterId: body.targetId,
            }),
            select: {
              id: true,
              characterId: true,
              metadata: true,
              sourceJobId: true,
              storageKey: true,
              url: true,
              sourceJob: {
                select: {
                  id: true,
                  sourceType: true,
                  sourceId: true,
                  status: true,
                  visualProfileId: true,
                  visualProfileVersion: true,
                  referenceSetRevisionId: true,
                },
              },
            },
          })
        : [];
      const currentRequiredRouteReferenceRoles = [
        ...(currentReferenceSet?.references.map(
          (reference) => reference.role,
        ) ?? []),
        ...currentAdditionalReferenceAssets.map(
          () => "source_image" as const,
        ),
      ];
      const currentQualifiedRoute = routeEvaluationRun
        ? null
        : await ensureOperationalGenerationRoute(tx, {
            style: visualProfile.style,
            policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
            evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
            at: new Date(),
            requiredReferenceCount: currentRequiredRouteReferenceRoles.length,
            requiredReferenceRoles: currentRequiredRouteReferenceRoles,
          });
      const currentCanonicalReferenceIds = currentReferenceSet?.references
        .map((reference) => reference.mediaAssetId) ?? [];
      const preflightCanonicalReferenceIds = activeReferenceSet.references
        .map((reference) => reference.mediaAssetId);
      const identityAuthorityChanged =
        !currentVisualProfile ||
        currentVisualProfile.id !== visualProfile.id ||
        currentVisualProfile.version !== visualProfile.version ||
        currentVisualProfile.immutableHash !== visualProfile.immutableHash ||
        currentVisualProfile.immutableHash !== characterVisualProfileSnapshotHash(currentVisualProfile) ||
        !currentReferenceSet ||
        currentReferenceSet.id !== activeReferenceSet.id ||
        currentReferenceSet.revision !== activeReferenceSet.revision ||
        currentReferenceSet.snapshotHash !== activeReferenceSet.snapshotHash ||
        currentReferenceSet.snapshotHash !== referenceSetSnapshotHash(currentReferenceSet) ||
        currentCanonicalReferenceIds.length === 0 ||
        currentCanonicalReferenceIds.length !== preflightCanonicalReferenceIds.length ||
        currentCanonicalReferenceIds.some((id, index) => id !== preflightCanonicalReferenceIds[index]) ||
        currentReferenceSet.references.some((reference) =>
          reference.mediaAsset.deletedAt !== null ||
          reference.mediaAsset.type !== "image" ||
          reference.mediaAsset.safetyStatus !== "passed" ||
          !isMediaAssetOperationalForAuthority(reference.mediaAsset.metadata) ||
          reference.mediaAsset.characterId !== body.targetId
        );
      const profileChanged =
        !currentProfile ||
        currentProfile.profileKey !== profile.profileKey ||
        currentProfile.version !== profile.version ||
        currentProfile.status !== "active" ||
        !currentProfile.enabled;
      const routeChanged = profileChanged || (
        !routeEvaluationRun && (
          !currentQualifiedRoute ||
          currentQualifiedRoute.routeFingerprint !== generationRouteAuthority?.routeFingerprint ||
          currentQualifiedRoute.generationProfileKey !== profile.profileKey ||
          currentQualifiedRoute.generationProfileVersion !== profile.version ||
          currentQualifiedRoute.workflowKey !== workflowKey ||
          currentQualifiedRoute.workflowVersion !== workflowVersion
        )
      );
      const pinnedContentId =
        target?.type === "character" ? target.contentVersionId : null;
      const pinnedContentVersion =
        target?.type === "character" ? target.contentVersion : null;
      const contentChanged =
        (currentContent?.id ?? null) !== pinnedContentId ||
        (currentContent?.version ?? null) !== pinnedContentVersion;
      const currentSourceVariationAuthority =
        generationSourceVariationAuthority({
          routeFingerprint: currentQualifiedRoute?.routeFingerprint ?? null,
          routeQualified: !routeChanged,
          workflow,
          qualificationWorkflowVersion: workflowVersion,
          profileCapabilities: generationProfileCapabilities(
            currentProfile?.runnerConfig ?? null,
          ),
          canonicalReferenceRoles:
            currentReferenceSet?.references.map((reference) => reference.role) ??
            [],
          sourceReferenceCount: currentAdditionalReferenceAssets.length,
        });
      const sourceRuntimeChanged =
        variationSourceCount > 0 &&
        !currentSourceVariationAuthority.ready;
      if (
        identityAuthorityChanged ||
        routeChanged ||
        contentChanged ||
        sourceRuntimeChanged
      ) {
        throw Errors.conflict("Character generation authority changed before the Run was committed", {
          identityAuthorityChanged,
          routeChanged,
          contentChanged,
          sourceRuntimeChanged,
          sourceVariationAuthority: currentSourceVariationAuthority,
          deepLink: `/admin/characters/${body.targetId}?tab=assets`,
        });
      }
      if (currentQualifiedRoute) {
        generationRouteAuthority = {
          qualificationId: currentQualifiedRoute.id,
          routeFingerprint: currentQualifiedRoute.routeFingerprint,
        };
      }
      for (const asset of currentAdditionalReferenceAssets) {
        await assertMediaAssetCustomerPublishable(tx, asset);
      }
      const currentSourceItems = currentAdditionalReferenceAssets.map((asset) => ({
        assetId: asset.id,
        itemId: asset.sourceJob?.sourceType === "content_production_item"
          ? asset.sourceJob.sourceId
          : null,
        sourceJob: asset.sourceJob,
      }));
      const currentItems = await tx.contentProductionItem.findMany({
        where: { id: { in: currentSourceItems.flatMap((source) => source.itemId ? [source.itemId] : []) } },
        select: { id: true, mediaAssetId: true, jobId: true },
      });
      const sourceAuthorityChanged =
        currentAdditionalReferenceAssets.length !== additionalReferenceAssets.length ||
        currentAdditionalReferenceAssets.some((asset) => !isMediaAssetOperationalForAuthority(asset.metadata) || !hasHydratableMediaBlobAuthority(asset)) ||
        currentSourceItems.some((source) => {
          if (
            !source.itemId ||
            source.sourceJob?.status !== "completed" ||
            source.sourceJob?.visualProfileId !== visualProfile.id ||
            source.sourceJob.visualProfileVersion !== visualProfile.version ||
            source.sourceJob.referenceSetRevisionId !== activeReferenceSet.id
          ) return true;
          return !currentItems.some((item) => item.id === source.itemId && item.mediaAssetId === source.assetId && item.jobId === source.sourceJob?.id);
        });
      if (sourceAuthorityChanged) {
        throw Errors.conflict("Variation source authority changed before the Run was committed", {
          deepLink: `/admin/characters/${body.targetId}?tab=assets`,
        });
      }
    }
    const referenceSnapshots = await freezeGenerationReferences(tx, {
      userId: actor.id,
      characterId: body.targetType === "character" ? body.targetId ?? null : null,
      controls,
      referenceAssetIds,
      referenceManifest,
    });
    const videoSourceIdentityByAssetId = new Map<string, Awaited<ReturnType<typeof pinCharacterVideoSourceIdentity>>>();
    for (const source of videoSources) {
      const frozenSource = referenceSnapshots.find(
        (reference) => reference.role === "source_image" && reference.assetId === source.id,
      );
      const pinned = frozenSource ? await pinCharacterVideoSourceIdentity(tx, source, frozenSource) : null;
      // Fail-fast on batch chat-library video packs so operators never burn
      // video GPU credits on a source image that cannot enter the chat library.
      if (characterLibraryVideoPackRun && !pinned) {
        throw Errors.badRequest(
          "Every source image in a Character library video pack must have a verified Character visual identity",
          { characterId: body.targetId ?? null, sourceAssetId: source.id },
        );
      }
      videoSourceIdentityByAssetId.set(source.id, pinned);
    }
    const videoSourceIdentity = videoSource
      ? videoSourceIdentityByAssetId.get(videoSource.id) ?? null
      : null;
    const createBatch = () => tx.contentProductionBatch.create({
      data: {
        title,
        purpose: body.purpose,
        targetType: body.targetType,
        targetId: body.targetId ?? null,
        profileId: profile.profileKey,
        profileVersion: profile.version,
        recipeId: recipe.recipeKey,
        recipeVersion: recipe.version,
        presetIds: toInputJson(body.presetIds),
        orientation,
        brief: body.brief ?? null,
        count: totalOutputCount,
        totalItems: totalOutputCount,
        estimatedCostDreamcoins: runCostQuote.totalCostDreamcoins,
        status: "queued",
        ownerId: actor.id,
        dueAt: parseOptionalDate(body.dueAt),
        priority: body.priority,
        lifecycleState: "active",
        workflowStage: "generation",
        verificationState: "pending",
        createdById: actor.id,
      },
    });

    const batches = await Promise.all(Array.from({ length: body.runCount ?? 1 }, createBatch));
    async function createItem(createdBatch: typeof batches[number], itemIndex: number) {
      const { direction, variantIndex } = workItems[itemIndex];
      const directionSnapshot = direction ? toInputJson(direction) : undefined;
      const directionHash = direction ? canonicalSha256(direction) : null;
      const directionBrief = direction
        ? [
            body.brief,
            `Direction: ${direction.title}`,
            `Scene: ${direction.scenePrompt}`,
            `Mood: ${direction.mood}`,
            `Setting: ${direction.setting}`,
            `Outfit: ${direction.outfit}`,
            `Camera: ${direction.camera}`,
            `Lighting: ${direction.lighting}`,
          ].filter(Boolean).join("\n")
        : body.brief;
      const prompt = productionPrompt({
        purpose: body.purpose,
        bootstrapIdentity: body.bootstrapIdentity,
        target: verifiedBootstrapAuthority?.target ?? target,
        presetFragment,
        brief: directionBrief,
        visualProfile: generationVisualProfile,
        consistencyMode: body.consistencyMode,
      });
      const item = await tx.contentProductionItem.create({
        data: {
          batchId: createdBatch.id,
          itemIndex,
          directionId: direction?.id,
          directionSnapshot,
          directionHash,
          status: "queued",
          tags: [],
        },
      });
      const itemVideoSource = characterLibraryVideoPackRun
        ? videoSources[itemIndex] ?? null
        : videoSource;
      const itemVideoSourceIdentity = itemVideoSource
        ? videoSourceIdentityByAssetId.get(itemVideoSource.id) ?? null
        : videoSourceIdentity;
      const itemReferenceAssetIds = characterLibraryVideoPackRun && itemVideoSource
        ? [itemVideoSource.id]
        : referenceAssetIds;
      const itemReferenceManifest = characterLibraryVideoPackRun && itemVideoSource
        ? referenceManifest.filter((reference) => reference.mediaAssetId === itemVideoSource.id)
        : referenceManifest;
      const itemReferenceSnapshots = characterLibraryVideoPackRun && itemVideoSource
        ? referenceSnapshots.filter((reference) => reference.assetId === itemVideoSource.id)
        : referenceSnapshots;
      const itemControls = characterLibraryVideoPackRun && itemVideoSource
        ? { ...controls, sourceImageAssetId: itemVideoSource.id, referenceSnapshots: itemReferenceSnapshots }
        : { ...controls, referenceSnapshots: itemReferenceSnapshots };
      const job = await tx.generationJob.create({
        data: {
          userId: actor.id,
          characterId: body.targetType === "character" ? body.targetId ?? null : null,
          visualProfileId: generationVisualProfile?.id,
          visualProfileVersion: generationVisualProfile?.version,
          consistencyMode: generationVisualProfile ? body.consistencyMode : null,
          seed: identityExperimentRun && body.identityExperiment
            ? identityExperimentCandidateSeed({
                strategy: body.identityExperiment.seedStrategy,
                baseSeed: body.identityExperiment.baseSeed,
                sourceSeed: additionalReferenceAssets[0]?.sourceJob?.seed,
                batchId: createdBatch.id,
                variantIndex,
              })
            : productionCandidateSeed({
                baseSeed: generationVisualProfile?.defaultSeed,
                batchId: createdBatch.id,
                directionId: direction?.id ?? null,
                variantIndex,
              }),
          referenceAssetIds: itemReferenceAssetIds.length > 0 ? toInputJson(itemReferenceAssetIds) : undefined,
          referenceSetRevisionId: activeReferenceSet?.id,
          referenceManifest: itemReferenceManifest.length > 0 ? toInputJson(itemReferenceManifest) : undefined,
          mode: productionMode,
          prompt,
          negativePrompt: effectiveNegativePrompt,
          controls: toInputJson(itemControls),
          presetIds: toInputJson(body.presetIds),
          model: workflowKey,
          profileId: profile.profileKey,
          profileVersion: profile.version,
          recipeId: recipe.recipeKey,
          recipeVersion: recipe.version,
          orientation,
          outputCount: 1,
          status: "queued",
          costDreamcoins: perItemCostDreamcoins,
          provider: profile.runner,
          sourceType: "content_production_item",
          sourceId: item.id,
          sourceMeta: toInputJson({
            ...(recipeNegative?.negativeRecipe ? { negativeRecipe: recipeNegative.negativeRecipe, promptRecipeFingerprint: recipeNegative.promptRecipeFingerprint } : {}),
            batchId: createdBatch.id,
            purpose: body.purpose,
            targetType: body.targetType,
            targetId: body.targetId ?? null,
            itemIndex,
            directionId: direction?.id ?? null,
            directionHash,
            variantIndex,
            consistencyMode: visualProfile ? body.consistencyMode : null,
            bootstrapIdentity: body.bootstrapIdentity,
            bootstrapProjectVersion: verifiedBootstrapAuthority?.projectVersion ?? null,
            characterContentVersionId:
              verifiedBootstrapAuthority?.characterContentVersionId ??
              (target?.type === "character" ? target.contentVersionId : null),
            visualBriefHash: verifiedBootstrapAuthority?.visualBriefHash ?? null,
            bootstrapAuthorityState: verifiedIdentityBootstrapAuthority?.state ?? null,
            expectedIdentityHistoryFingerprint:
              verifiedIdentityBootstrapAuthority?.historyFingerprint ?? null,
            expectedIdentityVersion: verifiedIdentityBootstrapAuthority?.nextVersion ?? null,
            referenceSetRevisionId: activeReferenceSet?.id ?? null,
            generationRouteQualificationId: generationRouteAuthority?.qualificationId ?? null,
            generationRouteFingerprint: generationRouteAuthority?.routeFingerprint ?? null,
            videoSourceAssetId:
              characterVideoRun
                ? itemVideoSource?.id ?? additionalReferenceAssets[0]?.id ?? null
                : null,
            ...(itemVideoSourceIdentity ? { videoSourceIdentity: itemVideoSourceIdentity } : {}),
            videoDurationSeconds:
              characterVideoRun
                ? characterVideoProductionRecipe.durationSeconds
                : null,
            routeQualificationEvaluationCandidate: routeEvaluationRun,
            routeQualificationMatrixKey:
              routeEvaluationRun ? body.routeEvaluationMatrixKey ?? null : null,
            routeQualificationMatrixSchemaVersion:
              routeEvaluationRun
                ? characterRouteEvaluationMatrixSchemaVersion
                : null,
            routeQualificationPolicyVersion:
              routeEvaluationRun ? CHARACTER_RELEASE_POLICY_VERSION : null,
            routeQualificationEvaluatorVersion:
              routeEvaluationRun ? env.GENERATION_ROUTE_EVALUATOR_VERSION : null,
            identityExperiment: identityExperimentRun && body.identityExperiment
              ? {
                  mode: body.identityExperiment.mode,
                  positivePrompt: body.brief ?? "",
                  negativePrompt: body.identityExperiment.negativePrompt,
                  seedStrategy: body.identityExperiment.seedStrategy,
                  baseSeed: body.identityExperiment.baseSeed ?? null,
                  sourceAssetId: body.identityExperiment.sourceAssetId ?? null,
                  strength: body.identityExperiment.strength,
                }
              : null,
          }),
        },
      });
      await tx.contentProductionItem.update({
        where: { id: item.id },
        data: { jobId: job.id },
      });
      await appendProductionJobEvent(tx, job.id, "created", "Content production job accepted", {
        batchId: createdBatch.id,
        itemId: item.id,
        purpose: body.purpose,
      });
      await appendProductionJobEvent(tx, job.id, "queued", "Content production job queued", {});
      await reserveInitialGenerationAttempt(tx, {
        requestId: job.id,
        creativeRunItemId: item.id,
        dispatch: {
          outboxId: `creative_initial_${createdBatch.id}_${item.id}`,
          eventType: "creative.generation.dispatch.v2",
          payload: {
            runId: createdBatch.id,
            itemId: item.id,
          },
        },
      });
      return { id: item.id };
    }

    const acceptedRuns: CreatedRun[] = [];
    for (const batch of batches) {
      const items: { id: string }[] = [];
      for (let index = 0; index < workItems.length; index += 1) {
        items.push(await createItem(batch, index));
      }
      acceptedRuns.push({ id: batch.id, items });
    }
    const primaryId = batches[0].id;
    if (idempotencyKey) {
      await tx.controlPlaneCommand.create({
        data: {
          scope: commandScope,
          idempotencyKey,
          commandType: "creative.run.create",
          targetType: "creative_run",
          targetId: primaryId,
          actorId: actor.id,
          requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
          requestHash,
          requestPayload: toInputJson(body),
          retryMode: "idempotent",
          status: "succeeded",
          result: toInputJson({
            batchId: primaryId,
            ...(body.runCount ? { runIds: batches.map(({ id }) => id) } : {}),
          }),
          finishedAt: new Date(),
        },
      });
    }
    for (const createdBatch of batches) {
      await refreshContentProductionBatchStats(tx, createdBatch.id);
      await tx.adminAuditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: "content.production.batch.create",
          targetType: "content_production_batch",
          targetId: createdBatch.id,
          reason: body.reason,
          after: toInputJson({
            purpose: createdBatch.purpose,
            count: createdBatch.totalItems,
            profileId: createdBatch.profileId,
            recipeId: createdBatch.recipeId,
          }),
          requestId: request.headers.get("x-request-id"),
        },
      });
    }
    return { batches: acceptedRuns };
  }, { timeout: 60_000 });
  if ("skip" in result) return { skip: result.skip, replayed };
  const outboxIds = result.batches.flatMap((batch) =>
    batch.items.map((item) => `creative_initial_${batch.id}_${item.id}`),
  );
  await dispatchGenerationAttemptOutbox(prisma, { limit: outboxIds.length, outboxIds });
  return createdRunResponse(result.batches, replayed);
}
