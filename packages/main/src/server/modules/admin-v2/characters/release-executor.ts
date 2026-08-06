import type { Prisma, PrismaClient } from "@prisma/client";
import { loadCharacterSoulSnapshot } from "@idream/shared";
import { nonSyntheticMediaAssetWhere } from "@/server/lib/media-asset-authority";
import { claimControlPlaneCommand } from "../shared/control-plane-command";
import { transitionControlPlaneCommandAttempt } from "../shared/control-plane-command-attempt";
import { transitionControlPlaneCommand } from "../shared/control-plane-command-transition";
import { toInputJson } from "../shared/prisma-json";
import { releaseMonitorDueAt } from "./release-monitor";
import {
  isCharacterProjectPhaseTransitionAllowed,
  isCharacterReleaseTransitionAllowed,
  isCharacterServingTransitionAllowed,
} from "../shared/state-transition-authority";
import { lockCharacterGenerationAuthority } from "./generation-authority-lock";
import { PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION } from "@/server/modules/ourdream/public-catalog-qualification";
import { evaluateEditorialReleaseAuthorityInTransaction } from "@/server/modules/ourdream/public-release-authority";
import {
  transitionCharacterProject,
  transitionCharacterRelease,
  transitionCharacterServing,
} from "./transition";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-policy";
import { validateCharacterReleaseSnapshot } from "./release-validation";
import {
  releaseAvatarAssetId as placementAssetId,
  releasePlacements,
  releaseRecord as record,
  releaseString as stringValue,
} from "./release-snapshot-values";

export { CHARACTER_RELEASE_POLICY_VERSION } from "./release-policy";
export { validateCharacterReleaseSnapshot } from "./release-validation";

// paused is an operator hold: an existing schedule remains durable and becomes
// eligible after resume. retired is terminal and cannot accept new schedules.
const SCHEDULABLE_SERVING_STATES = new Set(["inactive", "live"]);

type ReleaseCommandRow = Awaited<
  ReturnType<Prisma.TransactionClient["controlPlaneCommand"]["findUniqueOrThrow"]>
>;

type ReleaseCommandType =
  | "character.release.schedule"
  | "character.release.publish"
  | "character.release.rollback"
  | "character.serving.pause"
  | "character.serving.resume"
  | "character.serving.retire";

interface ExecuteReleaseCommandInput {
  readonly commandId: string;
  readonly workerId: string;
  readonly now?: Date;
  readonly leaseMs?: number;
  readonly policyVersion?: string;
  readonly afterClaim?: (commandId: string) => Promise<void>;
}

interface ReleaseCommandResult {
  readonly status: "succeeded" | "failed";
  readonly commandId: string;
  readonly releaseId: string;
  readonly errorCode?: string;
}

class ReleaseCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly evidence: Record<string, unknown> = {},
    readonly rollbackTransaction = false,
  ) {
    super(message);
    this.name = "ReleaseCommandError";
  }
}

function reasonFromPayload(value: Prisma.JsonValue): string {
  const payload = record(value);
  if (typeof payload.reason === "string") return payload.reason;
  const reason = payload.reason;
  if (reason && typeof reason === "object" && !Array.isArray(reason)) {
    const input = reason as Record<string, unknown>;
    return [input.code, input.summary, input.details]
      .filter((item): item is string => typeof item === "string")
      .join(": ");
  }
  return "Character Release command";
}

function releasedCharacterProjection(content: {
  personaSnapshot: Prisma.JsonValue;
  openingSnapshot: Prisma.JsonValue;
  appearanceSnapshot: Prisma.JsonValue;
}) {
  const soulResult = loadCharacterSoulSnapshot(content.personaSnapshot);
  const opening = record(content.openingSnapshot);
  const appearance = record(content.appearanceSnapshot);
  if (!soulResult.ok) {
    throw new ReleaseCommandError(
      "release_content_projection_incomplete",
      "Release content has no valid immutable Character Soul",
      { diagnostics: soulResult.diagnostics.map((item) => item.code) },
    );
  }
  const { identity } = soulResult.snapshot.soul;
  const name = identity.name;
  const description = identity.characterPromise;
  const age = identity.age;
  const gender = identity.gender;
  const relationship = identity.relationshipArchetype;
  const style = stringValue(appearance.style);
  const firstMessage = stringValue(opening.firstMessage);
  if (!name || !description || age === null || !gender || !relationship || !style || !firstMessage) {
    throw new ReleaseCommandError(
      "release_content_projection_incomplete",
      "Release content cannot produce the complete serving projection",
      { name: Boolean(name), description: Boolean(description), age, gender, relationship, style, firstMessage: Boolean(firstMessage) },
    );
  }
  const systemPrompt = soulResult.snapshot.compiled.systemPrompt;
  return {
    name,
    age,
    description,
    systemPrompt,
    style,
    gender,
    relationship,
    appearance: toInputJson(appearance),
    advancedDetails: toInputJson({
      soul: soulResult.snapshot.soul,
      opening,
      soulFingerprint: soulResult.snapshot.compiled.fingerprint,
      compilerVersion: soulResult.snapshot.compiled.compilerVersion,
    }),
  };
}

async function finishAttempt(
  tx: Prisma.TransactionClient,
  command: { id: string; attemptCount: number },
  status: "succeeded" | "failed",
  now: Date,
  error?: Record<string, unknown>,
) {
  await transitionControlPlaneCommandAttempt(tx, {
    commandId: command.id,
    attemptNo: command.attemptCount,
    to: status,
    data: {
      finishedAt: now,
      error: error ? toInputJson(error) : undefined,
    },
  });
}

async function failCommand(
  tx: Prisma.TransactionClient,
  command: { id: string; attemptCount: number; leaseOwner: string | null },
  error: ReleaseCommandError,
  now: Date,
) {
  const errorBody = {
    code: error.code,
    message: error.message,
    ...error.evidence,
  };
  await transitionControlPlaneCommand(tx, {
    commandId: command.id,
    to: "failed",
    expected: { from: "running", leaseOwner: command.leaseOwner, attemptCount: command.attemptCount },
    data: {
      error: toInputJson(errorBody),
      needsReconciliation: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: now,
    },
  });
  await finishAttempt(tx, command, "failed", now, errorBody);
}

async function appendExecutionEvidence(
  tx: Prisma.TransactionClient,
  input: {
    command: {
      id: string;
      actorId: string;
      requestPayload: Prisma.JsonValue;
      requestHash: string;
      requestId: string;
      attemptCount: number;
    };
    commandType: ReleaseCommandType;
    releaseId: string;
    characterId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    eventType: string;
    now: Date;
    result: Record<string, unknown>;
  },
) {
  const actor = await tx.user.findUnique({
    where: { id: input.command.actorId },
    select: { role: true },
  });
  const reason = reasonFromPayload(input.command.requestPayload);
  await tx.characterReleaseEvent.create({
    data: {
      releaseId: input.releaseId,
      characterId: input.characterId,
      type: input.eventType,
      actorId: input.command.actorId,
      commandId: input.command.id,
      reason,
      fromState: toInputJson(input.before),
      toState: toInputJson(input.after),
      evidence: toInputJson({
        requestHash: input.command.requestHash,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      }),
      occurredAt: input.now,
    },
  });
  await tx.adminAuditLog.create({
    data: {
      actorId: input.command.actorId,
      actorRole: actor?.role ?? "unknown",
      action: `${input.commandType}.executed`,
      targetType: "character_release",
      targetId: input.releaseId,
      reason,
      before: toInputJson(input.before),
      after: toInputJson(input.after),
      requestId: input.command.id,
    },
  });
  await tx.mainOutboxEvent.create({
    data: {
      eventType: `${input.eventType}.v2`,
      aggregateType: "character_release",
      aggregateId: input.releaseId,
      payload: toInputJson({
        commandId: input.command.id,
        characterId: input.characterId,
        releaseId: input.releaseId,
        occurredAt: input.now.toISOString(),
        ...input.result,
      }),
    },
  });
  await transitionControlPlaneCommand(tx, {
    commandId: input.command.id,
    to: "succeeded",
    expected: { from: "running", attemptCount: input.command.attemptCount },
    data: {
      result: toInputJson({
        ...input.result,
        releaseId: input.releaseId,
        verificationState: "passed",
      }),
      needsReconciliation: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: input.now,
    },
  });
  await finishAttempt(tx, input.command, "succeeded", input.now);
}

async function executeSchedule(
  tx: Prisma.TransactionClient,
  command: ReleaseCommandRow,
  policyVersion: string,
  now: Date,
) {
  const release = await tx.characterRelease.findUnique({
    where: { id: command.targetId },
  });
  if (!release)
    throw new ReleaseCommandError(
      "release_not_found",
      "Release does not exist",
    );
  if (
    release.version !== command.expectedVersion ||
    !isCharacterReleaseTransitionAllowed(release.status, "published")
  ) {
    throw new ReleaseCommandError(
      "release_version_conflict",
      "Only the expected approved Release can be scheduled",
    );
  }
  const validation = await validateCharacterReleaseSnapshot(tx, release, policyVersion, now);
  if (validation.failed.length > 0) {
    await tx.characterRelease.update({
      where: { id: release.id },
      data: { readiness: "blocked" },
    });
    throw new ReleaseCommandError(
      "release_validation_failed",
      "Release validation failed",
      {
        blockers: validation.failed.map((item) => item.key),
        validationRunId: validation.run.id,
      },
    );
  }
  const payload = record(command.requestPayload);
  const scheduledAtText = stringValue(payload.scheduledAt);
  const scheduledAt = scheduledAtText ? new Date(scheduledAtText) : null;
  if (
    !scheduledAt ||
    !Number.isFinite(scheduledAt.getTime()) ||
    scheduledAt <= now
  ) {
    throw new ReleaseCommandError(
      "invalid_schedule_time",
      "scheduledAt must be a future ISO timestamp",
    );
  }
  const serving = await tx.characterServing.findUnique({
    where: { characterId: validation.project?.characterId ?? "" },
  });
  if (!serving || serving.currentReleaseId === release.id) {
    throw new ReleaseCommandError(
      "serving_conflict",
      "Release is already current or CharacterServing is missing",
    );
  }
  if (!SCHEDULABLE_SERVING_STATES.has(serving.state)) {
    throw new ReleaseCommandError(
      "serving_not_schedulable",
      "Only inactive or live CharacterServing can accept a Release schedule",
      { servingState: serving.state },
    );
  }
  const updated = await tx.characterServing.updateMany({
    where: { id: serving.id, version: serving.version },
    data: {
      scheduledReleaseId: release.id,
      scheduledAt,
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1)
    throw new ReleaseCommandError(
      "serving_version_conflict",
      "CharacterServing changed while scheduling",
    );
  await tx.characterRelease.update({
    where: { id: release.id },
    data: { readiness: "ready" },
  });
  await appendExecutionEvidence(tx, {
    command,
    commandType: "character.release.schedule",
    releaseId: release.id,
    characterId: validation.project?.characterId ?? "",
    before: { serving },
    after: {
      scheduledReleaseId: release.id,
      scheduledAt: scheduledAt.toISOString(),
      servingVersion: serving.version + 1,
    },
    eventType: "character.release.scheduled",
    now,
    result: {
      scheduledAt: scheduledAt.toISOString(),
      validationRunId: validation.run.id,
    },
  });
  return release.id;
}

async function publishRelease(
  tx: Prisma.TransactionClient,
  command: ReleaseCommandRow,
  release: Awaited<
    ReturnType<
      Prisma.TransactionClient["characterRelease"]["findUniqueOrThrow"]
    >
  >,
  policyVersion: string,
  now: Date,
) {
  if (
    release.version !== command.expectedVersion ||
    release.status !== "approved"
  ) {
    throw new ReleaseCommandError(
      "release_version_conflict",
      "Only the expected approved Release can be published",
    );
  }
  const project = await tx.characterProject.findUnique({
    where: { id: release.projectId },
  });
  const characterId = project?.characterId;
  if (!project || !characterId)
    throw new ReleaseCommandError(
      "project_missing",
      "Release Project is missing",
    );
  if (
    project.phase !== "live_management" &&
    !isCharacterProjectPhaseTransitionAllowed(
      project.phase,
      "live_management",
    )
  ) {
    throw new ReleaseCommandError(
      "project_phase_conflict",
      "Character Project cannot enter live management from its present phase",
      { projectPhase: project.phase },
    );
  }
  const validation = await validateCharacterReleaseSnapshot(tx, release, policyVersion, now);
  if (validation.failed.length > 0) {
    await tx.characterRelease.update({
      where: { id: release.id },
      data: { readiness: "blocked" },
    });
    throw new ReleaseCommandError(
      "release_validation_failed",
      "Release validation failed",
      {
        blockers: validation.failed.map((item) => item.key),
        validationRunId: validation.run.id,
      },
    );
  }
  const serving = await tx.characterServing.findUnique({
    where: { characterId },
  });
  if (!serving)
    throw new ReleaseCommandError(
      "serving_missing",
      "CharacterServing is missing",
    );
  const payload = record(command.requestPayload);
  if (payload.trigger === "scheduled_release_due") {
    const scheduledRelease = record(payload.scheduledRelease);
    const servingId = stringValue(scheduledRelease.servingId);
    const releaseId = stringValue(scheduledRelease.releaseId);
    const scheduledAtText = stringValue(scheduledRelease.scheduledAt);
    const scheduledAt = scheduledAtText ? new Date(scheduledAtText) : null;
    const servingVersion = scheduledRelease.servingVersion;
    const occurrenceIsCurrent =
      servingId === serving.id &&
      releaseId === release.id &&
      typeof servingVersion === "number" &&
      Number.isInteger(servingVersion) &&
      servingVersion === serving.version &&
      scheduledAt !== null &&
      Number.isFinite(scheduledAt.getTime()) &&
      scheduledAt.getTime() <= now.getTime() &&
      serving.scheduledReleaseId === release.id &&
      serving.scheduledAt?.getTime() === scheduledAt.getTime();
    if (!occurrenceIsCurrent) {
      throw new ReleaseCommandError(
        "scheduled_release_occurrence_changed",
        "The scheduled Release occurrence changed before publish execution",
        {
          expected: {
            servingId,
            servingVersion,
            releaseId,
            scheduledAt: scheduledAtText,
          },
          actual: {
            servingId: serving.id,
            servingVersion: serving.version,
            releaseId: serving.scheduledReleaseId,
            scheduledAt: serving.scheduledAt?.toISOString() ?? null,
          },
        },
      );
    }
  }
  if (serving.currentReleaseId === release.id) {
    throw new ReleaseCommandError(
      "release_already_current",
      "Release is already current",
    );
  }
  if (serving.scheduledReleaseId && serving.scheduledReleaseId !== release.id) {
    throw new ReleaseCommandError(
      "scheduled_release_conflict",
      "Another Release is scheduled",
    );
  }
  if (!isCharacterServingTransitionAllowed(serving.state, "live")) {
    throw new ReleaseCommandError(
      "serving_state_conflict",
      "CharacterServing cannot become live from its present state",
      { servingState: serving.state },
    );
  }
  await transitionCharacterServing(tx, {
    servingId: serving.id,
    to: "live",
    expected: {
      from: serving.state as "inactive" | "live",
      version: serving.version,
      currentReleaseId: serving.currentReleaseId,
    },
    data: {
      currentReleaseId: release.id,
      scheduledReleaseId: null,
      scheduledAt: null,
    },
  });
  if (serving.currentReleaseId) {
    const currentRelease = await tx.characterRelease.findUnique({
      where: { id: serving.currentReleaseId },
      select: { status: true, version: true },
    });
    if (
      currentRelease &&
      !isCharacterReleaseTransitionAllowed(currentRelease.status, "superseded")
    ) {
      throw new ReleaseCommandError(
        "current_release_transition_invalid",
        "Current Release cannot be superseded from its present state",
        { releaseId: serving.currentReleaseId, status: currentRelease.status },
        true,
      );
    }
    await transitionCharacterRelease(tx, {
      releaseId: serving.currentReleaseId,
      to: "superseded",
      expected: { from: "published", version: currentRelease!.version },
    });
  }
  await transitionCharacterRelease(tx, {
    releaseId: release.id,
    to: "published",
    expected: { from: "approved", version: release.version },
    data: {
      readiness: "ready",
      publishedAt: now,
      supersedesId: serving.currentReleaseId,
    },
  });
  if (project.phase !== "live_management") {
    await transitionCharacterProject(tx, {
      projectId: project.id,
      to: "live_management",
      expected: {
        from: project.phase as "idea" | "launch_ready",
        version: project.version,
      },
    });
  }
  const publishedAssetIds = [
    ...new Set(
      releasePlacements(release.releasePlacementManifest).map(
        (placement) => placement.assetId,
      ),
    ),
  ];
  const promotedAssets = await tx.mediaAsset.updateMany({
    where: {
      id: { in: publishedAssetIds },
      type: "image",
      deletedAt: null,
      safetyStatus: "passed",
      AND: [
        {
          OR: [{ characterId }, { characterId: null }],
        },
        nonSyntheticMediaAssetWhere,
      ],
    },
    data: { visibility: "public_pack" },
  });
  if (promotedAssets.count !== publishedAssetIds.length) {
    throw new ReleaseCommandError(
      "release_asset_promotion_failed",
      "Every published Release asset must become customer-readable",
      {
        expectedAssetIds: publishedAssetIds,
        promotedCount: promotedAssets.count,
      },
      true,
    );
  }
  await tx.character.update({
    where: { id: characterId },
    data: {
      ...releasedCharacterProjection(validation.content!),
      status: "approved",
      visibility: "public",
      imageAssetId: validation.avatarAssetId,
    },
  });
  // Keep the write order compatible with databases that still have the
  // original statement-time qualification trigger: the Release assets and
  // Character avatar projection must exist before qualification is inserted.
  // The current migration also checks the complete cross-row invariant at
  // transaction commit, so partial publication still cannot escape atomically.
  const publicQualification = await tx.publicCatalogQualification.upsert({
    where: { releaseId: release.id },
    update: {},
    create: {
      id: `catalog-qualification:${release.id}`,
      releaseId: release.id,
      releaseSnapshotHash: release.snapshotHash,
      kind: "generated_release",
      validationRunId: validation.run.id,
      evidence: {
        schemaVersion: PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION,
        policyVersion: validation.run.policyVersion,
        validationRunId: validation.run.id,
        commandId: command.id,
      },
      qualifiedAt: validation.run.finishedAt ?? now,
    },
  });
  if (
    publicQualification.revokedAt !== null ||
    publicQualification.kind !== "generated_release"
  ) {
    throw new ReleaseCommandError(
      "public_catalog_qualification_conflict",
      "Release public qualification is revoked or has a conflicting provenance kind",
      { qualificationId: publicQualification.id },
      true,
    );
  }
  for (const window of ["24h", "72h"] as const) {
    await tx.releaseMonitor.upsert({
      where: { releaseId_window: { releaseId: release.id, window } },
      create: {
        releaseId: release.id,
        window,
        status: "pending",
        baseline: {},
        observed: {},
        verification: { state: "pending" },
        startedAt: now,
        dueAt: releaseMonitorDueAt(now, window),
      },
      update: {},
    });
  }
  await appendExecutionEvidence(tx, {
    command,
    commandType: command.commandType as ReleaseCommandType,
    releaseId: release.id,
    characterId,
    before: {
      serving,
      releaseStatus: release.status,
      releaseVersion: release.version,
    },
    after: {
      currentReleaseId: release.id,
      servingState: "live",
      releaseStatus: "published",
      releaseVersion: release.version + 1,
    },
    eventType:
      command.commandType === "character.release.rollback"
        ? "character.release.rolled_back"
        : "character.release.published",
    now,
    result: {
      validationRunId: validation.run.id,
      previousReleaseId: serving.currentReleaseId,
    },
  });
  return release.id;
}

async function executeRollback(
  tx: Prisma.TransactionClient,
  command: ReleaseCommandRow,
  policyVersion: string,
  now: Date,
) {
  const serving = await tx.characterServing.findUnique({
    where: { characterId: command.targetId },
  });
  if (!serving || serving.version !== command.expectedVersion) {
    throw new ReleaseCommandError(
      "serving_version_conflict",
      "CharacterServing version changed before rollback",
    );
  }
  const sourceReleaseId = stringValue(
    record(command.requestPayload).sourceReleaseId,
  );
  if (!sourceReleaseId)
    throw new ReleaseCommandError(
      "rollback_source_missing",
      "sourceReleaseId is required",
    );
  const source = await tx.characterRelease.findUnique({
    where: { id: sourceReleaseId },
  });
  if (!source)
    throw new ReleaseCommandError(
      "rollback_source_not_found",
      "Rollback source Release does not exist",
    );
  if (source.status !== "superseded") {
    throw new ReleaseCommandError(
      "rollback_source_not_superseded",
      "Rollback source must be a previously published superseded Release",
    );
  }
  const project = await tx.characterProject.findUnique({
    where: { id: source.projectId },
  });
  if (!project || project.characterId !== command.targetId) {
    throw new ReleaseCommandError(
      "rollback_source_character_mismatch",
      "Rollback source belongs to another Character",
    );
  }
  const rollbackId = `rollback:${command.id}`;
  const rollback = await tx.characterRelease.create({
    data: {
      id: rollbackId,
      projectId: source.projectId,
      revisionId: source.revisionId,
      characterContentVersionId: source.characterContentVersionId,
      visualProfileId: source.visualProfileId,
      visualProfileVersion: source.visualProfileVersion,
      referenceSetRevisionId: source.referenceSetRevisionId,
      generationProvenance: toInputJson(source.generationProvenance),
      releasePlacementManifest: toInputJson(source.releasePlacementManifest),
      snapshotHash: source.snapshotHash,
      readiness: "unknown",
      legacy: false,
      status: "approved",
      rollbackOfReleaseId: source.id,
      version: 1,
    },
  });
  const rollbackCommand = {
    ...command,
    targetId: rollback.id,
    expectedVersion: rollback.version,
  };
  return publishRelease(tx, rollbackCommand, rollback, policyVersion, now);
}

async function executeServingState(
  tx: Prisma.TransactionClient,
  command: ReleaseCommandRow,
  policyVersion: string,
  now: Date,
) {
  await lockCharacterGenerationAuthority(tx, command.targetId);
  const character = await tx.character.findFirst({
    where: {
      id: command.targetId,
      deletedAt: null,
      status: { not: "removed" },
    },
    select: { id: true },
  });
  if (!character) {
    throw new ReleaseCommandError(
      "serving_character_unavailable",
      "Archived or removed Characters cannot change serving state",
    );
  }
  const serving = await tx.characterServing.findUnique({
    where: { characterId: command.targetId },
  });
  if (
    !serving ||
    serving.version !== command.expectedVersion ||
    !serving.currentReleaseId
  ) {
    throw new ReleaseCommandError(
      "serving_version_conflict",
      "CharacterServing changed or has no current Release",
    );
  }
  const release = await tx.characterRelease.findUnique({
    where: { id: serving.currentReleaseId },
  });
  const project = release
    ? await tx.characterProject.findUnique({ where: { id: release.projectId } })
    : null;
  if (
    !release ||
    release.status !== "published" ||
    release.publishedAt === null ||
    project?.characterId !== command.targetId
  ) {
    throw new ReleaseCommandError(
      "serving_pointer_invalid",
      "Current pointer is not a published Release for this Character",
    );
  }
  const pausing = command.commandType === "character.serving.pause";
  const retiring = command.commandType === "character.serving.retire";
  const expectedState = pausing || retiring ? "live" : "paused";
  const nextState = retiring ? "retired" : pausing ? "paused" : "live";
  if (
    serving.state !== expectedState ||
    !isCharacterServingTransitionAllowed(serving.state, nextState)
  ) {
    throw new ReleaseCommandError(
      "serving_state_conflict",
      `Serving must be ${expectedState} before ${nextState}`,
    );
  }
  if (
    retiring &&
    project.phase !== "live_management"
  ) {
    throw new ReleaseCommandError(
      "project_phase_conflict",
      "Character Project must be in live management before retirement",
      { projectPhase: project.phase },
    );
  }
  const resuming = !pausing && !retiring;
  let resumeEvidence: Record<string, unknown> | null = null;
  if (resuming) {
    if (release.legacy) {
      const authority =
        await evaluateEditorialReleaseAuthorityInTransaction(tx, {
          releaseId: release.id,
          projectionState: "paused",
        });
      // INTENT: editorial Releases have no generated validation run that can
      // independently clear a hard readiness block. Resume may heal only the
      // known false-staleness shape (the exact authority is otherwise intact
      // and readiness alone is `stale`). `blocked` and `unknown` always require
      // an explicit authority repair/review workflow.
      const staleReadinessOnly =
        release.readiness === "stale" &&
        authority.failures.length === 1 &&
        authority.failures[0]?.code === "release_not_ready";
      if (!authority.valid && !staleReadinessOnly) {
        throw new ReleaseCommandError(
          "serving_resume_qualification_invalid",
          "Character Serving cannot resume because its editorial Release authority drifted",
          {
            blockers: authority.failures.map((item) => item.code),
            authorityKind: "editorial_import",
          },
        );
      }
      const qualification =
        await tx.publicCatalogQualification.findUniqueOrThrow({
          where: { releaseId: release.id },
          select: { id: true },
        });
      resumeEvidence = {
        authorityKind: "editorial_import",
        qualificationId: qualification.id,
        validationRunId: null,
      };
    } else {
      const validation = await validateCharacterReleaseSnapshot(
        tx,
        release,
        policyVersion,
        now,
      );
      if (validation.failed.length > 0) {
        throw new ReleaseCommandError(
          "serving_resume_validation_failed",
          "Character Serving cannot resume because the current Release authority drifted",
          {
            blockers: validation.failed.map((item) => item.key),
            validationRunId: validation.run.id,
          },
        );
      }
      const qualification = await tx.publicCatalogQualification.findUnique({
        where: { releaseId: release.id },
        include: { validationRun: true },
      });
      const qualificationEvidence = record(qualification?.evidence);
      const pinnedValidation = qualification?.validationRun ?? null;
      if (
        !qualification ||
        qualification.kind !== "generated_release" ||
        qualification.validationRunId === null ||
        qualification.revokedAt !== null ||
        qualification.releaseSnapshotHash !== release.snapshotHash ||
        qualificationEvidence.schemaVersion !==
          PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION ||
        qualificationEvidence.policyVersion !== policyVersion ||
        !pinnedValidation ||
        pinnedValidation.releaseId !== release.id ||
        pinnedValidation.snapshotHash !== release.snapshotHash ||
        pinnedValidation.policyVersion !== policyVersion ||
        pinnedValidation.result !== "passed" ||
        pinnedValidation.finishedAt === null
      ) {
        throw new ReleaseCommandError(
          "serving_resume_qualification_invalid",
          "Character Serving cannot resume without its exact current generated Release qualification",
          {
            qualificationId: qualification?.id ?? null,
            qualificationKind: qualification?.kind ?? null,
            validationRunId: qualification?.validationRunId ?? null,
          },
        );
      }
      resumeEvidence = {
        authorityKind: "generated_release",
        qualificationId: qualification.id,
        qualificationValidationRunId: qualification.validationRunId,
        resumeValidationRunId: validation.run.id,
      };
    }
    if (release.readiness !== "ready") {
      const restored = await tx.characterRelease.updateMany({
        where: {
          id: release.id,
          version: release.version,
          readiness: release.readiness,
        },
        data: {
          readiness: "ready",
          version: { increment: 1 },
        },
      });
      if (restored.count !== 1) {
        throw new ReleaseCommandError(
          "release_version_conflict",
          "Current Release changed while restoring resume readiness",
          {},
          true,
        );
      }
    }
  }
  const resumeAssetId = pausing || retiring
    ? null
    : placementAssetId(release.releasePlacementManifest);
  if (!pausing && !retiring && !resumeAssetId) {
    throw new ReleaseCommandError(
      "serving_projection_manifest_missing",
      "Published Release has no character avatar manifest",
    );
  }
  await transitionCharacterServing(tx, {
    servingId: serving.id,
    to: nextState,
    expected: {
      from: expectedState,
      version: serving.version,
    },
    data: {
      ...(retiring
        ? {
            scheduledReleaseId: null,
            scheduledAt: null,
          }
        : {}),
    },
  });
  await tx.character.update({
    where: { id: command.targetId },
    data: pausing || retiring
      ? { status: "archived", visibility: "private" }
      : {
          status: "approved",
          visibility: "public",
          imageAssetId: resumeAssetId,
        },
  });
  if (retiring) {
    await transitionCharacterProject(tx, {
      projectId: project.id,
      to: "retired",
      expected: {
        from: project.phase as "idea" | "planned" | "producing" | "qa" | "launch_ready" | "live_management",
        version: project.version,
      },
      data: { activeKey: null },
    });
  }
  await appendExecutionEvidence(tx, {
    command,
    commandType: command.commandType as ReleaseCommandType,
    releaseId: release.id,
    characterId: command.targetId,
    before: {
      servingState: serving.state,
      servingVersion: serving.version,
      releaseReadiness: release.readiness,
      releaseVersion: release.version,
      scheduledReleaseId: serving.scheduledReleaseId,
      scheduledAt: serving.scheduledAt?.toISOString() ?? null,
    },
    after: {
      servingState: nextState,
      servingVersion: serving.version + 1,
      releaseReadiness:
        resuming ? "ready" : release.readiness,
      releaseVersion:
        resuming && release.readiness !== "ready"
          ? release.version + 1
          : release.version,
      resumeEvidence,
      retired: retiring,
      scheduledReleaseId: retiring ? null : serving.scheduledReleaseId,
      scheduledAt: retiring
        ? null
        : serving.scheduledAt?.toISOString() ?? null,
      cancelledScheduledReleaseId: retiring
        ? serving.scheduledReleaseId
        : null,
    },
    eventType: retiring
      ? "character.serving.retired"
      : pausing
        ? "character.serving.paused"
        : "character.serving.resumed",
    now,
    result: {
      servingState: nextState,
      releaseReadiness:
        resuming ? "ready" : release.readiness,
      releaseVersion:
        resuming && release.readiness !== "ready"
          ? release.version + 1
          : release.version,
      resumeEvidence,
      retired: retiring,
      cancelledScheduledReleaseId: retiring
        ? serving.scheduledReleaseId
        : null,
    },
  });
  return release.id;
}

// SPEC: commandType → 执行者，只有这一张表。
// INVARIANT: 每个 ReleaseCommandType 都必须在表里有 handler —— 漏一个是编译错误。
// INTENT: 同一个集合此前写了三遍：联合类型、一个手写的 supported 数组、一串三元链。三元链的
// 兜底分支是 publishRelease，于是「往联合和 supported 里加了新命令、但忘了加三元分支」会静默
// 地把它当成一次发布来执行——没有任何一处会报错。
type ReleaseCommandHandler = (
  tx: Prisma.TransactionClient,
  command: ReleaseCommandRow,
  policyVersion: string,
  now: Date,
) => Promise<string>;

const RELEASE_COMMAND_HANDLERS: Readonly<
  Record<ReleaseCommandType, ReleaseCommandHandler>
> = {
  "character.release.schedule": executeSchedule,
  "character.release.publish": async (tx, command, policyVersion, now) =>
    publishRelease(
      tx,
      command,
      await tx.characterRelease.findUniqueOrThrow({
        where: { id: command.targetId },
      }),
      policyVersion,
      now,
    ),
  "character.release.rollback": executeRollback,
  "character.serving.pause": executeServingState,
  "character.serving.resume": executeServingState,
  "character.serving.retire": executeServingState,
};

function isReleaseCommandType(value: string): value is ReleaseCommandType {
  return value in RELEASE_COMMAND_HANDLERS;
}

export async function executeCharacterReleaseCommand(
  db: PrismaClient,
  input: ExecuteReleaseCommandInput,
): Promise<ReleaseCommandResult> {
  const now = input.now ?? new Date();
  const existing = await db.controlPlaneCommand.findUnique({
    where: { id: input.commandId },
  });
  if (!existing) {
    return {
      status: "failed",
      commandId: input.commandId,
      releaseId: "",
      errorCode: "command_not_found",
    };
  }
  if (existing.status === "succeeded") {
    return {
      status: "succeeded",
      commandId: existing.id,
      releaseId:
        stringValue(record(existing.result).releaseId) ?? existing.targetId,
    };
  }
  if (!isReleaseCommandType(existing.commandType)) {
    return {
      status: "failed",
      commandId: existing.id,
      releaseId: existing.targetId,
      errorCode: "unsupported_command",
    };
  }
  const claimed = await claimControlPlaneCommand(db, {
    commandId: input.commandId,
    workerId: input.workerId,
    leaseMs: input.leaseMs ?? 30_000,
    now,
  });
  if (!claimed) {
    return {
      status: "failed",
      commandId: existing.id,
      releaseId: existing.targetId,
      errorCode: "command_not_claimable",
    };
  }

  await input.afterClaim?.(claimed.id);

  try {
    return await db.$transaction(async (tx) => {
      const command = await tx.controlPlaneCommand.findUniqueOrThrow({
        where: { id: claimed.id },
      });
      try {
        if (!isReleaseCommandType(command.commandType)) {
          throw new ReleaseCommandError(
            "unsupported_command",
            "Command type is not a Character Release command",
          );
        }
        const releaseId = await RELEASE_COMMAND_HANDLERS[command.commandType](
          tx,
          command,
          input.policyVersion ?? CHARACTER_RELEASE_POLICY_VERSION,
          now,
        );
        return {
          status: "succeeded" as const,
          commandId: command.id,
          releaseId,
        };
      } catch (error) {
        if (
          !(error instanceof ReleaseCommandError) ||
          error.rollbackTransaction
        )
          throw error;
        const domainError = error;
        await failCommand(tx, command, domainError, now);
        return {
          status: "failed" as const,
          commandId: command.id,
          releaseId: command.targetId,
          errorCode: domainError.code,
        };
      }
    });
  } catch (error) {
    const domainError =
      error instanceof ReleaseCommandError
        ? error
        : new ReleaseCommandError(
            "release_executor_transaction_failed",
            error instanceof Error
              ? error.message
              : "Unknown transaction failure",
          );
    await db.$transaction(async (tx) => {
      const command = await tx.controlPlaneCommand.findUnique({
        where: { id: input.commandId },
      });
      if (
        command?.status === "running" &&
        command.leaseOwner === input.workerId
      ) {
        await failCommand(tx, command, domainError, now);
      }
    });
    return {
      status: "failed",
      commandId: input.commandId,
      releaseId: existing.targetId,
      errorCode: domainError.code,
    };
  }
}
