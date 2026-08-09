import {
  characterRouteEvaluationMatrixKey,
  characterRouteEvaluationMatrixSchemaVersion,
  characterVideoProductionRecipe,
} from "@idream/shared";
import { dimensionsForImageOrientation } from "@/server/modules/ourdream/generation-dimensions";
import { generationCostDreamcoins } from "@/server/lib/generation-pricing";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
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
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
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
  lockCharacterGenerationAndMediaAssetAuthorities,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import {
  generationSourceVariationAuthority,
  identityCalibrationGenerationModes,
} from "@/server/modules/admin-v2/characters/generation-route-authority";
import { operationalMediaAssetWhere } from "@/server/modules/metric-data-scope";
import { isProductionLtxVideoProfile } from "@/server/modules/generation/production-video-profile";
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
import { creativeRunCreationDTO, creativeRunInclude } from "./run-projection";

// SPEC: 建一次 Creative Run —— 校验并 pin 生成路线、原子写入 Run + items + Generation
// Request/Attempt + dispatch Outbox + 幂等命令 + 审计，然后投递 dispatch。
// INTENT: 这是「Creative Run 存在」这一事实的唯一写入口。它此前住在按目录命名的
// legacy `admin/content-ops.ts` 里，和 Image Library、Placement 两套不相干的权威共处
// 一个文件，而 v2 路由直接 import 它 —— 权威在 v1 杂物间、调用方在 v2，是错的方向。
// INVARIANT: 角色目标的 Run 恒为一张图（model_eval 例外）；identity/route/source 三类
// 权威都必须在事务内复核一次，preflight 结论不作数。

// SPEC: 入参就是 manifest 为 `POST /api/v2/admin/creative/runs` 声明的 body 契约。
// INTENT: 按 contract ref 取型，而不是 import 请求 schema —— 后者会在 manifest 之外
// 形成第二处契约引用（ADR-13 §2.3.1），api-manifest 守卫会当场拒绝。
export type CreativeRunCreateInput =
  AdminV2RequestBody<"creativeRunCreateRequestSchema+idempotency-key">;

/** Creative Run 创建表单的成本预估：与创建走同一套 profile 准入判断。 */
export async function estimateCreativeRunCost(input: {
  readonly profileId: string;
  readonly count: number;
}) {
  const profile = await resolveProductionProfile(input.profileId);
  const perItemCostDreamcoins = await generationCostDreamcoins(
    "image",
    1,
    profile.costMultiplier ?? 1,
  );
  return {
    perItemCostDreamcoins,
    totalCostDreamcoins: perItemCostDreamcoins * input.count,
  };
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
): Promise<Response> {
  const characterVideoRun = body.purpose === "character_video";
  const productionMode = characterVideoRun ? "video" as const : "image" as const;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;
  const commandScope = `${env.APP_ENV}:${actor.id}:creative.run.create`;
  const requestHash = canonicalSha256({ commandType: "creative.run.create", payload: body });
  if (idempotencyKey) {
    const existing = await prisma.controlPlaneCommand.findUnique({
      where: { scope_idempotencyKey: { scope: commandScope, idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Errors.conflict("Idempotency key was reused with a different Creative Run brief", {
          commandId: existing.id,
        });
      }
      const result = existing.result && typeof existing.result === "object" && !Array.isArray(existing.result)
        ? existing.result as Record<string, unknown>
        : {};
      if (existing.status !== "succeeded" || typeof result.batchId !== "string") {
        throw Errors.conflict("The original Creative Run create command has not completed", {
          commandId: existing.id,
          status: existing.status,
        });
      }
      const batch = await prisma.contentProductionBatch.findUniqueOrThrow({
        where: { id: result.batchId },
        include: creativeRunInclude,
      });
      return ok(
        {
          batch: await creativeRunCreationDTO(batch),
          replayed: true,
        },
        { status: 200 },
      );
    }
  }
  const profile = await resolveProductionProfile(
    body.profileId,
    undefined,
    productionMode,
  );
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
  const recipe = await resolveProductionRecipe(
    body.recipeId,
    body.targetType,
    undefined,
    productionMode,
  );
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
  if (characterTargetRun && !routeEvaluationRun && body.count !== 1) {
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
      workflow.identity.mode !== "none" ||
      workflow.identity.maxReferences !== 0 ||
      !workflow.capabilities.includes("textToImage") ||
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
      !isProductionLtxVideoProfile(profile) ||
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
    workflow.identity.mode !== "none" ||
    workflow.identity.maxReferences !== 0 ||
    !workflow.capabilities.includes("textToImage") ||
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
          sourceJob: {
            select: {
              id: true,
              seed: true,
              sourceType: true,
              sourceId: true,
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
      asset.sourceJob?.visualProfileId !== visualProfile.id ||
      asset.sourceJob.visualProfileVersion !== visualProfile.version ||
      asset.sourceJob.referenceSetRevisionId !== activeReferenceSet.id
    )) {
      throw Errors.conflict("A variation source must be derived from the active Character identity authority");
    }
    const variationSourceItems = additionalReferenceAssets.map((asset) => ({
      assetId: asset.id,
      itemId: asset.sourceJob?.sourceType === "content_production_item"
        ? asset.sourceJob.sourceId
        : null,
    }));
    if (variationSourceItems.some((source) => !source.itemId)) {
      throw Errors.conflict("A variation source must come from a reviewed Creative Run candidate");
    }
    const latestVariationDecisions = await prisma.creativeReviewDecision.findMany({
      where: {
        runItemId: {
          in: variationSourceItems.flatMap((source) =>
            source.itemId ? [source.itemId] : []
          ),
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const latestDecisionByItemId = new Map<string, (typeof latestVariationDecisions)[number]>();
    for (const decision of latestVariationDecisions) {
      if (!latestDecisionByItemId.has(decision.runItemId)) {
        latestDecisionByItemId.set(decision.runItemId, decision);
      }
    }
    if (variationSourceItems.some((source) => {
      if (!source.itemId) return true;
      const decision = latestDecisionByItemId.get(source.itemId);
      return decision?.artifactId !== source.assetId || decision.decision !== "approved";
    })) {
      throw Errors.conflict(
        "A variation source requires the latest immutable Creative Run decision to be approved",
      );
    }
  }
  const presets = await prisma.generationPreset.findMany({
    where: { id: { in: body.presetIds }, scope: "built_in", status: "active" },
  });
  if (presets.length !== body.presetIds.length) {
    throw Errors.badRequest("Production batch presets must be active built-in presets");
  }
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  const orientation = body.orientation ?? allowedOrientations[0] ?? "4:5";
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
  const perItemCostDreamcoins = await generationCostDreamcoins(
    productionMode,
    1,
    profile.costMultiplier ?? 1,
  );
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

  let replayed = false;
  const batch = await auditedTransaction("content.production.batch.create", async (tx) => {
    if (idempotencyKey) {
      await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext(${`${commandScope}:${idempotencyKey}`}))`;
      const existing = await tx.controlPlaneCommand.findUnique({
        where: { scope_idempotencyKey: { scope: commandScope, idempotencyKey } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw Errors.conflict("Idempotency key was reused with a different Creative Run brief", {
            commandId: existing.id,
          });
        }
        const result = existing.result && typeof existing.result === "object" && !Array.isArray(existing.result)
          ? existing.result as Record<string, unknown>
          : {};
        if (existing.status !== "succeeded" || typeof result.batchId !== "string") {
          throw Errors.conflict("The original Creative Run create command has not completed", {
            commandId: existing.id,
            status: existing.status,
          });
        }
        replayed = true;
        return tx.contentProductionBatch.findUniqueOrThrow({
          where: { id: result.batchId },
          include: creativeRunInclude,
        });
      }
    }
    if (body.targetType === "character" && body.targetId) {
      await lockCharacterGenerationAndMediaAssetAuthorities(
        tx,
        body.targetId,
        referenceAssetIds,
      );
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
    }
    let verifiedBootstrapAuthority = bootstrapAuthority;
    let verifiedIdentityBootstrapAuthority = identityBootstrapAuthority;
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
      const currentSource = await tx.mediaAsset.findFirst({
        where: operationalMediaAssetWhere({
          id: additionalReferenceAssets[0]?.id,
          type: "image",
          safetyStatus: "passed",
          deletedAt: null,
          characterId: body.targetId,
        }),
        select: { id: true, metadata: true },
      });
      if (
        !currentProfile ||
        !isProductionLtxVideoProfile(currentProfile) ||
        currentProfile.id !== profile.id ||
        !currentRecipe ||
        currentRecipe.recipeKey !== recipe.recipeKey ||
        currentRecipe.version !== recipe.version ||
        currentRecipe.mode !== "video" ||
        currentRecipe.useCase !== "character" ||
        currentRecipe.status !== "active" ||
        !currentSource ||
        !isMediaAssetOperationalForAuthority(currentSource.metadata)
      ) {
        throw Errors.conflict(
          "Character video authority changed before the Run was committed",
          {
            characterId: body.targetId,
            sourceAssetId: additionalReferenceAssets[0]?.id ?? null,
          },
        );
      }
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
              sourceJob: {
                select: {
                  id: true,
                  sourceType: true,
                  sourceId: true,
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
      const currentSourceItems = currentAdditionalReferenceAssets.map((asset) => ({
        assetId: asset.id,
        itemId: asset.sourceJob?.sourceType === "content_production_item"
          ? asset.sourceJob.sourceId
          : null,
        sourceJob: asset.sourceJob,
      }));
      const currentSourceDecisions = currentSourceItems.length > 0
        ? await tx.creativeReviewDecision.findMany({
            where: {
              runItemId: {
                in: currentSourceItems.flatMap((source) => source.itemId ? [source.itemId] : []),
              },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          })
        : [];
      const currentLatestDecisionByItemId = new Map<string, (typeof currentSourceDecisions)[number]>();
      for (const decision of currentSourceDecisions) {
        if (!currentLatestDecisionByItemId.has(decision.runItemId)) {
          currentLatestDecisionByItemId.set(decision.runItemId, decision);
        }
      }
      const sourceAuthorityChanged =
        currentAdditionalReferenceAssets.length !== additionalReferenceAssets.length ||
        currentSourceItems.some((source) => {
          if (
            !source.itemId ||
            source.sourceJob?.visualProfileId !== visualProfile.id ||
            source.sourceJob.visualProfileVersion !== visualProfile.version ||
            source.sourceJob.referenceSetRevisionId !== activeReferenceSet.id
          ) return true;
          const decision = currentLatestDecisionByItemId.get(source.itemId);
          return decision?.artifactId !== source.assetId || decision.decision !== "approved";
        });
      if (sourceAuthorityChanged) {
        throw Errors.conflict("Variation source authority changed before the Run was committed", {
          deepLink: `/admin/characters/${body.targetId}?tab=assets`,
        });
      }
    }
    const createdBatch = await tx.contentProductionBatch.create({
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
        estimatedCostDreamcoins: perItemCostDreamcoins * totalOutputCount,
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

    for (let itemIndex = 0; itemIndex < workItems.length; itemIndex += 1) {
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
        target,
        recipeBody: recipe.body,
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
          referenceAssetIds: referenceAssetIds.length > 0 ? toInputJson(referenceAssetIds) : undefined,
          referenceSetRevisionId: activeReferenceSet?.id,
          referenceManifest: referenceManifest.length > 0 ? toInputJson(referenceManifest) : undefined,
          mode: productionMode,
          prompt,
          negativePrompt: productionNegativePrompt(
            recipe.negativeBase,
            identityExperimentRun
              ? body.identityExperiment?.negativePrompt
              : generationVisualProfile?.negativeIdentityPrompt,
            body.purpose,
          ),
          controls: toInputJson(controls),
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
                ? additionalReferenceAssets[0]?.id ?? null
                : null,
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
    }

    await refreshContentProductionBatchStats(tx, createdBatch.id);
    if (idempotencyKey) {
      await tx.controlPlaneCommand.create({
        data: {
          scope: commandScope,
          idempotencyKey,
          commandType: "creative.run.create",
          targetType: "creative_run",
          targetId: createdBatch.id,
          actorId: actor.id,
          requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
          requestHash,
          requestPayload: toInputJson(body),
          retryMode: "idempotent",
          status: "succeeded",
          result: toInputJson({ batchId: createdBatch.id }),
          finishedAt: new Date(),
        },
      });
    }
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
    return tx.contentProductionBatch.findUniqueOrThrow({
      where: { id: createdBatch.id },
      include: creativeRunInclude,
    });
  });
  await dispatchGenerationAttemptOutbox(prisma, {
    limit: totalOutputCount,
    outboxIds: batch.items.map((item) => `creative_initial_${batch.id}_${item.id}`),
  });
  return ok(
    { batch: await creativeRunCreationDTO(batch), replayed },
    { status: replayed ? 200 : 202 },
  );
}
