import { prisma } from "@/server/lib/db";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { deriveCreativeRunState, type CreativeRunLedgerFact } from "@/server/modules/admin/content-production-state";
import { toInputJson } from "../shared/prisma-json";
import {
  isCreativePlacementVerificationTransitionAllowed,
  isCreativeRunItemTransitionAllowed,
  isCreativeRunLifecycleTransitionAllowed,
  isCreativeRunVerificationTransitionAllowed,
  isCreativeRunWorkflowTransitionAllowed,
} from "../shared/state-transition-authority";
import { resolveCommunityCampaignPlacements } from "@/server/modules/ourdream/community-campaigns";
import {
  creativeRunCreateOptionsSchema,
  creativeRunListResponseSchema,
  creativeRunQuerySchema,
} from "@idream/shared/admin";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  parseIsoCursorKey,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { creativeReviewQuality } from "@/server/modules/admin-v2/shared/creative-review-quality";
import { operationalContentProductionBatchWhere } from "@/server/modules/admin/shared/metric-data-scope";
import {
  CREATIVE_MEDIA_AUTHORITY_METADATA_KEY,
  evaluateCreativeMediaAuthority,
  parseCreativeMediaAuthorityEvidence,
  type CreativeMediaProviderSnapshot,
} from "@/server/lib/creative-media-authority";
import { generationWorkflowDescriptor } from "@/server/modules/admin/generation-catalog";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";

const RELEASE_OWNED_SLOTS = new Set(["character_avatar", "character_hero", "character_chat"]);

function latestByCreatedAt<T extends { id: string; createdAt: Date }>(rows: readonly T[]): T | null {
  return [...rows].sort((left, right) =>
    right.createdAt.getTime() - left.createdAt.getTime() ||
    right.id.localeCompare(left.id)
  )[0] ?? null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function jsonContainsString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((entry) => jsonContainsString(entry, expected));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .some((entry) => jsonContainsString(entry, expected));
  }
  return false;
}

async function characterAssetReviewDependencies(
  tx: Prisma.TransactionClient,
  characterId: string,
  assetId: string,
) {
  const character = await tx.character.findUnique({
    where: { id: characterId },
    select: { imageAssetId: true },
  });
  const project = await tx.characterProject.findFirst({
    where: { characterId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, draftImageAssetId: true, draftAssetPack: true },
  });
  const activeProfiles = await tx.characterVisualProfile.findMany({
    where: { characterId, status: "active" },
    select: { id: true, anchorAssetIds: true, referenceAssetIds: true },
  });
  const activeReference = await tx.characterVisualReferenceSnapshot.findFirst({
    where: {
      mediaAssetId: assetId,
      referenceSetRevision: {
        status: "active",
        visualProfile: { characterId, status: "active" },
      },
    },
    select: { referenceSetRevisionId: true },
  });
  const activeLook = await tx.characterLook.findFirst({
    where: {
      characterId,
      referenceAssetId: assetId,
      status: { in: ["active", "needs_rebase"] },
    },
    select: { id: true },
  });
  const serving = await tx.characterServing.findUnique({
    where: { characterId },
    include: { currentRelease: true, scheduledRelease: true },
  });
  const dependencies: string[] = [];
  const activeRelease = project
    ? await tx.characterRelease.findFirst({
        where: {
          projectId: project.id,
          status: { in: ["draft", "validating", "in_review", "approved"] },
        },
        select: { id: true, releasePlacementManifest: true },
      })
    : null;
  const downstreamGeneration = await tx.generationJob.findFirst({
    where: {
      characterId,
      status: {
        in: [
          "queued",
          "moderating_input",
          "running",
          "moderating_output",
          "completed",
        ],
      },
      OR: [
        { referenceAssetIds: { array_contains: [assetId] } },
        {
          referenceManifest: {
            array_contains: [{ mediaAssetId: assetId }],
          },
        },
        {
          controls: {
            path: ["sourceImageAssetId"],
            equals: assetId,
          },
        },
      ],
    },
    select: { id: true },
  });
  if (character?.imageAssetId === assetId) dependencies.push("live_character_image");
  if (
    project?.draftImageAssetId === assetId ||
    (project && jsonContainsString(project.draftAssetPack, assetId))
  ) {
    dependencies.push("character_project_draft");
  }
  if (activeProfiles.some((profile) =>
    [
      ...strings(profile.anchorAssetIds),
      ...strings(profile.referenceAssetIds),
    ].includes(assetId)
  )) {
    dependencies.push("active_visual_identity");
  }
  if (activeReference) dependencies.push("active_reference_set");
  if (activeLook) dependencies.push("active_character_look");
  if (
    activeRelease &&
    jsonContainsString(activeRelease.releasePlacementManifest, assetId)
  ) {
    dependencies.push("active_character_release");
  }
  if (
    serving?.currentRelease &&
    jsonContainsString(serving.currentRelease.releasePlacementManifest, assetId)
  ) {
    dependencies.push("current_character_release");
  }
  if (
    serving?.scheduledRelease &&
    jsonContainsString(serving.scheduledRelease.releasePlacementManifest, assetId)
  ) {
    dependencies.push("scheduled_character_release");
  }
  if (downstreamGeneration) dependencies.push("downstream_generation_lineage");
  return dependencies;
}

function creativeDirectionSnapshot(value: unknown) {
  const direction = record(value);
  const required = ["title", "scenePrompt", "mood", "setting", "outfit", "camera", "lighting"] as const;
  if (required.some((key) => typeof direction[key] !== "string" || direction[key].trim().length === 0)) {
    return null;
  }
  return Object.fromEntries(required.map((key) => [key, String(direction[key]).trim()])) as {
    title: string;
    scenePrompt: string;
    mood: string;
    setting: string;
    outfit: string;
    camera: string;
    lighting: string;
  };
}

const GENERIC_CREATIVE_PURPOSES = [
  {
    value: "campaign",
    label: "Campaign",
    description: "Create a reviewed campaign image that can be verified against the live campaign surface.",
    defaultOrientation: "16:9",
    runtimePlacementSupported: true,
  },
  {
    value: "homepage",
    label: "Homepage feature",
    description: "Create a homepage candidate for review and handoff. Live placement is not yet automated.",
    defaultOrientation: "16:9",
    runtimePlacementSupported: false,
  },
  {
    value: "feed",
    label: "Feed image",
    description: "Create a feed-ready image for review and downstream curation.",
    defaultOrientation: "1:1",
    runtimePlacementSupported: false,
  },
  {
    value: "seo",
    label: "SEO image",
    description: "Create a search or editorial image for review and downstream publishing.",
    defaultOrientation: "16:9",
    runtimePlacementSupported: false,
  },
  {
    value: "template_cover",
    label: "Template cover",
    description: "Create a reusable template cover for review and downstream adoption.",
    defaultOrientation: "4:5",
    runtimePlacementSupported: false,
  },
] as const;

export async function getCreativeRunCreateOptions(input: {
  readonly actor: AdminActor;
}) {
  void input.actor;
  const [profiles, recipe] = await Promise.all([
    prisma.generationModelProfile.findMany({
      where: {
        mode: "image",
        status: "active",
        enabled: true,
        rolloutPercent: { gt: 0 },
      },
      orderBy: [{ publishedAt: "desc" }, { version: "desc" }, { profileKey: "asc" }],
      take: 80,
    }),
    prisma.generationRecipe.findFirst({
      where: { mode: "image", useCase: "freeplay", status: "active" },
      select: { id: true },
    }),
  ]);
  const compatible: Array<{
    profileKey: string;
    profileVersion: number;
    label: string;
    workflowKey: string;
    workflowVersion: number;
    allowedOrientations: string[];
    requiredEntitlement: string | null;
  }> = [];
  for (const profile of profiles) {
    const workflowKey = profile.workflowKey ?? profile.pipelineModel;
    const workflow = await generationWorkflowDescriptor(workflowKey);
    const capabilities = record(record(profile.runnerConfig).capabilities);
    if (
      !workflow ||
      workflow.identity.mode !== "none" ||
      workflow.identity.maxReferences !== 0 ||
      !workflow.capabilities.includes("textToImage") ||
      capabilities.textToImage !== true
    ) {
      continue;
    }
    const allowedOrientations = strings(profile.allowedOrientations);
    compatible.push({
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      label: profile.label,
      workflowKey,
      workflowVersion: workflow.version,
      allowedOrientations: allowedOrientations.length > 0 ? allowedOrientations : ["1:1"],
      requiredEntitlement: profile.requiredEntitlement,
    });
  }
  compatible.sort((left, right) =>
    Number(Boolean(left.requiredEntitlement)) - Number(Boolean(right.requiredEntitlement)) ||
    left.profileKey.localeCompare(right.profileKey) ||
    right.profileVersion - left.profileVersion
  );
  return creativeRunCreateOptionsSchema.parse({
    purposes: GENERIC_CREATIVE_PURPOSES,
    profiles: compatible.map((profile, index) => ({
      profileKey: profile.profileKey,
      profileVersion: profile.profileVersion,
      label: profile.label,
      workflowKey: profile.workflowKey,
      workflowVersion: profile.workflowVersion,
      allowedOrientations: profile.allowedOrientations,
      recommended: index === 0,
    })),
    readiness: {
      ready: compatible.length > 0 && Boolean(recipe),
      blocker: compatible.length === 0
        ? "No compatible text-to-image route is currently available."
        : !recipe
          ? "No active freeplay image recipe is currently available."
          : null,
    },
    characterAssetStudioHref: "/admin/characters",
  });
}

async function creativeMediaProviderSnapshot(
  tx: Prisma.TransactionClient,
  asset: { readonly sourceJobId: string | null },
): Promise<CreativeMediaProviderSnapshot> {
  if (!asset.sourceJobId) {
    return {
      sourceJobId: null,
      jobProvider: null,
      latestAttemptProvider: null,
    };
  }
  const job = await tx.generationJob.findUnique({
    where: { id: asset.sourceJobId },
    select: { provider: true },
  });
  const latestAttempt = await tx.generationAttempt.findFirst({
    where: {
      requestId: asset.sourceJobId,
      status: "succeeded",
    },
    orderBy: { attemptNo: "desc" },
    select: { provider: true },
  });
  return {
    sourceJobId: asset.sourceJobId,
    jobProvider: job?.provider ?? null,
    latestAttemptProvider: latestAttempt?.provider ?? null,
  };
}

async function assertCustomerPublishableCreativeAsset(
  tx: Prisma.TransactionClient,
  asset: {
    readonly id: string;
    readonly metadata: unknown;
    readonly sourceJobId: string | null;
  },
  pinned?: CreativeMediaProviderSnapshot,
  options?: {
    readonly requireCompleteProviderAuthority?: boolean;
  },
) {
  const current = await creativeMediaProviderSnapshot(tx, asset);
  const authority = evaluateCreativeMediaAuthority({
    metadata: asset.metadata,
    current,
    pinned,
    requireCompleteProviderAuthority:
      options?.requireCompleteProviderAuthority,
  });
  if (authority.publishable) return authority.snapshot;
  throw Errors.badRequest(
    "Synthetic or mock-provider media cannot become customer-facing Creative authority",
    {
      code: "creative_asset_not_customer_publishable",
      mediaAssetId: asset.id,
      reasons: authority.reasons,
    },
  );
}

export function creativeIdentityReviewMode(input: {
  readonly purpose: string;
  readonly sourceMeta: unknown;
}) {
  if (input.purpose === "model_eval") {
    return "preserves_identity" as const;
  }
  if (input.purpose === "identity_calibration") {
    return "defines_identity" as const;
  }
  if (!["character_cover", "character_hero", "character_chat"].includes(input.purpose)) {
    return "not_applicable" as const;
  }
  return record(input.sourceMeta).bootstrapIdentity === true
    ? "defines_identity" as const
    : "preserves_identity" as const;
}

export function approvedIdentityConsistencyForMode(
  mode: ReturnType<typeof creativeIdentityReviewMode>,
) {
  if (mode === "defines_identity") return "unscored" as const;
  if (mode === "preserves_identity") return "passed" as const;
  return null;
}

export async function attachCreativeRunToIncident(input: {
  readonly runId: string;
  readonly incidentId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const run = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
      include: { items: { select: { jobId: true } } },
    });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before Incident attachment", { currentVersion: run.version });
    }
    const incident = await tx.opsIncident.findUnique({ where: { id: input.incidentId } });
    if (!incident || ["resolved", "closed"].includes(incident.status)) {
      throw Errors.conflict("Only an active Incident can receive Creative Run occurrences");
    }
    const requestIds = run.items.flatMap((item) => item.jobId ? [item.jobId] : []);
    const attempts = await tx.generationAttempt.findMany({
      where: { requestId: { in: requestIds }, status: { in: ["failed", "unknown"] } },
      orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
    });
    const latestAttempts = [...new Map(attempts.map((attempt) => [attempt.requestId, attempt])).values()];
    if (latestAttempts.length === 0) {
      throw Errors.conflict("Creative Run has no failed or unknown Attempt to attach");
    }
    const existing = await tx.opsIncidentOccurrence.findMany({
      where: { attemptId: { in: latestAttempts.map((attempt) => attempt.id) } },
    });
    const conflicting = existing.find((occurrence) => occurrence.incidentId !== incident.id);
    if (conflicting) {
      throw Errors.conflict("A Creative failure already belongs to another Incident", {
        occurrenceId: conflicting.id,
        incidentId: conflicting.incidentId,
        deepLink: `/admin/ops/incidents/${conflicting.incidentId}`,
      });
    }
    const attachedAttemptIds = new Set(existing.map((occurrence) => occurrence.attemptId));
    const toCreate = latestAttempts.filter((attempt) => !attachedAttemptIds.has(attempt.id));
    if (toCreate.length > 0) {
      await tx.opsIncidentOccurrence.createMany({
        data: toCreate.map((attempt) => ({
          incidentId: incident.id,
          requestId: attempt.requestId,
          attemptId: attempt.id,
          occurrenceKey: `creative_manual:${run.id}:${attempt.id}`,
          observedAt: attempt.finishedAt ?? attempt.createdAt,
        })),
      });
    }
    const now = new Date();
    const impact = record(incident.impact);
    const creativeRunIds = Array.isArray(impact.creativeRunIds)
      ? impact.creativeRunIds.filter((value): value is string => typeof value === "string")
      : [];
    const updatedIncident = await tx.opsIncident.update({
      where: { id: incident.id },
      data: {
        impact: toInputJson({ ...impact, creativeRunIds: [...new Set([...creativeRunIds, run.id])] }),
        lastSeen: now,
        version: { increment: 1 },
      },
    });
    const updatedRun = await tx.contentProductionBatch.update({
      where: { id: run.id },
      data: { version: { increment: 1 } },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.run.incident_attached",
        targetType: "creative_run",
        targetId: run.id,
        reason: input.reason,
        after: toInputJson({
          incidentId: incident.id,
          occurrenceCount: latestAttempts.length,
          createdOccurrenceCount: toCreate.length,
          runVersion: updatedRun.version,
          incidentVersion: updatedIncident.version,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "creative.run.incident_attached.v2",
        aggregateType: "creative_run",
        aggregateId: run.id,
        payload: toInputJson({
          runId: run.id,
          incidentId: incident.id,
          attemptIds: latestAttempts.map((attempt) => attempt.id),
          runVersion: updatedRun.version,
          incidentVersion: updatedIncident.version,
        }),
      },
    });
    return {
      runId: run.id,
      incidentId: incident.id,
      relatedAttemptIds: latestAttempts.map((attempt) => attempt.id),
      runVersion: updatedRun.version,
      incidentVersion: updatedIncident.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

async function ledgerFacts(jobIds: readonly string[]): Promise<CreativeRunLedgerFact[]> {
  if (jobIds.length === 0) return [];
  return prisma.dreamcoinLedger.findMany({
    where: { sourceId: { in: [...jobIds] }, reason: { in: ["generation_spend", "refund"] } },
    select: { sourceId: true, reason: true, delta: true },
  });
}

export async function recordCreativeReviewDecision(input: {
  readonly runId: string;
  readonly itemId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly supersedesDecisionId?: string;
  readonly decision: "approved" | "rejected";
  readonly identityConsistency: "passed" | "failed" | "unscored";
  readonly score?: number;
  readonly quality?: {
    readonly artifactFree: boolean;
    readonly singleSubject: boolean;
    readonly intentMatch: boolean;
    readonly noVisibleText: boolean;
  };
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  if (input.reason.trim().length < 3) throw Errors.badRequest("Review reason is required");
  const execute = async (tx: Prisma.TransactionClient) => {
    const locator = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
      select: { targetType: true, targetId: true },
    });
    if (!locator) throw Errors.notFound("Creative Run not found");
    if (locator.targetType === "character" && locator.targetId) {
      await lockCharacterGenerationAuthority(tx, locator.targetId);
    }
    const run = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
    });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before review", { currentVersion: run.version });
    }
    const immutableDecisionCorrection =
      run.lifecycleState === "closed" &&
      typeof input.supersedesDecisionId === "string";
    if (
      !immutableDecisionCorrection &&
      (
        run.lifecycleState !== "active" ||
        !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, run.lifecycleState)
      )
    ) {
      throw Errors.conflict("Creative Run is not active for review", { lifecycleState: run.lifecycleState });
    }
    const characterAssetReview = ["character_cover", "character_hero", "character_chat"].includes(run.purpose);
    const routeEvaluationReview = run.purpose === "model_eval";
    if (characterAssetReview) {
      if (!input.quality) {
        throw Errors.badRequest("Character asset review requires the complete visible quality checklist");
      }
      if (
        input.decision === "approved" &&
        (!input.quality.artifactFree ||
          !input.quality.singleSubject ||
          !input.quality.intentMatch ||
          !input.quality.noVisibleText)
      ) {
        throw Errors.badRequest("A Character asset cannot be approved while a required quality check is failing");
      }
      if (input.decision === "approved" && input.score === undefined) {
        throw Errors.badRequest("Character asset approval requires an explicit score");
      }
    }
    if (
      routeEvaluationReview &&
      (
        input.identityConsistency === "unscored" ||
        input.score === undefined
      )
    ) {
      throw Errors.badRequest(
        "Model evaluation review requires an explicit identity result and identity match score",
      );
    }
    const itemLocator = await tx.contentProductionItem.findFirst({
      where: { id: input.itemId, batchId: run.id },
      select: {
        mediaAssetId: true,
        job: {
          select: {
            assets: {
              select: { id: true },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });
    if (!itemLocator) throw Errors.notFound("Creative Run item not found");
    const locatedAssetIds = [
      ...(itemLocator.mediaAssetId ? [itemLocator.mediaAssetId] : []),
      ...(itemLocator.job?.assets.map((asset) => asset.id) ?? []),
    ];
    await lockCharacterMediaAssetAuthorities(tx, locatedAssetIds);
    const item = await tx.contentProductionItem.findFirst({
      where: { id: input.itemId, batchId: run.id },
      include: {
        mediaAsset: { include: { placements: true } },
        job: {
          include: {
            assets: {
              include: { placements: true },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });
    if (!item) throw Errors.notFound("Creative Run item not found");
    const lockedAssetIds = new Set(locatedAssetIds);
    const currentAssetIds = [
      ...(item.mediaAssetId ? [item.mediaAssetId] : []),
      ...(item.job?.assets.map((asset) => asset.id) ?? []),
    ];
    if (currentAssetIds.some((assetId) => !lockedAssetIds.has(assetId))) {
      throw Errors.conflict("Creative Run asset authority changed before review");
    }
    const supersededDecision = await tx.creativeReviewDecision.findFirst({
      where: { runItemId: item.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (supersededDecision?.id !== input.supersedesDecisionId) {
      throw Errors.conflict("Creative review authority changed before this decision was recorded", {
        expectedSupersedesDecisionId: input.supersedesDecisionId ?? null,
        latestDecisionId: supersededDecision?.id ?? null,
      });
    }
    const reviewInvalidatesExistingAuthority =
      supersededDecision !== null || input.decision === "rejected";
    const reviewedAssetId =
      item.mediaAssetId ?? item.job?.assets[0]?.id ?? null;
    if (
      reviewInvalidatesExistingAuthority &&
      run.targetType === "character" &&
      run.targetId &&
      reviewedAssetId
    ) {
      const dependencies = await characterAssetReviewDependencies(
        tx,
        run.targetId,
        reviewedAssetId,
      );
      if (dependencies.length > 0) {
        throw Errors.conflict(
          "Withdraw this asset from Character draft, identity, references, and serving before rejecting or superseding its review",
          {
            characterId: run.targetId,
            assetId: reviewedAssetId,
            dependencies,
            deepLink: `/admin/characters/${run.targetId}?tab=assets`,
          },
        );
      }
    }
    const identityReviewMode = creativeIdentityReviewMode({
      purpose: run.purpose,
      sourceMeta: item.job?.sourceMeta,
    });
    const requiredIdentityConsistency = approvedIdentityConsistencyForMode(identityReviewMode);
    if (
      input.decision === "approved" &&
      requiredIdentityConsistency !== null &&
      input.identityConsistency !== requiredIdentityConsistency
    ) {
      throw Errors.badRequest(
        identityReviewMode === "defines_identity"
          ? "The first reviewed portrait defines identity and must keep identity consistency unscored"
          : "An identity-preserving Character asset can only be approved when identity consistency passes",
      );
    }
    if (!isCreativeRunItemTransitionAllowed(item.status, input.decision)) {
      throw Errors.conflict("Creative Run item cannot enter the requested review state", {
        from: item.status,
        to: input.decision,
      });
    }
    const projectedItemStatuses = (await tx.contentProductionItem.findMany({
      where: { batchId: run.id },
      select: { id: true, status: true },
      orderBy: { itemIndex: "asc" },
    })).map((candidate) => candidate.id === item.id ? input.decision : candidate.status);
    const continuation = deriveCreativeRunContinuation(
      projectedItemStatuses,
      { requiresVerifiedPlacement: run.purpose === "campaign" },
    );
    if (
      !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, continuation.lifecycleState) ||
      !isCreativeRunWorkflowTransitionAllowed(run.workflowStage, continuation.workflowStage) ||
      !isCreativeRunVerificationTransitionAllowed(run.verificationState, continuation.verificationState)
    ) {
      throw Errors.conflict("Creative Run cannot accept the requested review transition", {
        lifecycle: { from: run.lifecycleState, to: continuation.lifecycleState },
        workflow: { from: run.workflowStage, to: continuation.workflowStage },
        verification: { from: run.verificationState, to: continuation.verificationState },
      });
    }
    const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
    if (!asset || asset.deletedAt || asset.safetyStatus !== "passed") {
      throw Errors.badRequest("Only a valid generated asset can be reviewed");
    }
    if (input.decision === "approved") {
      await assertCustomerPublishableCreativeAsset(tx, asset);
    }
    const activePlacement = asset.placements.find((placement) =>
      ["published", "scheduled"].includes(placement.status) &&
      ["pending", "verifying", "passed"].includes(placement.verificationState)
    );
    if (reviewInvalidatesExistingAuthority && activePlacement) {
      throw Errors.conflict("A staged or active placement must be withdrawn before rejecting or superseding a review", {
        placementId: activePlacement.id,
        placementStatus: activePlacement.status,
        verificationState: activePlacement.verificationState,
      });
    }
    const claimedRun = await tx.contentProductionBatch.updateMany({
      where: {
        id: run.id,
        version: run.version,
        lifecycleState: run.lifecycleState,
        workflowStage: run.workflowStage,
        verificationState: run.verificationState,
      },
      data: {
        lifecycleState: continuation.lifecycleState,
        workflowStage: continuation.workflowStage,
        verificationState: continuation.verificationState,
        status: continuation.status,
        version: { increment: 1 },
      },
    });
    if (claimedRun.count !== 1) {
      throw Errors.conflict("Creative Run changed during review", {
        expectedVersion: run.version,
      });
    }
    const claimedItem = await tx.contentProductionItem.updateMany({
      where: {
        id: item.id,
        batchId: run.id,
        version: item.version,
        status: item.status,
        mediaAssetId: item.mediaAssetId,
      },
      data: {
        mediaAssetId: asset.id,
        status: input.decision,
        reviewNote: input.reason.trim(),
        rating: input.score,
        reviewedById: input.actor.id,
        reviewedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (claimedItem.count !== 1) {
      throw Errors.conflict("Creative Run item changed during review", {
        itemId: item.id,
        expectedVersion: item.version,
      });
    }
    const decision = await tx.creativeReviewDecision.create({
      data: {
        runItemId: item.id,
        artifactId: asset.id,
        supersedesDecisionId: supersededDecision?.id ?? null,
        decision: input.decision,
        identityConsistency: input.identityConsistency,
        score: input.score,
        reason: input.reason.trim(),
        evidence: toInputJson(input.quality ? { quality: input.quality } : {}),
        reviewerId: input.actor.id,
      },
    });
    const approvedItems = await tx.contentProductionItem.count({
      where: { batchId: run.id, status: { in: ["approved", "published"] } },
    });
    const updatedRun = await tx.contentProductionBatch.update({
      where: { id: run.id, version: run.version + 1 },
      data: { approvedItems },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.run.review_decided",
        targetType: "creative_run_item",
        targetId: item.id,
        reason: input.reason.trim(),
        before: toInputJson({ status: item.status, runVersion: run.version }),
        after: toInputJson({
          decisionId: decision.id,
          supersedesDecisionId: supersededDecision?.id ?? null,
          decision: decision.decision,
          identityConsistency: decision.identityConsistency,
          score: decision.score,
          quality: input.quality ?? null,
          runVersion: updatedRun.version,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "creative.review.decided.v2",
        aggregateType: "creative_run",
        aggregateId: run.id,
        payload: toInputJson({
          runId: run.id,
          runItemId: item.id,
          assetId: asset.id,
          decisionId: decision.id,
          supersedesDecisionId: supersededDecision?.id ?? null,
          decision: decision.decision,
          runVersion: updatedRun.version,
        }),
      },
    });
    return {
      runId: run.id,
      itemId: item.id,
      decisionId: decision.id,
      decision: decision.decision,
      lifecycleState: updatedRun.lifecycleState,
      workflowStage: updatedRun.workflowStage,
      verificationState: updatedRun.verificationState,
      version: updatedRun.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function publishDistributionPlacement(input: {
  readonly runId: string;
  readonly itemId: string;
  readonly assetId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly slot: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly ctaLabel?: string;
  readonly href?: string;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  if (RELEASE_OWNED_SLOTS.has(input.slot)) {
    throw Errors.forbidden("Release-owned placements require a Character Release patch and publish command", {
      code: "release_owned_placement_requires_release_patch",
      slot: input.slot,
    });
  }
  if (input.slot !== "campaign" || input.targetType !== "campaign") {
    throw Errors.conflict("Only the verified campaign runtime surface is available for Creative placement", {
      code: "creative_runtime_surface_not_supported",
      slot: input.slot,
      targetType: input.targetType,
    });
  }
  const execute = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`creative-placement:${input.slot}:${input.targetType}:${input.targetId}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${input.assetId}`}))`;
    const run = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
    });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before placement", { currentVersion: run.version });
    }
    if (
      run.lifecycleState !== "active" ||
      !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, run.lifecycleState)
    ) {
      throw Errors.conflict("Creative Run is not active for placement", { lifecycleState: run.lifecycleState });
    }
    if (run.purpose !== "campaign") {
      throw Errors.conflict("Only Campaign Creative Runs can enter runtime placement verification", {
        purpose: run.purpose,
      });
    }
    if (
      !isCreativeRunWorkflowTransitionAllowed(run.workflowStage, "verification") ||
      !isCreativeRunVerificationTransitionAllowed(run.verificationState, "verifying")
    ) {
      throw Errors.conflict("Creative Run cannot enter placement verification from its present state", {
        workflow: { from: run.workflowStage, to: "verification" },
        verification: { from: run.verificationState, to: "verifying" },
      });
    }
    const item = await tx.contentProductionItem.findFirst({
      where: { id: input.itemId, batchId: run.id, mediaAssetId: input.assetId },
      include: { mediaAsset: true },
    });
    if (!item || !item.mediaAsset) throw Errors.notFound("Approved Creative asset not found");
    if (!isCreativeRunItemTransitionAllowed(item.status, "published")) {
      throw Errors.conflict("Creative Run item must be approved before placement", { status: item.status });
    }
    if (item.mediaAsset.deletedAt || item.mediaAsset.safetyStatus !== "passed") {
      throw Errors.badRequest("Placement asset is not valid");
    }
    const customerMediaAuthority = await assertCustomerPublishableCreativeAsset(
      tx,
      item.mediaAsset,
      undefined,
      { requireCompleteProviderAuthority: true },
    );
    const latestReview = await tx.creativeReviewDecision.findFirst({
      where: { runItemId: item.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (
      !latestReview ||
      latestReview.artifactId !== input.assetId ||
      latestReview.decision !== "approved"
    ) {
      throw Errors.badRequest("An approved immutable review decision is required before placement");
    }
    const rollbackTarget = await tx.mediaAssetPlacement.findFirst({
      where: {
        slot: input.slot,
        targetType: input.targetType,
        targetId: input.targetId,
        status: "published",
        verificationState: "passed",
      },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    });
    const stagedPlacement = await tx.mediaAssetPlacement.findFirst({
      where: {
        slot: input.slot,
        targetType: input.targetType,
        targetId: input.targetId,
        status: "scheduled",
        verificationState: "verifying",
      },
      select: { id: true },
    });
    if (stagedPlacement) {
      throw Errors.conflict("Another placement is already awaiting verification for this target", {
        placementId: stagedPlacement.id,
      });
    }
    const claimedRun = await tx.contentProductionBatch.updateMany({
      where: {
        id: run.id,
        version: run.version,
        lifecycleState: "active",
        workflowStage: run.workflowStage,
        verificationState: run.verificationState,
      },
      data: {
        workflowStage: "verification",
        verificationState: "verifying",
        version: { increment: 1 },
      },
    });
    if (claimedRun.count !== 1) {
      throw Errors.conflict("Creative Run changed during placement", {
        expectedVersion: run.version,
      });
    }
    const claimedItem = await tx.contentProductionItem.updateMany({
      where: {
        id: item.id,
        batchId: run.id,
        version: item.version,
        status: item.status,
        mediaAssetId: input.assetId,
      },
      data: { version: { increment: 1 } },
    });
    if (claimedItem.count !== 1) {
      throw Errors.conflict("Creative Run item changed during placement", {
        itemId: item.id,
        expectedVersion: item.version,
      });
    }
    const placement = await tx.mediaAssetPlacement.create({
      data: {
        mediaAssetId: input.assetId,
        slot: input.slot,
        targetType: input.targetType,
        targetId: input.targetId,
        status: "scheduled",
        createdById: input.actor.id,
        metadata: toInputJson({
          creativeRunId: run.id,
          creativeRunItemId: item.id,
          eyebrow: input.eyebrow,
          title: input.title,
          ...(input.ctaLabel ? { ctaLabel: input.ctaLabel } : {}),
          ...(input.href ? { href: input.href } : {}),
          [CREATIVE_MEDIA_AUTHORITY_METADATA_KEY]: customerMediaAuthority,
        }),
        verificationState: "verifying",
        rollbackPlacementId: rollbackTarget?.id,
      },
    });
    const updatedRun = await tx.contentProductionBatch.findUniqueOrThrow({
      where: { id: run.id },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.placement.staged",
        targetType: "media_asset_placement",
        targetId: placement.id,
        reason: input.reason,
        before: toInputJson({ rollbackPlacementId: rollbackTarget?.id ?? null, runVersion: run.version }),
        after: toInputJson({
          mediaAssetId: placement.mediaAssetId,
          slot: placement.slot,
          targetType: placement.targetType,
          targetId: placement.targetId,
          verificationState: placement.verificationState,
          runVersion: updatedRun.version,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "creative.placement.verification_requested.v2",
        aggregateType: "creative_run",
        aggregateId: run.id,
        payload: toInputJson({
          runId: run.id,
          itemId: item.id,
          placementId: placement.id,
          expectedAssetId: placement.mediaAssetId,
          slot: placement.slot,
          targetType: placement.targetType,
          targetId: placement.targetId,
          runVersion: updatedRun.version,
        }),
      },
    });
    return {
      runId: run.id,
      placementId: placement.id,
      verificationState: placement.verificationState,
      rollbackPlacementId: placement.rollbackPlacementId,
      runVersion: updatedRun.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function withdrawCreativePlacement(input: {
  readonly runId: string;
  readonly placementId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const run = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
    });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before placement withdrawal", {
        currentVersion: run.version,
      });
    }
    const placement = await tx.mediaAssetPlacement.findUnique({
      where: { id: input.placementId },
    });
    if (!placement) throw Errors.notFound("Creative placement not found");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`creative-placement:${placement.slot}:${placement.targetType}:${placement.targetId}`}))`;
    const metadata = record(placement.metadata);
    if (metadata.creativeRunId !== run.id) {
      throw Errors.notFound("Placement does not belong to Creative Run");
    }
    if (placement.status !== "scheduled" || placement.verificationState !== "verifying") {
      throw Errors.conflict("Only a staged placement can be withdrawn", {
        status: placement.status,
        verificationState: placement.verificationState,
      });
    }
    if (
      run.lifecycleState !== "active" ||
      run.workflowStage !== "verification" ||
      run.verificationState !== "verifying" ||
      !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, "active") ||
      !isCreativeRunWorkflowTransitionAllowed(run.workflowStage, "placement") ||
      !isCreativeRunVerificationTransitionAllowed(run.verificationState, "pending") ||
      !isCreativePlacementVerificationTransitionAllowed(placement.verificationState, "overridden")
    ) {
      throw Errors.conflict("Creative Run cannot withdraw the staged placement from its present state", {
        lifecycleState: run.lifecycleState,
        workflowStage: run.workflowStage,
        runVerificationState: run.verificationState,
        placementVerificationState: placement.verificationState,
      });
    }
    const withdrawnAt = new Date();
    const claimedRun = await tx.contentProductionBatch.updateMany({
      where: {
        id: run.id,
        version: run.version,
        lifecycleState: "active",
        workflowStage: "verification",
        verificationState: "verifying",
      },
      data: {
        workflowStage: "placement",
        verificationState: "pending",
        status: "reviewing",
        version: { increment: 1 },
      },
    });
    if (claimedRun.count !== 1) {
      throw Errors.conflict("Creative Run changed during placement withdrawal", {
        expectedVersion: run.version,
      });
    }
    const claimedPlacement = await tx.mediaAssetPlacement.updateMany({
      where: {
        id: placement.id,
        version: placement.version,
        status: "scheduled",
        verificationState: "verifying",
      },
      data: {
        status: "archived",
        verificationState: "overridden",
        archivedAt: withdrawnAt,
        verificationEvidence: toInputJson({
          disposition: "operator_withdrawn",
          reason: input.reason,
          withdrawnAt: withdrawnAt.toISOString(),
          rollbackPlacementId: placement.rollbackPlacementId,
        }),
        version: { increment: 1 },
      },
    });
    if (claimedPlacement.count !== 1) {
      throw Errors.conflict("Creative placement changed during withdrawal", {
        placementId: placement.id,
        expectedVersion: placement.version,
      });
    }
    const updatedRun = await tx.contentProductionBatch.findUniqueOrThrow({
      where: { id: run.id },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.placement.withdrawn",
        targetType: "media_asset_placement",
        targetId: placement.id,
        reason: input.reason,
        before: toInputJson({
          placementStatus: placement.status,
          placementVerificationState: placement.verificationState,
          runVersion: run.version,
          runVerificationState: run.verificationState,
        }),
        after: toInputJson({
          placementStatus: "archived",
          placementVerificationState: "overridden",
          runVersion: updatedRun.version,
          runVerificationState: updatedRun.verificationState,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "creative.placement.withdrawn.v2",
        aggregateType: "creative_run",
        aggregateId: run.id,
        payload: toInputJson({
          runId: run.id,
          placementId: placement.id,
          itemId: typeof metadata.creativeRunItemId === "string"
            ? metadata.creativeRunItemId
            : null,
          verificationState: "overridden",
          runVerificationState: updatedRun.verificationState,
          runVersion: updatedRun.version,
        }),
      },
    });
    return {
      runId: run.id,
      placementId: placement.id,
      verificationState: "overridden" as const,
      runVersion: updatedRun.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function verifyCreativePlacement(input: {
  readonly runId: string;
  readonly placementId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const run = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
    });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before placement verification", { currentVersion: run.version });
    }
    let placement = await tx.mediaAssetPlacement.findUnique({
      where: { id: input.placementId },
      include: { mediaAsset: true },
    });
    if (!placement) throw Errors.notFound("Creative placement not found");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`creative-placement:${placement.slot}:${placement.targetType}:${placement.targetId}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${placement.mediaAssetId}`}))`;
    placement = await tx.mediaAssetPlacement.findUnique({
      where: { id: input.placementId },
      include: { mediaAsset: true },
    });
    if (!placement) throw Errors.notFound("Creative placement not found");
    const metadata = placement.metadata as Record<string, unknown>;
    if (metadata.creativeRunId !== run.id) throw Errors.notFound("Placement does not belong to Creative Run");
    if (placement.status !== "scheduled" || placement.verificationState !== "verifying") {
      throw Errors.conflict("Only a staged placement can be verified", {
        status: placement.status,
        verificationState: placement.verificationState,
      });
    }
    const authorityEvidence = parseCreativeMediaAuthorityEvidence(
      placement.metadata,
    );
    if (authorityEvidence.kind !== "present") {
      throw Errors.badRequest(
        "Creative placement provider authority evidence is missing or malformed",
        {
          code: "creative_asset_not_customer_publishable",
          mediaAssetId: placement.mediaAsset.id,
          reasons: [
            authorityEvidence.kind === "missing"
              ? "provider_authority_evidence_missing"
              : "provider_authority_evidence_invalid",
          ],
        },
      );
    }
    await assertCustomerPublishableCreativeAsset(
      tx,
      placement.mediaAsset,
      authorityEvidence.snapshot,
      { requireCompleteProviderAuthority: true },
    );
    const runItemId = typeof metadata.creativeRunItemId === "string"
      ? metadata.creativeRunItemId
      : null;
    const item = runItemId
      ? await tx.contentProductionItem.findFirst({
          where: {
            id: runItemId,
            batchId: run.id,
            mediaAssetId: placement.mediaAssetId,
          },
        })
      : null;
    if (!item || item.status !== "approved") {
      throw Errors.conflict("Staged placement lost its approved Creative Run item authority");
    }
    const rollbackTarget = await tx.mediaAssetPlacement.findFirst({
      where: {
        slot: placement.slot,
        targetType: placement.targetType,
        targetId: placement.targetId,
        status: "published",
        verificationState: "passed",
      },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    });
    if ((rollbackTarget?.id ?? null) !== placement.rollbackPlacementId) {
      throw Errors.conflict("The staged placement rollback authority changed before verification", {
        expectedRollbackPlacementId: placement.rollbackPlacementId,
        currentRollbackPlacementId: rollbackTarget?.id ?? null,
      });
    }
    const verifiedAt = new Date();
    const previousVisibility = placement.mediaAsset.visibility;
    const structurallyEligible =
      placement.slot === "campaign" &&
      placement.mediaAsset.deletedAt === null &&
      placement.mediaAsset.safetyStatus === "passed" &&
      placement.mediaAsset.type === "image";
    if (structurallyEligible && previousVisibility === "private") {
      await tx.mediaAsset.update({
        where: { id: placement.mediaAsset.id },
        data: { visibility: "unlisted" },
      });
    }
    if (structurallyEligible && rollbackTarget) {
      await tx.mediaAssetPlacement.update({
        where: { id: rollbackTarget.id },
        data: { status: "archived", archivedAt: verifiedAt, version: { increment: 1 } },
      });
    }
    if (structurallyEligible) {
      await tx.mediaAssetPlacement.update({
        where: { id: placement.id },
        data: {
          status: "published",
          publishedAt: verifiedAt,
          verificationState: "passed",
          verifiedAt,
          version: { increment: 1 },
        },
      });
    }
    const renderedCampaigns = structurallyEligible
      ? await resolveCommunityCampaignPlacements(tx)
      : [];
    const observed = renderedCampaigns.find((candidate) => candidate.id === placement.id) ?? null;
    const checks = {
      runtimeSurfaceSupported: placement.slot === "campaign",
      placementVisibleInRuntime: observed?.id === placement.id,
      renderedAssetMatches: observed?.mediaAssetId === placement.mediaAssetId,
      assetValid: Boolean(
        observed &&
        observed.mediaAsset.deletedAt === null &&
        observed.mediaAsset.safetyStatus === "passed",
      ),
    };
    const passed = Object.values(checks).every(Boolean);
    const placementVerificationState = passed ? "passed" : "failed";
    const projectedItemStatuses = (await tx.contentProductionItem.findMany({
      where: { batchId: run.id },
      select: { id: true, status: true },
      orderBy: { itemIndex: "asc" },
    })).map((candidate) => candidate.id === item.id && passed ? "published" : candidate.status);
    const continuation = passed
      ? deriveCreativeRunContinuation(projectedItemStatuses)
      : {
          lifecycleState: "active" as const,
          workflowStage: "placement" as const,
          verificationState: "failed" as const,
          status: "reviewing" as const,
        };
    if (
      !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, continuation.lifecycleState) ||
      !isCreativeRunWorkflowTransitionAllowed(run.workflowStage, continuation.workflowStage) ||
      !isCreativeRunVerificationTransitionAllowed(run.verificationState, continuation.verificationState) ||
      !isCreativePlacementVerificationTransitionAllowed(placement.verificationState, placementVerificationState)
    ) {
      throw Errors.conflict("Creative Run cannot accept the requested verification transition", {
        from: run.lifecycleState,
        to: continuation.lifecycleState,
        workflow: { from: run.workflowStage, to: continuation.workflowStage },
        runVerification: { from: run.verificationState, to: continuation.verificationState },
        placementVerification: { from: placement.verificationState, to: placementVerificationState },
      });
    }
    if (passed) {
      const itemUpdated = await tx.contentProductionItem.updateMany({
        where: {
          id: item.id,
          batchId: run.id,
          mediaAssetId: placement.mediaAssetId,
          status: "approved",
          version: item.version,
        },
        data: { status: "published", version: { increment: 1 } },
      });
      if (itemUpdated.count !== 1) {
        throw Errors.conflict("Creative Run item changed during placement verification");
      }
    } else {
      await tx.mediaAssetPlacement.update({
        where: { id: placement.id },
        data: {
          status: "archived",
          publishedAt: null,
          archivedAt: verifiedAt,
          verificationState: "failed",
          verifiedAt,
          version: { increment: structurallyEligible ? 0 : 1 },
        },
      });
      if (rollbackTarget && structurallyEligible) {
        await tx.mediaAssetPlacement.update({
          where: { id: rollbackTarget.id },
          data: { status: "published", archivedAt: null, version: { increment: 1 } },
        });
      }
      if (previousVisibility === "private" && structurallyEligible) {
        await tx.mediaAsset.update({
          where: { id: placement.mediaAsset.id },
          data: { visibility: "private" },
        });
      }
    }
    await tx.mediaAssetPlacement.update({
      where: { id: placement.id },
      data: {
        verificationEvidence: toInputJson({
          checks,
          resolver: placement.slot === "campaign" ? "community.campaigns.v1" : null,
          observedPlacementId: observed?.id ?? null,
          observedAssetId: observed?.mediaAssetId ?? null,
          observedAt: verifiedAt.toISOString(),
          rollbackPlacementId: rollbackTarget?.id ?? null,
          rollbackPreserved: !passed && Boolean(rollbackTarget),
        }),
      },
    });
    const updatedRun = await tx.contentProductionBatch.update({
      where: { id: run.id },
      data: {
        workflowStage: continuation.workflowStage,
        verificationState: continuation.verificationState,
        lifecycleState: continuation.lifecycleState,
        status: continuation.status,
        version: { increment: 1 },
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.placement.verified",
        targetType: "media_asset_placement",
        targetId: placement.id,
        reason: input.reason,
        before: toInputJson({ verificationState: placement.verificationState, runVersion: run.version }),
        after: toInputJson({
          placementVerificationState,
          runVerificationState: continuation.verificationState,
          checks,
          runVersion: updatedRun.version,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: passed ? "creative.placement.verified.v2" : "creative.placement.verification_failed.v2",
        aggregateType: "creative_run",
        aggregateId: run.id,
        payload: toInputJson({
          runId: run.id,
          placementId: placement.id,
          verificationState: placementVerificationState,
          runVerificationState: continuation.verificationState,
          checks,
          runVersion: updatedRun.version,
        }),
      },
    });
    return {
      runId: run.id,
      placementId: placement.id,
      verificationState: placementVerificationState,
      checks,
      runVersion: updatedRun.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function listCreativeRuns(input: {
  readonly requestUrl: string;
  readonly actor: AdminActor;
}) {
  void input.actor;
  const query = creativeRunQuerySchema.parse(Object.fromEntries(new URL(input.requestUrl).searchParams));
  const queryIdentity = {
    lifecycleState: query.lifecycleState,
    workflowStage: query.workflowStage,
    executionOutcome: query.executionOutcome,
    ownerId: query.ownerId,
    priority: query.priority,
    targetType: query.targetType,
    targetId: query.targetId,
    search: query.search,
    sort: query.sort,
  };
  const summaries: Array<ReturnType<typeof deriveCreativeRunSummary>> = [];
  const batchSize = Math.min(200, Math.max(50, query.limit * 4));
  let scanCursor = query.cursor;
  let updatedCursor: { updatedAt: Date; id: string } | null = null;
  if (query.sort === "updated_desc" && query.cursor) {
    const keys = decodeAdminListCursor(query.cursor, "creative_runs", queryIdentity);
    if (typeof keys[1] !== "string") throw Errors.badRequest("creative_runs cursor id is invalid");
    updatedCursor = {
      updatedAt: parseIsoCursorKey(keys[0], "creative_runs"),
      id: keys[1],
    };
  }
  let exhausted = false;

  while (summaries.length <= query.limit && !exhausted) {
    const cursorWhere: Prisma.ContentProductionBatchWhereInput | undefined = query.sort === "updated_desc"
      ? updatedCursor
        ? {
            OR: [
              { updatedAt: { lt: updatedCursor.updatedAt } },
              { updatedAt: updatedCursor.updatedAt, id: { lt: updatedCursor.id } },
            ],
          }
        : undefined
      : scanCursor
        ? { id: { gt: scanCursor } }
        : undefined;
    const roots = await prisma.contentProductionBatch.findMany({
      where: operationalContentProductionBatchWhere({
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
        lifecycleState: query.lifecycleState,
        workflowStage: query.workflowStage,
        ownerId: query.ownerId,
        priority: query.priority,
        targetType: query.targetType,
        targetId: query.targetId,
        ...(query.search ? {
          OR: [
            { id: { contains: query.search, mode: "insensitive" } },
            { title: { contains: query.search, mode: "insensitive" } },
            { purpose: { contains: query.search, mode: "insensitive" } },
          ],
        } : {}),
      }),
      orderBy: query.sort === "updated_desc"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : { id: "asc" },
      take: batchSize,
      include: {
        items: {
          include: {
            job: { include: { assets: { include: { placements: true } } } },
            mediaAsset: { include: { placements: true } },
          },
          orderBy: { itemIndex: "asc" },
        },
      },
    });
    if (roots.length === 0) {
      exhausted = true;
      break;
    }
    const allJobIds = roots.flatMap((run) => run.items.flatMap((item) => item.jobId ? [item.jobId] : []));
    const allLedgerFacts = await ledgerFacts(allJobIds);
    for (const run of roots) {
      const summary = deriveCreativeRunSummary(run, allLedgerFacts);
      if (!query.executionOutcome || summary.executionOutcome === query.executionOutcome) {
        summaries.push(summary);
      }
    }
    scanCursor = roots.at(-1)?.id;
    const lastRoot = roots.at(-1);
    updatedCursor = lastRoot ? { updatedAt: lastRoot.updatedAt, id: lastRoot.id } : updatedCursor;
    exhausted = roots.length < batchSize;
  }

  const page = summaries.slice(0, query.limit);
  const hasNextPage = summaries.length > query.limit || !exhausted;
  return creativeRunListResponseSchema.parse({
    items: page,
    pageInfo: {
      endCursor: hasNextPage
        ? query.sort === "updated_desc"
          ? page.at(-1)
            ? encodeAdminListCursor(
                "creative_runs",
                queryIdentity,
                [page.at(-1)!.updatedAt, page.at(-1)!.id],
              )
            : null
          : page.at(-1)?.id ?? scanCursor ?? null
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

type CreativeRunRoot = Prisma.ContentProductionBatchGetPayload<{
  include: {
    items: {
      include: {
        job: { include: { assets: { include: { placements: true } } } };
        mediaAsset: { include: { placements: true } };
      };
    };
  };
}>;

export function deriveCreativeItemExecutionState(input: {
  readonly itemStatus: string;
  readonly jobStatus: string | null;
  readonly attemptStatus: string | null;
  readonly transportStatus: string | null;
  readonly hasAsset: boolean;
}) {
  if (input.hasAsset) return "ready" as const;
  if (
    input.itemStatus === "failed" ||
    ["failed", "blocked", "refunded"].includes(input.jobStatus ?? "") ||
    ["failed", "cancelled", "unknown"].includes(input.attemptStatus ?? "") ||
    ["failed", "unknown"].includes(input.transportStatus ?? "")
  ) {
    return "failed" as const;
  }
  if (
    input.transportStatus === "succeeded" ||
    input.attemptStatus === "succeeded" ||
    input.jobStatus === "completed"
  ) {
    return "finalizing" as const;
  }
  if (
    input.transportStatus === "running" ||
    input.attemptStatus === "running" ||
    ["running", "moderating_input", "moderating_output"].includes(input.jobStatus ?? "")
  ) {
    return "generating" as const;
  }
  if (input.attemptStatus === "queued" || input.jobStatus === "queued") {
    return "provider_queued" as const;
  }
  return "dispatching" as const;
}

export function deriveCreativeRunContinuation(
  itemStatuses: readonly string[],
  options: { readonly requiresVerifiedPlacement?: boolean } = {},
) {
  const requiresVerifiedPlacement = options.requiresVerifiedPlacement ?? true;
  const terminalStatuses = requiresVerifiedPlacement
    ? ["published", "rejected", "failed"]
    : ["approved", "published", "rejected", "failed"];
  const allResolved = itemStatuses.length > 0 &&
    itemStatuses.every((status) => terminalStatuses.includes(status));
  if (allResolved) {
    const runtimeVerified = requiresVerifiedPlacement &&
      itemStatuses.some((status) => status === "published");
    return {
      lifecycleState: "closed" as const,
      workflowStage: runtimeVerified ? "verification" as const : "review" as const,
      verificationState: runtimeVerified ? "passed" as const : "pending" as const,
      status: "completed" as const,
    };
  }
  const workflowStage = itemStatuses.some((status) => ["queued", "regenerate_requested"].includes(status))
    ? "generation" as const
    : itemStatuses.some((status) => status === "generated")
      ? "review" as const
      : "placement" as const;
  return {
    lifecycleState: "active" as const,
    workflowStage,
    verificationState: "pending" as const,
    status: "reviewing" as const,
  };
}

function deriveCreativeRunSummary(
  run: CreativeRunRoot,
  allLedgerFacts: readonly CreativeRunLedgerFact[],
) {
  const jobIds = new Set(run.items.flatMap((item) => item.jobId ? [item.jobId] : []));
  const state = deriveCreativeRunState({
    legacyStatus: run.status,
    expectedItemCount: run.totalItems,
    items: run.items.map((item) => {
      const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
      return {
        id: item.id,
        status: item.status,
        job: item.job ? {
          id: item.job.id,
          status: item.job.status,
          errorCode: item.job.errorCode,
          costDreamcoins: item.job.costDreamcoins,
        } : null,
        asset: asset ? { id: asset.id, safetyStatus: asset.safetyStatus, deletedAt: asset.deletedAt } : null,
        placements: asset?.placements.map((placement) => ({
          status: placement.status,
          verificationState: placement.verificationState as "pending" | "verifying" | "passed" | "failed" | "overridden",
        })) ?? [],
      };
    }),
    ledgerEntries: allLedgerFacts.filter((fact) => fact.sourceId !== null && jobIds.has(fact.sourceId)),
  });
  return {
    id: run.id,
    purpose: run.purpose,
    target: { type: run.targetType, id: run.targetId ?? run.id },
    ownerId: run.ownerId,
    dueAt: run.dueAt?.toISOString() ?? null,
    priority: run.priority,
    lifecycleState: run.lifecycleState,
    workflowStage: run.workflowStage,
    executionOutcome: state.executionOutcome,
    reviewState: state.reviewState,
    deploymentState: state.deploymentState,
    counts: state.counts,
    verificationState: run.verificationState as "pending" | "verifying" | "passed" | "failed" | "overridden",
    version: run.version,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export async function getCreativeRunDetail(input: {
  readonly runId: string;
  readonly actor: AdminActor;
}) {
  void input.actor;
  const run = await prisma.contentProductionBatch.findFirst({
    where: operationalContentProductionBatchWhere({ id: input.runId }),
    include: {
      items: {
        include: {
          job: { include: { assets: { include: { placements: true } } } },
          mediaAsset: { include: { placements: true } },
        },
        orderBy: { itemIndex: "asc" },
      },
    },
  });
  if (!run) throw Errors.notFound("Creative Run not found");
  const itemIds = run.items.map((item) => item.id);
  const jobIds = run.items.flatMap((item) => item.jobId ? [item.jobId] : []);
  const [decisions, attempts, ledgerEntries, profile, recipe] = await Promise.all([
    prisma.creativeReviewDecision.findMany({ where: { runItemId: { in: itemIds } }, orderBy: { createdAt: "desc" } }),
    prisma.generationAttempt.findMany({ where: { requestId: { in: jobIds } }, orderBy: { attemptNo: "desc" } }),
    ledgerFacts(jobIds),
    run.profileId && run.profileVersion
      ? prisma.generationModelProfile.findFirst({
          where: { profileKey: run.profileId, version: run.profileVersion },
          select: { label: true },
        })
      : null,
    run.recipeId && run.recipeVersion
      ? prisma.generationRecipe.findFirst({
          where: { recipeKey: run.recipeId, version: run.recipeVersion },
          select: { label: true },
        })
      : null,
  ]);
  const transportExecutions = attempts.length > 0
    ? await prisma.generationTransportExecution.findMany({
        where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
        orderBy: { transportAttemptNo: "desc" },
      })
    : [];
  const state = deriveCreativeRunState({
    legacyStatus: run.status,
    expectedItemCount: run.totalItems,
    items: run.items.map((item) => {
      const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
      return {
        id: item.id,
        status: item.status,
        job: item.job ? { id: item.job.id, status: item.job.status, errorCode: item.job.errorCode, costDreamcoins: item.job.costDreamcoins } : null,
        asset: asset ? { id: asset.id, safetyStatus: asset.safetyStatus, deletedAt: asset.deletedAt } : null,
        placements: asset?.placements.map((placement) => ({
          status: placement.status,
          verificationState: placement.verificationState as "pending" | "verifying" | "passed" | "failed" | "overridden",
        })) ?? [],
      };
    }),
    ledgerEntries,
  });
  const relatedIncidentIds = [...new Set((await prisma.opsIncidentOccurrence.findMany({
    where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
    select: { incidentId: true },
  })).map((occurrence) => occurrence.incidentId))];
  const rawExperiment = record(
    record(run.items[0]?.job?.sourceMeta).identityExperiment,
  );
  const experimentMode = rawExperiment.mode === "image_to_image"
    ? "image_to_image" as const
    : rawExperiment.mode === "text_to_image"
      ? "text_to_image" as const
      : null;
  const experimentSeedStrategy = rawExperiment.seedStrategy === "locked"
    ? "locked" as const
    : rawExperiment.seedStrategy === "reuse_source"
      ? "reuse_source" as const
      : rawExperiment.seedStrategy === "random"
        ? "random" as const
        : null;
  const identityExperiment =
    run.purpose === "identity_calibration" &&
    experimentMode &&
    experimentSeedStrategy
      ? {
          mode: experimentMode,
          positivePrompt:
            typeof rawExperiment.positivePrompt === "string" &&
              rawExperiment.positivePrompt.trim()
              ? rawExperiment.positivePrompt.trim()
              : run.brief?.trim() || "Identity calibration",
          negativePrompt:
            typeof rawExperiment.negativePrompt === "string"
              ? rawExperiment.negativePrompt
              : "",
          seedStrategy: experimentSeedStrategy,
          baseSeed:
            typeof rawExperiment.baseSeed === "string"
              ? rawExperiment.baseSeed
              : null,
          sourceAssetId:
            typeof rawExperiment.sourceAssetId === "string"
              ? rawExperiment.sourceAssetId
              : null,
          strength:
            typeof rawExperiment.strength === "number"
              ? rawExperiment.strength
              : 0.65,
        }
      : null;
  return {
    id: run.id,
    title: run.title,
    purpose: run.purpose,
    reviewContext: {
      brief: run.brief?.trim() || "No brief was preserved for this legacy Run.",
      orientation: run.orientation,
      profile: {
        key: run.profileId,
        version: run.profileVersion,
        label: profile?.label ?? null,
      },
      recipe: {
        key: run.recipeId,
        version: run.recipeVersion,
        label: recipe?.label ?? null,
      },
      referenceAssetCount: run.items[0]?.job
        ? new Set(strings(run.items[0].job.referenceAssetIds)).size
        : 0,
      experiment: identityExperiment,
    },
    target: { type: run.targetType, id: run.targetId ?? run.id },
    ownerId: run.ownerId,
    dueAt: run.dueAt?.toISOString() ?? null,
    priority: run.priority,
    lifecycleState: run.lifecycleState,
    workflowStage: run.workflowStage,
    ...state,
    verificationState: run.verificationState as "pending" | "verifying" | "passed" | "failed" | "overridden",
    relatedIncidentIds,
    version: run.version,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    items: run.items.map((item) => {
      const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
      const latestDecision = latestByCreatedAt(decisions.filter((decision) => decision.runItemId === item.id));
      const latestAttempt = attempts.find((attempt) => attempt.requestId === item.jobId) ?? null;
      const latestTransport = transportExecutions.find((execution) => execution.attemptId === latestAttempt?.id) ?? null;
      const placement = asset
        ? latestByCreatedAt(asset.placements.filter((candidate) =>
            ["published", "scheduled"].includes(candidate.status)
          ))
        : null;
      return {
        id: item.id,
        ordinal: item.itemIndex,
        status: item.status,
        executionState: deriveCreativeItemExecutionState({
          itemStatus: item.status,
          jobStatus: item.job?.status ?? null,
          attemptStatus: latestAttempt?.status ?? null,
          transportStatus: latestTransport?.status ?? null,
          hasAsset: Boolean(asset),
        }),
        identityReviewMode: creativeIdentityReviewMode({
          purpose: run.purpose,
          sourceMeta: item.job?.sourceMeta,
        }),
        direction: creativeDirectionSnapshot(item.directionSnapshot),
        version: item.version,
        retryability: latestAttempt?.retryability ?? (item.status === "failed" ? "unknown" : "not_applicable"),
        lineage: {
          briefId: run.id,
          directionId: item.directionId,
          directionHash: item.directionHash,
          generationProfileKey: run.profileId,
          generationProfileVersion: run.profileVersion === null ? null : String(run.profileVersion),
          workflowKey: latestAttempt?.workflowKey ?? null,
          workflowVersion: latestAttempt?.workflowVersion === null || latestAttempt?.workflowVersion === undefined
            ? null
            : String(latestAttempt.workflowVersion),
          requestId: item.jobId,
          attemptId: latestAttempt?.id ?? null,
          providerRequestId: latestTransport?.providerRequestId ?? null,
          seed: item.job?.seed ?? null,
          assetId: asset?.id ?? null,
          reviewDecisionId: latestDecision?.id ?? null,
          placementVersionId: placement?.id ?? null,
        },
        asset: asset ? {
          id: asset.id,
          url: asset.url,
          thumbnailUrl: asset.thumbnailUrl,
          width: asset.width,
          height: asset.height,
        } : null,
        review: latestDecision
          ? {
              id: latestDecision.id,
              supersedesDecisionId: latestDecision.supersedesDecisionId,
              decision: latestDecision.decision,
              identityConsistency: latestDecision.identityConsistency,
              score: latestDecision.score,
              quality: creativeReviewQuality(latestDecision.evidence),
              reason: latestDecision.reason,
              reviewerId: latestDecision.reviewerId,
              createdAt: latestDecision.createdAt.toISOString(),
            }
          : null,
        placement: placement
          ? {
              id: placement.id,
              slot: placement.slot,
              targetType: placement.targetType,
              targetId: placement.targetId,
              status: placement.status,
              verificationState: placement.verificationState,
              verifiedAt: placement.verifiedAt?.toISOString() ?? null,
              rollbackPlacementId: placement.rollbackPlacementId,
            }
          : null,
      };
    }),
  };
}
