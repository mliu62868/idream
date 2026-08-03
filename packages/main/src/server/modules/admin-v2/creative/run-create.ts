import type { Prisma } from "@prisma/client";
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
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/release-executor";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "@/server/modules/admin-v2/characters/release-snapshot";
import { loadCharacterIdentityBootstrapAuthority } from "@/server/modules/admin-v2/characters/identity-bootstrap-authority";
import { characterReferenceAuthorityFrom } from "@/server/modules/admin-v2/characters/reference-authority";
import {
  lockCharacterGenerationAndMediaAssetAuthorities,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import {
  generationSourceVariationAuthority,
  identityCalibrationGenerationModes,
} from "@/server/modules/admin-v2/characters/generation-route-authority";
import { operationalMediaAssetWhere } from "@/server/modules/metric-data-scope";
import { isProductionLtxVideoProfile } from "@/server/modules/generation/production-video-profile";
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
type CreativeRunCreateInput =
  AdminV2RequestBody<"creativeRunCreateRequestSchema+idempotency-key">;

// INTENT: 与 legacy admin 的 `toInputJson` 逐字同义（裸 cast），**不是**
// admin-v2/shared/prisma-json 的 JSON round-trip 版本 —— 后者会把 Decimal /
// Date 提前序列化，写进 referenceManifest 与 sourceMeta 的值就变了。
function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

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
      const [currentBootstrapAuthority, currentIdentityBootstrapAuthority] = await Promise.all([
        resolveProductionBootstrapAuthority(tx, body.targetId, body.brief ?? null),
        loadCharacterIdentityBootstrapAuthority(tx, body.targetId),
      ]);
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
      const [currentProfile, currentRecipe, currentSource] = await Promise.all([
        tx.generationModelProfile.findUnique({
          where: { id: profile.id },
        }),
        tx.generationRecipe.findUnique({
          where: { id: recipe.id },
          select: {
            id: true,
            recipeKey: true,
            version: true,
            mode: true,
            useCase: true,
            status: true,
          },
        }),
        tx.mediaAsset.findFirst({
          where: operationalMediaAssetWhere({
            id: additionalReferenceAssets[0]?.id,
            type: "image",
            safetyStatus: "passed",
            deletedAt: null,
            characterId: body.targetId,
          }),
          select: { id: true, metadata: true },
        }),
      ]);
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

async function resolveProductionProfile(
  profileId: string,
  version?: number,
  mode: "image" | "video" = "image",
) {
  const profile = await prisma.generationModelProfile.findFirst({
    where: {
      mode,
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
      version,
      OR: [{ id: profileId }, { profileKey: profileId }],
    },
    orderBy: { version: "desc" },
  });
  if (!profile) {
    throw Errors.badRequest(
      `Production Studio requires an active ${mode} profile`,
    );
  }
  if (mode === "video" && !isProductionLtxVideoProfile(profile)) {
    throw Errors.conflict(
      "Production Studio only accepts the exact pinned Character video profile",
      { profileId, version: version ?? null },
    );
  }
  return profile;
}

async function resolveProductionRecipe(
  recipeId: string | undefined,
  targetType: string,
  version?: number,
  mode: "image" | "video" = "image",
) {
  const useCase = targetType === "character" ? "character" : "freeplay";
  const recipe = await prisma.generationRecipe.findFirst({
    where: recipeId
      ? {
          mode,
          status: "active",
          version,
          OR: [{ id: recipeId }, { recipeKey: recipeId }],
        }
      : {
          mode,
          status: "active",
          useCase,
        },
    orderBy: { version: "desc" },
  });
  if (!recipe) {
    throw Errors.badRequest(
      `Production Studio requires an active ${mode} prompt recipe`,
    );
  }
  return recipe;
}

async function resolveProductionTarget(targetType: string, targetId?: string) {
  if (targetType === "none" || !targetId) return null;
  if (targetType === "character") {
    const [character, content] = await Promise.all([
      prisma.character.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          name: true,
          age: true,
          gender: true,
          style: true,
          description: true,
        },
      }),
      prisma.characterContentVersion.findFirst({
        where: { characterId: targetId },
        orderBy: { version: "desc" },
        select: {
          id: true,
          version: true,
          personaSnapshot: true,
          appearanceSnapshot: true,
        },
      }),
    ]);
    if (!character) throw Errors.badRequest("Target character not found");
    const persona = jsonRecord(content?.personaSnapshot);
    const appearance = jsonRecord(content?.appearanceSnapshot);
    const name = stringFromRecord(persona, "name") ?? character.name;
    const age = numberFromRecord(persona, "age") ?? character.age;
    const gender = stringFromRecord(persona, "gender") ?? character.gender;
    const style = stringFromRecord(appearance, "style") ?? character.style;
    const description =
      stringFromRecord(persona, "characterPromise") ??
      stringFromRecord(persona, "description") ??
      character.description;
    const identityTraits = [
      stringFromRecord(appearance, "identityAnchor"),
      ...jsonStringArray(appearance.stableTraits),
    ].filter((value): value is string => Boolean(value));
    return {
      type: "character",
      id: character.id,
      label: name,
      detail: `${age}, ${gender}, ${style}. ${description}`,
      visualIdentity: {
        age,
        gender,
        style,
        traits: identityTraits,
        artDirection:
          stringFromRecord(appearance, "referenceDirection") ?? null,
      },
      contentVersionId: content?.id ?? null,
      contentVersion: content?.version ?? null,
    };
  }
  if (targetType === "template") {
    const template = await prisma.characterTemplate.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, summary: true, gender: true, style: true },
    });
    if (!template) throw Errors.badRequest("Target template not found");
    return {
      type: "template",
      id: template.id,
      label: template.name,
      detail: [template.summary, template.gender, template.style].filter(Boolean).join(", "),
      visualIdentity: null,
    };
  }
  return {
    type: targetType,
    id: targetId,
    label: targetId,
    detail: "",
    visualIdentity: null,
  };
}

async function resolveProductionVisualProfile(
  db: Pick<Prisma.TransactionClient, "characterVisualProfile">,
  targetType: string,
  targetId?: string,
) {
  if (targetType !== "character" || !targetId) return null;
  return db.characterVisualProfile.findFirst({
    where: { characterId: targetId, status: "active" },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      style: true,
      identityPrompt: true,
      negativeIdentityPrompt: true,
      faceTraits: true,
      hairTraits: true,
      bodyTraits: true,
      signatureTraits: true,
      styleTraits: true,
      defaultSeed: true,
      anchorAssetIds: true,
      immutableHash: true,
      evidenceState: true,
      // 运营生图的 payload 锚点要和付费主链路同口径：由 active Reference Set 的 role 现算。
      referenceSetRevisions: {
        where: { status: "active" },
        orderBy: { revision: "desc" },
        take: 1,
        select: {
          id: true,
          revision: true,
          references: {
            orderBy: { position: "asc" },
            select: { mediaAssetId: true, role: true },
          },
        },
      },
    },
  });
}

async function resolveProductionReferenceSet(
  db: Pick<Prisma.TransactionClient, "referenceSetRevision">,
  visualProfileId: string,
) {
  return db.referenceSetRevision.findFirst({
    where: { visualProfileId, status: "active" },
    include: {
      references: {
        include: { mediaAsset: true },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { revision: "desc" },
  });
}

async function resolveProductionBootstrapAuthority(
  db: Pick<Prisma.TransactionClient, "characterProject" | "characterContentVersion">,
  characterId: string,
  brief: string | null,
) {
  const [project, content] = await Promise.all([
    db.characterProject.findFirst({
      where: { characterId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, version: true, phase: true },
    }),
    db.characterContentVersion.findFirst({
      where: { characterId },
      orderBy: { version: "desc" },
      select: { id: true, appearanceSnapshot: true },
    }),
  ]);
  if (!project || !content || !["idea", "planned", "producing"].includes(project.phase)) return null;
  return {
    projectId: project.id,
    projectVersion: project.version,
    characterContentVersionId: content.id,
    visualBriefHash: canonicalSha256({
      characterContentVersionId: content.id,
      appearanceSnapshot: content.appearanceSnapshot,
      brief,
    }),
  };
}

function generationProfileCapabilities(value: Prisma.JsonValue | null) {
  const capabilities = jsonRecord(jsonRecord(value).capabilities);
  return {
    textToImage: capabilities.textToImage === true,
    referenceImages: capabilities.referenceImages === true,
    initImage: capabilities.initImage === true,
  };
}

function productionConsistencyPrompt(
  mode: CreativeRunCreateInput["consistencyMode"],
) {
  if (mode === "strict") {
    return "Identity consistency: strict; preserve the locked face, hairstyle, body type, and signature traits.";
  }
  if (mode === "creative") {
    return "Identity consistency: creative; explore composition and styling while preserving the core locked identity.";
  }
  return "Identity consistency: balanced; preserve the locked identity while allowing the requested scene, pose, outfit, and lighting.";
}

function productionPrompt(input: {
  purpose: CreativeRunCreateInput["purpose"];
  target: Awaited<ReturnType<typeof resolveProductionTarget>>;
  recipeBody: string;
  presetFragment: string;
  brief?: string;
  visualProfile: Awaited<ReturnType<typeof resolveProductionVisualProfile>>;
  consistencyMode: CreativeRunCreateInput["consistencyMode"];
}) {
  if (
    input.purpose === "character_video" &&
    input.target?.type === "character"
  ) {
    return [
      `Create one continuous ${characterVideoProductionRecipe.durationSeconds}-second image-to-video portrait clip.`,
      `Target character: ${input.target.label}.`,
      "The pinned source image is the exact identity, appearance, composition, and first-frame authority.",
      `Recipe: ${input.recipeBody}`,
      input.brief ? `Operator motion brief: ${input.brief}` : "",
      "Use subtle natural motion, stable facial identity, coherent anatomy, and a steady single camera take.",
      "Do not cut, reframe, duplicate the person, introduce another person, add captions, or replace the background.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (
    input.purpose === "identity_calibration" &&
    input.target?.type === "character" &&
    input.target.visualIdentity
  ) {
    const visualIdentity = input.target.visualIdentity;
    return [
      "Single uninterrupted portrait photograph.",
      `Subject: ${input.target.label}, an adult ${visualIdentity.age}-year-old ${visualIdentity.gender}.`,
      `Visual style: ${visualIdentity.style}.`,
      visualIdentity.traits.length > 0
        ? `Identity traits: ${visualIdentity.traits.join("; ")}.`
        : "",
      visualIdentity.artDirection
        ? `Art direction: ${visualIdentity.artDirection}.`
        : "",
      input.brief ? `Operator visual brief: ${input.brief}` : "",
      "Composition: one person centered in one continuous camera frame, with a coherent background and clear subject framing.",
      "Polished reusable portrait photography.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const targetPrompt = !input.target
    ? ""
    : input.target.type === "character" && input.visualProfile
      ? `Target character: ${input.target.label}. The Operator brief is the authority for the current scene; do not import people, setting, or events from the character synopsis.`
      : `Target ${input.target.type}: ${input.target.label}. ${input.target.detail}`;
  return [
    `Production purpose: ${purposeLabel(input.purpose)}.`,
    targetPrompt,
    input.visualProfile ? `Locked identity: ${input.visualProfile.identityPrompt}` : "",
    input.visualProfile ? productionConsistencyPrompt(input.consistencyMode) : "",
    `Recipe: ${input.recipeBody}`,
    input.presetFragment ? `Presets: ${input.presetFragment}` : "",
    input.brief ? `Operator brief: ${input.brief}` : "",
    input.target?.type === "character"
      ? "Composition guard: render exactly one person total—the target character—with no background people, duplicated person, collage, contact sheet, split panel, or comparison grid."
      : "",
    "Generate a polished, reusable platform image with clear subject framing and no text overlay.",
  ]
    .filter(Boolean)
    .join("\n");
}

function productionControls(input: {
  orientation: string;
  dimensions: { width: number; height: number };
  profile: {
    profileKey: string;
    version: number;
    runner: string;
    pipelineModel: string;
    sourceModelPath: string | null;
    convertedModelPath: string | null;
    modelFormat: string;
    runnerConfig: Prisma.JsonValue | null;
    steps: number;
    sampler: string;
    scheduler: string;
    cfgScale: number;
    defaultWidth: number;
    defaultHeight: number;
  };
  presets: Array<{ id: string; type: string }>;
  visualProfile: Awaited<ReturnType<typeof resolveProductionVisualProfile>>;
  consistencyMode: CreativeRunCreateInput["consistencyMode"];
  referenceAssetIds: readonly string[];
  workflowIdentity: {
    mode: string;
    maxReferences: number;
    acceptedRoles: readonly string[];
    supportsLookReference: boolean;
    supportsSourceImageWithIdentity: boolean;
  } | undefined;
  generationRouteFingerprint?: string;
  compositionRequirement?: "single_subject_single_frame";
}) {
  // 锚点由 active Reference Set 的 role 现算，与 service.ts 的付费生成路径同口径；
  // 此前这里读 profile 影子列，两条生图路径对「哪几张是身份锚点」的判断可能不一致。
  const anchorAssetIds = [
    ...(characterReferenceAuthorityFrom(
      input.visualProfile?.referenceSetRevisions[0],
    )?.anchors ?? []),
  ];
  const referenceAssetIds = [...new Set(input.referenceAssetIds)];
  return pruneUndefined({
    orientation: input.orientation,
    model: input.profile.profileKey,
    profileId: input.profile.profileKey,
    width: input.dimensions.width,
    height: input.dimensions.height,
    backgroundPresetId: presetIdForType(input.presets, "background"),
    posePresetId: presetIdForType(input.presets, "pose"),
    outfitPresetId: presetIdForType(input.presets, "outfit"),
    modePresetId: presetIdForType(input.presets, "mode"),
    consistencyMode: input.visualProfile ? input.consistencyMode : undefined,
    workflowIdentity: input.workflowIdentity,
    generationRouteFingerprint: input.generationRouteFingerprint,
    compositionRequirement: input.compositionRequirement,
    visualIdentity: input.visualProfile
      ? {
          visualProfileId: input.visualProfile.id,
          visualProfileVersion: input.visualProfile.version,
          consistencyMode: input.consistencyMode,
          anchorAssetIds,
          referenceAssetIds,
          seed: input.visualProfile.defaultSeed,
        }
      : undefined,
    contentProduction: true,
  });
}

function productionNegativePrompt(
  base: string | null,
  identity: string | null | undefined,
  purpose: CreativeRunCreateInput["purpose"],
) {
  if (purpose === "character_video") {
    return [
      base?.trim(),
      "identity drift, face morphing, flicker, jitter, camera cut, reframing, duplicate person, extra people, text, watermark",
    ].filter(Boolean).join(", ");
  }
  const characterCompositionGuard =
    purpose.startsWith("character_") || purpose === "identity_calibration"
    ? "collage, contact sheet, split screen, multiple panels, comparison grid, duplicate person, extra people"
    : null;
  return [base?.trim(), identity?.trim(), characterCompositionGuard].filter(Boolean).join(", ") || null;
}

function presetIdForType(presets: Array<{ id: string; type: string }>, type: string) {
  return presets.find((preset) => preset.type === type)?.id;
}

function presetPromptFragment(
  orderedIds: string[],
  presets: Array<{ id: string; label: string; controls: Prisma.JsonValue }>,
) {
  const fragments: string[] = [];
  for (const id of orderedIds) {
    const preset = presets.find((item) => item.id === id);
    if (!preset) continue;
    const controls = jsonRecord(preset.controls);
    const values = Object.values(controls)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    fragments.push(values.length ? values.join(", ") : preset.label);
  }
  return fragments.join(", ");
}

async function appendProductionJobEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  return tx.generationJobEvent.create({
    data: {
      jobId,
      type,
      message,
      metadata: toInputJson(metadata),
    },
  });
}

function purposeLabel(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function parseOptionalDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw Errors.badRequest("Invalid scheduledAt value");
  return date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function numberFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}

function pruneUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}
