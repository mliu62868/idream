import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { createMedia, createUser } from "@/server/test/helpers";
import { POST as scheduleRoute } from "@/app/api/v2/admin/characters/[id]/releases/[releaseId]/commands/schedule/route";
import { POST as rollbackRoute } from "@/app/api/v2/admin/characters/[id]/releases/[releaseId]/commands/rollback/route";
import { drainAdminCommands } from "@/processes/admin-command-worker";
import { acceptControlPlaneCommand } from "../shared/control-plane-command";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import {
  CHARACTER_RELEASE_POLICY_VERSION,
  executeCharacterReleaseCommand,
} from "./release-executor";
import { dispatchDueCharacterReleasePublishes } from "./scheduled-release-dispatcher";

describe("Character Release command executor", () => {
  const suffix = randomUUID();
  const prefix = `zt-release-executor-${suffix}`;
  const actorId = `${prefix}-actor`;
  const characterId = `${prefix}-character`;
  const projectId = `${prefix}-project`;
  const contentId = `${prefix}-content`;
  const revisionId = `${prefix}-revision`;
  const profileId = `${prefix}-profile`;
  const referenceSetId = `${prefix}-refs`;
  const mediaId = `${prefix}-media`;
  const oldReleaseId = `${prefix}-old`;
  const candidateReleaseId = `${prefix}-candidate`;
  const invalidReleaseId = `${prefix}-invalid`;
  const policyDriftReleaseId = `${prefix}-policy-drift`;
  const rescheduledReleaseId = `${prefix}-rescheduled`;
  const routeFingerprint = `${prefix}:route`;
  const qaRunId = `${prefix}-qa-run`;
  const qaEvidenceHash = `${prefix}-qa-evidence-hash`;

  function releaseData(id: string, overrides: Record<string, unknown> = {}) {
    const generationProvenance = {
      routeFingerprint,
      matrixKey: "default-character",
      generationProfileKey: "portrait",
      generationProfileVersion: 2,
      workflowKey: "identity",
      workflowVersion: 3,
      characterQa: { status: "passed", qaRunId, evidenceHash: qaEvidenceHash },
    };
    const releasePlacementManifest = {
      placements: [
        { slotKey: "character_avatar", assetId: mediaId, slotVersion: 1 },
      ],
    };
    const snapshot = {
      projectId,
      revisionId,
      characterContentVersionId: contentId,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      referenceSetRevisionId: referenceSetId,
      generationProvenance,
      releasePlacementManifest,
    };
    const base = {
      id,
      ...snapshot,
      status: "approved",
      readiness: "ready",
      legacy: false,
      version: 1,
    };
    return {
      ...base,
      snapshotHash: characterReleaseSnapshotHash(snapshot),
      ...overrides,
    };
  }

  async function accept(input: {
    commandType: string;
    target: { type: string; id: string };
    expectedVersion: number;
    payload: Record<string, unknown>;
  }) {
    return acceptControlPlaneCommand(prisma, {
      environment: "test",
      actor: { id: actorId, role: "admin" },
      idempotencyKey: randomUUID(),
      commandType: input.commandType,
      target: input.target,
      expectedVersion: input.expectedVersion,
      payload: input.payload,
      retryMode: "idempotent",
      reason: "Phase 2 release executor test",
      requestId: randomUUID(),
    });
  }

  function routeRequest(body: Record<string, unknown>, confirmation: string) {
    return new Request(
      "http://localhost/api/v2/admin/characters/x/releases/x/commands/test",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
          "idempotency-key": randomUUID(),
          "if-match": `"${String(body.entityVersion)}"`,
        },
        body: JSON.stringify({
          ...body,
          reason: {
            code: "operator_verified",
            summary: "Verified Phase 2 release command",
          },
          confirmation,
        }),
      },
    );
  }

  beforeAll(async () => {
    await createUser({ id: actorId, role: "admin" });
    await createMedia({ id: mediaId, ownerId: actorId, visibility: "public" });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Release executor character",
        age: 28,
        description: "Complete immutable content.",
        systemPrompt: "Stay in persona.",
        source: "official",
        status: "approved",
        visibility: "public",
        imageAssetId: mediaId,
        appearance: { face: { eyes: "amber" } },
        advancedDetails: { firstMessage: "Welcome back." },
      },
    });
    const visualProfileData = {
      id: profileId,
      characterId,
      version: 1,
      status: "active",
      style: "realistic",
      identityPrompt: "stable identity",
      faceTraits: { eyes: "amber" },
      hairTraits: { color: "black" },
      bodyTraits: {},
      signatureTraits: {},
      styleTraits: { style: "realistic" },
      anchorAssetIds: [mediaId],
      referenceAssetIds: [mediaId],
      adapterRefs: {},
      evidenceState: "qualified",
      createdFrom: "test",
    };
    await prisma.characterVisualProfile.create({
      data: {
        ...visualProfileData,
        immutableHash: characterVisualProfileSnapshotHash({
          ...visualProfileData,
          negativeIdentityPrompt: null,
        }),
      },
    });
    await prisma.referenceSetRevision.create({
      data: {
        id: referenceSetId,
        visualProfileId: profileId,
        revision: 1,
        status: "active",
        selectorVersion: "v2",
        snapshotHash: referenceSetSnapshotHash({
          visualProfileId: profileId,
          revision: 1,
          selectorVersion: "v2",
          references: [
            {
              mediaAssetId: mediaId,
              position: 0,
              role: "primary_face",
              weight: 1,
            },
          ],
        }),
        createdFrom: "test",
        references: {
          create: {
            mediaAssetId: mediaId,
            position: 0,
            role: "primary_face",
            selectionReason: "test evidence",
          },
        },
      },
    });
    await prisma.generationRouteQualification.create({
      data: {
        routeFingerprint,
        generationProfileKey: "portrait",
        generationProfileVersion: 2,
        workflowKey: "identity",
        workflowVersion: 3,
        style: "realistic",
        matrixKey: "default-character",
        sampleCount: 40,
        passCount: 37,
        identityMatch: 0.925,
        result: "qualified",
        evidence: { reviewerId: actorId, evaluatorVersion: "eval-v2" },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `${prefix}-content-hash`,
        personaSnapshot: {
          name: "Released Snapshot Persona",
          age: 29,
          gender: "female",
          relationshipArchetype: "trusted confidante",
          characterPromise: "Complete immutable content.",
          personality: "Grounded and attentive.",
          tone: "Warm and concise.",
          backstory: "A host who remembers the important details.",
          systemPrompt: "Stay in persona.",
          description: "Complete immutable content.",
        },
        openingSnapshot: { firstMessage: "Welcome back." },
        appearanceSnapshot: { style: "realistic" },
        sourceType: "test",
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "launch_ready",
        audience: { segment: "test" },
        successCriteria: ["healthy launch"],
        activeKey: `official:${characterId}`,
      },
    });
    await prisma.characterRevision.create({
      data: {
        id: revisionId,
        projectId,
        revision: 1,
        characterContentVersionId: contentId,
        projectSnapshot: { hypothesis: "test" },
      },
    });
    await prisma.characterQaRun.create({
      data: {
        id: qaRunId,
        characterId,
        projectId,
        characterContentVersionId: contentId,
        projectVersion: 1,
        ownerId: actorId,
        status: "passed",
        checks: [],
        evidenceHash: qaEvidenceHash,
      },
    });
    await prisma.characterRelease.create({
      data: releaseData(oldReleaseId, {
        status: "published",
        publishedAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    });
    await prisma.characterRelease.create({
      data: releaseData(candidateReleaseId),
    });
    await prisma.characterRelease.create({
      data: releaseData(invalidReleaseId, {
        snapshotHash: "tampered-snapshot",
      }),
    });
    await prisma.characterRelease.create({
      data: releaseData(policyDriftReleaseId),
    });
    await prisma.characterRelease.create({
      data: releaseData(rescheduledReleaseId),
    });
    await prisma.characterServing.create({
      data: {
        characterId,
        state: "live",
        currentReleaseId: oldReleaseId,
        version: 1,
      },
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { startsWith: prefix } },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.characterReleaseEvent.deleteMany({ where: { characterId } });
    const commands = await prisma.controlPlaneCommand.findMany({
      where: { actorId },
      select: { id: true },
    });
    await prisma.controlPlaneCommandAttempt.deleteMany({
      where: { commandId: { in: commands.map((item) => item.id) } },
    });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.releaseCheckResult.deleteMany({
      where: {
        validationRunId: {
          in: (
            await prisma.releaseValidationRun.findMany({
              where: { releaseId: { startsWith: prefix } },
              select: { id: true },
            })
          ).map((item) => item.id),
        },
      },
    });
    await prisma.releaseValidationRun.deleteMany({
      where: { releaseId: { startsWith: prefix } },
    });
    await prisma.releaseMonitor.deleteMany({
      where: { releaseId: { startsWith: prefix } },
    });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.characterRelease.deleteMany({
      where: { id: { startsWith: prefix } },
    });
    await prisma.characterQaRun.deleteMany({ where: { id: qaRunId } });
    await prisma.characterRevision.deleteMany({ where: { projectId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.generationRouteQualification.deleteMany({
      where: { routeFingerprint },
    });
    await prisma.characterVisualReferenceSnapshot.deleteMany({
      where: { referenceSetRevisionId: referenceSetId },
    });
    await prisma.referenceSetRevision.deleteMany({
      where: { id: referenceSetId },
    });
    await prisma.characterVisualProfile.deleteMany({
      where: { id: profileId },
    });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: mediaId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("accepts schedule but rejects rollback to a never-published draft", async () => {
    const schedule = await scheduleRoute(
      routeRequest(
        { entityVersion: 1, scheduledAt: "2030-01-02T00:00:00.000Z" },
        `${characterId}:${invalidReleaseId}:schedule`,
      ),
      {
        params: Promise.resolve({
          id: characterId,
          releaseId: invalidReleaseId,
        }),
      },
    );
    const rollback = await rollbackRoute(
      routeRequest(
        { entityVersion: 1 },
        `${characterId}:${invalidReleaseId}:rollback`,
      ),
      {
        params: Promise.resolve({
          id: characterId,
          releaseId: invalidReleaseId,
        }),
      },
    );
    expect([schedule.status, rollback.status]).toEqual([202, 422]);
    await expect(rollback.json()).resolves.toMatchObject({
      error: { code: "invariant_failed", blockers: [{ code: "rollback_source_not_superseded" }] },
    });
    expect(
      await prisma.controlPlaneCommand.findUnique({ where: { id: (await schedule.json()).data.commandId } }),
    ).toMatchObject({
      commandType: "character.release.schedule",
      targetType: "character_release",
      targetId: invalidReleaseId,
    });
  });

  it("fails closed when the current validation policy has no matching route qualification", async () => {
    const accepted = await accept({
      commandType: "character.release.publish",
      target: { type: "character_release", id: candidateReleaseId },
      expectedVersion: 1,
      payload: { reason: "Exercise policy drift" },
    });
    const result = await executeCharacterReleaseCommand(prisma, {
      commandId: accepted.commandId,
      workerId: `${prefix}-worker`,
      policyVersion: "character-release-policy-v3",
      now: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "release_validation_failed",
    });
    const validation = await prisma.releaseValidationRun.findFirstOrThrow({
      where: { releaseId: candidateReleaseId },
      orderBy: { startedAt: "desc" },
    });
    expect(validation).toMatchObject({
      policyVersion: "character-release-policy-v3",
      result: "failed",
    });
    expect(
      (
        await prisma.characterServing.findUniqueOrThrow({
          where: { characterId },
        })
      ).currentReleaseId,
    ).toBe(oldReleaseId);
  });

  it("rejects an illegal Project phase before writing validation evidence", async () => {
    await prisma.characterProject.update({
      where: { id: projectId },
      data: { phase: "retired", version: { increment: 1 } },
    });
    const validationsBefore = await prisma.releaseValidationRun.count({
      where: { releaseId: candidateReleaseId },
    });
    const accepted = await accept({
      commandType: "character.release.publish",
      target: { type: "character_release", id: candidateReleaseId },
      expectedVersion: 1,
      payload: { reason: "Reject an illegal Project transition" },
    });

    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: accepted.commandId,
        workerId: `${prefix}-invalid-project-phase-worker`,
        now: new Date("2026-07-11T01:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "project_phase_conflict",
    });
    await expect(
      prisma.releaseValidationRun.count({
        where: { releaseId: candidateReleaseId },
      }),
    ).resolves.toBe(validationsBefore);
    await expect(
      prisma.characterRelease.findUnique({ where: { id: candidateReleaseId } }),
    ).resolves.toMatchObject({ status: "approved", version: 1 });

    await prisma.characterProject.update({
      where: { id: projectId },
      data: { phase: "launch_ready", version: { increment: 1 } },
    });
  });

  it("validates and schedules without changing the current live pointer", async () => {
    const scheduledAt = new Date("2026-07-20T12:00:00.000Z");
    const accepted = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: candidateReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: scheduledAt.toISOString(),
        reason: "Schedule tested release",
      },
    });
    const result = await executeCharacterReleaseCommand(prisma, {
      commandId: accepted.commandId,
      workerId: `${prefix}-worker`,
      now: new Date("2026-07-12T00:00:00.000Z"),
    });
    expect(result.status).toBe("succeeded");
    expect(
      await prisma.characterServing.findUnique({ where: { characterId } }),
    ).toMatchObject({
      currentReleaseId: oldReleaseId,
      scheduledReleaseId: candidateReleaseId,
      scheduledAt,
      state: "live",
      version: 2,
    });
    const validation = await prisma.releaseValidationRun.findFirstOrThrow({
      where: { releaseId: candidateReleaseId },
      orderBy: { startedAt: "desc" },
    });
    expect(validation).toMatchObject({
      snapshotHash: releaseData(candidateReleaseId).snapshotHash,
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      result: "passed",
    });
  });

  it("survives dispatcher restart and lets concurrent schedulers and workers publish one canonical effect", async () => {
    const dueAt = new Date("2026-07-20T12:00:00.000Z");
    const validationsBefore = await prisma.releaseValidationRun.count({
      where: { releaseId: candidateReleaseId },
    });
    const dispatches = await Promise.all([
      dispatchDueCharacterReleasePublishes(prisma, {
        dispatcherId: `${prefix}-scheduler-a`,
        environment: "test",
        now: dueAt,
      }),
      dispatchDueCharacterReleasePublishes(prisma, {
        dispatcherId: `${prefix}-scheduler-b`,
        environment: "test",
        now: dueAt,
      }),
    ]);
    const commandIds = dispatches.flatMap((dispatch) =>
      dispatch.commands.map((command) => command.commandId),
    );
    expect(new Set(commandIds).size).toBe(1);
    expect(dispatches.reduce((sum, dispatch) => sum + dispatch.accepted, 0)).toBe(1);
    expect(dispatches.reduce((sum, dispatch) => sum + dispatch.replayed, 0)).toBe(1);

    const restarted = await dispatchDueCharacterReleasePublishes(prisma, {
      dispatcherId: `${prefix}-scheduler-after-restart`,
      environment: "test",
      now: new Date(dueAt.getTime() + 1_000),
    });
    expect(restarted).toMatchObject({ accepted: 0, replayed: 1 });
    expect(restarted.commands[0]?.commandId).toBe(commandIds[0]);

    await Promise.all([
      drainAdminCommands(prisma, {
        workerId: `${prefix}-publisher-a`,
        environment: "test",
        now: dueAt,
      }),
      drainAdminCommands(prisma, {
        workerId: `${prefix}-publisher-b`,
        environment: "test",
        now: dueAt,
      }),
    ]);
    const acceptedCommandId = commandIds[0]!;
    expect(
      await prisma.controlPlaneCommand.count({
        where: {
          actorId: "system:character-release-scheduler",
          commandType: "character.release.publish",
          targetId: candidateReleaseId,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.characterServing.findUnique({ where: { characterId } }),
    ).toMatchObject({
      currentReleaseId: candidateReleaseId,
      scheduledReleaseId: null,
      scheduledAt: null,
      state: "live",
      version: 3,
    });
    expect(
      await prisma.characterRelease.findUnique({ where: { id: oldReleaseId } }),
    ).toMatchObject({ status: "superseded" });
    expect(
      await prisma.characterRelease.findUnique({
        where: { id: candidateReleaseId },
      }),
    ).toMatchObject({ status: "published", readiness: "ready", version: 2 });
    expect(
      await prisma.character.findUnique({ where: { id: characterId } }),
    ).toMatchObject({
      name: "Released Snapshot Persona",
      age: 29,
      status: "approved",
      visibility: "public",
      imageAssetId: mediaId,
    });
    expect(
      await prisma.characterReleaseEvent.count({
        where: { releaseId: candidateReleaseId, type: "character.release.published" },
      }),
    ).toBe(1);
    expect(
      await prisma.adminAuditLog.count({
        where: {
          requestId: acceptedCommandId,
          action: "character.release.publish.executed",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.mainOutboxEvent.count({
        where: {
          eventType: "character.release.published.v2",
          aggregateId: candidateReleaseId,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.releaseValidationRun.count({
        where: { releaseId: candidateReleaseId },
      }),
    ).toBe(validationsBefore + 1);
    expect(
      await prisma.releaseValidationRun.findFirst({
        where: { releaseId: candidateReleaseId },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      }),
    ).toMatchObject({
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      result: "passed",
    });
    expect(
      await prisma.releaseMonitor.findMany({
        where: { releaseId: candidateReleaseId },
        orderBy: { window: "asc" },
        select: { window: true, status: true, startedAt: true, dueAt: true },
      }),
    ).toEqual([
      {
        window: "24h",
        status: "pending",
        startedAt: dueAt,
        dueAt: new Date(dueAt.getTime() + 24 * 60 * 60 * 1_000),
      },
      {
        window: "72h",
        status: "pending",
        startedAt: dueAt,
        dueAt: new Date(dueAt.getTime() + 72 * 60 * 60 * 1_000),
      },
    ]);
  });

  it("fails closed on a tampered snapshot and leaves the serving pointer unchanged", async () => {
    const accepted = await accept({
      commandType: "character.release.publish",
      target: { type: "character_release", id: invalidReleaseId },
      expectedVersion: 1,
      payload: { reason: "Must fail" },
    });
    const result = await executeCharacterReleaseCommand(prisma, {
      commandId: accepted.commandId,
      workerId: `${prefix}-worker`,
      now: new Date("2026-07-21T00:00:00.000Z"),
    });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("release_validation_failed");
    expect(
      (
        await prisma.characterServing.findUniqueOrThrow({
          where: { characterId },
        })
      ).currentReleaseId,
    ).toBe(candidateReleaseId);
    const validation = await prisma.releaseValidationRun.findFirstOrThrow({
      where: { releaseId: invalidReleaseId },
      orderBy: { startedAt: "desc" },
    });
    expect(validation.result).toBe("failed");
    expect(
      await prisma.releaseCheckResult.findFirst({
        where: {
          validationRunId: validation.id,
          checkKey: "snapshot_hash_matches",
        },
      }),
    ).toMatchObject({ result: "failed" });
  });

  it("rolls back by cloning the complete historical snapshot into a new Release", async () => {
    const serving = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
    });
    const accepted = await accept({
      commandType: "character.release.rollback",
      target: { type: "character_serving", id: characterId },
      expectedVersion: serving.version,
      payload: {
        sourceReleaseId: oldReleaseId,
        reason: "Rollback after verification",
      },
    });
    const result = await executeCharacterReleaseCommand(prisma, {
      commandId: accepted.commandId,
      workerId: `${prefix}-worker`,
      now: new Date("2026-07-22T00:00:00.000Z"),
    });
    expect(result.status).toBe("succeeded");
    expect(result.releaseId).not.toBe(oldReleaseId);
    const rollback = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: result.releaseId },
    });
    expect(rollback).toMatchObject({
      rollbackOfReleaseId: oldReleaseId,
      characterContentVersionId: contentId,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      referenceSetRevisionId: referenceSetId,
      snapshotHash: releaseData(oldReleaseId).snapshotHash,
      status: "published",
    });
    expect(
      (
        await prisma.characterRelease.findUniqueOrThrow({
          where: { id: oldReleaseId },
        })
      ).status,
    ).toBe("superseded");
    expect(
      (
        await prisma.characterServing.findUniqueOrThrow({
          where: { characterId },
        })
      ).currentReleaseId,
    ).toBe(rollback.id);
  });

  it("rejects a queued due command when the schedule occurrence changes before its worker runs", async () => {
    const firstScheduledAt = new Date("2026-07-23T12:00:00.000Z");
    const schedule = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: rescheduledReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: firstScheduledAt.toISOString(),
        reason: "Schedule the first occurrence",
      },
    });
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: schedule.commandId,
        workerId: `${prefix}-first-schedule-worker`,
        now: new Date("2026-07-23T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    const due = await dispatchDueCharacterReleasePublishes(prisma, {
      dispatcherId: `${prefix}-first-occurrence-scheduler`,
      environment: "test",
      now: firstScheduledAt,
    });
    expect(due).toMatchObject({ accepted: 1, replayed: 0 });

    const secondScheduledAt = new Date("2026-07-24T12:00:00.000Z");
    const reschedule = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: rescheduledReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: secondScheduledAt.toISOString(),
        reason: "Move the schedule before the queued worker runs",
      },
    });
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: reschedule.commandId,
        workerId: `${prefix}-reschedule-worker`,
        now: new Date("2026-07-23T12:00:01.000Z"),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    await drainAdminCommands(prisma, {
      workerId: `${prefix}-stale-occurrence-worker`,
      environment: "test",
      now: new Date("2026-07-23T12:00:02.000Z"),
    });
    expect(
      await prisma.controlPlaneCommand.findUniqueOrThrow({
        where: { id: due.commands[0]!.commandId },
      }),
    ).toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        code: "scheduled_release_occurrence_changed",
      }),
    });
    expect(
      await prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).toMatchObject({
      scheduledReleaseId: rescheduledReleaseId,
      scheduledAt: secondScheduledAt,
    });
    expect(
      await prisma.characterRelease.findUniqueOrThrow({
        where: { id: rescheduledReleaseId },
      }),
    ).toMatchObject({ status: "approved", version: 1 });
    expect(
      await prisma.characterReleaseEvent.count({
        where: {
          releaseId: rescheduledReleaseId,
          type: "character.release.published",
        },
      }),
    ).toBe(0);
  });

  it("publishes a due first Release from inactive Serving and moves it live", async () => {
    await prisma.characterServing.update({
      where: { characterId },
      data: {
        state: "inactive",
        currentReleaseId: null,
        scheduledReleaseId: null,
        scheduledAt: null,
        version: { increment: 1 },
      },
    });
    const scheduledAt = new Date("2026-07-24T12:00:00.000Z");
    const schedule = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: rescheduledReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: scheduledAt.toISOString(),
        reason: "Schedule the first Release for an inactive Character",
      },
    });
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: schedule.commandId,
        workerId: `${prefix}-inactive-schedule-worker`,
        now: new Date("2026-07-24T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    const dispatched = await dispatchDueCharacterReleasePublishes(prisma, {
      dispatcherId: `${prefix}-inactive-due-scheduler`,
      environment: "test",
      now: scheduledAt,
    });
    expect(dispatched).toMatchObject({ accepted: 1, replayed: 0 });
    await drainAdminCommands(prisma, {
      workerId: `${prefix}-inactive-due-worker`,
      environment: "test",
      now: scheduledAt,
    });
    expect(
      await prisma.controlPlaneCommand.findUniqueOrThrow({
        where: { id: dispatched.commands[0]!.commandId },
      }),
    ).toMatchObject({ status: "succeeded" });
    expect(
      await prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).toMatchObject({
      state: "live",
      currentReleaseId: rescheduledReleaseId,
      scheduledReleaseId: null,
      scheduledAt: null,
    });
  });

  it("fails scheduling closed after Serving is retired", async () => {
    await prisma.characterServing.update({
      where: { characterId },
      data: {
        state: "retired",
        scheduledReleaseId: null,
        scheduledAt: null,
        version: { increment: 1 },
      },
    });
    const schedule = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: policyDriftReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: "2026-07-26T00:00:00.000Z",
        reason: "A retired Character must stay retired",
      },
    });
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: schedule.commandId,
        workerId: `${prefix}-retired-schedule-worker`,
        now: new Date("2026-07-25T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "serving_not_schedulable",
    });
    expect(
      await prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).toMatchObject({
      state: "retired",
      scheduledReleaseId: null,
      scheduledAt: null,
    });
    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "live", version: { increment: 1 } },
    });
  });

  it("fails a due publish closed when current policy evidence drifted after scheduling", async () => {
    const scheduledAt = new Date("2026-07-26T00:00:00.000Z");
    const servingBefore = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
    });
    const schedule = await accept({
      commandType: "character.release.schedule",
      target: { type: "character_release", id: policyDriftReleaseId },
      expectedVersion: 1,
      payload: {
        scheduledAt: scheduledAt.toISOString(),
        reason: "Schedule before policy evidence drifts",
      },
    });
    await expect(
      executeCharacterReleaseCommand(prisma, {
        commandId: schedule.commandId,
        workerId: `${prefix}-policy-schedule-worker`,
        now: new Date("2026-07-25T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await prisma.generationRouteQualification.updateMany({
      where: { routeFingerprint, policyVersion: CHARACTER_RELEASE_POLICY_VERSION },
      data: { expiresAt: new Date("2026-07-25T12:00:00.000Z") },
    });

    const dueAt = new Date("2026-07-26T00:00:00.000Z");
    const dispatched = await dispatchDueCharacterReleasePublishes(prisma, {
      dispatcherId: `${prefix}-policy-drift-scheduler`,
      environment: "test",
      now: dueAt,
    });
    await drainAdminCommands(prisma, {
      workerId: `${prefix}-policy-drift-worker`,
      environment: "test",
      now: dueAt,
    });
    expect(dispatched).toMatchObject({ accepted: 1, replayed: 0 });
    expect(
      await prisma.controlPlaneCommand.findUnique({
        where: { id: dispatched.commands[0]!.commandId },
      }),
    ).toMatchObject({
      status: "failed",
      error: expect.objectContaining({ code: "release_validation_failed" }),
    });
    expect(
      await prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).toMatchObject({
      currentReleaseId: servingBefore.currentReleaseId,
      scheduledReleaseId: policyDriftReleaseId,
      scheduledAt,
    });
    expect(
      await prisma.releaseValidationRun.findFirst({
        where: { releaseId: policyDriftReleaseId },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      }),
    ).toMatchObject({
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      result: "failed",
    });
  });
});
