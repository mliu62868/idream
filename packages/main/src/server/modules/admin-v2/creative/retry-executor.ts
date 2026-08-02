import { Prisma, type PrismaClient } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  normalizedModelCapabilities,
  runtimeReferenceImagesForDispatch,
} from "@/server/modules/generation/attempt-dispatch";
import { generationReferenceRequests } from "@/server/ai/reference-images";
import {
  reserveRetryGenerationAttempt,
  resolveGenerationAttemptRetryAuthority,
} from "@/server/modules/generation/generation-attempt-authority";
import { generationWorkflowDescriptor } from "@/server/modules/admin/generation-catalog";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "../characters/generation-authority-lock";
import { generationJobReferencedAssetIds } from "../shared/media-asset-authority-dependencies";
import { claimControlPlaneCommand } from "../shared/control-plane-command";
import { transitionControlPlaneCommandAttempt } from "../shared/control-plane-command-attempt";
import {
  transitionControlPlaneCommand,
  updateControlPlaneCommandMetadata,
} from "../shared/control-plane-command-transition";
import { toInputJson } from "../shared/prisma-json";
import {
  isCreativeRunItemTransitionAllowed,
  isCreativeRunLifecycleTransitionAllowed,
  isCreativeRunVerificationTransitionAllowed,
  isCreativeRunWorkflowTransitionAllowed,
} from "../shared/state-transition-authority";

const TERMINAL_ATTEMPT_STATES = new Set(["succeeded", "failed", "blocked", "cancelled", "unknown"]);
const HEALTHY_VERIFICATION_STATES = new Set(["passed", "verified", "manual_passed"]);
const FROZEN_IMAGE_REFERENCE_ROLES = new Set([
  "primary_face",
  "identity_anchor",
  "identity_reference",
  "source_image",
  "look_reference",
]);

function record(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function generationProfileHealth(profile: {
  enabled: boolean;
  status: string;
  runnerConfig: Prisma.JsonValue | null;
} | null) {
  if (!profile) return { healthy: false, reason: "generation_profile_missing" } as const;
  if (!profile.enabled || profile.status !== "active") {
    return { healthy: false, reason: "generation_profile_inactive" } as const;
  }
  const verificationState = record(profile.runnerConfig).verificationStatus;
  if (
    typeof verificationState === "string" &&
    !HEALTHY_VERIFICATION_STATES.has(verificationState)
  ) {
    return { healthy: false, reason: `generation_profile_${verificationState}` } as const;
  }
  return { healthy: true, reason: null } as const;
}

type CreativeRetryFrozenJob = {
  readonly id: string;
  readonly userId: string;
  readonly characterId: string | null;
  readonly status: string;
  readonly version: number;
  readonly mode: string;
  readonly controls: Prisma.JsonValue;
  readonly referenceAssetIds: Prisma.JsonValue | null;
  readonly referenceManifest: Prisma.JsonValue | null;
};

function frozenManifestRoleErrors(value: Prisma.JsonValue | null) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return ["reference_manifest_not_array"];
  return value.flatMap((entry, index) => {
    const item = record(entry as Prisma.JsonValue);
    const mediaAssetId = item.mediaAssetId;
    const role = item.role;
    if (typeof mediaAssetId !== "string" || mediaAssetId.length === 0) {
      return [`reference_manifest_asset_missing:${index}`];
    }
    if (typeof role !== "string" || !FROZEN_IMAGE_REFERENCE_ROLES.has(role)) {
      return [`reference_manifest_role_invalid:${index}`];
    }
    return [];
  });
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

async function assertCreativeRetryDispatchContract(input: {
  readonly job: CreativeRetryFrozenJob;
  readonly profile: {
    readonly profileKey: string;
    readonly version: number;
    readonly runner: string;
    readonly runnerConfig: Prisma.JsonValue | null;
    readonly workflowKey: string | null;
    readonly pipelineModel: string;
  };
  readonly latestAttempt: {
    readonly profileKey: string | null;
    readonly profileVersion: number | null;
    readonly workflowKey: string | null;
    readonly workflowVersion: number | null;
  } | null;
}) {
  if (
    (
      input.latestAttempt?.profileKey &&
      input.latestAttempt.profileKey !== input.profile.profileKey
    ) ||
    (
      input.latestAttempt?.profileVersion !== null &&
      input.latestAttempt?.profileVersion !== undefined &&
      input.latestAttempt.profileVersion !== input.profile.version
    )
  ) {
    throw Errors.conflict(
      "Creative retry profile no longer matches the frozen Generation Attempt",
      { generationJobId: input.job.id },
    );
  }
  if (input.job.mode !== "image") return;
  const controls = record(input.job.controls);
  const visualIdentity = record(
    controls.visualIdentity as Prisma.JsonValue | null,
  );
  const sourceImageAssetId =
    typeof controls.sourceImageAssetId === "string"
      ? controls.sourceImageAssetId
      : undefined;
  const lookReferenceAssetId =
    typeof controls.lookReferenceAssetId === "string"
      ? controls.lookReferenceAssetId
      : undefined;
  const referenceImages = generationReferenceRequests({
    sourceImageAssetId,
    lookReferenceAssetId,
    anchorAssetIds: stringArray(
      visualIdentity.anchorAssetIds as Prisma.JsonValue,
    ),
    identityReferenceIds: stringArray(
      visualIdentity.referenceAssetIds as Prisma.JsonValue,
    ),
    jobReferenceIds: stringArray(
      input.job.referenceAssetIds ?? [],
    ),
    referenceManifest: input.job.referenceManifest,
    maxReferences: Number.MAX_SAFE_INTEGER,
  }).map((reference) => ({
    assetId: reference.mediaAssetId,
    role: reference.role,
    ...(reference.weight === undefined
      ? {}
      : { weight: reference.weight }),
  }));
  const workflowKey =
    input.profile.workflowKey ?? input.profile.pipelineModel;
  const workflow = await generationWorkflowDescriptor(workflowKey);
  runtimeReferenceImagesForDispatch({
    generationJobId: input.job.id,
    images: referenceImages,
    capabilities: normalizedModelCapabilities(
      input.profile.runnerConfig,
      input.profile.runner === "sd_cpp",
    ),
    workflow,
    workflowKey,
    storedWorkflowKey:
      input.latestAttempt?.workflowKey ??
      (
        typeof controls.workflowKey === "string"
          ? controls.workflowKey
          : undefined
      ),
    storedWorkflowVersion:
      input.latestAttempt?.workflowVersion ??
      (
        typeof controls.workflowVersion === "number"
          ? controls.workflowVersion
          : undefined
      ),
  });
}

/**
 * A Creative retry is a new consumer of the original immutable image inputs.
 * Validate those bytes under the same Character/Media authority locks as the
 * failed→queued transition. If retry wins, a later Library archive observes
 * the queued dependency; if archive wins, retry fails before any domain state
 * is changed.
 */
async function assertCreativeRetryFrozenMediaAuthorities(
  tx: Prisma.TransactionClient,
  jobs: readonly CreativeRetryFrozenJob[],
) {
  const discoveredAssetIdsByJob = new Map(
    jobs.map((job) => [job.id, generationJobReferencedAssetIds(job)]),
  );
  const characterIds = [...new Set(
    jobs.flatMap((job) => job.characterId ? [job.characterId] : []),
  )].sort();
  for (const characterId of characterIds) {
    await lockCharacterGenerationAuthority(tx, characterId);
  }
  await lockCharacterMediaAssetAuthorities(
    tx,
    jobs.flatMap((job) => discoveredAssetIdsByJob.get(job.id) ?? []),
  );

  for (const job of jobs) {
    const current = await tx.generationJob.findUnique({
      where: { id: job.id },
      select: {
        id: true,
        userId: true,
        characterId: true,
        status: true,
        version: true,
        mode: true,
        controls: true,
        referenceAssetIds: true,
        referenceManifest: true,
      },
    });
    if (
      !current ||
      current.status !== "failed" ||
      current.version !== job.version ||
      current.userId !== job.userId ||
      current.characterId !== job.characterId ||
      current.mode !== job.mode
    ) {
      throw Errors.conflict(
        "Generation job changed before Creative retry media authority was reserved",
        { generationJobId: job.id },
      );
    }
    const discoveredAssetIds = discoveredAssetIdsByJob.get(job.id) ?? [];
    const currentAssetIds = generationJobReferencedAssetIds(current);
    if (!sameStringSet(discoveredAssetIds, currentAssetIds)) {
      throw Errors.conflict(
        "Generation image references changed before Creative retry execution",
        { generationJobId: job.id },
      );
    }
    const manifestErrors = frozenManifestRoleErrors(current.referenceManifest);
    if (manifestErrors.length > 0) {
      throw Errors.conflict(
        "Generation reference manifest is not replayable",
        {
          generationJobId: job.id,
          manifestErrors,
        },
      );
    }
    if (current.characterId) {
      const character = await tx.character.findFirst({
        where: {
          id: current.characterId,
          deletedAt: null,
          status: { notIn: ["archived", "removed"] },
        },
        select: { id: true },
      });
      if (!character) {
        throw Errors.conflict(
          "Creative retry Character is no longer active",
          {
            generationJobId: job.id,
            characterId: current.characterId,
          },
        );
      }
    }
    if (currentAssetIds.length === 0) continue;
    const assets = await tx.mediaAsset.findMany({
      where: { id: { in: [...new Set(currentAssetIds)] } },
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
    });
    const usableAssetIds = new Set(
      assets
        .filter((asset) =>
          asset.type === "image" &&
          asset.deletedAt === null &&
          asset.safetyStatus === "passed" &&
          isMediaAssetOperationalForAuthority(asset.metadata) &&
          hasHydratableMediaBlobAuthority(asset) &&
          (
            asset.ownerId === current.userId ||
            (
              current.characterId !== null &&
              asset.characterId === current.characterId
            )
          )
        )
        .map((asset) => asset.id),
    );
    const unavailableAssetIds = [...new Set(currentAssetIds)]
      .filter((assetId) => !usableAssetIds.has(assetId))
      .sort();
    if (unavailableAssetIds.length > 0) {
      throw Errors.conflict(
        "Creative retry image references are no longer available",
        {
          generationJobId: job.id,
          unavailableAssetIds,
        },
      );
    }
  }
}

async function failCommand(
  db: PrismaClient,
  input: { commandId: string; attemptNo: number; workerId: string; error: unknown },
) {
  const error = {
    code: "creative_retry_execution_failed",
    message: input.error instanceof Error ? input.error.message : "Creative retry execution failed",
  };
  await db.$transaction(async (tx) => {
    await transitionControlPlaneCommand(tx, {
      commandId: input.commandId,
      to: "failed",
      expected: { from: "running", leaseOwner: input.workerId, attemptCount: input.attemptNo },
      data: {
        error: toInputJson(error),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: new Date(),
      },
    });
    await transitionControlPlaneCommandAttempt(tx, {
      commandId: input.commandId,
      attemptNo: input.attemptNo,
      to: "failed",
      data: { error: toInputJson(error), finishedAt: new Date() },
    });
  });
}

export async function executeCreativeRetryCommand(
  db: PrismaClient,
  input: { readonly commandId: string; readonly workerId: string },
) {
  const existing = await db.controlPlaneCommand.findUnique({ where: { id: input.commandId } });
  if (!existing) throw Errors.notFound("Creative retry command not found");
  if (existing.commandType !== "creative.run.retry_failed") {
    throw Errors.badRequest("Command is not a Creative retry command");
  }
  if (["verifying", "succeeded", "failed", "cancelled"].includes(existing.status)) return existing;

  const claimed = await claimControlPlaneCommand(db, {
    commandId: input.commandId,
    workerId: input.workerId,
    leaseMs: 60_000,
  });
  if (!claimed) return db.controlPlaneCommand.findUniqueOrThrow({ where: { id: input.commandId } });

  try {
    return await db.$transaction(async (tx) => {
      const run = await tx.contentProductionBatch.findUnique({
        where: { id: claimed.targetId },
        include: {
          items: {
            include: { job: true },
          },
        },
      });
      if (!run) throw Errors.notFound("Creative Run not found during retry execution");
      if (run.version !== claimed.expectedVersion) {
        throw Errors.conflict("Creative Run changed before retry execution", {
          expectedVersion: claimed.expectedVersion,
          actualVersion: run.version,
        });
      }
      if (
        run.lifecycleState !== "active" ||
        !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, run.lifecycleState)
      ) {
        throw Errors.conflict("Creative Run is not active for retry", { lifecycleState: run.lifecycleState });
      }
      if (
        !isCreativeRunWorkflowTransitionAllowed(run.workflowStage, "generation") ||
        !isCreativeRunVerificationTransitionAllowed(run.verificationState, "verifying")
      ) {
        throw Errors.conflict("Creative Run cannot enter retry from its present state", {
          workflow: { from: run.workflowStage, to: "generation" },
          verification: { from: run.verificationState, to: "verifying" },
        });
      }
      const failedItemIds = stringArray(record(claimed.requestPayload).failedItemIds as Prisma.JsonValue);
      if (failedItemIds.length === 0) throw Errors.conflict("Retry command has no frozen failed-item set");
      const items = run.items.filter((item) => failedItemIds.includes(item.id));
      if (items.length !== failedItemIds.length) {
        throw Errors.conflict("Creative retry target set changed before execution");
      }
      for (const item of items) {
        if (
          !isCreativeRunItemTransitionAllowed(
            item.status,
            "regenerate_requested",
          ) ||
          !item.job
        ) {
          throw Errors.conflict("Creative item is no longer retryable", {
            itemId: item.id,
          });
        }
      }
      await assertCreativeRetryFrozenMediaAuthorities(
        tx,
        items.flatMap((item) => item.job ? [item.job] : []),
      );

      const attemptIds: string[] = [];
      for (const item of items) {
        if (!isCreativeRunItemTransitionAllowed(item.status, "regenerate_requested") || !item.job) {
          throw Errors.conflict("Creative item is no longer retryable", { itemId: item.id });
        }
        const latest = await tx.generationAttempt.findFirst({
          where: { requestId: item.job.id },
          orderBy: { attemptNo: "desc" },
        });
        const retryAuthority = await resolveGenerationAttemptRetryAuthority(tx, {
          request: item.job,
          latestAttempt: latest,
        });
        if (!retryAuthority.allowed) {
          throw Errors.conflict(retryAuthority.message, {
            code: retryAuthority.code,
            ...retryAuthority.details,
            itemId: item.id,
          });
        }
        const profile = await tx.generationModelProfile.findFirst({
          where: {
            version: item.job.profileVersion ?? run.profileVersion ?? undefined,
            OR: [
              ...(item.job.profileId ? [{ id: item.job.profileId }, { profileKey: item.job.profileId }] : []),
              ...(run.profileId ? [{ id: run.profileId }, { profileKey: run.profileId }] : []),
            ],
          },
          orderBy: { version: "desc" },
        });
        const health = generationProfileHealth(profile);
        if (!health.healthy) {
          throw Errors.conflict("Generation dependency is unhealthy; retry is disabled", {
            itemId: item.id,
            reason: health.reason,
          });
        }
        if (!profile) {
          throw Errors.conflict(
            "Generation dependency is missing; retry is disabled",
            { itemId: item.id },
          );
        }
        await assertCreativeRetryDispatchContract({
          job: item.job,
          profile,
          latestAttempt: latest,
        });
        const { attempt } = await reserveRetryGenerationAttempt(tx, {
          requestId: item.job.id,
          expectedRequestVersion: item.job.version,
          sourceCommandId: claimed.id,
          creativeRunItemId: item.id,
          dispatch: {
            outboxId: `creative_retry_${claimed.id}_${item.id}`,
            eventType: "creative.retry.dispatch.v2",
            payload: {
              commandId: claimed.id,
              runId: run.id,
              itemId: item.id,
            },
          },
        });
        attemptIds.push(attempt.id);
        const itemUpdated = await tx.contentProductionItem.updateMany({
          where: {
            id: item.id,
            batchId: run.id,
            version: item.version,
            status: item.status,
            jobId: item.job.id,
          },
          data: { status: "regenerate_requested", version: { increment: 1 } },
        });
        if (itemUpdated.count !== 1) {
          throw Errors.conflict("Creative item changed during retry execution", {
            itemId: item.id,
          });
        }
      }

      const runUpdated = await tx.contentProductionBatch.updateMany({
        where: {
          id: run.id,
          version: run.version,
          lifecycleState: run.lifecycleState,
          workflowStage: run.workflowStage,
          verificationState: run.verificationState,
        },
        data: {
          workflowStage: "generation",
          verificationState: "verifying",
          status: "queued",
          version: { increment: 1 },
        },
      });
      if (runUpdated.count !== 1) {
        throw Errors.conflict("Creative Run changed during retry execution", {
          runId: run.id,
        });
      }
      const updatedRun = await tx.contentProductionBatch.findUniqueOrThrow({
        where: { id: run.id },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: claimed.actorId,
          actorRole: "command_executor",
          action: "creative.run.retry_started",
          targetType: "creative_run",
          targetId: run.id,
          reason: "Frozen eligible failed items were converted to new business attempts",
          before: toInputJson({ version: run.version, failedItemIds }),
          after: toInputJson({ version: updatedRun.version, attemptIds, verificationState: "verifying" }),
          requestId: claimed.requestId,
        },
      });
      return transitionControlPlaneCommand(tx, {
        commandId: claimed.id,
        to: "verifying",
        expected: { from: "running", leaseOwner: input.workerId, attemptCount: claimed.attemptCount },
        data: {
          result: toInputJson({
            runId: run.id,
            runVersion: updatedRun.version,
            itemIds: failedItemIds,
            attemptIds,
            verificationState: "verifying",
          }),
          heartbeatAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
    });
  } catch (error) {
    await failCommand(db, {
      commandId: claimed.id,
      attemptNo: claimed.attemptCount,
      workerId: input.workerId,
      error,
    });
    throw error;
  }
}

export async function verifyCreativeRetryCommands(
  db: PrismaClient,
  input: { readonly limit?: number } = {},
) {
  const commands = await db.controlPlaneCommand.findMany({
    where: { commandType: "creative.run.retry_failed", status: "verifying" },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const command of commands) {
    const attempts = await db.generationAttempt.findMany({
      where: { sourceCommandId: command.id },
      orderBy: { attemptNo: "asc" },
    });
    const items = await db.contentProductionItem.findMany({
      where: { id: { in: attempts.flatMap((attempt) => attempt.creativeRunItemId ? [attempt.creativeRunItemId] : []) } },
      include: { mediaAsset: true, job: { include: { assets: true } } },
    });
    const itemById = new Map(items.map((item) => [item.id, item]));
    const allTerminal = attempts.length > 0 && attempts.every((attempt) => TERMINAL_ATTEMPT_STATES.has(attempt.status));
    const outputProjected = attempts.every((attempt) => {
      if (attempt.status !== "succeeded" || !attempt.creativeRunItemId) return true;
      const item = itemById.get(attempt.creativeRunItemId);
      const asset = item?.mediaAsset ?? item?.job?.assets[0] ?? null;
      return Boolean(asset && !asset.deletedAt && asset.safetyStatus === "passed");
    });
    if (!allTerminal || !outputProjected) {
      pending += 1;
      await db.$transaction((tx) => updateControlPlaneCommandMetadata(tx, {
        commandId: command.id,
        expected: { from: "verifying", attemptCount: command.attemptCount },
        data: { heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000) },
      }));
      continue;
    }
    const recoveredItemIds = attempts.flatMap((attempt) => {
      if (attempt.status !== "succeeded" || !attempt.creativeRunItemId) return [];
      const item = itemById.get(attempt.creativeRunItemId);
      const asset = item?.mediaAsset ?? item?.job?.assets[0] ?? null;
      return asset && asset.safetyStatus === "passed" ? [attempt.creativeRunItemId] : [];
    });
    const verificationPassed = recoveredItemIds.length === attempts.length;
    await db.$transaction(async (tx) => {
      const currentRun = await tx.contentProductionBatch.findUniqueOrThrow({
        where: { id: command.targetId },
      });
      const nextWorkflowStage = verificationPassed ? "review" : "generation";
      const nextVerificationState = verificationPassed ? "pending" : "failed";
      if (
        !isCreativeRunWorkflowTransitionAllowed(currentRun.workflowStage, nextWorkflowStage) ||
        !isCreativeRunVerificationTransitionAllowed(currentRun.verificationState, nextVerificationState)
      ) {
        throw Errors.conflict("Creative Run cannot accept retry verification from its present state", {
          workflow: { from: currentRun.workflowStage, to: nextWorkflowStage },
          verification: { from: currentRun.verificationState, to: nextVerificationState },
        });
      }
      const run = await tx.contentProductionBatch.update({
        where: { id: command.targetId },
        data: {
          workflowStage: nextWorkflowStage,
          verificationState: nextVerificationState,
          status: verificationPassed ? "reviewing" : "completed",
          version: { increment: 1 },
        },
      });
      const result = {
        runId: run.id,
        runVersion: run.version,
        attempted: attempts.length,
        recovered: recoveredItemIds.length,
        recoveredItemIds,
        verificationState: verificationPassed ? "passed" : "failed",
      };
      await transitionControlPlaneCommand(tx, {
        commandId: command.id,
        to: verificationPassed ? "succeeded" : "failed",
        expected: { from: "verifying", attemptCount: command.attemptCount },
        data: {
          result: toInputJson(result),
          error: verificationPassed ? Prisma.DbNull : toInputJson({ code: "creative_retry_verification_failed", ...result }),
          needsReconciliation: false,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          finishedAt: new Date(),
        },
      });
      await transitionControlPlaneCommandAttempt(tx, {
        commandId: command.id,
        attemptNo: command.attemptCount,
        to: verificationPassed ? "succeeded" : "failed",
        data: {
          error: verificationPassed ? Prisma.DbNull : toInputJson({ code: "creative_retry_verification_failed" }),
          finishedAt: new Date(),
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: command.actorId,
          actorRole: "verification_worker",
          action: "creative.run.retry_verified",
          targetType: "creative_run",
          targetId: run.id,
          reason: verificationPassed ? "All retried items produced valid assets" : "One or more retried items did not recover",
          after: toInputJson(result),
          requestId: command.requestId,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: verificationPassed ? "creative.retry.verified.v2" : "creative.retry.verification_failed.v2",
          aggregateType: "creative_run",
          aggregateId: run.id,
          payload: toInputJson({ commandId: command.id, ...result }),
        },
      });
    });
    if (verificationPassed) passed += 1;
    else failed += 1;
  }
  return { examined: commands.length, passed, failed, pending };
}
