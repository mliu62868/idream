import type { Prisma, PrismaClient } from "@prisma/client";
import { claimControlPlaneCommand } from "../shared/control-plane-command";
import { transitionControlPlaneCommandAttempt } from "../shared/control-plane-command-attempt";
import { toInputJson } from "../shared/prisma-json";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import { releaseMonitorDueAt } from "./release-monitor";
import {
  isCharacterProjectPhaseTransitionAllowed,
  isCharacterReleaseTransitionAllowed,
  isCharacterServingTransitionAllowed,
} from "../shared/state-transition-authority";

export const CHARACTER_RELEASE_POLICY_VERSION = "character-release-policy-v2";

// paused is an operator hold: an existing schedule remains durable and becomes
// eligible after resume. retired is terminal and cannot accept new schedules.
const SCHEDULABLE_SERVING_STATES = new Set(["inactive", "live"]);

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

interface ValidationCheck {
  readonly key: string;
  readonly passed: boolean;
  readonly evidence: Record<string, unknown>;
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function placementAssetId(value: Prisma.JsonValue): string | null {
  const placements = record(value).placements;
  if (!Array.isArray(placements)) return null;
  const primary = placements.find(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).slotKey === "character_avatar",
  );
  return primary && typeof primary === "object" && !Array.isArray(primary)
    ? stringValue((primary as Record<string, unknown>).assetId)
    : null;
}

function releasedCharacterProjection(content: {
  personaSnapshot: Prisma.JsonValue;
  openingSnapshot: Prisma.JsonValue;
  appearanceSnapshot: Prisma.JsonValue;
}) {
  const persona = record(content.personaSnapshot);
  const opening = record(content.openingSnapshot);
  const appearance = record(content.appearanceSnapshot);
  const name = stringValue(persona.name);
  const description = stringValue(persona.characterPromise) ?? stringValue(persona.description);
  const age = typeof persona.age === "number" && Number.isInteger(persona.age) && persona.age >= 18
    ? persona.age
    : null;
  const gender = stringValue(persona.gender);
  const relationship = stringValue(persona.relationshipArchetype);
  const style = stringValue(appearance.style);
  const firstMessage = stringValue(opening.firstMessage);
  if (!name || !description || age === null || !gender || !relationship || !style || !firstMessage) {
    throw new ReleaseCommandError(
      "release_content_projection_incomplete",
      "Release content cannot produce the complete serving projection",
      { name: Boolean(name), description: Boolean(description), age, gender, relationship, style, firstMessage: Boolean(firstMessage) },
    );
  }
  const systemPrompt = stringValue(persona.systemPrompt) ?? [
    stringValue(persona.personality),
    stringValue(persona.tone),
    stringValue(persona.backstory),
  ].filter((value): value is string => value !== null).join("\n\n");
  if (!systemPrompt) {
    throw new ReleaseCommandError(
      "release_content_projection_incomplete",
      "Release content has no serving system prompt",
    );
  }
  return {
    name,
    age,
    description,
    systemPrompt,
    style,
    gender,
    relationship,
    appearance: toInputJson(appearance),
    advancedDetails: toInputJson({ ...persona, ...opening }),
  };
}

export async function validateCharacterReleaseSnapshot(
  tx: Prisma.TransactionClient,
  release: Awaited<
    ReturnType<
      Prisma.TransactionClient["characterRelease"]["findUniqueOrThrow"]
    >
  >,
  policyVersion: string,
  now: Date,
) {
  // Interactive transactions use one connection; keep reads sequential so the
  // pg adapter never multiplexes queries on an already-busy client.
  const project = await tx.characterProject.findUnique({
    where: { id: release.projectId },
  });
  const revision = await tx.characterRevision.findUnique({
    where: { id: release.revisionId },
  });
  const content = await tx.characterContentVersion.findUnique({
    where: { id: release.characterContentVersionId },
  });
  const profile = release.visualProfileId
    ? await tx.characterVisualProfile.findUnique({
        where: { id: release.visualProfileId },
      })
    : null;
  const referenceSet = release.referenceSetRevisionId
    ? await tx.referenceSetRevision.findUnique({
        where: { id: release.referenceSetRevisionId },
        include: {
          references: {
            include: { mediaAsset: { select: { id: true, deletedAt: true } } },
            orderBy: { position: "asc" },
          },
        },
      })
    : null;
  const provenance = record(release.generationProvenance);
  const routeFingerprint = stringValue(provenance.routeFingerprint);
  const route = routeFingerprint
    ? await tx.generationRouteQualification.findFirst({
        where: {
          routeFingerprint,
          result: "qualified",
          policyVersion,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: { evaluatedAt: "desc" },
      })
    : null;
  const canonicalSnapshotHash = characterReleaseSnapshotHash({
    projectId: release.projectId,
    revisionId: release.revisionId,
    characterContentVersionId: release.characterContentVersionId,
    visualProfileId: release.visualProfileId,
    visualProfileVersion: release.visualProfileVersion,
    referenceSetRevisionId: release.referenceSetRevisionId,
    generationProvenance: release.generationProvenance,
    releasePlacementManifest: release.releasePlacementManifest,
  });
  const currentVisualHash = profile
    ? characterVisualProfileSnapshotHash(profile)
    : null;
  const currentReferenceHash = referenceSet
    ? referenceSetSnapshotHash(referenceSet)
    : null;
  const characterQa = record(provenance.characterQa);
  const characterQaRunId = stringValue(characterQa.qaRunId);
  const characterQaRun = characterQaRunId
    ? await tx.characterQaRun.findUnique({ where: { id: characterQaRunId } })
    : null;
  const avatarAssetId = placementAssetId(release.releasePlacementManifest);
  const avatarAsset = avatarAssetId
    ? await tx.mediaAsset.findFirst({
        where: { id: avatarAssetId, deletedAt: null },
        select: { id: true },
      })
    : null;
  const persona = content ? record(content.personaSnapshot) : {};
  const opening = content ? record(content.openingSnapshot) : {};
  const checks: ValidationCheck[] = [
    {
      key: "project_character_authority",
      passed: project !== null,
      evidence: {
        projectId: release.projectId,
        characterId: project?.characterId ?? null,
      },
    },
    {
      key: "revision_is_immutable_and_pinned",
      passed:
        revision !== null &&
        revision.projectId === release.projectId &&
        revision.characterContentVersionId ===
          release.characterContentVersionId,
      evidence: { revisionId: release.revisionId },
    },
    {
      key: "persona_complete",
      passed:
        content !== null &&
        (stringValue(persona.systemPrompt) !== null ||
          stringValue(persona.description) !== null),
      evidence: {
        characterContentVersionId: release.characterContentVersionId,
      },
    },
    {
      key: "opening_complete",
      passed: content !== null && stringValue(opening.firstMessage) !== null,
      evidence: {
        characterContentVersionId: release.characterContentVersionId,
      },
    },
    {
      key: "visual_identity_exact_version",
      passed:
        profile !== null &&
        profile.characterId === project?.characterId &&
        profile.version === release.visualProfileVersion &&
        (profile.status === "active" || release.rollbackOfReleaseId !== null) &&
        profile.immutableHash !== null &&
        profile.immutableHash === currentVisualHash,
      evidence: {
        visualProfileId: release.visualProfileId,
        expectedVersion: release.visualProfileVersion,
        actualVersion: profile?.version ?? null,
        immutableHash: profile?.immutableHash ?? null,
        currentVisualHash,
      },
    },
    {
      key: "reference_set_published_snapshot",
      passed:
        referenceSet !== null &&
        referenceSet.visualProfileId === release.visualProfileId &&
        (referenceSet.status === "active" ||
          release.rollbackOfReleaseId !== null) &&
        referenceSet.snapshotHash !== null &&
        referenceSet.snapshotHash === currentReferenceHash &&
        referenceSet.references.length > 0 &&
        referenceSet.references.every(
          (item) => item.mediaAsset.deletedAt === null,
        ),
      evidence: {
        referenceSetRevisionId: release.referenceSetRevisionId,
        referenceCount: referenceSet?.references.length ?? 0,
        snapshotHash: referenceSet?.snapshotHash ?? null,
        currentReferenceHash,
      },
    },
    {
      key: "generation_route_qualified",
      passed:
        route !== null &&
        route.sampleCount >= 40 &&
        route.identityMatch >= 0.9 &&
        route.generationProfileKey === provenance.generationProfileKey &&
        route.generationProfileVersion ===
          provenance.generationProfileVersion &&
        route.workflowKey === provenance.workflowKey &&
        route.workflowVersion === provenance.workflowVersion,
      evidence: {
        routeFingerprint,
        qualificationId: route?.id ?? null,
        sampleCount: route?.sampleCount ?? null,
        identityMatch: route?.identityMatch ?? null,
        policyVersion,
      },
    },
    {
      key: "character_qa_passed",
      passed:
        characterQa.status === "passed" &&
        characterQaRun !== null &&
        characterQaRun.status === "passed" &&
        characterQaRun.characterId === project?.characterId &&
        characterQaRun.projectId === release.projectId &&
        characterQaRun.characterContentVersionId === release.characterContentVersionId &&
        characterQaRun.evidenceHash === stringValue(characterQa.evidenceHash),
      evidence: {
        status: characterQa.status ?? null,
        qaRunId: characterQaRunId,
        evidenceHash: characterQa.evidenceHash ?? null,
        authorityStatus: characterQaRun?.status ?? null,
      },
    },
    {
      key: "release_avatar_manifest_available",
      passed: avatarAsset !== null,
      evidence: { avatarAssetId },
    },
    {
      key: "snapshot_hash_matches",
      passed: release.snapshotHash === canonicalSnapshotHash,
      evidence: {
        stored: release.snapshotHash,
        computed: canonicalSnapshotHash,
      },
    },
  ];
  const failed = checks.filter((check) => !check.passed);
  const run = await tx.releaseValidationRun.create({
    data: {
      releaseId: release.id,
      snapshotHash: canonicalSnapshotHash,
      policyVersion,
      result: failed.length === 0 ? "passed" : "failed",
      startedAt: now,
      finishedAt: now,
    },
  });
  await tx.releaseCheckResult.createMany({
    data: checks.map((check) => ({
      validationRunId: run.id,
      checkKey: check.key,
      result: check.passed ? "passed" : "failed",
      evidence: toInputJson(check.evidence),
      checkedAt: now,
    })),
  });
  return { run, checks, failed, project, content, avatarAssetId };
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
  await tx.controlPlaneCommand.update({
    where: { id: command.id },
    data: {
      status: "failed",
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
  await tx.controlPlaneCommand.update({
    where: { id: input.command.id },
    data: {
      status: "succeeded",
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
  command: Awaited<
    ReturnType<
      Prisma.TransactionClient["controlPlaneCommand"]["findUniqueOrThrow"]
    >
  >,
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
  command: Awaited<
    ReturnType<
      Prisma.TransactionClient["controlPlaneCommand"]["findUniqueOrThrow"]
    >
  >,
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
  const servingUpdate = await tx.characterServing.updateMany({
    where: {
      id: serving.id,
      version: serving.version,
      currentReleaseId: serving.currentReleaseId,
    },
    data: {
      currentReleaseId: release.id,
      scheduledReleaseId: null,
      scheduledAt: null,
      state: "live",
      version: { increment: 1 },
    },
  });
  if (servingUpdate.count !== 1)
    throw new ReleaseCommandError(
      "serving_version_conflict",
      "CharacterServing changed while publishing",
    );
  if (serving.currentReleaseId) {
    const currentRelease = await tx.characterRelease.findUnique({
      where: { id: serving.currentReleaseId },
      select: { status: true },
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
    await tx.characterRelease.updateMany({
      where: { id: serving.currentReleaseId, status: "published" },
      data: { status: "superseded", version: { increment: 1 } },
    });
  }
  const published = await tx.characterRelease.updateMany({
    where: { id: release.id, version: release.version, status: "approved" },
    data: {
      status: "published",
      readiness: "ready",
      publishedAt: now,
      supersedesId: serving.currentReleaseId,
      version: { increment: 1 },
    },
  });
  if (published.count !== 1) {
    throw new ReleaseCommandError(
      "release_version_conflict",
      "Release changed while publishing",
      {},
      true,
    );
  }
  if (project.phase !== "live_management") {
    const projectUpdated = await tx.characterProject.updateMany({
      where: {
        id: project.id,
        version: project.version,
        phase: project.phase,
      },
      data: { phase: "live_management", version: { increment: 1 } },
    });
    if (projectUpdated.count !== 1) {
      throw new ReleaseCommandError(
        "project_version_conflict",
        "Character Project changed while publishing",
        {},
        true,
      );
    }
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
  command: Awaited<
    ReturnType<
      Prisma.TransactionClient["controlPlaneCommand"]["findUniqueOrThrow"]
    >
  >,
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
  command: Awaited<
    ReturnType<
      Prisma.TransactionClient["controlPlaneCommand"]["findUniqueOrThrow"]
    >
  >,
  now: Date,
) {
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
    !isCharacterProjectPhaseTransitionAllowed(project.phase, "retired")
  ) {
    throw new ReleaseCommandError(
      "project_phase_conflict",
      "Character Project must be in live management before retirement",
      { projectPhase: project.phase },
    );
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
  const updated = await tx.characterServing.updateMany({
    where: { id: serving.id, version: serving.version, state: expectedState },
    data: { state: nextState, version: { increment: 1 } },
  });
  if (updated.count !== 1)
    throw new ReleaseCommandError(
      "serving_version_conflict",
      "CharacterServing changed during state transition",
    );
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
    await tx.characterProject.update({
      where: { id: project.id },
      data: { phase: "retired", activeKey: null, version: { increment: 1 } },
    });
  }
  await appendExecutionEvidence(tx, {
    command,
    commandType: command.commandType as ReleaseCommandType,
    releaseId: release.id,
    characterId: command.targetId,
    before: { servingState: serving.state, servingVersion: serving.version },
    after: { servingState: nextState, servingVersion: serving.version + 1, retired: retiring },
    eventType: retiring
      ? "character.serving.retired"
      : pausing
        ? "character.serving.paused"
        : "character.serving.resumed",
    now,
    result: { servingState: nextState, retired: retiring },
  });
  return release.id;
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
  const supported: readonly ReleaseCommandType[] = [
    "character.release.schedule",
    "character.release.publish",
    "character.release.rollback",
    "character.serving.pause",
    "character.serving.resume",
    "character.serving.retire",
  ];
  if (!supported.includes(existing.commandType as ReleaseCommandType)) {
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
        const releaseId =
          command.commandType === "character.release.schedule"
            ? await executeSchedule(
                tx,
                command,
                input.policyVersion ?? CHARACTER_RELEASE_POLICY_VERSION,
                now,
              )
            : command.commandType === "character.serving.pause" ||
                command.commandType === "character.serving.resume" ||
                command.commandType === "character.serving.retire"
              ? await executeServingState(tx, command, now)
              : command.commandType === "character.release.rollback"
                ? await executeRollback(
                    tx,
                    command,
                    input.policyVersion ?? CHARACTER_RELEASE_POLICY_VERSION,
                    now,
                  )
                : await publishRelease(
                    tx,
                    command,
                    await tx.characterRelease.findUniqueOrThrow({
                      where: { id: command.targetId },
                    }),
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
