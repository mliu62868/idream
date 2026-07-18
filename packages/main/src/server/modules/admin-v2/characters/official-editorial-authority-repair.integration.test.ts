import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  ensureOfficialEditorialCatalogQualification,
} from "@/server/modules/ourdream/public-catalog-qualification";
import {
  publicCharacterAudienceWhere,
} from "@/server/modules/ourdream/public-content-audience";
import {
  evaluateEditorialReleaseAuthority,
} from "@/server/modules/ourdream/public-release-authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { acceptControlPlaneCommand } from "../shared/control-plane-command";
import { executeCharacterReleaseCommand } from "./release-executor";
import { runOfficialEditorialAuthorityRepair } from "./official-editorial-authority-repair";

describe("official editorial Release authority repair", () => {
  const suffix = randomUUID();
  const ownerId = `editorial-repair-owner-${suffix}`;
  const characterId = `editorial-repair-character-${suffix}`;
  const assetId = `editorial-repair-asset-${suffix}`;
  const seedSource = `editorial-repair-seed-${suffix}`;
  const dryRunId = `editorial-repair-dry-${suffix}`;
  const applyRunId = `editorial-repair-apply-${suffix}`;
  const replayRunId = `editorial-repair-replay-${suffix}`;
  let releaseId = "";

  async function executeServingTransition(
    commandType:
      | "character.serving.pause"
      | "character.serving.resume",
    now: Date,
  ) {
    const serving = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
    });
    const accepted = await acceptControlPlaneCommand(prisma, {
      environment: "test",
      actor: { id: ownerId, role: "admin" },
      idempotencyKey: randomUUID(),
      commandType,
      target: { type: "character_serving", id: characterId },
      expectedVersion: serving.version,
      payload: { reason: `Exercise ${commandType}` },
      retryMode: "idempotent",
      reason: "Verify editorial resume authority",
      requestId: randomUUID(),
    });
    const result = await executeCharacterReleaseCommand(prisma, {
      commandId: accepted.commandId,
      workerId: `${ownerId}-${commandType}`,
      now,
    });
    return { commandId: accepted.commandId, result };
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `${ownerId}@idream.internal`,
        role: "admin",
        status: "active",
        dataClass: "internal",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerId,
        type: "image",
        url: `https://assets.example.test/${assetId}.webp`,
        thumbnailUrl: `https://assets.example.test/${assetId}.webp`,
        visibility: "public_pack",
        safetyStatus: "passed",
        metadata: {
          seedSource,
          ownership: "platform_official",
          synthetic: false,
        },
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: ownerId,
        name: "Editorial repair fixture",
        age: 29,
        description: "Truthful official cold-start content.",
        systemPrompt: "Stay in the editorial persona.",
        source: "official",
        status: "approved",
        visibility: "public",
        style: "realistic",
        gender: "female",
        imageAssetId: assetId,
        appearance: {},
        advancedDetails: { firstMessage: "Hello." },
      },
    });
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { characterId },
    });
    const qualified = await ensureOfficialEditorialCatalogQualification(
      prisma,
      {
        characterId,
        expectedAssetId: assetId,
        expectedSeedSource: seedSource,
      },
    );
    releaseId = qualified.releaseId;
    await expect(
      evaluateEditorialReleaseAuthority(prisma, { releaseId }),
    ).resolves.toMatchObject({ valid: true, repairable: false });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: releaseId },
    });
    await prisma.adminAuditLog.deleteMany({
      where: {
        targetType: "character_release",
        targetId: releaseId,
      },
    });
    await prisma.adminBackfillItem.deleteMany({
      where: { runId: { in: [dryRunId, applyRunId, replayRunId] } },
    });
    await prisma.adminBackfillRun.deleteMany({
      where: { id: { in: [dryRunId, applyRunId, replayRunId] } },
    });
    await prisma.releaseMonitor.deleteMany({ where: { releaseId } });
    await prisma.characterReleaseEvent.deleteMany({ where: { releaseId } });
    const commands = await prisma.controlPlaneCommand.findMany({
      where: { actorId: ownerId },
      select: { id: true },
    });
    await prisma.controlPlaneCommandAttempt.deleteMany({
      where: { commandId: { in: commands.map((command) => command.id) } },
    });
    await prisma.controlPlaneCommand.deleteMany({
      where: { id: { in: commands.map((command) => command.id) } },
    });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.publicCatalogQualification.deleteMany({
      where: { releaseId },
    });
    await prisma.characterRelease.deleteMany({ where: { id: releaseId } });
    await prisma.characterRevision.deleteMany({
      where: { projectId: `editorial-project:${characterId}` },
    });
    await prisma.characterProject.deleteMany({
      where: { id: `editorial-project:${characterId}` },
    });
    await prisma.characterContentVersion.deleteMany({
      where: { characterId },
    });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: assetId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
  });

  it("dry-runs, repairs only exact false staleness, and replays without rewriting content", async () => {
    const beforeRelease = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: releaseId },
    });
    const beforeQualification =
      await prisma.publicCatalogQualification.findUniqueOrThrow({
        where: { releaseId },
      });
    const immutableBefore = canonicalSha256({
      generationProvenance: beforeRelease.generationProvenance,
      releasePlacementManifest: beforeRelease.releasePlacementManifest,
      snapshotHash: beforeRelease.snapshotHash,
      qualification: beforeQualification,
    });
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { readiness: "stale", version: { increment: 1 } },
    });
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { characterId: null },
    });
    const staleAt = new Date("2026-07-17T12:00:00.000Z");
    await prisma.characterReleaseEvent.create({
      data: {
        releaseId,
        characterId,
        type: "generation_route_qualification_stale",
        reason: "missing_qualification",
        fromState: { readiness: "ready" },
        toState: { readiness: "stale" },
        evidence: { evaluatorVersion: "historical-route-evaluator" },
        occurredAt: staleAt,
      },
    });
    await prisma.releaseMonitor.create({
      data: {
        releaseId,
        window: "route_qualification",
        status: "action_required",
        baseline: {},
        observed: {
          effectiveQualification: "unqualified",
          reason: "missing_qualification",
        },
        verification: {
          servingChanged: false,
          checkedAt: staleAt.toISOString(),
        },
        startedAt: staleAt,
      },
    });

    await expect(
      prisma.character.count({
        where: {
          AND: [
            publicCharacterAudienceWhere,
            { id: characterId },
          ],
        },
      }),
    ).resolves.toBe(0);
    const dryRun = await runOfficialEditorialAuthorityRepair(prisma, {
      mode: "dry_run",
      runId: dryRunId,
      now: new Date("2026-07-17T12:05:00.000Z"),
      releaseIds: [releaseId],
    });
    expect(dryRun).toMatchObject({
      status: "completed",
      summary: {
        scanned: 1,
        valid: 0,
        repairable: 1,
        applied: 0,
        rejected: 0,
      },
      candidates: [
        {
          releaseId,
          characterId,
          assetId,
          classification: "repairable",
          failureCodes: expect.arrayContaining([
            "release_not_ready",
            "asset_character_mismatch",
          ]),
        },
      ],
    });
    await expect(
      prisma.characterRelease.findUniqueOrThrow({
        where: { id: releaseId },
      }),
    ).resolves.toMatchObject({ readiness: "stale" });

    const applied = await runOfficialEditorialAuthorityRepair(prisma, {
      mode: "apply",
      runId: applyRunId,
      now: new Date("2026-07-17T12:10:00.000Z"),
      releaseIds: [releaseId],
    });
    expect(applied.summary).toEqual({
      scanned: 1,
      valid: 1,
      repairable: 1,
      applied: 1,
      rejected: 0,
    });
    await expect(
      evaluateEditorialReleaseAuthority(prisma, { releaseId }),
    ).resolves.toMatchObject({
      valid: true,
      repairable: false,
      failures: [],
    });
    await expect(
      prisma.character.count({
        where: {
          AND: [
            publicCharacterAudienceWhere,
            { id: characterId },
          ],
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.releaseMonitor.findUniqueOrThrow({
        where: {
          releaseId_window: {
            releaseId,
            window: "route_qualification",
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      verification: expect.objectContaining({
        classification: "not_applicable",
        repairRunId: applyRunId,
      }),
    });
    await expect(
      prisma.characterReleaseEvent.count({
        where: {
          releaseId,
          type: "editorial_import_route_staleness_repaired",
        },
      }),
    ).resolves.toBe(1);

    const afterRelease = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: releaseId },
    });
    const afterQualification =
      await prisma.publicCatalogQualification.findUniqueOrThrow({
        where: { releaseId },
      });
    expect(
      canonicalSha256({
        generationProvenance: afterRelease.generationProvenance,
        releasePlacementManifest: afterRelease.releasePlacementManifest,
        snapshotHash: afterRelease.snapshotHash,
        qualification: afterQualification,
      }),
    ).toBe(immutableBefore);

    const replayed = await runOfficialEditorialAuthorityRepair(prisma, {
      mode: "apply",
      runId: replayRunId,
      now: new Date("2026-07-17T12:15:00.000Z"),
      releaseIds: [releaseId],
    });
    expect(replayed.summary).toEqual({
      scanned: 1,
      valid: 1,
      repairable: 0,
      applied: 0,
      rejected: 0,
    });
    await expect(
      prisma.characterReleaseEvent.count({
        where: {
          releaseId,
          type: "editorial_import_route_staleness_repaired",
        },
      }),
    ).resolves.toBe(1);
  });

  it("resumes only exact editorial stale-readiness drift and never promotes blocked authority", async () => {
    const qualificationBefore =
      await prisma.publicCatalogQualification.findUniqueOrThrow({
        where: { releaseId },
      });
    const validationsBefore = await prisma.releaseValidationRun.count({
      where: { releaseId },
    });

    await expect(
      executeServingTransition(
        "character.serving.pause",
        new Date("2026-07-17T13:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      result: { status: "succeeded", releaseId },
    });
    const staleRelease = await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { readiness: "stale", version: { increment: 1 } },
    });
    const staleResume = await executeServingTransition(
      "character.serving.resume",
      new Date("2026-07-17T13:05:00.000Z"),
    );

    expect(staleResume.result).toMatchObject({
      status: "succeeded",
      releaseId,
    });
    await expect(
      prisma.characterRelease.findUniqueOrThrow({ where: { id: releaseId } }),
    ).resolves.toMatchObject({
      readiness: "ready",
      version: staleRelease.version + 1,
    });
    await expect(
      prisma.characterServing.findUniqueOrThrow({
        where: { characterId },
      }),
    ).resolves.toMatchObject({ state: "live" });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({
      status: "approved",
      visibility: "public",
    });
    await expect(
      prisma.publicCatalogQualification.findUniqueOrThrow({
        where: { releaseId },
      }),
    ).resolves.toEqual(qualificationBefore);
    await expect(
      prisma.releaseValidationRun.count({ where: { releaseId } }),
    ).resolves.toBe(validationsBefore);
    await expect(
      prisma.controlPlaneCommand.findUniqueOrThrow({
        where: { id: staleResume.commandId },
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: expect.objectContaining({
        resumeEvidence: {
          authorityKind: "editorial_import",
          qualificationId: qualificationBefore.id,
          validationRunId: null,
        },
      }),
    });

    await expect(
      executeServingTransition(
        "character.serving.pause",
        new Date("2026-07-17T13:10:00.000Z"),
      ),
    ).resolves.toMatchObject({
      result: { status: "succeeded", releaseId },
    });
    const blockedRelease = await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { readiness: "blocked", version: { increment: 1 } },
    });
    const servingBeforeBlockedResume =
      await prisma.characterServing.findUniqueOrThrow({
        where: { characterId },
      });
    const characterBeforeBlockedResume =
      await prisma.character.findUniqueOrThrow({
        where: { id: characterId },
      });
    const blockedResume = await executeServingTransition(
      "character.serving.resume",
      new Date("2026-07-17T13:15:00.000Z"),
    );

    expect(blockedResume.result).toMatchObject({
      status: "failed",
      errorCode: "serving_resume_qualification_invalid",
    });
    await expect(
      prisma.controlPlaneCommand.findUniqueOrThrow({
        where: { id: blockedResume.commandId },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        code: "serving_resume_qualification_invalid",
        blockers: ["release_not_ready"],
      }),
    });
    await expect(
      prisma.characterRelease.findUniqueOrThrow({ where: { id: releaseId } }),
    ).resolves.toMatchObject({
      readiness: "blocked",
      version: blockedRelease.version,
    });
    await expect(
      prisma.characterServing.findUniqueOrThrow({
        where: { characterId },
      }),
    ).resolves.toEqual(servingBeforeBlockedResume);
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toEqual(characterBeforeBlockedResume);
    await expect(
      prisma.publicCatalogQualification.findUniqueOrThrow({
        where: { releaseId },
      }),
    ).resolves.toEqual(qualificationBefore);
    await expect(
      prisma.releaseValidationRun.count({ where: { releaseId } }),
    ).resolves.toBe(validationsBefore);
    await expect(
      prisma.characterReleaseEvent.count({
        where: {
          releaseId,
          commandId: blockedResume.commandId,
          type: "character.serving.resumed",
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.mainOutboxEvent.count({
        where: {
          aggregateId: releaseId,
          payload: {
            path: ["commandId"],
            equals: blockedResume.commandId,
          },
        },
      }),
    ).resolves.toBe(0);
  });
});
